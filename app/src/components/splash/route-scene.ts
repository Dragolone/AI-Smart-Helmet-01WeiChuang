// 开屏动画前半段：贴着路面出发的骑行路线随镜头升起，轨迹凝聚成公司商标（三种收尾共用）。
//
// 画面是按「故事时间」（毫秒）算出来的一帧：drawRouteScene(Skia, canvas, state, tables, t, H)。
// 同一份代码在两处跑：App 里是 UI 线程上的 worklet，每帧录成一张 Picture；电脑上用同一套 Skia 接口
// （CanvasKit）出图，和设计原型逐帧对比（scripts/splash-frames.ts）。所以这里不依赖 React，也不碰 DOM。
//
// 做法照设计原型（route-converge-splash），为手机上的解释执行做了两处改动：
//   1. 每个采样点的世界坐标对「车道收拢进度」是线性的，开头一次算好系数，逐帧只做相机变换；
//   2. 离镜头远的路段隔两点取一个采样。
// 坐标：屏幕宽固定按 282 个单位算（商标 196 宽），高度 H 随屏幕比例变；画面以屏幕中心为准，
// 所以不同比例的屏幕看到的是同一幅画，只是上下露出多少不同。
import type {
  SkCanvas,
  SkColor,
  SkPaint,
  SkPath,
  SkPathBuilder,
  SkPicture,
  SkPictureRecorder,
  SkShader,
} from "@shopify/react-native-skia";

import {
  ONE_ROUTE,
  POLY_BAR,
  POLY_GREEN,
  POLY_ZERO,
  ROUTE_CAM,
  ROUTE_DS,
  ROUTE_SPLIT,
  ZERO_ROUTE,
} from "./route-data";

/** App 里从包根引入的那个 Skia 接口对象的类型 */
export type SkiaApi = typeof import("@shopify/react-native-skia").Skia;

/** 屏幕宽度按多少个单位算 */
export const SCENE_W = 282;
/** 商标在画面里的边长（单位同上），中心在屏幕中心上方 MARK_LIFT 处 */
export const MARK_SIZE = 196;
export const MARK_LIFT = 29;
export const SCENE_BG = "#0E0F12";

/** 故事时间上的几个节点（毫秒） */
export const SCENE_T = {
  /** 车道收拢到商标轮廓上 */
  converge: [430, 1180] as const,
  /** 白色轮廓线鼓起来、融成实心的「0」和竖条 */
  fuse: [1190, 1500] as const,
  /** 换成原图（边缘逐像素一致） */
  raster: [1470, 1570] as const,
  /** 到这一刻之后不再画线 */
  linesOff: 1560,
  /** 商标完成 */
  markDone: 1600,
};

// Skia 的枚举值（scripts 里脱离 React Native 跑时没法从包根引入；数值由单测对着包里的枚举核对）
const BLEND_SRC_OVER = 3;
const BLEND_PLUS = 12;
const STYLE_STROKE = 1;
const JOIN_ROUND = 1;
const TILE_CLAMP = 0;
const TILE_DECAL = 3;
const CLIP_INTERSECT = 1;
export const SKIA_ENUMS_USED = {
  BLEND_SRC_OVER,
  BLEND_PLUS,
  STYLE_STROKE,
  JOIN_ROUND,
  TILE_CLAMP,
  TILE_DECAL,
  CLIP_INTERSECT,
};

