// 预录路线帧的读取与按帧取图（route-frames.ts）：读资源 → 解析文件头 → 交给 UI 线程；按帧切出各自的数据交给
// Skia 解图、同一帧不重复解、越界给空；按真实时间换算帧号；解不出来就放掉、退回实时画；各种读不到的情形回 false。
// 文件内容用小的合成包（格式同 route-frames-format），Skia 解图换成记录收到哪段字节的替身。
// loadRouteFrames 进程内只读一次，每个用例各拿一份新的模块。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { Skia } from "@shopify/react-native-skia";
import { Asset } from "expo-asset";

jest.mock("@/assets/splash/route-frames.skpack", () => 7);
jest.mock("react-native-worklets", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .workletsMock(),
);
jest.mock("@shopify/react-native-skia", () => ({
  Skia: { Picture: { MakePicture: jest.fn() } },
}));
const mockAsset = {
  downloadAsync: jest.fn(() => Promise.resolve()),
  localUri: "file:///cache/route-frames.skpack" as string | null,
};
jest.mock("expo-asset", () => ({
  Asset: { fromModule: jest.fn(() => mockAsset) },
}));
const mockFile = {
  uris: [] as string[],
  bytes: jest.fn((): Promise<Uint8Array> => Promise.resolve(new Uint8Array())),
};
jest.mock("expo-file-system", () => ({
  File: class {
    constructor(uri: string) {
      mockFile.uris.push(uri);
    }
    bytes() {
      return mockFile.bytes();
    }
  },
}));

type Frames = typeof import("../route-frames");
const fresh = (): Frames => {
  let mod!: Frames;
  jest.isolateModules(() => {
    mod = jest.requireActual<Frames>("../route-frames");
  });
  return mod;
};
const makePicture = Skia.Picture.MakePicture as unknown as jest.Mock;

/** 合成一个预录包：frames 是各帧的数据；pad 让它落在一块更大缓冲区的中间（byteOffset ≠ 0） */
function pack(frames: number[][], pad = 0, magic = 0x31465348): Uint8Array {
  const count = frames.length;
  const head = 20 + 4 * (count + 1);
  const data = frames.reduce((n, f) => n + f.length, 0);
  const buf = new ArrayBuffer(pad + head + data);
  const v = new DataView(buf, pad);
  v.setUint32(0, magic, true);
  v.setUint32(4, count, true);
  v.setUint32(8, 60, true);
  v.setFloat32(12, 720, true);
  v.setFloat32(16, 2500, true);
  const bytes = new Uint8Array(buf, pad);
  let off = 0;
  frames.forEach((f, i) => {
    v.setUint32(20 + 4 * i, off, true);
    bytes.set(f, head + off);
    off += f.length;
  });
  v.setUint32(20 + 4 * count, off, true);
  return bytes;
}
const FRAMES = [
  [1, 1, 1],
  [2, 2, 2, 2],
  [3, 3],
];
/** 替身每次解图都给回一张记着自己字节的「图」 */
const decodeAs = () =>
  makePicture.mockImplementation((ab: unknown) => ({
    bytes: Array.from(new Uint8Array(ab as ArrayBuffer)),
  }));

let warn: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  mockAsset.localUri = "file:///cache/route-frames.skpack";
  mockAsset.downloadAsync.mockImplementation(() => Promise.resolve());
  mockFile.uris = [];
  mockFile.bytes.mockImplementation(() => Promise.resolve(pack(FRAMES)));
  decodeAs();
  warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  fresh().releaseRouteFrames();
  warn.mockRestore();
  jest.clearAllMocks();
});

describe("读进来之前", () => {
  it("高度是 0、哪一帧都没有（调用方改实时画）", () => {
    const f = fresh();
    f.releaseRouteFrames();
    expect(f.routeFramesHeight()).toBe(0);
    expect(f.routeFrame(0)).toBeNull();
    expect(f.routeFrameAt(0)).toBeNull();
    expect(makePicture).not.toHaveBeenCalled();
  });
});

