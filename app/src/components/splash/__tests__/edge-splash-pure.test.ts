// 开屏收尾编排（landings）、动画样式缓存（steady-style 的 forgetSteady）、设备页大图（hero-splash 的
// 电量极低 / 浅色主题）、路线段的缓动和时间轴（route-scene 里能纯算的导出函数 + 开头算一次的表）。
import { describe, expect, it, jest } from "@jest/globals";
import type { DevicePublic } from "@helmet/shared";

import { heroSplashOf } from "../hero-splash";
import {
  DEVICE,
  LAND_DEVICE,
  LAND_LOGIN,
  LAND_NONE,
  LAND_PLAIN,
  LAND_UNBOUND,
  LOGIN,
  UNBOUND,
  deviceGlide,
  deviceWipe,
  glide,
  glowDockAt,
  lockupAt,
  loginBreath,
  loginDock,
  loginReveal,
  slide,
  sparkDuration,
  spring,
} from "../landings";
import {
  ONE_ROUTE,
  POLY_BAR,
  POLY_GREEN,
  POLY_ZERO,
  ROUTE_CAM,
  ROUTE_DS,
  ZERO_ROUTE,
} from "../route-data";
import {
  MARK_SIZE,
  SCENE_T,
  buildSceneTables,
  clamp01,
  easeOut,
  frontAt,
  lerp,
  rasterOpacityAt,
  sceneIsEmpty,
  smooth,
  smoother,
  type MarkGlow,
} from "../route-scene";
import { forgetSteady, steady } from "../steady-style";
import { LOCKUP, MARK_DONE } from "../timeline";

jest.mock("@/constants/helmet-images", () => ({ helmetImageFor: () => 7 }));

const near = (a: number, b: number, eps = 1e-9) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);

