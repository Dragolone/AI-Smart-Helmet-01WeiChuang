// 开屏落到设备页时画的表盘替身（landing-device）：用电脑上那套真的 Skia（CanvasKit）把每一刻交出的图画出来、读像素。
// - 不知道大图长什么样就什么都不画；三样（样子 / 商标图 / 头盔图）齐了才由这里接手画商标
// - 底环、电量从环起点滑到电量处、扫描从中心显出头盔并擦掉商标、没连上的头盔是半透明的、连着时扫描后亮起光晕
// - 表盘先在商标的位置，再滑到页面上大图的位置（引导页衔接时一开始就在那里）；到点交还给页面
// - 光点落到连接状态那一粒上的时刻（名字 / 连接状态跟着出现）；电量那一行字
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { SkImage, SkPicture } from "@shopify/react-native-skia";
import path from "node:path";
import { TextDecoder as NodeTextDecoder } from "node:util";
import type { SharedValue } from "react-native-reanimated";
import {
  flat,
  isHost,
  render,
  type Rendered,
} from "@/__tests__/helpers/render";
import { anchorRect, pillFrom, splashOn, splashStory } from "../bus";
import { HELMET_BOX, type HeroSplash } from "../hero-splash";
import { DeviceLanding, releaseDeviceLanding } from "../landing-device";
import { DEVICE, deviceWipe, sparkDuration } from "../landings";
import { MARK_LIFT, SCENE_W, type SkiaApi } from "../route-scene";

/** 真的 Skia 在 beforeAll 里异步起好，替身模块通过它拿；枚举直接用库里的 */
const mockKit: { Skia: SkiaApi | null } = { Skia: null };
jest.mock("@shopify/react-native-skia", () => {
  const { createElement: h } =
    jest.requireActual<typeof import("react")>("react");
  const types = jest.requireActual<Record<string, unknown>>(
    "@shopify/react-native-skia/lib/commonjs/skia/types",
  );
  return {
    BlendMode: types.BlendMode,
    BlurStyle: types.BlurStyle,
    FilterMode: types.FilterMode,
    MipmapMode: types.MipmapMode,
    PaintStyle: types.PaintStyle,
    StrokeCap: types.StrokeCap,
    TileMode: types.TileMode,
    Canvas: (p: Record<string, unknown>) =>
      h("SkCanvas", p, p.children as never),
    Picture: (p: Record<string, unknown>) => h("SkPictureNode", p),
    // 顶层的 worklet 函数在模块加载时就把 Skia 收进闭包（那时真的 Skia 还没起好）：交一个转发的壳，用的时候再去拿
    Skia: new Proxy(
      {},
      {
        get: (_t, prop) =>
          (mockKit.Skia as unknown as Record<string | symbol, unknown>)[prop],
      },
    ),
    createPicture: (
      cb: (canvas: unknown) => void,
      size: { width: number; height: number },
    ) => {
      const S = mockKit.Skia!;
      const rec = S.PictureRecorder();
      const canvas = rec.beginRecording(
        S.XYWHRect(0, 0, size.width, size.height),
      );
      cb(canvas);
      return rec.finishRecordingAsPicture();
    },
  };
});
jest.mock("@/global.css", () => ({}));
jest.mock("react-native-worklets", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .workletsMock(),
);
jest.mock("react-native-reanimated", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .reanimatedMock(),
);

const W = 390;
const H = 844;
// 表盘不在页面上时：中心在商标的位置，边长是屏幕宽的 280/390
const k = W / SCENE_W;
const CX = W / 2;
const CY = H / 2 - MARK_LIFT * k;
const SIZE0 = (280 / 390) * W;
const savedDecoder = globalThis.TextDecoder;
let Skia: SkiaApi;
let surface: NonNullable<ReturnType<SkiaApi["Surface"]["Make"]>>;
let BLUE: SkImage;
let RED: SkImage;