// ---------------------------------------------------------------- 缓动
export function clamp01(v: number): number {
  "worklet";
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
export function lerp(a: number, b: number, t: number): number {
  "worklet";
  return a + (b - a) * t;
}
export function smooth(v: number): number {
  "worklet";
  const p = v < 0 ? 0 : v > 1 ? 1 : v;
  return p * p * (3 - 2 * p);
}
export function smoother(v: number): number {
  "worklet";
  const p = v < 0 ? 0 : v > 1 ? 1 : v;
  return p * p * p * (p * (p * 6 - 15) + 10);
}
export function easeOut(v: number): number {
  "worklet";
  const p = v < 0 ? 0 : v > 1 ? 1 : v;
  return 1 - (1 - p) * (1 - p) * (1 - p);
}

/**
 * 交给 worklet 的数值表一律是 Float64Array，不用普通数组：普通数组捕获进 worklet 时每个数都要单独
 * 序列化一次（这张表加起来约 4 万个，开屏时在 JS 线程上同步做完，中端安卓上上百毫秒），
 * 类型化数组是整块拷过去。仍是 64 位浮点，数值与普通数组时完全一样；worklet 里对它们只读下标和 length。
 * 每张表各自一块刚好大小的缓冲区（worklet 序列化类型化数组时拷的是整块 buffer，不能让几张表共用一块）。
 */
const pack = (a: readonly number[]): Float64Array => Float64Array.from(a);

/** 过各关键点的单调三次曲线：速度连续，两个关键点之间不会回头 */
type Curve = {
  xs: Float64Array;
  ys: Float64Array;
  hs: Float64Array;
  ms: Float64Array;
};
function makeCurve(keys: number[][]): Curve {
  const n = keys.length;
  const xs = keys.map((k) => k[0]);
  const ys = keys.map((k) => k[1]);
  const hs: number[] = [];
  const d: number[] = [];
  const ms: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) {
    hs[i] = xs[i + 1] - xs[i];
    d[i] = (ys[i + 1] - ys[i]) / hs[i];
  }
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] > 0) {
      const w1 = 2 * hs[i] + hs[i - 1];
      const w2 = hs[i] + 2 * hs[i - 1];
      ms[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return { xs: pack(xs), ys: pack(ys), hs: pack(hs), ms: pack(ms) };
}
function evalCurve(c: Curve, x: number): number {
  "worklet";
  const n = c.xs.length;
  if (x <= c.xs[0]) return c.ys[0];
  if (x >= c.xs[n - 1]) return c.ys[n - 1];
  let i = 0;
  while (x > c.xs[i + 1]) i++;
  const h = c.hs[i];
  const t = (x - c.xs[i]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * c.ys[i] +
    (t3 - 2 * t2 + t) * h * c.ms[i] +
    (-2 * t3 + 3 * t2) * c.ys[i + 1] +
    (t3 - t2) * h * c.ms[i + 1]
  );
}

// ---------------------------------------------------------------- 镜头与世界
// 世界：U 向右、V 向上（商标正着看的方向），N 是离路面的高度；一个商标单位 = 一个世界单位。
// 最后一个机位正对着往下看，所以从那里看到的路线就是商标本身，比例一致。
const FOCAL = 300;
const SCALE = MARK_SIZE / 600;
const HC = FOCAL / SCALE;
const BY = -MARK_LIFT / SCALE;
const CAM_SIDE = 26;
const CAM_HEIGHT = 52;
const NEAR = 9;
const DOF = 2200;
const FAR_SOFT = 0.45;
const DS = ROUTE_DS;
const S_CAM = ROUTE_CAM * DS;
// 领头的光走过的路程：起步快，随后稳在匀速
const FLOW = 2.5;
const BURST = 0.9;
const BURST_TAU = 160;
export function frontAt(t: number): number {
  "worklet";
  return (
    S_CAM - 60 + FLOW * t + BURST * BURST_TAU * (1 - Math.exp(-t / BURST_TAU))
  );
}

const I_A = ZERO_ROUTE.marks.A;
const I_CUT = ZERO_ROUTE.marks.ext;
const I_B = ONE_ROUTE.marks.B;
const I_TIP = ONE_ROUTE.marks.out;
const I_DOCK = ONE_ROUTE.marks.dock;
const I_DOCK_END = ONE_ROUTE.marks.cut;
const SP_ROAD = 50;
const SP_LOGO = 24;
const T_GREEN = 760;

type LaneDef = {
  route: 0 | 1;
  r?: number;
  beta?: number;
  dock?: number;
  merge?: [number, number];
  base: number;
  lead: number;
  tail: number;
  nodes: number[][];
  roadOnly?: boolean;
  main?: boolean;
  lead1?: boolean;
};
// lead：这条线的光比所在路线的光超前多少。nodes：[落后那束光多远, 大小]。
// 路线 0（骑行的那条路）——r：横向位置，按车道间距算（负数在环的外侧）；beta：收拢后落在「0」的哪条轮廓上
//   （0 外轮廓，1 内轮廓）。roadOnly 的线只属于路：并进同 beta 的那条线，到「0」的尾巴之前就没了。
// 路线 1（从左上进来的线）——领头线走路线自己的中线；dock 的线从它下面进来，最后落在「0」的顶上。
const LANES: LaneDef[] = [
  {
    route: 0,
    r: -3.3,
    beta: 0,
    base: 0.3,
    lead: -180,
    tail: 130,
    nodes: [
      [-110, 3.0],
      [-680, 2.6],
    ],
    roadOnly: true,
  },
  {
    route: 0,
    r: -2.5,
    beta: 0,
    base: 0.4,
    lead: 70,
    tail: 130,
    nodes: [
      [-300, 3.2],
      [-940, 2.8],
    ],
    roadOnly: true,
  },
  {
    route: 0,
    r: -1.7,
    beta: 0,
    base: 0.58,
    lead: 30,
    tail: 130,
    nodes: [
      [-200, 3.4],
      [-760, 2.9],
    ],
  },
  {
    route: 0,
    r: -0.9,
    beta: 0,
    base: 0.5,
    lead: -85,
    tail: 130,
    nodes: [
      [-50, 3.4],
      [-560, 2.9],
      [-1120, 2.6],
    ],
    roadOnly: true,
  },
  {
    route: 0,
    r: 0.0,
    beta: 2 / 3,
    base: 1.0,
    lead: 0,
    tail: 500,
    nodes: [
      [0, 5.8],
      [-210, 4.4],
      [-490, 3.9],
      [-840, 3.5],
      [-1250, 3.2],
    ],
    main: true,
  },
  {
    route: 0,
    r: 1.0,
    beta: 1,
    base: 0.58,
    lead: 110,
    tail: 130,
    nodes: [
      [-240, 3.4],
      [-780, 2.9],
    ],
  },
  {
    route: 0,
    r: 1.8,
    beta: 1,
    base: 0.4,
    lead: -240,
    tail: 130,
    nodes: [[-460, 2.9]],
    roadOnly: true,
  },
  {
    route: 1,
    beta: 0,
    base: 0.62,
    lead: 0,
    tail: 300,
    nodes: [
      [0, 4.8],
      [-320, 3.6],
      [-780, 3.0],
    ],
    lead1: true,
  },
  { route: 1, dock: 0, base: 0.5, lead: -70, tail: 130, nodes: [[-150, 3.2]] },
  {
    route: 1,
    dock: 68,
    merge: [-125, 100],
    base: 0.34,
    lead: 60,
    tail: 130,
    nodes: [],
  },
];
const LANE_EDGE_ZERO_OUT = 2;
const LANE_EDGE_ZERO_IN = 5;
const LANE_MAIN = 4;
const LANE_LEAD = 7;

/** 画线的样式：w 路面上的宽度，wmin 屏幕上最细多少，gain 亮度；spill 是洒在路面上的光，hot 是亮芯 */
type LineStyle = {
  w: number;
  wmin: number;
  gain: number;
  spill?: boolean;
  hot?: boolean;
};
const STYLE_WHITE: LineStyle[] = [{ w: 1.3, wmin: 0.85, gain: 1 }];
const STYLE_MAIN: LineStyle[] = [
  { w: 18, wmin: 0, gain: 0.05, spill: true },
  { w: 3.3, wmin: 1.6, gain: 1 },
  { w: 1.2, wmin: 0.7, gain: 0.6, hot: true },
];
const STYLE_LEAD: LineStyle[] = [
  { w: 2.2, wmin: 1.2, gain: 1 },
  { w: 0.9, wmin: 0.6, gain: 0.45, hot: true },
];

// ---------------------------------------------------------------- 开头一次算好的表
type RouteTable = {
  /** 用到的采样点在原始路线里的序号 */
  idx: Float64Array;
  /** 抬升之后的基准点和法线方向（法线没有高度分量） */
  bx: Float64Array;
  by: Float64Array;
  bz: Float64Array;
  nx: Float64Array;
  ny: Float64Array;
  conv: Float64Array;
};
type LaneTable = {
  /** 横向偏移 = offA + 收拢进度 × offB */
  offA: Float64Array;
  offB: Float64Array;
  /** 沿这条线自己量的路程 = ll0 + 收拢进度 × dll */
  ll0: Float64Array;
  dll: Float64Array;
  /** 亮度里不随时间变的那部分 */
  fS: Float64Array;
  /** 路线 1：从路面上看不见、镜头升起才进入视野的程度（1 = 一直看得见） */
  sB: Float64Array;
  /** 这条线在这一点有多绿（只有路线 1 的领头线用） */
  gS: Float64Array;
};
export type SceneTables = {
  routes: [RouteTable, RouteTable];
  lanes: LaneTable[];
  /** 路线 1 另一条轮廓（「1」的左边和勾的内侧），只用来铺面 */
  oneInnerOff: Float64Array;
  ride: Curve;
  camRise: Curve;
  oa: [number, number, number];
  ob: [number, number, number];
  frontOne: number;
  /** 商标三块的轮廓：抬升之后的点 */
  poly: { x: Float64Array; y: Float64Array; z: Float64Array }[];
  /** 商标三块在最终画面里的轮廓（以商标中心为原点，单位同屏幕） */
  flat: Float64Array[];
  /** 路线 0 全分辨率的中线，镜头沿它走 */
  camX: Float64Array;
  camY: Float64Array;
  camNx: Float64Array;
  camNy: Float64Array;
  camAlt: Float64Array;
};

function liftK(alt: number): number {
  return 1 - alt / HC;
}

/** 开头算一次（在 JS 线程上，约一两毫秒）。返回的数值表都是只读的 Float64Array，可以直接被 worklet 捕获。 */
export function buildSceneTables(): SceneTables {
  const Z = ZERO_ROUTE;
  const O = ONE_ROUTE;
  const zn = Z.n;
  const on = O.n;
  // 路线 0：车道间距、允许收拢的程度、两端淡出
  const zSp: number[] = [];
  const zConv: number[] = [];
  const zEdge: number[] = [];
  for (let i = 0; i < zn; i++) {
    zSp[i] = lerp(SP_ROAD, SP_LOGO, smooth((i - (I_A - 330)) / 150));
    zConv[i] = smooth((i - (I_A - 150)) / 125);
    zEdge[i] = smooth(i / 40) * (1 - smooth((i - (I_CUT - 4)) / 6));
  }
  const oEdge: number[] = [];
  for (let i = 0; i < on; i++) {
    oEdge[i] = smooth(i / 40) * (1 - smooth((i - I_TIP) / (on - 1 - I_TIP)));
  }

  // 采样：镜头贴着路面骑过的那一段逐点取，其余隔两点取一个；几个关键位置一定取到
  const pick = (n: number, dense: [number, number] | null, must: number[]) => {
    const set = new Set<number>([0, n - 1, ...must]);
    for (let i = 0; i < n; i++) {
      if (dense && i >= dense[0] && i <= dense[1]) set.add(i);
      else if (i % 3 === 0) set.add(i);
    }
    return Array.from(set).sort((a, b) => a - b);
  };
  const zIdx = pick(zn, [60, 340], [I_A, I_A - 46, I_CUT, ROUTE_CAM]);
  const oIdx = pick(on, null, [I_B, I_TIP, I_DOCK, I_DOCK_END]);

  type RouteGeometry = {
    x: number[];
    y: number[];
    nx: number[];
    ny: number[];
    alt: number[];
  };
  const routeTable = (
    R: RouteGeometry,
    idx: number[],
    conv: number[] | null,
  ): RouteTable => {
    const bx: number[] = [];
    const by: number[] = [];
    const bz: number[] = [];
    const nx: number[] = [];
    const ny: number[] = [];
    const cv: number[] = [];
    for (const i of idx) {
      const k = liftK(R.alt[i]);
      bx.push((R.x[i] - 300) * k);
      by.push(BY * (1 - k) + (300 - R.y[i]) * k);
      bz.push(R.alt[i]);
      nx.push(R.nx[i] * k);
      ny.push(-R.ny[i] * k);
      cv.push(conv ? conv[i] : 0);
    }
    return {
      idx: pack(idx),
      bx: pack(bx),
      by: pack(by),
      bz: pack(bz),
      nx: pack(nx),
      ny: pack(ny),
      conv: pack(cv),
    };
  };
  const routes: [RouteTable, RouteTable] = [
    routeTable(Z, zIdx, zConv),
    routeTable(O, oIdx, null),
  ];

  // 每条线：横向偏移的两个系数、沿线路程、不随时间变的亮度
  const offFull = (lane: LaneDef, i: number, convT: number): number => {
    if (lane.route === 1) {
      if (lane.dock === undefined) return (lane.beta ?? 0) * O.wi[i];
      const m = lane.merge;
      return (
        O.dz[i] +
        (lane.dock && m
          ? lane.dock * (1 - smooth((i - (I_DOCK + m[0])) / m[1]))
          : 0)
      );
    }
    const c = zConv[i] * convT;
    return (
      (1 - c) * (lane.r ?? 0) * zSp[i] +
      c * (-Z.wo[i] + (lane.beta ?? 0) * (Z.wo[i] + Z.wi[i]))
    );
  };
  const lengthAt = (lane: LaneDef, convT: number): number[] => {
    const R = lane.route === 1 ? O : Z;
    const out: number[] = [];
    let px = 0;
    let py = 0;
    for (let i = 0; i < R.n; i++) {
      const off = offFull(lane, i, convT);
      const x = R.x[i] + R.nx[i] * off;
      const y = R.y[i] + R.ny[i] * off;
      out[i] = i ? out[i - 1] + Math.hypot(x - px, y - py) : 0;
      px = x;
      py = y;
    }
    // 路线 0 的线在镜头出发处对齐，路线 1 的线在竖条顶上对齐
    const ref = lane.route === 1 ? I_B : ROUTE_CAM;
    const shift = ref * DS - out[ref];
    return out.map((v) => v + shift);
  };
  const lanes: LaneTable[] = LANES.map((lane) => {
    const idx = lane.route === 1 ? oIdx : zIdx;
    const l0 = lengthAt(lane, 0);
    const l1 = lane.route === 1 ? l0 : lengthAt(lane, 1);
    const offA: number[] = [];
    const offB: number[] = [];
    const ll0: number[] = [];
    const dll: number[] = [];
    const fS: number[] = [];
    const sB: number[] = [];
    const gS: number[] = [];
    for (const i of idx) {
      const a = offFull(lane, i, 0);
      offA.push(a);
      offB.push(offFull(lane, i, 1) - a);
      ll0.push(l0[i]);
      dll.push(l1[i] - l0[i]);
      if (lane.route === 0) {
        fS.push(zEdge[i] * (lane.roadOnly ? 1 - zConv[i] : 1));
        sB.push(1);
        gS.push(0);
      } else {
        let f = oEdge[i];
        if (lane.dock !== undefined) {
          f *= 1 - smooth((i - (I_DOCK_END - 5)) / 6);
          if (lane.dock > 0 && lane.merge) {
            const m0 = I_DOCK + lane.merge[0];
            const m1 = lane.merge[1];
            f *= 1 - smooth((i - (m0 + 0.55 * m1)) / (0.6 * m1));
          }
        }
        fS.push(f);
        sB.push(smooth((i - (I_B - 120)) / 80));
        gS.push(lane.lead1 ? smooth((i - (I_B - 85)) / 60) : 0);
      }
    }
    return {
      offA: pack(offA),
      offB: pack(offB),
      ll0: pack(ll0),
      dll: pack(dll),
      fS: pack(fS),
      sB: pack(sB),
      gS: pack(gS),
    };
  });
  const oneInnerOff = pack(oIdx.map((i) => O.wi[i]));

  // 镜头：先是骑行的人的视角，贴着路面沿路往前；然后离开路面，绕到环的上方，直到正对着往下看
  const ride = makeCurve([
    [-240, -84],
    [0, 0],
    [260, 96],
    [520, 162],
    [800, 188],
    [1000, 194],
  ]);
  const camRise = makeCurve([
    [0, 0],
    [430, 0],
    [560, 0.045],
    [700, 0.2],
    [850, 0.48],
    [990, 0.76],
    [1120, 0.92],
    [1250, 0.985],
    [1380, 1],
  ]);
  const rideEnd = ridePosition(
    1e4,
    ride,
    Z.x,
    Z.y,
    Z.nx,
    Z.ny,
    Z.alt,
    [0, 0, 0],
  );
  const orbit = (p: number[]): [number, number, number] => {
    const rho = Math.hypot(p[0], p[1], p[2]);
    return [rho, Math.asin(p[2] / rho), Math.atan2(p[0], p[1])];
  };
  const oa = orbit(rideEnd);
  const ob = orbit([0, BY, HC]);
  if (oa[2] < 0) oa[2] += 2 * Math.PI;

  // 荧光那一块先成形：路线 1 的领头光一跨进去就开始鼓起来，时间对在故事时间 760 毫秒
  const s0 = ROUTE_SPLIT[0];
  const s1 = ROUTE_SPLIT[1];
  const splitLen = Math.hypot(s1[0] - s0[0], s1[1] - s0[1]);
  const greenSide = (x: number, y: number) =>
    ((s1[0] - s0[0]) * (y - s0[1]) - (s1[1] - s0[1]) * (x - s0[0])) / splitLen;
  let iSplit = I_B;
  while (iSplit < I_TIP && greenSide(O.x[iSplit], O.y[iSplit]) <= 0) iSplit++;
  const frontOne = iSplit * DS - frontAt(T_GREEN);

  const polys = [POLY_ZERO, POLY_BAR, POLY_GREEN];
  const poly = polys.map((P) => {
    const x: number[] = [];
    const y: number[] = [];
    const z: number[] = [];
    P.p.forEach((pt, k) => {
      const kk = liftK(P.a[k]);
      x.push((pt[0] - 300) * kk);
      y.push(BY * (1 - kk) + (300 - pt[1]) * kk);
      z.push(P.a[k]);
    });
    return { x: pack(x), y: pack(y), z: pack(z) };
  });
  const flat = polys.map((P) => {
    const out: number[] = [];
    for (const pt of P.p)
      out.push((pt[0] - 300) * SCALE, (pt[1] - 300) * SCALE);
    return pack(out);
  });

  return {
    routes,
    lanes,
    oneInnerOff,
    ride,
    camRise,
    oa,
    ob,
    frontOne,
    poly,
    flat,
    camX: pack(Z.x),
    camY: pack(Z.y),
    camNx: pack(Z.nx),
    camNy: pack(Z.ny),
    camAlt: pack(Z.alt),
  };
}

function ridePosition(
  t: number,
  ride: Curve,
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  nx: ArrayLike<number>,
  ny: ArrayLike<number>,
  alt: ArrayLike<number>,
  o: number[],
): number[] {
  "worklet";
  const fi = (S_CAM + evalCurve(ride, t)) / DS;
  const i = Math.floor(fi);
  const u = fi - i;
  const px = lerp(x[i] - nx[i] * CAM_SIDE, x[i + 1] - nx[i + 1] * CAM_SIDE, u);
  const py = lerp(y[i] - ny[i] * CAM_SIDE, y[i + 1] - ny[i + 1] * CAM_SIDE, u);
  const a = lerp(alt[i], alt[i + 1], u);
  const k = 1 - a / HC;
  o[0] = (px - 300) * k;
  o[1] = BY + (300 - py - BY) * k;
  o[2] = a + CAM_HEIGHT;
  return o;
}

// ---------------------------------------------------------------- 每帧用的状态（在画的那个线程上建一次）
const NCLASS = 7;
/** 虚化多少算一档：第 j 档对应的弥散圆直径是 CLASS_C0 × 2^j（屏幕单位） */
const CLASS_C0 = 2;
/**
 * 模糊的两组参数（屏幕单位）。classSigma：第 j 档的线先画成一条带子，再整层做这么大的高斯模糊；
 * bloom：整幅光的泛光，几层高斯加在一起，每层 [模糊半径, 强度]。数值是对着设计原型的画面调出来的
 * （原型用的是逐级缩小再放大的模糊链，这里换成等效的高斯）。scripts/splash-frames.ts 可以临时改这两组来试。
 */
export const SCENE_TUNING = {
  classSigma: [0, 0.8, 1.6, 3.2, 6.4, 12.8, 25.6],
  bloom: [
    [1.0, 0.8],
    [3.5, 0.85],
    [12, 0.9],
  ],
};
/** 线的亮度分多少级（按开方分，暗处分得细） */
const ALPHA_STEPS = 20;
/** 屏幕上相邻两点至少隔这么远（平方，屏幕单位）才各算一个点 */
const THIN_D2 = 6.5;
const BED_STEPS = 400;
const BED_ALPHA = 0.06;
const GHOST = 0.13;
const TINT_STEPS = 12;
const WHITE = [238, 243, 255];
const GREEN = [190, 255, 46];
const HOT = [240, 255, 190];
const MAX_PTS = 1024;

export type SceneState = {
  H: number;
  // 当前这条线：相机空间里的点、亮度、绿的程度、沿线路程
  cX: Float32Array;
  cY: Float32Array;
  cZ: Float32Array;
  vI: Float32Array;
  vG: Float32Array;
  /** 每一点的明暗（不含沿线的流光），发光的小点用 */
  vF: Float32Array;
  LL: Float32Array;
  laneN: number;
  // 这一帧每条路线的基准点和法线在相机空间里的样子
  rb: Float32Array[];
  // 一段连续可见的线：屏幕坐标、每单位多少像素、亮度、绿、弥散圆、法线
  eX: Float32Array;
  eY: Float32Array;
  eP: Float32Array;
  eI: Float32Array;
  eG: Float32Array;
  eC: Float32Array;
  eNx: Float32Array;
  eNy: Float32Array;
  eN: number;
  tG: Float32Array;
  tC: Float32Array;
  qA: Float32Array;
  qL: Float32Array;
  qCol: Int32Array;
  // 铺面用：两条边线的屏幕坐标和深度
  bOx: Float32Array;
  bOy: Float32Array;
  bOz: Float32Array;
  bIx: Float32Array;
  bIy: Float32Array;
  bIz: Float32Array;
  llLead: Float32Array;
  // 镜头
  P: number[];
  r: number[];
  u: number[];
  f: number[];
  focus: number;
  rise: number;
  convT: number;
  front: number;
  t: number;
  // Skia 对象
  recs: SkPictureRecorder[];
  fillRec: SkPictureRecorder;
  flatPaths: SkPath[];
  /** 三块形状合起来占多大（以商标中心为原点） */
  flatBounds: { x: number; y: number; width: number; height: number };
  pulseColor: SkColor;
  cvs: SkCanvas[];
  used: boolean[];
  pics: (SkPicture | null)[];
  pb: SkPathBuilder;
  linePaint: SkPaint;
  /** 画等宽的线用：描边 */
  widePaint: SkPaint;
  nodePaint: SkPaint;
  strokePaint: SkPaint;
  fillPaint: SkPaint;
  blurPaints: SkPaint[];
  /** 整幅光：原样加上它的泛光 */
  linesPaint: SkPaint;
  /** 只要泛光（商标实心部分周围的光） */
  glowPaint: SkPaint;
  layerPaint: SkPaint;
  tints: SkColor[];
  bedColor: SkColor;
  fillWhite: SkColor;
  fillGreen: SkColor;
  haloShaders: (SkShader | null)[];
  coreShaders: (SkShader | null)[];
  bounds: ReturnType<SkiaApi["XYWHRect"]>;
};

export function makeSceneState(
  Skia: SkiaApi,
  tb: SceneTables,
  H: number,
): SceneState {
  "worklet";
  const f = (n: number) => new Float32Array(n);
  const tints: SkColor[] = [];
  for (let hot = 0; hot < 2; hot++) {
    const a = hot ? HOT : GREEN;
    for (let q = 0; q <= TINT_STEPS; q++) {
      const u = q / TINT_STEPS;
      tints.push(
        Skia.Color(
          `rgb(${Math.round(lerp(WHITE[0], a[0], u))},${Math.round(lerp(WHITE[1], a[1], u))},${Math.round(lerp(WHITE[2], a[2], u))})`,
        ),
      );
    }
  }
  const plus = () => {
    const p = Skia.Paint();
    p.setAntiAlias(true);
    p.setBlendMode(BLEND_PLUS);
    return p;
  };
  const widePaint = plus();
  widePaint.setStyle(STYLE_STROKE);
  widePaint.setStrokeJoin(JOIN_ROUND);
  const strokePaint = plus();
  strokePaint.setStyle(STYLE_STROKE);
  strokePaint.setStrokeWidth(0.9);
  strokePaint.setStrokeJoin(JOIN_ROUND);
  const blurPaints: SkPaint[] = [];
  for (let j = 0; j < NCLASS; j++) {
    const p = Skia.Paint();
    p.setBlendMode(BLEND_PLUS);
    const sigma = SCENE_TUNING.classSigma[j];
    if (j > 0)
      p.setImageFilter(
        Skia.ImageFilter.MakeBlur(sigma, sigma, TILE_DECAL, null),
      );
    blurPaints.push(p);
  }
  // 泛光 = 几层高斯按强度相加（同一张输入只渲染一次，滤镜图里分出几路去模糊）。
  // 只用 Blur / ColorFilter / Blend 这三种滤镜：电脑上出图用的那套 Skia 没有实现别的。
  // 调强度用「只缩放透明度」的颜色矩阵：颜色是预乘的，缩放透明度就是把这一路光整体调暗。
  type Filter = ReturnType<SkiaApi["ImageFilter"]["MakeBlur"]>;
  let bloom: Filter | null = null;
  for (let b = SCENE_TUNING.bloom.length - 1; b >= 0; b--) {
    const sigma = SCENE_TUNING.bloom[b][0];
    const gain = SCENE_TUNING.bloom[b][1];
    const dim = Skia.ColorFilter.MakeMatrix([
      1,
      0,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      0,
      gain,
      0,
    ]);
    const one: Filter = Skia.ImageFilter.MakeColorFilter(
      dim,
      Skia.ImageFilter.MakeBlur(sigma, sigma, TILE_DECAL, null),
    );
    bloom = bloom ? Skia.ImageFilter.MakeBlend(BLEND_PLUS, bloom, one) : one;
  }
  const linesPaint = Skia.Paint();
  linesPaint.setBlendMode(BLEND_PLUS);
  if (bloom)
    linesPaint.setImageFilter(
      Skia.ImageFilter.MakeBlend(BLEND_PLUS, bloom, null),
    );
  const glowPaint = Skia.Paint();
  glowPaint.setBlendMode(BLEND_PLUS);
  if (bloom) glowPaint.setImageFilter(bloom);
  const fillPaint = Skia.Paint();
  fillPaint.setAntiAlias(true);
  const layerPaint = Skia.Paint();
  const recs: SkPictureRecorder[] = [];
  for (let j = 0; j < NCLASS; j++) recs.push(Skia.PictureRecorder());
  const builder = Skia.PathBuilder.Make();
  const flatPaths: SkPath[] = [];
  let fx0 = Infinity;
  let fy0 = Infinity;
  let fx1 = -Infinity;
  let fy1 = -Infinity;
  for (let w = 0; w < 3; w++) {
    const pts = tb.flat[w];
    builder.moveTo(pts[0], pts[1]);
    for (let k = 2; k < pts.length; k += 2) builder.lineTo(pts[k], pts[k + 1]);
    builder.close();
    flatPaths.push(builder.detach());
    for (let k = 0; k < pts.length; k += 2) {
      fx0 = Math.min(fx0, pts[k]);
      fx1 = Math.max(fx1, pts[k]);
      fy0 = Math.min(fy0, pts[k + 1]);
      fy1 = Math.max(fy1, pts[k + 1]);
    }
  }
  const flatBounds = { x: fx0, y: fy0, width: fx1 - fx0, height: fy1 - fy0 };
  return {
    H,
    cX: f(MAX_PTS),
    cY: f(MAX_PTS),
    cZ: f(MAX_PTS),
    vI: f(MAX_PTS),
    vG: f(MAX_PTS),
    vF: f(MAX_PTS),
    LL: f(MAX_PTS),
    laneN: 0,
    rb: [f(MAX_PTS * 6), f(MAX_PTS * 6)],
    eX: f(MAX_PTS + 8),
    eY: f(MAX_PTS + 8),
    eP: f(MAX_PTS + 8),
    eI: f(MAX_PTS + 8),
    eG: f(MAX_PTS + 8),
    eC: f(MAX_PTS + 8),
    eNx: f(MAX_PTS + 8),
    eNy: f(MAX_PTS + 8),
    eN: 0,
    tG: f(MAX_PTS + 8),
    tC: f(MAX_PTS + 8),
    qA: f(MAX_PTS + 8),
    qL: f(MAX_PTS + 8),
    qCol: new Int32Array(MAX_PTS + 8),
    bOx: f(MAX_PTS),
    bOy: f(MAX_PTS),
    bOz: f(MAX_PTS),
    bIx: f(MAX_PTS),
    bIy: f(MAX_PTS),
    bIz: f(MAX_PTS),
    llLead: f(MAX_PTS),
    P: [0, 0, 0],
    r: [0, 0, 0],
    u: [0, 0, 0],
    f: [0, 0, 0],
    focus: 300,
    rise: 0,
    convT: 0,
    front: 0,
    t: 0,
    recs,
    fillRec: Skia.PictureRecorder(),
    flatPaths,
    flatBounds,
    pulseColor: Skia.Color("rgb(205,238,96)"),
    cvs: [],
    used: [false, false, false, false, false, false, false],
    pics: [null, null, null, null, null, null, null],
    pb: builder,
    linePaint: plus(),
    widePaint,
    nodePaint: plus(),
    strokePaint,
    fillPaint,
    blurPaints,
    linesPaint,
    glowPaint,
    layerPaint,
    tints,
    bedColor: Skia.Color("rgb(226,236,214)"),
    fillWhite: Skia.Color("rgb(243,245,247)"),
    fillGreen: Skia.Color("rgb(212,241,63)"),
    haloShaders: [],
    coreShaders: [],
    bounds: Skia.XYWHRect(0, 0, SCENE_W, H),
  };
}

// ---------------------------------------------------------------- 一帧
function setCamera(S: SceneState, tb: SceneTables, t: number): void {
  "worklet";
  const p = evalCurve(tb.camRise, t);
  const eps = lerp(tb.oa[1], tb.ob[1], p);
  const az = lerp(tb.oa[2], tb.ob[2], p);
  const rho = lerp(tb.oa[0], tb.ob[0], p);
  const ce = Math.cos(eps);
  const w = smoother((t - 380) / 400);
  const rp = ridePosition(
    t,
    tb.ride,
    tb.camX,
    tb.camY,
    tb.camNx,
    tb.camNy,
    tb.camAlt,
    S.P,
  );
  const px = lerp(rp[0], rho * ce * Math.sin(az), w);
  const py = lerp(rp[1], rho * ce * Math.cos(az), w);
  const pz = lerp(rp[2], rho * Math.sin(eps), w);
  S.P[0] = px;
  S.P[1] = py;
  S.P[2] = pz;
  let psi = 0;
  let th = -Math.PI / 2;
  if (p < 1) {
    // 让商标中心钉在它在屏幕上的位置：环就地展开。位置按离屏幕中心的偏移给，所以和屏幕高度无关
    const a = (lerp(138, SCENE_W / 2, p) - SCENE_W / 2) / FOCAL;
    const b = lerp(26.5, MARK_LIFT, p) / FOCAL;
    const d0 = -px;
    const d1 = -py;
    const d2 = -pz;
    const len = Math.hypot(d0, d1, d2);
    const xp = (a * len) / Math.sqrt(1 + a * a + b * b);
    const yp = Math.sqrt(Math.max(0, d0 * d0 + d1 * d1 - xp * xp));
    psi = Math.atan2(d0, d1) - Math.atan2(xp, yp);
    th = Math.atan2(d2, yp) - Math.atan(b);
  }
  const cs = Math.cos(psi);
  const sn = Math.sin(psi);
  const ct = Math.cos(th);
  const st = Math.sin(th);
  S.r[0] = cs;
  S.r[1] = -sn;
  S.r[2] = 0;
  S.u[0] = -sn * st;
  S.u[1] = -cs * st;
  S.u[2] = ct;
  S.f[0] = sn * ct;
  S.f[1] = cs * ct;
  S.f[2] = st;
  // 浅景深：开头焦点在第一个弯附近，镜头升起时移到商标上
  const rack = smoother((t - 420) / 520);
  S.focus = lerp(
    lerp(300, 400, clamp01(t / 450)),
    Math.hypot(px, py, pz),
    rack,
  );
  S.rise = p;
}

/** 这一帧两条路线的基准点和法线各自变到相机空间里（每条线再用自己的偏移去合成） */
function projectRoutes(S: SceneState, tb: SceneTables): void {
  "worklet";
  const r0 = S.r[0];
  const r1 = S.r[1];
  const u0 = S.u[0];
  const u1 = S.u[1];
  const u2 = S.u[2];
  const f0 = S.f[0];
  const f1 = S.f[1];
  const f2 = S.f[2];
  const px = S.P[0];
  const py = S.P[1];
  const pz = S.P[2];
  for (let k = 0; k < 2; k++) {
    const R = tb.routes[k];
    const o = S.rb[k];
    const n = R.idx.length;
    for (let j = 0; j < n; j++) {
      const dx = R.bx[j] - px;
      const dy = R.by[j] - py;
      const dz = R.bz[j] - pz;
      const q = j * 6;
      o[q] = r0 * dx + r1 * dy;
      o[q + 1] = u0 * dx + u1 * dy + u2 * dz;
      o[q + 2] = f0 * dx + f1 * dy + f2 * dz;
      const nx = R.nx[j];
      const ny = R.ny[j];
      o[q + 3] = r0 * nx + r1 * ny;
      o[q + 4] = u0 * nx + u1 * ny;
      o[q + 5] = f0 * nx + f1 * ny;
    }
  }
}

function drainTo(t: number, into: number): number {
  "worklet";
  return lerp(-60, into + 12, smoother((t - 960) / 400));
}

/** 这条线在这一帧的样子：相机空间里的点、沿线路程、每一点的亮度 */
function layoutLane(
  S: SceneState,
  tb: SceneTables,
  li: number,
  withLight: boolean,
): void {
  "worklet";
  const lane = LANES[li];
  const L = tb.lanes[li];
  const R = tb.routes[lane.route];
  const o = S.rb[lane.route];
  const n = R.idx.length;
  const convT = S.convT;
  const t = S.t;
  S.laneN = n;
  const sf = S.front + (lane.route === 1 ? tb.frontOne : 0) + lane.lead;
  const pre = 0.12 * smooth(t / 110);
  const base = lane.base;
  const tail = lane.tail;
  const fuseOut = 1 - smooth((t - 1330) / 210);
  const riseVis = smooth((S.rise - 0.01) / 0.14);
  const isZero = lane.route === 0;
  const isDock = lane.dock !== undefined;
  const drain = drainTo(t, isZero ? I_A : isDock ? I_DOCK_END : I_B);
  const greenMain = lane.main ? 1 - smooth((t - SCENE_T.fuse[0]) / 220) : 0;
  for (let j = 0; j < n; j++) {
    const off = L.offA[j] + convT * L.offB[j];
    const q = j * 6;
    S.cX[j] = o[q] + off * o[q + 3];
    S.cY[j] = o[q + 1] + off * o[q + 4];
    S.cZ[j] = o[q + 2] + off * o[q + 5];
    const ll = L.ll0[j] + convT * L.dll[j];
    S.LL[j] = ll;
    if (!withLight) continue;
    const behind = sf - ll;
    let e = base * pre;
    if (behind > 0) {
      const lit = smooth(behind / 70);
      e =
        base * (pre + (1 - pre) * lit) + lit * 0.85 * Math.exp(-behind / tail);
    }
    // 全都往前流进商标里，远端先走；商标自己的线最后化进实心里
    const i = R.idx[j];
    let fd = L.fS[j];
    if (isZero) {
      fd *= i < I_A ? smooth((i - drain) / 60) : fuseOut;
    } else {
      // 贴着路面时远处的线在视线之外，镜头升起来才进入视野
      fd *= lerp(riseVis, 1, L.sB[j]);
      if (isDock) fd *= smooth((i - drain) / 60);
      else if (i < I_B) fd *= smooth((i - drain) / 60);
      else if (i > I_TIP) fd *= 1 - convT;
      else fd *= fuseOut;
    }
    S.vF[j] = fd;
    S.vI[j] = e * fd;
    S.vG[j] = isZero ? greenMain : L.gS[j];
  }
}

function cocAt(S: SceneState, z: number): number {
  "worklet";
  const v = 1 / z - 1 / S.focus;
  const c = DOF * (v > 0 ? v : -v * FAR_SOFT);
  return c > 46 ? 46 : c;
}

function emit(
  S: SceneState,
  xc: number,
  yc: number,
  zc: number,
  I: number,
  G: number,
): void {
  "worklet";
  const p = FOCAL / zc;
  const sx = SCENE_W / 2 + xc * p;
  const sy = S.H / 2 - yc * p;
  const n = S.eN;
  if (n > 0) {
    const dx = sx - S.eX[n - 1];
    const dy = sy - S.eY[n - 1];
    const dI = I - S.eI[n - 1];
    if (dx * dx + dy * dy < THIN_D2 && dI < 0.05 && dI > -0.05) return;
  }
  S.eX[n] = sx;
  S.eY[n] = sy;
  S.eP[n] = p;
  S.eI[n] = I;
  S.eG[n] = G;
  S.eC[n] = cocAt(S, zc);
  S.eN = n + 1;
}

/**
 * 一段线画成一条宽度随透视变化的带子。每一小段的光分给和它的虚化最接近的两档，所以焦点沿线是连续变化的。
 *
 * 手机上每调一次 Skia 都有固定开销，一帧里最贵的就是这里的逐点调用，所以尽量少调：
 *   - 亮度按感知（开方）分成 ALPHA_STEPS 级、两档之间的分配分成 3 级，亮度 / 颜色 / 分配都相同的相邻小段
 *     合成一块，只建一次路径，两档各画一遍；
 *   - 宽度基本不变的一块（镜头升起来之后几乎都是）画成一条有宽度的折线，点数是带子的一半；
 *     宽度沿线变得快的（贴着路面、离镜头近的那几段）才画成带子。
 */
function strokeRun(S: SceneState, st: LineStyle): void {
  "worklet";
  const n = S.eN;
  for (let k = 0; k < n; k++) {
    const h = 0.5 * Math.hypot(st.w * S.eP[k], st.wmin);
    let c = S.eC[k];
    if (st.spill) c = Math.min(64, Math.max(c, 10 * h));
    // 失焦的线画成约 0.7 个弥散圆宽的带子，边缘交给那一档的模糊去柔化
    S.tG[k] = Math.max(h, 0.35 * c);
    S.tC[k] = c;
    S.qL[k] = h;
  }
  const hotBase = st.hot ? TINT_STEPS + 1 : 0;
  const key = S.qCol;
  for (let k = 0; k < n - 1; k++) {
    const I = (S.eI[k] + S.eI[k + 1]) * 0.5 * st.gain;
    const h = S.qL[k] + S.qL[k + 1];
    const g = S.tG[k] + S.tG[k + 1];
    const c = (S.tC[k] + S.tC[k + 1]) * 0.5;
    // 比镜头分辨得出的还细的线，变暗而不是变细；失焦把光摊开
    const thin =
      st.wmin > 0
        ? Math.min(
            1,
            Math.sqrt((st.w * (S.eP[k] + S.eP[k + 1]) * 0.5) / st.wmin),
          )
        : 1;
    const a =
      I < 0.002 ? 0 : I * thin * Math.sqrt(h / (h + c)) * Math.sqrt(h / g);
    const lvl = a <= 0 ? 0 : Math.round(Math.sqrt(a > 1 ? 1 : a) * ALPHA_STEPS);
    if (lvl === 0) {
      key[k] = 0;
      continue;
    }
    let cls = Math.log2(Math.max(1, c / CLASS_C0));
    if (cls > NCLASS - 1) cls = NCLASS - 1;
    const lo = Math.floor(cls);
    const share = lo >= NCLASS - 1 ? 0 : Math.round((cls - lo) * 3);
    const col =
      hotBase + Math.round(clamp01((S.eG[k] + S.eG[k + 1]) * 0.5) * TINT_STEPS);
    // 宽度沿这一小段变得慢：可以当成等宽的线来画，宽度按 20% 一级归档
    const steady = g > 0 && Math.abs(S.tG[k + 1] - S.tG[k]) * 2 < 0.06 * g;
    const band = steady ? 1 + Math.round(Math.log(g * 0.5) / 0.18) + 40 : 0;
    key[k] = ((((col * 64 + lvl) * 8 + lo) * 8 + share) * 128 + band) | 0;
  }
  const pb = S.pb;
  let from = 0;
  for (let k = 1; k <= n - 1; k++) {
    if (k < n - 1 && key[k] === key[from]) continue;
    const kk = key[from];
    if (kk !== 0) {
      const band = kk & 127;
      const share = (kk >> 7) & 7;
      const lo = (kk >> 10) & 7;
      const lvl = (kk >> 13) & 63;
      const col = kk >> 19;
      const alpha = (lvl / ALPHA_STEPS) * (lvl / ALPHA_STEPS);
      let paint = S.linePaint;
      if (band > 0) {
        // 等宽：一条折线，按宽度描
        paint = S.widePaint;
        paint.setStrokeWidth(2 * Math.exp((band - 41) * 0.18));
        pb.moveTo(S.eX[from], S.eY[from]);
        for (let m = from + 1; m <= k; m++) pb.lineTo(S.eX[m], S.eY[m]);
      } else {
        pb.moveTo(
          S.eX[from] + S.eNx[from] * S.tG[from],
          S.eY[from] + S.eNy[from] * S.tG[from],
        );
        for (let m = from + 1; m <= k; m++)
          pb.lineTo(S.eX[m] + S.eNx[m] * S.tG[m], S.eY[m] + S.eNy[m] * S.tG[m]);
        for (let m = k; m >= from; m--)
          pb.lineTo(S.eX[m] - S.eNx[m] * S.tG[m], S.eY[m] - S.eNy[m] * S.tG[m]);
        pb.close();
      }
      const path = pb.detach();
      paint.setColor(S.tints[col]);
      if (share < 3) {
        paint.setAlphaf(alpha * (1 - share / 3));
        S.cvs[lo].drawPath(path, paint);
        S.used[lo] = true;
      }
      if (share > 0) {
        paint.setAlphaf(alpha * (share / 3));
        S.cvs[lo + 1].drawPath(path, paint);
        S.used[lo + 1] = true;
      }
    }
    from = k;
  }
}

function flushRun(S: SceneState, styles: LineStyle[]): void {
  "worklet";
  const n = S.eN;
  if (n >= 2) {
    for (let k = 0; k < n; k++) {
      const a = k > 0 ? k - 1 : 0;
      const b = k < n - 1 ? k + 1 : n - 1;
      const tx = S.eX[b] - S.eX[a];
      const ty = S.eY[b] - S.eY[a];
      const l = Math.hypot(tx, ty) || 1;
      S.eNx[k] = -ty / l;
      S.eNy[k] = tx / l;
    }
    for (let s = 0; s < styles.length; s++) strokeRun(S, styles[s]);
  }
  S.eN = 0;
}

function drawLane(S: SceneState, tb: SceneTables, li: number): void {
  "worklet";
  const lane = LANES[li];
  layoutLane(S, tb, li, true);
  const styles = lane.main ? STYLE_MAIN : lane.lead1 ? STYLE_LEAD : STYLE_WHITE;
  const n = S.laneN;
  const cX = S.cX;
  const cY = S.cY;
  const cZ = S.cZ;
  const vI = S.vI;
  const vG = S.vG;
  S.eN = 0;
  let prev = false;
  for (let i = 0; i < n; i++) {
    const ok = cZ[i] > NEAR && vI[i] > 0.003;
    if (ok) {
      // 从镜头后面穿到前面的线，在近平面上补一个点
      if (!prev && i > 0 && cZ[i - 1] <= NEAR && vI[i - 1] > 0.003) {
        const u = (NEAR - cZ[i - 1]) / (cZ[i] - cZ[i - 1]);
        emit(
          S,
          lerp(cX[i - 1], cX[i], u),
          lerp(cY[i - 1], cY[i], u),
          NEAR,
          lerp(vI[i - 1], vI[i], u),
          vG[i],
        );
      }
      emit(S, cX[i], cY[i], cZ[i], vI[i], vG[i]);
    } else if (prev) {
      if (cZ[i] <= NEAR && vI[i] > 0.003) {
        const u = (NEAR - cZ[i - 1]) / (cZ[i] - cZ[i - 1]);
        emit(
          S,
          lerp(cX[i - 1], cX[i], u),
          lerp(cY[i - 1], cY[i], u),
          NEAR,
          lerp(vI[i - 1], vI[i], u),
          vG[i - 1],
        );
      }
      flushRun(S, styles);
    }
    prev = ok;
  }
  flushRun(S, styles);
}

// worklet 里用到的函数必须写在用它的函数前面：闭包是按书写顺序抓取的，写在后面的抓到的是 undefined
function rgba(c: SkColor, a: number): string {
  "worklet";
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
}

/** 沿线发着光的小点：对上焦是一个带光晕的硬点，失焦时同样的光摊成一片又大又暗的软圆 */
function drawNodes(
  S: SceneState,
  Skia: SkiaApi,
  tb: SceneTables,
  li: number,
): void {
  "worklet";
  const lane = LANES[li];
  if (lane.nodes.length === 0) return;
  const cv = S.cvs[0];
  const sf = S.front + (lane.route === 1 ? tb.frontOne : 0) + lane.lead;
  const appear = smooth(S.t / 90);
  const n = S.laneN;
  const LL = S.LL;
  const L = tb.lanes[li];
  for (let k = 0; k < lane.nodes.length; k++) {
    const s = sf + lane.nodes[k][0];
    if (s <= LL[0] || s >= LL[n - 1]) continue;
    let i = 0;
    let hi = n - 1;
    while (hi - i > 1) {
      const mid = (i + hi) >> 1;
      if (LL[mid] <= s) i = mid;
      else hi = mid;
    }
    const u = (s - LL[i]) / (LL[i + 1] - LL[i] || 1);
    const zc = lerp(S.cZ[i], S.cZ[i + 1], u);
    if (zc <= NEAR) continue;
    // 就在镜头底下的点一两帧就闪过去了：让它离远一点再亮起来
    const bright =
      appear * S.vF[i] * (lane.main ? 1 : 0.85) * smooth((zc - 30) / 110);
    if (bright < 0.01) continue;
    const p = FOCAL / zc;
    const sx = SCENE_W / 2 + lerp(S.cX[i], S.cX[i + 1], u) * p;
    const sy = S.H / 2 - lerp(S.cY[i], S.cY[i + 1], u) * p;
    if (sx < -60 || sx > SCENE_W + 60 || sy < -60 || sy > S.H + 60) continue;
    const r = Math.max(lane.main ? 1.6 : 1.2, lane.nodes[k][1] * p * 0.5);
    const big = r + cocAt(S, zc) * 0.5;
    const g = lane.main
      ? 1
      : lane.route === 1
        ? lerp(L.gS[i], L.gS[i + 1], u)
        : 0;
    const soft = r / big;
    const a = bright * Math.pow(soft, 1.35);
    const gq = Math.round(clamp01(g) * TINT_STEPS);
    const paint = S.nodePaint;
    // 光晕
    let sh = S.haloShaders[gq];
    if (!sh) {
      const c = S.tints[gq];
      sh = Skia.Shader.MakeRadialGradient(
        { x: 0, y: 0 },
        1,
        [c, Skia.Color(rgba(c, 0.32)), Skia.Color("rgba(0,0,0,0)")],
        [0, 0.35, 1],
        TILE_CLAMP,
      );
      S.haloShaders[gq] = sh;
    }
    const haloR = big * 3.2 + 2;
    cv.save();
    cv.translate(sx, sy);
    cv.scale(haloR, haloR);
    paint.setShader(sh);
    paint.setAlphaf(Math.min(1, a * 0.4));
    cv.drawCircle(0, 0, 1, paint);
    cv.restore();
    // 亮芯
    const sq = Math.round(soft * 8);
    const key = (gq * 16 + sq) * 2 + (lane.main ? 1 : 0);
    let core = S.coreShaders[key];
    if (!core) {
      const sf2 = sq / 8;
      const body = S.tints[gq];
      const white = Skia.Color("#fff");
      core = Skia.Shader.MakeRadialGradient(
        { x: 0, y: 0 },
        1,
        [
          white,
          lane.main ? S.tints[TINT_STEPS + 1 + TINT_STEPS] : white,
          Skia.Color(rgba(body, 0.6)),
          Skia.Color("rgba(0,0,0,0)"),
        ],
        [0, lerp(0.2, 0.55, sf2), lerp(0.55, 0.85, sf2), 1],
        TILE_CLAMP,
      );
      S.coreShaders[key] = core;
    }
    cv.save();
    cv.translate(sx, sy);
    cv.scale(big, big);
    paint.setShader(core);
    paint.setAlphaf(Math.min(1, a * 1.2));
    cv.drawCircle(0, 0, 1, paint);
    cv.restore();
  }
}

// ---------------------------------------------------------------- 路面与商标的实心部分
/** 两条边线之间的带子：li < 0 表示路线 1 的另一条轮廓（没有自己的线） */
function layoutBand(
  S: SceneState,
  tb: SceneTables,
  outer: number,
  inner: number,
  j0: number,
  j1: number,
): void {
  "worklet";
  const route = LANES[outer].route;
  const o = S.rb[route];
  const A = tb.lanes[outer];
  const B = inner >= 0 ? tb.lanes[inner] : null;
  const convT = S.convT;
  const H2 = S.H / 2;
  for (let j = j0; j <= j1; j++) {
    const q = j * 6;
    let off = A.offA[j] + convT * A.offB[j];
    let z = o[q + 2] + off * o[q + 5];
    let p = FOCAL / (z > 1e-3 ? z : 1e-3);
    S.bOx[j] = SCENE_W / 2 + (o[q] + off * o[q + 3]) * p;
    S.bOy[j] = H2 - (o[q + 1] + off * o[q + 4]) * p;
    S.bOz[j] = z;
    off = B ? B.offA[j] + convT * B.offB[j] : tb.oneInnerOff[j];
    z = o[q + 2] + off * o[q + 5];
    p = FOCAL / (z > 1e-3 ? z : 1e-3);
    S.bIx[j] = SCENE_W / 2 + (o[q] + off * o[q + 3]) * p;
    S.bIy[j] = H2 - (o[q + 1] + off * o[q + 4]) * p;
    S.bIz[j] = z;
  }
}

/** 把带子上亮度相同的一段填成一个多边形 */
function fillStretch(
  S: SceneState,
  cv: SkCanvas,
  paint: SkPaint,
  from: number,
  to: number,
): void {
  "worklet";
  const pb = S.pb;
  pb.moveTo(S.bOx[from], S.bOy[from]);
  for (let k = from + 1; k <= to; k++) pb.lineTo(S.bOx[k], S.bOy[k]);
  for (let k = to; k >= from; k--) pb.lineTo(S.bIx[k], S.bIy[k]);
  pb.close();
  cv.drawPath(pb.detach(), paint);
}

/** 路是一个面，不只是几条线：最外和最里两条线之间一条很淡的带子，镜头升起来之后才看得出 */
function drawBed(S: SceneState, tb: SceneTables): void {
  "worklet";
  const lift = BED_ALPHA * smooth(S.rise / 0.22);
  if (lift < 0.002) return;
  const R = tb.routes[0];
  const n = R.idx.length;
  const main = tb.lanes[LANE_MAIN];
  layoutBand(S, tb, LANE_EDGE_ZERO_OUT, LANE_EDGE_ZERO_IN, 0, n - 1);
  const cv = S.cvs[1];
  const paint = S.linePaint;
  paint.setColor(S.bedColor);
  const t = S.t;
  const drain = drainTo(t, I_A);
  const fuseOut = 1 - smooth((t - 1330) / 210);
  let from = -1;
  let level = 0;
  for (let j = 0; j <= n - 1; j++) {
    let q = 0;
    if (j < n - 1) {
      const ok =
        S.bOz[j] > NEAR &&
        S.bOz[j + 1] > NEAR &&
        S.bIz[j] > NEAR &&
        S.bIz[j + 1] > NEAR;
      if (ok) {
        const i = R.idx[j];
        const fd = main.fS[j] * (i < I_A ? smooth((i - drain) / 60) : fuseOut);
        q = Math.round(
          lift *
            smooth((S.front - i * DS) / 220) *
            fd *
            (1 - R.conv[j] * S.convT) *
            BED_STEPS,
        );
      }
    }
    if (j === n - 1 || q !== level) {
      if (from >= 0 && level > 0 && j > from) {
        paint.setAlphaf(level / BED_STEPS);
        fillStretch(S, cv, paint, from, j);
        S.used[1] = true;
      }
      from = j;
      level = q;
    }
  }
}

/** 商标的一块在这一帧镜头下的轮廓 */
function polyPath(S: SceneState, tb: SceneTables, which: number): SkPath {
  "worklet";
  const P = tb.poly[which];
  const pb = S.pb;
  const n = P.x.length;
  for (let k = 0; k < n; k++) {
    const dx = P.x[k] - S.P[0];
    const dy = P.y[k] - S.P[1];
    const dz = P.z[k] - S.P[2];
    const zc = S.f[0] * dx + S.f[1] * dy + S.f[2] * dz;
    const s = FOCAL / (zc > NEAR ? zc : NEAR);
    const sx = SCENE_W / 2 + (S.r[0] * dx + S.r[1] * dy) * s;
    const sy = S.H / 2 - (S.u[0] * dx + S.u[1] * dy + S.u[2] * dz) * s;
    if (k) pb.lineTo(sx, sy);
    else pb.moveTo(sx, sy);
  }
  pb.close();
  return pb.detach();
}

/** 沿带子一段一段地填，亮度可以沿路变化（光沿着路跑进去）；相邻的段加在一起不留缝 */
function fillSlices(
  S: SceneState,
  cv: SkCanvas,
  paint: SkPaint,
  j0: number,
  j1: number,
  alphas: Float32Array,
): void {
  "worklet";
  let from = -1;
  let level = 0;
  for (let j = j0; j <= j1; j++) {
    const q = j < j1 ? Math.round(clamp01(alphas[j]) * 64) : 0;
    if (j === j1 || q !== level) {
      if (from >= 0 && level > 0 && j > from) {
        paint.setAlphaf(level / 64);
        fillStretch(S, cv, paint, from, j);
      }
      from = j;
      level = q;
    }
  }
}

function indexOfSample(idx: ArrayLike<number>, i: number): number {
  "worklet";
  let a = 0;
  let b = idx.length - 1;
  while (b - a > 1) {
    const m = (a + b) >> 1;
    if (idx[m] <= i) a = m;
    else b = m;
  }
  return idx[b] <= i ? b : a;
}

/**
 * 商标的实心部分就是路面本身，按轮廓裁出来：车道收拢时先隐约透出来，绿光跑进荧光那一块时它先变实，
 * 然后白色的部分被光填满。画进 cv（调用方负责放进一个普通图层里）。返回有没有画东西。
 */
function drawFills(S: SceneState, tb: SceneTables, cv: SkCanvas): boolean {
  "worklet";
  const t = S.t;
  const ghost = GHOST * smooth((S.convT - 0.3) / 0.5);
  if (ghost < 0.003) return false;
  const paint = S.fillPaint;
  paint.setBlendMode(BLEND_PLUS);
  const fuseLen = SCENE_T.fuse[1] - SCENE_T.fuse[0] - 60;
  const al = S.tG; // 借用一块暂存

  // 「0」：沿路一段段亮起来
  const Z = tb.routes[0];
  const zn = Z.idx.length;
  const z0 = indexOfSample(Z.idx, I_A - 46);
  layoutBand(S, tb, LANE_EDGE_ZERO_OUT, LANE_EDGE_ZERO_IN, z0, zn - 1);
  for (let j = z0; j < zn; j++) {
    const k = clamp01((Z.idx[j] - I_A) / (I_CUT - I_A));
    al[j] = lerp(ghost, 1, smoother((t - SCENE_T.fuse[0] - 60 * k) / fuseLen));
  }
  cv.save();
  cv.clipPath(polyPath(S, tb, 0), CLIP_INTERSECT, true);
  paint.setColor(S.fillWhite);
  fillSlices(S, cv, paint, z0, zn - 1, al);
  cv.restore();

  // 「1」的竖条有些地方没有线经过（斜切的顶），整块一起填
  paint.setColor(S.fillWhite);
  paint.setAlphaf(
    lerp(ghost, 1, smoother((t - SCENE_T.fuse[0] - 60) / fuseLen)),
  );
  cv.drawPath(polyPath(S, tb, 1), paint);

  // 荧光那一块最先成形：绿光沿着勾往下跑，身后变实，前沿很软
  const O = tb.routes[1];
  const o0 = indexOfSample(O.idx, I_B);
  const o1 = indexOfSample(O.idx, I_TIP);
  layoutLane(S, tb, LANE_LEAD, false);
  for (let j = o0; j <= o1; j++) S.llLead[j] = S.LL[j];
  layoutBand(S, tb, LANE_LEAD, -1, o0, o1);
  const sfLead = S.front + tb.frontOne + LANES[LANE_LEAD].lead;
  for (let j = o0; j <= o1; j++)
    al[j] = lerp(ghost, 1, smoother((sfLead - S.llLead[j] - 30) / 300));
  cv.save();
  cv.clipPath(polyPath(S, tb, 2), CLIP_INTERSECT, true);
  paint.setColor(S.fillGreen);
  fillSlices(S, cv, paint, o0, o1, al);
  cv.restore();
  return true;
}

// ---------------------------------------------------------------- 对外
/** 商标完成之后它在画面里的状态（由收尾那一段给）：这里只用来画它周围的光 */
export type MarkGlow = {
  /** 商标中心（屏幕单位）和相对 196 的缩放 */
  cx: number;
  cy: number;
  scale: number;
  /** 0..1：商标离开原位的程度，光随之收掉 */
  dock: number;
  /** 0..1：呼吸（只有去登录页的那一版有） */
  breath: number;
  /** 脉冲环的进度，< 0 表示没有 */
  pulse: number;
};

/** 商标原图盖在矢量形状上的不透明度（原图由调用方用普通图片组件显示） */
export function rasterOpacityAt(t: number): number {
  "worklet";
  return smooth(
    (t - SCENE_T.raster[0]) / (SCENE_T.raster[1] - SCENE_T.raster[0]),
  );
}

/** 这一刻之后画布上什么都不剩（线已收完、商标周围的光也收掉了），可以卸掉画布 */
export function sceneIsEmpty(t: number, glow: MarkGlow): boolean {
  "worklet";
  return (
    t >= SCENE_T.raster[1] &&
    glow.dock > 0.995 &&
    (glow.pulse < 0 || glow.pulse >= 1.25)
  );
}

/** 完成之后的商标（三块平面形状），只在算光的时候用 */
function drawFlatMark(
  S: SceneState,
  canvas: SkCanvas,
  glow: MarkGlow,
  alpha: number,
): void {
  "worklet";
  const paint = S.fillPaint;
  paint.setBlendMode(BLEND_SRC_OVER);
  canvas.save();
  canvas.translate(glow.cx, glow.cy);
  canvas.scale(glow.scale, glow.scale);
  paint.setColor(S.fillWhite);
  paint.setAlphaf(alpha);
  canvas.drawPath(S.flatPaths[0], paint);
  canvas.drawPath(S.flatPaths[1], paint);
  paint.setColor(S.fillGreen);
  paint.setAlphaf(alpha);
  canvas.drawPath(S.flatPaths[2], paint);
  canvas.restore();
}

/**
 * 画一帧。canvas 的坐标要先缩放到「宽 282 个单位」。t 是故事时间（毫秒）。
 * 商标原图和文字不在这里画。withBackground 为 false 时不铺深色底，只画光（预录每一帧时用）。
 * holdMark：换成原图之后矢量的实心商标也一直留着（录成视频时用，原因见 scripts/build-splash-video.ts）。
 */
export function drawRouteScene(
  Skia: SkiaApi,
  canvas: SkCanvas,
  S: SceneState,
  tb: SceneTables,
  t: number,
  glow: MarkGlow,
  withBackground: boolean = true,
  holdMark: boolean = false,
): void {
  "worklet";
  S.t = t;
  setCamera(S, tb, t);
  S.convT = smoother(
    (t - SCENE_T.converge[0]) / (SCENE_T.converge[1] - SCENE_T.converge[0]),
  );
  S.front = frontAt(t);
  const linesOn = t < SCENE_T.linesOff;
  if (withBackground) canvas.drawColor(Skia.Color(SCENE_BG));

  if (linesOn) {
    projectRoutes(S, tb);
    for (let j = 0; j < NCLASS; j++) {
      S.cvs[j] = S.recs[j].beginRecording(S.bounds);
      S.used[j] = false;
    }
    for (let li = 0; li < LANES.length; li++) {
      drawLane(S, tb, li);
      drawNodes(S, Skia, tb, li);
    }
    S.used[0] = true;
    drawBed(S, tb);
    // 没有线经过的那几段轮廓（斜切口、「1」的顶），在车道收拢时浮出来
    const outline =
      0.5 * smooth((t - 930) / 250) * (1 - smooth((t - 1330) / 200));
    if (outline > 0.005) {
      const sp = S.strokePaint;
      sp.setAlphaf(1);
      sp.setColor(S.tints[0]);
      sp.setAlphaf(outline);
      S.cvs[0].drawPath(polyPath(S, tb, 0), sp);
      S.cvs[0].drawPath(polyPath(S, tb, 1), sp);
      sp.setColor(S.tints[TINT_STEPS]);
      sp.setAlphaf(outline);
      S.cvs[0].drawPath(polyPath(S, tb, 2), sp);
    }
    for (let j = 0; j < NCLASS; j++)
      S.pics[j] = S.recs[j].finishRecordingAsPicture();
  }

  // 商标的实心部分：成形中是矢量的，换成原图之后这里只负责它周围的光
  const forming = holdMark || t < SCENE_T.raster[1];
  let fillPic: SkPicture | null = null;
  if (forming) {
    const rec = S.fillRec;
    const cv = rec.beginRecording(S.bounds);
    const any = drawFills(S, tb, cv);
    fillPic = rec.finishRecordingAsPicture();
    if (!any) fillPic = null;
  }
  const hasMark = forming ? fillPic !== null : glow.dock <= 0.995;
  const settle = smooth((t - 1300) / 300);
  const fillGlow = hasMark
    ? (lerp(0.5, 0.2, settle) + 0.16 * glow.breath) * (1 - glow.dock)
    : 0;

  if (linesOn) {
    // 整幅光放在一层里：清楚的线直接画，虚的每一档整层模糊；这一层出去的时候再加上它自己的泛光
    canvas.saveLayer(S.linesPaint);
    canvas.drawPicture(S.pics[0] as SkPicture);
    for (let j = 1; j < NCLASS; j++) {
      if (!S.used[j]) continue;
      canvas.saveLayer(S.blurPaints[j]);
      canvas.drawPicture(S.pics[j] as SkPicture);
      canvas.restore();
    }
    canvas.restore();
  }
  // 商标周围的光压在实心商标下面：商标保持原色，只有它周围发亮
  if (fillGlow > 0.004) {
    // 先把商标调暗再去模糊（几层模糊加起来会超过 1，反过来做会被削顶，光就弱了）
    const amount = fillGlow > 1 ? 1 : fillGlow;
    if (fillPic) {
      canvas.saveLayer(S.glowPaint);
      S.layerPaint.setAlphaf(amount);
      canvas.saveLayer(S.layerPaint);
      canvas.drawPicture(fillPic);
      canvas.restore();
    } else {
      // 这一层只开到商标那么大（模糊往外的那一圈由滤镜自己扩出去）：不给范围就是整块画布陪着模糊三遍，
      // 商标完成之后这圈光每帧都要画，手机上省下一大半的像素
      const fb = S.flatBounds;
      const k = glow.scale;
      canvas.saveLayer(
        S.glowPaint,
        Skia.XYWHRect(
          glow.cx + fb.x * k - 1,
          glow.cy + fb.y * k - 1,
          fb.width * k + 2,
          fb.height * k + 2,
        ),
      );
      drawFlatMark(S, canvas, glow, amount);
    }
    canvas.restore();
  }
  if (fillPic) {
    S.layerPaint.setAlphaf(1);
    canvas.saveLayer(S.layerPaint);
    canvas.drawPicture(fillPic);
    canvas.restore();
  }

  // 一次克制的脉冲：细环离开商标，到品牌名之前就淡掉
  if (glow.pulse > 0 && glow.pulse < 1.25) {
    const rings = [
      [0, 84, 110, 0.2],
      [0.22, 96, 118, 0.11],
    ];
    const sp = S.strokePaint;
    sp.setStrokeWidth(0.8);
    sp.setColor(S.pulseColor);
    for (let k = 0; k < rings.length; k++) {
      const u = clamp01(glow.pulse - rings[k][0]);
      if (u <= 0 || u >= 1) continue;
      sp.setAlphaf(rings[k][3] * Math.pow(Math.sin(Math.PI * u), 1.3));
      canvas.drawCircle(
        glow.cx,
        glow.cy,
        lerp(rings[k][1], rings[k][2], easeOut(u)),
        sp,
      );
    }
    sp.setStrokeWidth(0.9);
  }
}
