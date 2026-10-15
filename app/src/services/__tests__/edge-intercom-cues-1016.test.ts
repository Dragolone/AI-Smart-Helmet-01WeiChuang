// 对讲提示音的边界（2026-10-16）：声音文件第一次用到时写进缓存目录、之后复用；文件大小对不上就重写；
// 交给 TRTC 音效接口时去掉 file:// 并解码；任何一步失败都只是没有提示音，绝不抛给通话。
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

type Cues = typeof import("../intercom-cues");

const mockFiles = new Map<string, number>(); // 文件名 → 字节数
const mockFs = {
  createThrows: false,
  ctorThrows: false,
  writes: [] as string[],
};
const mockPlay = jest.fn(
  async (_p: {
    id: number;
    path: string;
    publish: boolean;
    isShortFile: boolean;
  }) => undefined,
);
const mockShared = { throws: false };

jest.mock("expo-file-system", () => ({
  Paths: { cache: { uri: "file:///data/user/0/app/cache/" } },
  File: class MockFile {
    private readonly name: string;
    constructor(_dir: unknown, name: string) {
      if (mockFs.ctorThrows) throw new Error("cache dir unavailable");
      this.name = name;
    }
    get exists(): boolean {
      return mockFiles.has(this.name);
    }
    get size(): number {
      return mockFiles.get(this.name) ?? 0;
    }
    get uri(): string {
      return `file:///data/user/0/app/cache%20dir/${this.name}`;
    }
    create(): void {
      if (mockFs.createThrows) throw new Error("disk full");
    }
    write(bytes: Uint8Array): void {
      mockFs.writes.push(this.name);
      mockFiles.set(this.name, bytes.length);
    }
  },
}));
jest.mock("trtc-react-native", () => ({
  __esModule: true,
  default: {
    sharedInstance: () => {
      if (mockShared.throws) throw new Error("TRTC not ready");
      return {
        getAudioEffectManager: () => ({
          startPlayMusic: (p: never) => mockPlay(p),
        }),
      };
    },
  },
}));

const load = (): Cues => {
  let mod!: Cues;
  jest.isolateModules(() => {
    mod = jest.requireActual<Cues>("../intercom-cues");
  });
  return mod;
};

beforeEach(() => {
  mockFiles.clear();
  mockFs.createThrows = false;
  mockFs.ctorThrows = false;
  mockFs.writes.length = 0;
  mockShared.throws = false;
  mockPlay.mockReset();
  mockPlay.mockResolvedValue(undefined);
});

describe("prepareCues / playCue", () => {
  it("备好六段声音各写一次；再备一遍不重写", () => {
    const m = load();
    m.prepareCues();
    expect(mockFs.writes.sort()).toEqual(
      ["blip", "down", "tickOff", "tickOn", "up", "warn"]
        .map((s) => `intercom-cue-${s}.wav`)
        .sort(),
    );
    m.prepareCues();
    expect(mockFs.writes).toHaveLength(6);
  });

  it("交给 TRTC 的是绝对路径：去掉 file:// 并解码空格；只在本机放（publish=false）、短音效", () => {
    const m = load();
    m.playCue("enter");
    expect(mockPlay).toHaveBeenCalledWith({
      id: 9101,
      path: "/data/user/0/app/cache dir/intercom-cue-up.wav",
      publish: false,
      isShortFile: true,
    });
  });

  it("同一段声音的几个用途共用一个文件：进房 / 重连 / 开麦都是「上行」那段，只写一次", () => {
    const m = load();
    m.playCue("enter");
    m.playCue("back");
    m.playCue("micOn");
    expect(mockFs.writes).toEqual(["intercom-cue-up.wav"]);
    expect(mockPlay.mock.calls.map((c) => c[0].id)).toEqual([9101, 9101, 9101]);
  });

  it("缓存里已有同名文件且大小对得上：不重写；大小对不上（旧版本 / 上次没写完）：重写", () => {
    const first = load();
    first.playCue("join");
    const size = mockFiles.get("intercom-cue-blip.wav")!;
    mockFs.writes.length = 0;
    load().playCue("join");
    expect(mockFs.writes).toEqual([]);
    mockFiles.set("intercom-cue-blip.wav", size - 10);
    load().playCue("join");
    expect(mockFs.writes).toEqual(["intercom-cue-blip.wav"]);
  });

  it("每种提示对应的声音：掉线和头盔断开是三声低音，按住说话两声各自不同", () => {
    const m = load();
    for (const cue of [
      "lost",
      "helmet",
      "talkOn",
      "talkOff",
      "leave",
      "micOff",
      "join",
    ] as const)
      m.playCue(cue);
    expect(mockPlay.mock.calls.map((c) => c[0].id)).toEqual([
      9104, 9104, 9105, 9106, 9102, 9102, 9103,
    ]);
  });

  it("写文件失败：这次没有提示音、不抛；下次还会再试（没把失败结果缓存下来）", () => {
    mockFs.createThrows = true;
    const m = load();
    expect(() => m.playCue("enter")).not.toThrow();
    expect(mockPlay).not.toHaveBeenCalled();
    mockFs.createThrows = false;
    m.playCue("enter");
    expect(mockPlay).toHaveBeenCalledTimes(1);
  });

  it("缓存目录拿不到（File 构造就抛）：不抛、不放", () => {
    mockFs.ctorThrows = true;
    const m = load();
    expect(() => m.prepareCues()).not.toThrow();
    expect(() => m.playCue("talkOn")).not.toThrow();
    expect(mockPlay).not.toHaveBeenCalled();
  });

  it("TRTC 还没起来（sharedInstance 抛）或播放被拒：都不抛，也不产生未处理的 Promise 拒绝", async () => {
    const m = load();
    mockShared.throws = true;
    expect(() => m.playCue("enter")).not.toThrow();
    mockShared.throws = false;
    mockPlay.mockRejectedValueOnce(new Error("busy"));
    const unhandled = jest.fn();
    process.on("unhandledRejection", unhandled);
    try {
      m.playCue("leave");
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