const solid = (color: string): SkImage => {
  const s = Skia.Surface.Make(64, 64)!;
  s.getCanvas().clear(Skia.Color(color));
  s.flush();
  return s.makeImageSnapshot() as unknown as SkImage;
};
beforeAll(async () => {
  (globalThis as { TextDecoder: unknown }).TextDecoder = NodeTextDecoder;
  const kitDir = path.dirname(
    require.resolve("canvaskit-wasm/bin/full/canvaskit.js"),
  );
  const CanvasKitInit = require("canvaskit-wasm/bin/full/canvaskit.js");
  const CanvasKit = await CanvasKitInit({
    locateFile: (f: string) => path.join(kitDir, f),
  });
  (globalThis as { CanvasKit?: unknown }).CanvasKit = CanvasKit;
  const {
    JsiSkApi,
  } = require("@shopify/react-native-skia/lib/commonjs/skia/web/JsiSkia");
  Skia = JsiSkApi(CanvasKit) as SkiaApi;
  mockKit.Skia = Skia;
  surface = Skia.Surface.Make(W, H)!;
  BLUE = solid("#0000FF"); // 头盔图
  RED = solid("#FF0000"); // 商标图
}, 30000);
afterAll(() => {
  (globalThis as { TextDecoder: unknown }).TextDecoder = savedDecoder;
});
beforeEach(() => {
  releaseDeviceLanding();
  anchorRect.hero.set(null);
  anchorRect.heroPill.set(null);
  splashOn.set(0);
  pillFrom.set(-1);
});

const hero = (over: Partial<HeroSplash> = {}): HeroSplash => ({
  battery: 60,
  linked: true,
  arc: "#00FF00",
  track: "#808080",
  tick: "#404040",
  spot: "#000000",
  image: 1,
  imageBox: HELMET_BOX,
  glow: null,
  batteryTop: 0.85,
  label: "电量",
  labelColor: "#AAAAAA",
  value: "60",
  unit: "%",
  valueColor: "#FFFFFF",
  ...over,
});
const shared = () => {
  let v = -1;
  return {
    get: () => v,
    set: (n: number) => {
      v = n;
    },
  } as unknown as SharedValue<number> & { get: () => number };
};
type Opts = {
  t: number;
  hero?: HeroSplash;
  mark?: SkImage | null;
  helmet?: SkImage | null;
  inPlace?: boolean;
  giveAt?: number;
  markTaken?: SharedValue<number>;
};
const mount = (o: Opts): Rendered => {
  splashStory.set(o.t);
  return render(
    <DeviceLanding
      width={W}
      height={H}
      hero={"hero" in o ? o.hero : hero()}
      mark={"mark" in o ? (o.mark ?? null) : RED}
      helmet={"helmet" in o ? (o.helmet ?? null) : BLUE}
      markTaken={o.markTaken ?? shared()}
      inPlace={o.inPlace}
      giveAt={o.giveAt}
    />,
  );
};
const pictureOf = (r: Rendered) =>
  r.root.find((n) => isHost(n, "SkPictureNode")).props.picture
    .value as SkPicture;
const pixels = (pic: SkPicture): Uint8Array => {
  const canvas = surface.getCanvas();
  canvas.clear(Skia.Color("transparent"));
  canvas.drawPicture(pic);
  surface.flush();
  return surface.makeImageSnapshot().readPixels(0, 0, {
    width: W,
    height: H,
    colorType: 4,
    alphaType: 2,
  }) as Uint8Array;
};
const draw = (o: Opts) => pixels(pictureOf(mount(o)));
const at = (px: Uint8Array, x: number, y: number) => {
  const i = (Math.round(y) * W + Math.round(x)) * 4;
  return [px[i], px[i + 1], px[i + 2], px[i + 3]];
};
/** 表盘 240 画布上的一点 → 屏幕（表盘中心 cx,cy、边长 size） */
const onScreen = (
  gx: number,
  gy: number,
  cx = CX,
  cy = CY,
  size = SIZE0,
): [number, number] => [
  cx - size / 2 + (gx * size) / 240,
  cy - size / 2 + (gy * size) / 240,
];
const near = (a: number[], b: number[], tol = 6) =>
  a.every((v, i) => Math.abs(v - b[i]) <= tol);
const maxAlpha = (px: Uint8Array) => {
  let a = 0;
  for (let i = 3; i < px.length; i += 4) a = Math.max(a, px[i]);
  return a;
};
const diffCount = (a: Uint8Array, b: Uint8Array) => {
  let n = 0;
  for (let i = 0; i < a.length; i += 4)
    if (
      a[i] !== b[i] ||
      a[i + 1] !== b[i + 1] ||
      a[i + 2] !== b[i + 2] ||
      a[i + 3] !== b[i + 3]
    )
      n++;
  return n;
};
// 环的正上方（240 画布 120,16）和正左（16,120）
const TOP: [number, number] = [120, 16];
const LEFT: [number, number] = [16, 120];
// 头盔图的中心：图占 0.8、左 0.1、上 0.075
const HELMET_C: [number, number] = [120, 18 + 96];