describe("路线段的缓动", () => {
  it("clamp01 / lerp", () => {
    expect([clamp01(-3), clamp01(0.25), clamp01(7)]).toEqual([0, 0.25, 1]);
    expect(lerp(10, 20, 0)).toBe(10);
    expect(lerp(10, 20, 1)).toBe(20);
    expect(lerp(10, 20, 0.25)).toBe(12.5);
    // 不夹紧：超出 0..1 时外推
    expect(lerp(0, 10, 1.5)).toBe(15);
  });

  it("smooth / smoother / easeOut：两头夹到 0 和 1，中点各有各的值", () => {
    for (const f of [smooth, smoother, easeOut]) {
      expect(f(-1)).toBe(0);
      expect(f(0)).toBe(0);
      expect(f(1)).toBe(1);
      expect(f(2)).toBe(1);
      let prev = 0;
      for (let i = 1; i <= 100; i++) {
        const v = f(i / 100);
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
    expect(smooth(0.5)).toBe(0.5);
    expect(smoother(0.5)).toBe(0.5);
    expect(easeOut(0.5)).toBe(0.875);
    // smoother 起步比 smooth 更缓
    expect(smoother(0.1)).toBeLessThan(smooth(0.1));
  });

  it("领头的光：t=0 在镜头出发点之前 60，起步快、随后匀速 2.5 / ms", () => {
    near(frontAt(0), ROUTE_CAM * ROUTE_DS - 60);
    const early = frontAt(100) - frontAt(0);
    const late = frontAt(2100) - frontAt(2000);
    expect(early).toBeGreaterThan(late);
    near(late, 250, 0.01);
  });

  it("商标原图的不透明度：换图那 100 ms 里从 0 到 1", () => {
    expect(rasterOpacityAt(0)).toBe(0);
    expect(rasterOpacityAt(SCENE_T.raster[0])).toBe(0);
    expect(rasterOpacityAt((SCENE_T.raster[0] + SCENE_T.raster[1]) / 2)).toBe(
      0.5,
    );
    expect(rasterOpacityAt(SCENE_T.raster[1])).toBe(1);
    expect(rasterOpacityAt(5000)).toBe(1);
  });

  it("画布什么时候可以卸：换完原图、商标离开原位、脉冲没有或已走完，三样都满足", () => {
    const glow = (over: Partial<MarkGlow>): MarkGlow => ({
      cx: 0,
      cy: 0,
      scale: 1,
      dock: 1,
      breath: 0,
      pulse: -1,
      ...over,
    });
    const done = SCENE_T.raster[1];
    expect(sceneIsEmpty(done, glow({}))).toBe(true);
    expect(sceneIsEmpty(done - 1, glow({}))).toBe(false);
    expect(sceneIsEmpty(done, glow({ dock: 0.99 }))).toBe(false);
    expect(sceneIsEmpty(done, glow({ pulse: 0.5 }))).toBe(false);
    expect(sceneIsEmpty(done, glow({ pulse: 1.25 }))).toBe(true);
    expect(sceneIsEmpty(done, glow({ pulse: 0 }))).toBe(false);
  });
});

describe("开头算一次的表（buildSceneTables）", () => {
  const tb = buildSceneTables();
  const [zero, one] = tb.routes;

  it("采样点：升序不重复，两端和关键位置都取到；贴着路面那一段逐点取", () => {
    for (const [r, n] of [
      [zero, ZERO_ROUTE.n],
      [one, ONE_ROUTE.n],
    ] as const) {
      for (let i = 1; i < r.idx.length; i++)
        expect(r.idx[i]).toBeGreaterThan(r.idx[i - 1]);
      expect(r.idx[0]).toBe(0);
      expect(r.idx[r.idx.length - 1]).toBe(n - 1);
      for (const k of ["bx", "by", "bz", "nx", "ny", "conv"] as const)
        expect(r[k]).toHaveLength(r.idx.length);
    }
    for (let i = 60; i <= 340; i++) expect(zero.idx).toContain(i);
    expect(zero.idx).toContain(ROUTE_CAM);
    expect(zero.idx).toContain(ZERO_ROUTE.marks.A);
    expect(one.idx).toContain(ONE_ROUTE.marks.B);
    expect(one.idx).toContain(ONE_ROUTE.marks.dock);
    // 远处隔两点取一个：路线 1 没有逐点段，点数约为三分之一
    expect(one.idx.length).toBeLessThan(ONE_ROUTE.n / 2);
  });

  it("路线 1 不参与车道收拢（conv 全 0）；路线 0 收拢进度在 0..1", () => {
    expect(one.conv.every((c) => c === 0)).toBe(true);
    expect(zero.conv.every((c) => c >= 0 && c <= 1)).toBe(true);
    expect(Math.max(...zero.conv)).toBe(1);
  });

  it("十条线；每条线的各列和所在路线的采样点一样长", () => {
    expect(tb.lanes).toHaveLength(10);
    for (const lane of tb.lanes) {
      const n = lane.offA.length;
      expect(n === zero.idx.length || n === one.idx.length).toBe(true);
      for (const k of ["offB", "ll0", "dll", "fS", "sB", "gS"] as const)
        expect(lane[k]).toHaveLength(n);
    }
    expect(tb.oneInnerOff).toHaveLength(one.idx.length);
  });

  it("沿线路程单调不减；路线 0 的线在镜头出发处对齐、路线 1 的线在竖条顶上对齐", () => {
    const camAt = zero.idx.indexOf(ROUTE_CAM);
    const bAt = one.idx.indexOf(ONE_ROUTE.marks.B);
    for (const lane of tb.lanes) {
      for (let i = 1; i < lane.ll0.length; i++)
        expect(lane.ll0[i]).toBeGreaterThanOrEqual(lane.ll0[i - 1]);
      const onZero = lane.offA.length === zero.idx.length;
      if (onZero) near(lane.ll0[camAt], ROUTE_CAM * ROUTE_DS, 1e-6);
      else near(lane.ll0[bAt], ONE_ROUTE.marks.B * ROUTE_DS, 1e-6);
    }
  });

  it("路线 0 的线一直看得见、不发绿；只有路线 1 的领头线会变绿", () => {
    const zeroLanes = tb.lanes.filter((l) => l.offA.length === zero.idx.length);
    const oneLanes = tb.lanes.filter((l) => l.offA.length === one.idx.length);
    expect(zeroLanes).toHaveLength(7);
    expect(oneLanes).toHaveLength(3);
    for (const l of zeroLanes) {
      expect(l.sB.every((v) => v === 1)).toBe(true);
      expect(l.gS.every((v) => v === 0)).toBe(true);
    }
    const greens = oneLanes.map((l) => Math.max(...l.gS));
    expect(greens.filter((g) => g === 1)).toHaveLength(1);
    expect(greens.filter((g) => g === 0)).toHaveLength(2);
    // 路线 1 镜头升起前看不见：前段 sB 为 0、到竖条附近为 1
    expect(oneLanes[0].sB[0]).toBe(0);
    expect(oneLanes[0].sB[one.idx.indexOf(ONE_ROUTE.marks.B)]).toBe(1);
  });

  it("亮度里不变的那部分在 0..1；只属于路的线到「0」的尾巴前就没了", () => {
    for (const l of tb.lanes)
      expect(l.fS.every((v) => v >= 0 && v <= 1 + 1e-12)).toBe(true);
    // 第一条线 roadOnly：收拢完（conv=1）的地方亮度为 0
    const fullConv = zero.conv.findIndex((c) => c === 1);
    expect(tb.lanes[0].fS[fullConv]).toBe(0);
  });

  it("商标三块平面形状落在 196 见方、以中心为原点的框里", () => {
    expect(tb.flat).toHaveLength(3);
    const polys = [POLY_ZERO, POLY_BAR, POLY_GREEN];
    tb.flat.forEach((pts, w) => {
      expect(pts).toHaveLength(polys[w].p.length * 2);
      for (const v of pts)
        expect(Math.abs(v)).toBeLessThanOrEqual(MARK_SIZE / 2);
    });
    expect(tb.poly.map((p) => p.x.length)).toEqual(
      polys.map((p) => p.p.length),
    );
  });

  it("镜头曲线：骑行段过原点、升起段从 0 到 1；绕行两端的方位角在 0..2π", () => {
    expect(tb.ride.xs).toContain(0);
    expect(tb.ride.ys[tb.ride.xs.indexOf(0)]).toBe(0);
    expect(tb.camRise.ys[0]).toBe(0);
    expect(tb.camRise.ys[tb.camRise.ys.length - 1]).toBe(1);
    expect(tb.oa[2]).toBeGreaterThanOrEqual(0);
    expect(tb.oa[2]).toBeLessThan(2 * Math.PI);
    expect(tb.oa[0]).toBeGreaterThan(0);
    expect(tb.ob[0]).toBeGreaterThan(0);
    // 终点机位正对着往下看：仰角接近 90°
    expect(tb.ob[1]).toBeGreaterThan(1.3);
    expect(Number.isFinite(tb.frontOne)).toBe(true);
    expect(Array.from(tb.camX)).toEqual(ZERO_ROUTE.x);
  });

  it("交给 worklet 的数值表都是 Float64Array、各占一块刚好大小的缓冲区；表里没有逐个序列化的普通数字数组", () => {
    // 普通数字数组捕获进 worklet 时每个数都单独序列化（这张表约 4 万个，开屏时在 JS 线程上同步做完）；
    // 类型化数组整块拷。worklet 序列化类型化数组拷的是它的整块 buffer（react-native-worklets 的 Serializable.cpp），
    // 所以不能让几张表共用一块大缓冲区、各取一段视图。oa / ob 是 3 个数的元组，不算
    let typed = 0;
    let numbers = 0;
    const walk = (v: unknown, path: string) => {
      if (ArrayBuffer.isView(v)) {
        expect(v).toBeInstanceOf(Float64Array);
        const f = v as Float64Array;
        expect([path, f.byteOffset]).toEqual([path, 0]);
        expect([path, f.buffer.byteLength]).toEqual([path, f.length * 8]);
        typed += 1;
        numbers += f.length;
      } else if (Array.isArray(v)) {
        if (v.length > 0 && v.every((x) => typeof x === "number"))
          expect([path, v.length]).toEqual([path, 3]);
        else v.forEach((x, i) => walk(x, `${path}[${i}]`));
      } else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
      }
    };
    walk(tb, "tb");
    expect(typed).toBeGreaterThan(100);
    expect(numbers).toBeGreaterThan(30_000);
  });

  it("模拟 worklet 的序列化（整块拷 buffer，再按 byteOffset / length 重建）：每个数逐项相等", () => {
    const roundtrip = (f: Float64Array) =>
      new Float64Array(f.buffer.slice(0), f.byteOffset, f.length);
    const walk = (v: unknown): void => {
      if (ArrayBuffer.isView(v)) {
        const f = v as Float64Array;
        const back = roundtrip(f);
        expect(back).toHaveLength(f.length);
        for (let i = 0; i < f.length; i++)
          expect(Object.is(back[i], f[i])).toBe(true);
      } else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(tb);
  });

  it("两次算出来一样（没有藏着的随机或全局状态）", () => {
    const again = buildSceneTables();
    expect(again.lanes[4].ll0).toEqual(tb.lanes[4].ll0);
    expect(again.frontOne).toBe(tb.frontOne);
  });
});

describe("开屏收尾编排（landings）", () => {
  it("spring 带过冲、两头夹紧；glide 不过冲；slide 起步慢收尾长", () => {
    expect(spring(-1)).toBe(0);
    expect(spring(2)).toBe(1);
    expect(spring(0.3)).toBeGreaterThan(1);
    expect(glide(-1)).toBe(0);
    near(glide(1), 1);
    expect(glide(0.5)).toBeLessThan(1);
    expect(slide(0)).toBe(0);
    expect(slide(1)).toBe(1);
    expect(slide(0.1)).toBeLessThan(0.1);
  });

  it("去登录页：上移 / 涌上来到时间点才动，走完停在 1；呼吸起落", () => {
    expect(loginDock(LOGIN.dockFrom)).toBe(0);
    near(loginDock(LOGIN.dockFrom + LOGIN.dockLen), 1);
    expect(loginDock(LOGIN.dockFrom + LOGIN.dockLen / 2)).toBeGreaterThan(0.5);
    expect(loginReveal(LOGIN.revealFrom - 10)).toBe(0);
    near(loginReveal(LOGIN.revealFrom + LOGIN.revealLen * 2), 1);
    near(loginBreath(LOGIN.pulse[0]), 0);
    near(loginBreath((LOGIN.pulse[0] + LOGIN.pulse[1]) / 2), 1);
    near(loginBreath(LOGIN.pulse[1]), 0, 1e-12);
  });

  it("去设备页：扫描擦除和上移各自从 0 走到 1", () => {
    expect(deviceWipe(DEVICE.scan[0])).toBe(0);
    expect(deviceWipe(DEVICE.scan[1])).toBe(1);
    expect(deviceGlide(DEVICE.hand)).toBe(0);
    near(deviceGlide(DEVICE.hand + DEVICE.glide), 1);
  });

  it("光点收尾时长夹在 220–420 ms 之间", () => {
    expect(sparkDuration(0, 0)).toBe(220);
    expect(sparkDuration(200, 0)).toBe(260);
    expect(sparkDuration(1000, 1000)).toBe(420);
  });

  it("品牌名显隐：登录页按自己的节奏出现；设备页、未绑定先出现再收走；只停一下的那种一直在", () => {
    expect(lockupAt(LAND_LOGIN, LOGIN.wordsFrom)).toBe(0);
    expect(lockupAt(LAND_LOGIN, LOGIN.wordsFrom + LOGIN.wordsLen)).toBe(1);
    const shown = LOCKUP.start + LOCKUP.dur;
    expect(lockupAt(LAND_DEVICE, shown)).toBe(1);
    expect(
      lockupAt(LAND_DEVICE, DEVICE.wordsLeave + DEVICE.wordsLeaveLen),
    ).toBe(0);
    expect(lockupAt(LAND_UNBOUND, shown)).toBe(1);
    expect(lockupAt(LAND_UNBOUND, UNBOUND.start + UNBOUND.wordsLeaveLen)).toBe(
      0,
    );
    expect(lockupAt(LAND_PLAIN, 3000)).toBe(1);
    expect(lockupAt(LAND_NONE, 3000)).toBe(1);
    expect(lockupAt(LAND_PLAIN, LOCKUP.start)).toBe(0);
  });

  it("商标周围的光：成标前一律 0；各收尾按自己的离开节奏收掉，只停一下的不收", () => {
    for (const land of [LAND_LOGIN, LAND_DEVICE, LAND_UNBOUND, LAND_PLAIN])
      expect(glowDockAt(land, MARK_DONE - 1)).toBe(0);
    expect(glowDockAt(LAND_LOGIN, LOGIN.dockFrom)).toBe(0);
    near(glowDockAt(LAND_LOGIN, 9000), 1);
    // 设备页：擦到 60% 时光已经收完
    const at60 = DEVICE.scan[0] + (DEVICE.scan[1] - DEVICE.scan[0]) * 0.7;
    expect(deviceWipe(at60)).toBeGreaterThan(0.6);
    expect(glowDockAt(LAND_DEVICE, at60)).toBe(1);
    expect(glowDockAt(LAND_DEVICE, MARK_DONE)).toBe(0);
    expect(glowDockAt(LAND_UNBOUND, UNBOUND.start - 130)).toBe(0);
    expect(glowDockAt(LAND_UNBOUND, UNBOUND.start + 70)).toBe(1);
    expect(glowDockAt(LAND_PLAIN, 3000)).toBe(0);
    expect(glowDockAt(LAND_NONE, 3000)).toBe(0);
  });
});

describe("steady-style：组件卸掉时清掉记着的样式", () => {
  it("forgetSteady 之后同样的输入交出新对象；没记过的 id 也能清", () => {
    const a = steady("edge.forget", { opacity: 1 });
    expect(steady("edge.forget", { opacity: 1 })).toBe(a);
    forgetSteady("edge.forget");
    const b = steady("edge.forget", { opacity: 1 });
    expect(b).not.toBe(a);
    expect(() => forgetSteady("edge.never")).not.toThrow();
  });

  it("一边是数组一边不是、一边是 null，都算变了", () => {
    const a = steady("edge.shape", { v: [1] as unknown });
    expect(steady("edge.shape", { v: { 0: 1 } as unknown })).not.toBe(a);
    const b = steady("edge.shape", { v: null as unknown });
    expect(steady("edge.shape", { v: {} as unknown })).not.toBe(b);
  });

  it("全局表还没建时 forgetSteady 不抛错", () => {
    const g = globalThis as { __steadyStyles?: unknown };
    const saved = g.__steadyStyles;
    delete g.__steadyStyles;
    expect(() => forgetSteady("x")).not.toThrow();
    g.__steadyStyles = saved;
  });
});

describe("设备页大图：电量极低、浅色主题", () => {
  const theme = {
    text: "#000",
    textSecondary: "#666",
    background: "#FFFFFF",
    backgroundElement: "#FAFAFA",
    backgroundSelected: "#EEEEEE",
    borderStrong: "#CCC",
    success: "#0A0",
    warning: "#FA0",
    danger: "#E00",
  } as unknown as Parameters<typeof heroSplashOf>[0]["theme"];
  const device = (battery: number | null) =>
    ({
      deviceId: "h",
      name: "n",
      battery,
      charging: false,
      online: true,
    }) as DevicePublic;
  const of = (battery: number | null, dark: boolean) =>
    heroSplashOf({
      device: device(battery),
      link: "connected",
      theme,
      dark,
      t: (k) => k,
      glowRadius: null,
    });

  it("≤10% 连着：环、数字、小标题都是危险红，写「电量低」", () => {
    const h = of(8, false);
    expect(h.arc).toBe(theme.danger);
    expect(h.valueColor).toBe(theme.danger);
    expect(h.labelColor).toBe(theme.danger);
    expect(h.label).toBe("devices.batteryLow");
  });

  it("浅色主题：光晕更浓、往外退得慢，柔光底用卡片底色；没给半径时为 null", () => {
    const h = of(80, false);
    expect(h.glow).toEqual({ radius: null, alpha: 0.34, mid: 0.17 });
    expect(h.spot).toBe(theme.backgroundElement);
    expect(of(80, true).spot).toBe(theme.backgroundSelected);
  });
});