describe("loadRouteFrames", () => {
  it("读资源文件、解析文件头后交给 UI 线程；进程内只读一次", async () => {
    const f = fresh();
    const first = f.loadRouteFrames();
    expect(f.loadRouteFrames()).toBe(first);
    await expect(first).resolves.toBe(true);
    expect(Asset.fromModule).toHaveBeenCalledTimes(1);
    expect(Asset.fromModule).toHaveBeenCalledWith(7);
    expect(mockAsset.downloadAsync).toHaveBeenCalledTimes(1);
    expect(mockFile.uris).toEqual(["file:///cache/route-frames.skpack"]);
    expect(f.routeFramesHeight()).toBe(720);
    await expect(f.loadRouteFrames()).resolves.toBe(true);
    expect(Asset.fromModule).toHaveBeenCalledTimes(1);
  });

  it.each<[string, () => void]>([
    [
      "资源没有本地路径",
      () => {
        mockAsset.localUri = null;
      },
    ],
    [
      "不是预录包（文件头不对）",
      () =>
        mockFile.bytes.mockImplementation(() =>
          Promise.resolve(pack(FRAMES, 0, 0x12345678)),
        ),
    ],
    [
      "文件读不出来",
      () =>
        mockFile.bytes.mockImplementation(() =>
          Promise.reject(new Error("EIO")),
        ),
    ],
    [
      "资源下载失败",
      () =>
        mockAsset.downloadAsync.mockImplementation(() =>
          Promise.reject(new Error("offline")),
        ),
    ],
  ])("%s：回 false，不装任何帧", async (_name, arrange) => {
    arrange();
    const f = fresh();
    await expect(f.loadRouteFrames()).resolves.toBe(false);
    expect(f.routeFramesHeight()).toBe(0);
    expect(f.routeFrame(0)).toBeNull();
  });
});

describe("按帧取图", () => {
  it("每帧只把自己那段字节交给 Skia；同一帧不重复解，换帧才解；越界给空", async () => {
    const f = fresh();
    await f.loadRouteFrames();
    expect(f.routeFrame(0)).toEqual({ bytes: [1, 1, 1] });
    expect(f.routeFrame(0)).toEqual({ bytes: [1, 1, 1] });
    expect(makePicture).toHaveBeenCalledTimes(1);
    expect(f.routeFrame(1)).toEqual({ bytes: [2, 2, 2, 2] });
    expect(f.routeFrame(2)).toEqual({ bytes: [3, 3] });
    expect(makePicture).toHaveBeenCalledTimes(3);
    expect(f.routeFrame(-1)).toBeNull();
    expect(f.routeFrame(3)).toBeNull();
    // 来回切：手上只留一张，切回去要重解
    expect(f.routeFrame(1)).toEqual({ bytes: [2, 2, 2, 2] });
    expect(makePicture).toHaveBeenCalledTimes(4);
  });

  it("文件落在一块更大缓冲区的中间（byteOffset ≠ 0）也切得对", async () => {
    mockFile.bytes.mockImplementation(() => Promise.resolve(pack(FRAMES, 13)));
    const f = fresh();
    await expect(f.loadRouteFrames()).resolves.toBe(true);
    expect(f.routeFrame(1)).toEqual({ bytes: [2, 2, 2, 2] });
    expect(f.routeFrame(2)).toEqual({ bytes: [3, 3] });
  });

  it("按真实时间换帧号（60 帧 / 秒，四舍五入）；过了最后一帧给空", async () => {
    const f = fresh();
    await f.loadRouteFrames();
    expect(f.routeFrameAt(0)).toEqual({ bytes: [1, 1, 1] });
    expect(f.routeFrameAt(8)).toEqual({ bytes: [1, 1, 1] }); // 0.48 帧
    expect(f.routeFrameAt(9)).toEqual({ bytes: [2, 2, 2, 2] }); // 0.54 帧
    expect(f.routeFrameAt(1000 / 30)).toEqual({ bytes: [3, 3] });
    expect(f.routeFrameAt(50)).toBeNull();
  });

  it("解不出来（Skia 升级没重录）：给空、提醒一次重录，之后整段放掉都改实时画", async () => {
    const f = fresh();
    await f.loadRouteFrames();
    makePicture.mockImplementation(() => null);
    expect(f.routeFrame(1)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("build-splash-frames");
    expect(f.routeFramesHeight()).toBe(0);
    expect(f.routeFrame(0)).toBeNull();
    expect(f.routeFrameAt(0)).toBeNull();
    expect(makePicture).toHaveBeenCalledTimes(1);
  });

  it("releaseRouteFrames 之后高度回 0、哪帧都没有", async () => {
    const f = fresh();
    await f.loadRouteFrames();
    expect(f.routeFrame(0)).not.toBeNull();
    f.releaseRouteFrames();
    expect(f.routeFramesHeight()).toBe(0);
    expect(f.routeFrame(0)).toBeNull();
  });
});