describe("画不画、谁来画商标", () => {
  it("还不知道大图长什么样：整幅透明，也不接手商标；三样都齐了才由这里画商标", () => {
    const taken = shared();
    let px = draw({ t: 2400, hero: undefined, markTaken: taken });
    expect(maxAlpha(px)).toBe(0);
    expect(taken.get()).toBe(0);
    mount({ t: 2400, helmet: null, markTaken: taken });
    expect(taken.get()).toBe(0);
    mount({ t: 2400, markTaken: taken });
    expect(taken.get()).toBe(1);
    px = draw({ t: 2400 });
    expect(maxAlpha(px)).toBe(255);
  });
});

describe("表盘这一刻画成什么样（真的 Skia）", () => {
  it("底环在商标收小后悄悄出来（1660 之前没有）", () => {
    expect(at(draw({ t: 1650 }), ...onScreen(...TOP))[3]).toBe(0);
    const ring = at(
      draw({ t: 2000, hero: hero({ battery: null }) }),
      ...onScreen(...TOP),
    );
    expect(near(ring, [128, 128, 128, 255], 3)).toBe(true);
  });

  it("电量：光点从环的起点滑到电量处——60% 盖过正上方、30% 盖不到；没有电量只画底环", () => {
    const full = draw({ t: 2400 });
    expect(near(at(full, ...onScreen(...TOP)), [0, 255, 0, 255], 3)).toBe(true);
    expect(near(at(full, ...onScreen(...LEFT)), [0, 255, 0, 255], 3)).toBe(
      true,
    );
    const low = draw({ t: 2400, hero: hero({ battery: 30 }) });
    expect(near(at(low, ...onScreen(...TOP)), [128, 128, 128, 255], 3)).toBe(
      true,
    );
    expect(near(at(low, ...onScreen(...LEFT)), [0, 255, 0, 255], 3)).toBe(true);
    // 光点刚出发：还没滑到左边
    const early = draw({ t: DEVICE.line + 40 });
    expect(at(early, ...onScreen(...LEFT))[1]).toBeLessThan(200);
  });

  it("扫描到一半：圈里显出头盔（还暗着），圈外还是商标；扫完头盔整个亮着、商标没了", () => {
    const t = 2200;
    const r = deviceWipe(t) * 104 * 1.14;
    expect(r).toBeGreaterThan(30);
    expect(r).toBeLessThan(60);
    const mid = draw({ t });
    const c = at(mid, ...onScreen(...HELMET_C));
    // 头盔压暗到六成多
    expect(c[2]).toBeGreaterThan(130);
    expect(c[2]).toBeLessThan(200);
    expect(c[0]).toBeLessThan(10);
    // 圈外、商标范围内：商标的红
    const out = at(mid, ...onScreen(120 + r + 20, 120));
    expect(out[0]).toBeGreaterThan(240);
    expect(out[2]).toBeLessThan(10);

    const done = draw({ t: 2400 });
    expect(near(at(done, ...onScreen(...HELMET_C)), [0, 0, 255, 255], 2)).toBe(
      true,
    );
    expect(at(done, ...onScreen(120 + r + 20, 120))[0]).toBeLessThan(10);
  });

  it("没连上：头盔是半透明的、环是灰的、没有光晕", () => {
    const px = draw({
      t: 2400,
      hero: hero({ linked: false, arc: "#808080", glow: null }),
    });
    const c = at(px, ...onScreen(...HELMET_C));
    expect(c[2]).toBeGreaterThan(100);
    expect(c[2]).toBeLessThan(130);
    // 背后那块柔光底是实的（头盔中心略偏离它的圆心，差一点点）
    expect(c[3]).toBeGreaterThan(240);
  });

  it("连着且有光晕：扫描结束后环外慢慢亮起一圈绿光（光晕半径默认按大图边长的 1.05 倍）", () => {
    const outside = onScreen(120, 120 + 112); // 正下方、环外、没有刻度
    const glow = { radius: null, alpha: 0.5, mid: 0.2 };
    const before = draw({ t: DEVICE.scan[0] - 60, hero: hero({ glow }) });
    expect(at(before, ...outside)[3]).toBe(0);
    const lit = draw({ t: DEVICE.scan[1] + 600, hero: hero({ glow }) });
    const p = at(lit, ...outside);
    expect(p[1]).toBeGreaterThan(20);
    expect(p[0]).toBe(0);
    const none = draw({ t: DEVICE.scan[1] + 600 });
    expect(at(none, ...outside)[3]).toBe(0);
  });
});

