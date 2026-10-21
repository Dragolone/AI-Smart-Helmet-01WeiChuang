// 开屏播到商标完成时落到哪种页面（负责人 2026-10-08 定的口径）
import { describe, expect, it } from "@jest/globals";

import {
  planLanding,
  SPLASH_MAX_ASPECT,
  tooWideForSplash,
  type LandingFacts,
} from "../plan";

const facts = (over: Partial<LandingFacts> = {}): LandingFacts => ({
  hydrated: true,
  themeReady: true,
  dark: true,
  reduceMotion: false,
  authed: true,
  deviceCount: null,
  remembered: undefined,
  waited: false,
  ...over,
});

describe("开屏落到哪种页面", () => {
  it("没登录：登录页", () => {
    expect(planLanding(facts({ authed: false }))).toBe("login");
  });

  it("设备列表回来了：有头盔去设备页，没有去引导页", () => {
    expect(planLanding(facts({ deviceCount: 2 }))).toBe("device");
    expect(planLanding(facts({ deviceCount: 0 }))).toBe("unbound");
  });

  it("列表回来了就以它为准，不看本机记住的", () => {
    expect(planLanding(facts({ deviceCount: 0, remembered: true }))).toBe(
      "unbound",
    );
    expect(planLanding(facts({ deviceCount: 1, remembered: false }))).toBe(
      "device",
    );
  });

  it("列表没回来：按本机记住的上次结果播", () => {
    expect(planLanding(facts({ remembered: true }))).toBe("device");
    expect(planLanding(facts({ remembered: false }))).toBe("unbound");
  });

  it("列表没回来、也没有记录：先停在商标上，等满时限直接进页面", () => {
    expect(planLanding(facts({ remembered: null }))).toBeNull();
    expect(planLanding(facts({ remembered: undefined }))).toBeNull();
    expect(planLanding(facts({ remembered: null, waited: true }))).toBe(
      "plain",
    );
  });

  it("登录态、外观还没读出来：不猜，等；等满时限直接进页面", () => {
    expect(planLanding(facts({ hydrated: false, authed: false }))).toBeNull();
    expect(
      planLanding(facts({ themeReady: false, deviceCount: 1 })),
    ).toBeNull();
    expect(
      planLanding(facts({ hydrated: false, authed: false, waited: true })),
    ).toBe("plain");
  });

  it("浅色外观、减弱动态效果：不做落位，商标停一下整层淡出", () => {
    expect(planLanding(facts({ dark: false, authed: false }))).toBe("plain");
    expect(planLanding(facts({ dark: false, deviceCount: 3 }))).toBe("plain");
    expect(planLanding(facts({ reduceMotion: true, deviceCount: 0 }))).toBe(
      "plain",
    );
  });
});

describe("窗口放不下开屏就不播（负责人 10-21 定，O32 选 A）", () => {
  it("手机竖屏、竖着拿的展开折叠屏照播；正方形（离底边太近，留余量）、横着拿和更宽的不播", () => {
    expect(tooWideForSplash(411, 914)).toBe(false); // Pixel 8
    expect(tooWideForSplash(701, 841)).toBe(false); // 展开折叠屏竖着（0.83）
    expect(tooWideForSplash(686, 744)).toBe(false); // 0.92：模拟器量过完整
    expect(tooWideForSplash(686, 686)).toBe(true); // 正方形：量过还完整，但三键导航栏会压到品牌名
    expect(tooWideForSplash(743, 686)).toBe(true); // 1.08：「零一智行」压到手势条
    expect(tooWideForSplash(841, 701)).toBe(true); // 展开折叠屏横着（1.2）
    expect(tooWideForSplash(1280, 800)).toBe(true); // 平板横着
  });

  it("分界在 0.95；高度还没量出来时照常播", () => {
    expect(tooWideForSplash(95, 100)).toBe(false);
    expect(tooWideForSplash(96, 100)).toBe(true);
    expect(SPLASH_MAX_ASPECT).toBe(0.95);
    expect(tooWideForSplash(400, 0)).toBe(false);
  });
});