describe("表盘在哪", () => {
  const RECT = { x: 75, y: 100, w: 240, h: 240 };

  it("页面大图还没量到：一直在商标的位置", () => {
    const px = draw({ t: 3000, hero: hero({ battery: null }) });
    expect(at(px, ...onScreen(...TOP))[3]).toBe(255);
  });

  it("量到了：扫描完先在原地，再滑到页面上大图的位置；引导页衔接时一开始就在那里", () => {
    anchorRect.hero.set(RECT);
    const h = hero({ battery: null });
    const cx = RECT.x + RECT.w / 2;
    const cy = RECT.y + RECT.h / 2;
    const still = draw({ t: DEVICE.hand - 10, hero: h });
    expect(at(still, ...onScreen(...TOP))[3]).toBe(255);
    const there = draw({ t: DEVICE.hand + DEVICE.glide, hero: h });
    expect(at(there, ...onScreen(...TOP, cx, cy, RECT.w))[3]).toBe(255);
    // 原来那个位置（正左）已经空了
    expect(at(still, ...onScreen(...LEFT))[3]).toBe(255);
    expect(at(there, ...onScreen(...LEFT))[3]).toBe(0);
    const inPlace = draw({ t: 2000, hero: h, inPlace: true });
    expect(at(inPlace, ...onScreen(...TOP, cx, cy, RECT.w))[3]).toBe(255);
  });

  it("交还给页面：量到了就从 giveAt+100 起 200ms 淡出；没量到就跟着底色淡掉", () => {
    const opacity = (r: Rendered) =>
      flat(r.root.findAll((n) => typeof n.type !== "string")[1].props.style)
        .opacity;
    anchorRect.hero.set(RECT);
    expect(opacity(mount({ t: DEVICE.give + 200 }))).toBeCloseTo(0.5);
    expect(opacity(mount({ t: 2600 + 200, giveAt: 2600 }))).toBeCloseTo(0.5);
    expect(opacity(mount({ t: DEVICE.give }))).toBe(1);
    anchorRect.hero.set(null);
    expect(opacity(mount({ t: DEVICE.hand - 80 + 160 }))).toBeCloseTo(0.5);
  });
});

describe("名字 / 连接状态出现的时刻、电量那一行", () => {
  it("没连上（或没有电量）：扫描结束后 20ms；连着：按光点从电量处走完剩下的环再落到那一粒上的时长算；不在播时不改", () => {
    mount({ t: 2000, hero: hero({ linked: false }) });
    expect(pillFrom.get()).toBe(-1);
    splashOn.set(1);
    mount({ t: 2000, hero: hero({ linked: false }) });
    expect(pillFrom.get()).toBe(DEVICE.scan[1] + 20);
    mount({ t: 2000, hero: hero({ battery: null }) });
    expect(pillFrom.get()).toBe(DEVICE.scan[1] + 20);
    mount({ t: 2000 });
    const onRing = 0.4 * DEVICE.arc;
    expect(pillFrom.get()).toBeCloseTo(
      DEVICE.spark + sparkDuration(onRing, 140) - 30,
    );
    // 量到了那一粒：落下去的距离按实际位置算（远一些，时长就长一些，封顶 420）
    anchorRect.hero.set({ x: 75, y: 100, w: 240, h: 240 });
    anchorRect.heroPill.set({ x: 20, y: 700, w: 80, h: 26 });
    mount({ t: 2000 });
    expect(pillFrom.get()).toBeGreaterThan(
      DEVICE.spark + sparkDuration(onRing, 140) - 30,
    );
    expect(pillFrom.get()).toBeLessThanOrEqual(DEVICE.spark + 420 - 30);
  });

  it("连着、量到了那一粒：光点走的那一小段里画出来，走完就没了", () => {
    const RECT = { x: 75, y: 100, w: 240, h: 240 };
    anchorRect.hero.set(RECT);
    const h = hero({ battery: 90 });
    const plain = draw({ t: DEVICE.spark + 120, hero: h });
    anchorRect.heroPill.set({ x: 150, y: 420, w: 80, h: 26 });
    const spark = draw({ t: DEVICE.spark + 120, hero: h });
    expect(diffCount(plain, spark)).toBeGreaterThan(20);
    // 落到那一粒附近
    const late = draw({ t: DEVICE.spark + 300, hero: h });
    expect(diffCount(plain, late)).toBeGreaterThan(0);
    const gone = draw({ t: DEVICE.spark + 800, hero: h });
    anchorRect.heroPill.set(null);
    expect(diffCount(draw({ t: DEVICE.spark + 800, hero: h }), gone)).toBe(0);
  });

  it("电量那一行：小标题 / 数字 / 单位用页面给的颜色；没有单位时不写；扫描快结束时淡入", () => {
    const r = mount({ t: DEVICE.scan[1] - 130 + 110 });
    expect(r.texts()).toEqual(expect.arrayContaining(["电量", "60%", "%"]));
    const label = r.root.find(
      (n) => isHost(n, "Text") && n.children.join("") === "电量",
    );
    expect(flat(label.props.style).color).toBe("#AAAAAA");
    const box = r.root.findAll((n) => typeof n.type !== "string")[1];
    const battery = box.findAll(
      (n) =>
        typeof n.type !== "string" &&
        flat(n.props.style).transformOrigin === "center top",
    )[0];
    const s = flat(battery.props.style);
    expect(s.opacity).toBeCloseTo(0.5);
    expect(s.width).toBe(SIZE0);
    const none = mount({ t: 2400, hero: hero({ value: "—", unit: "" }) });
    expect(none.texts()).toContain("—");
    expect(none.texts()).not.toContain("%");
  });

  it("光点刚从电量处出发、还在环上走：画在环上；走完环才往连接状态那一粒落下去", () => {
    anchorRect.hero.set({ x: 75, y: 100, w: 240, h: 240 });
    const h = hero({ battery: 30 });
    /** 画面上 y 在 [y0, y1) 之间、两张图不一样的像素有多少 */
    const diffRows = (a: Uint8Array, b: Uint8Array, y0: number, y1: number) =>
      diffCount(
        a.subarray(y0 * W * 4, y1 * W * 4),
        b.subarray(y0 * W * 4, y1 * W * 4),
      );
    const pair = (t: number) => {
      anchorRect.heroPill.set(null);
      const plain = draw({ t, hero: h });
      anchorRect.heroPill.set({ x: 150, y: 700, w: 80, h: 26 });
      return [plain, draw({ t, hero: h })] as const;
    };
    // 电量 30%：剩下的环很长，出发后 40ms 还在环上（表盘这时在屏幕中间，环的下沿在 y≈520）
    const [p0, s0] = pair(DEVICE.spark + 40);
    expect(diffRows(p0, s0, 0, 560)).toBeGreaterThan(0);
    expect(diffRows(p0, s0, 560, H)).toBe(0);
    // 快走完时已经离开环，落到环和那一粒之间
    const [p1, s1] = pair(DEVICE.spark + 360);
    expect(diffRows(p1, s1, 600, H)).toBeGreaterThan(0);
  });

  it("没连上的头盔扫描到一半：亮边用素白，不用环的颜色", () => {
    const t = 2200;
    const r = deviceWipe(t) * 104 * 1.14;
    const u = SIZE0 / 240;
    /** 扫描那一圈（半径 r±2，环自己的 240 画布）上各点「绿比红多多少」的平均 */
    const greenOnEdge = (px: Uint8Array) => {
      let sum = 0;
      let n = 0;
      for (let a = 0; a < 360; a += 3) {
        for (const dr of [-2, -1, 0, 1, 2]) {
          const rad = (r + dr) * u;
          const p = at(
            px,
            CX + rad * Math.cos((a * Math.PI) / 180),
            CY + rad * Math.sin((a * Math.PI) / 180),
          );
          sum += p[1] - p[0];
          n++;
        }
      }
      return sum / n;
    };
    // 环色都给绿的，只差连没连上：连着的亮边偏绿，没连上的是素白（红绿差不多）
    const linked = greenOnEdge(draw({ t, hero: hero() }));
    const waiting = greenOnEdge(draw({ t, hero: hero({ linked: false }) }));
    expect(linked - waiting).toBeGreaterThan(8);
  });

  it("光点出发前（1680 之前）先在角上画一个几乎看不见的点，把两张图传到显卡上；还没读出来的那张不画", () => {
    const corner = (o: Partial<Opts>) =>
      at(draw({ t: DEVICE.line - 40, ...o }), 0, 0);
    expect(corner({ mark: null, helmet: null })[3]).toBe(0);
    // 只有商标图（红）
    const markOnly = corner({ helmet: null });
    expect(markOnly[3]).toBeGreaterThan(0);
    expect(markOnly[0]).toBeGreaterThan(0);
    expect(markOnly[2]).toBe(0);
    // 头盔图（蓝）也到了
    expect(corner({})[2]).toBeGreaterThan(0);
    // 光点出发之后不再预热
    expect(at(draw({ t: DEVICE.line + 40 }), 0, 0)[3]).toBe(0);
  });

  it("releaseDeviceLanding 放掉 UI 线程上那份画具，下次重新建", () => {
    draw({ t: 2400 });
    const g = globalThis as unknown as { __splashDial?: unknown };
    expect(g.__splashDial).toBeDefined();
    releaseDeviceLanding();
    expect(g.__splashDial).toBeUndefined();
  });
});
