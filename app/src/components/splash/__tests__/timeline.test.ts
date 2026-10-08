// 开屏的时间表：故事时间和真实时间怎么换算，各种收尾多长
import { describe, expect, it } from "@jest/globals";

import {
  LOCKUP,
  MARK_DONE,
  PACE,
  STORY_TOTAL,
  buildWarp,
  realAt,
  storyAt,
} from "../timeline";
import { DEVICE, LOGIN, UNBOUND, glide, slide, spring } from "../landings";
import { SCENE_T } from "../route-scene";

describe("故事时间 ↔ 真实时间", () => {
  const warp = buildWarp();

  it("一路往前走，不回头", () => {
    for (let s = 1; s <= MARK_DONE; s++)
      expect(warp[s]).toBeGreaterThan(warp[s - 1]);
  });

  it("放慢的那一段确实是 1.6 倍，两头是原速", () => {
    expect(warp[100] - warp[99]).toBeCloseTo(1, 5);
    expect(warp[1000] - warp[999]).toBeCloseTo(PACE, 5);
  });

  it("商标完成之后两种时间一比一地走", () => {
    const end = warp[MARK_DONE];
    expect(storyAt(warp, end + 500)).toBeCloseTo(MARK_DONE + 500, 6);
    expect(realAt(warp, MARK_DONE + 500)).toBeCloseTo(end + 500, 6);
  });

  it("两个方向互为反函数", () => {
    for (const s of [0, 37.5, 380, 612.25, 1000, 1419.9, 1599, 1600, 2400])
      expect(storyAt(warp, realAt(warp, s))).toBeCloseTo(s, 3);
  });

  it("成标这一段比原速多用不到 0.7 秒", () => {
    const extra = warp[MARK_DONE] - MARK_DONE;
    expect(extra).toBeGreaterThan(400);
    expect(extra).toBeLessThan(700);
  });
});

describe("各种收尾的时刻对得上", () => {
  it("落位的动作都排在商标完成之后、整段结束之前", () => {
    expect(SCENE_T.raster[1]).toBeLessThan(MARK_DONE);
    expect(LOCKUP.start).toBeLessThan(MARK_DONE);
    expect(LOGIN.dockFrom).toBeGreaterThan(MARK_DONE);
    expect(LOGIN.dockFrom + LOGIN.dockLen).toBeLessThanOrEqual(
      STORY_TOTAL.login,
    );
    expect(DEVICE.tuck[0]).toBe(MARK_DONE);
    expect(DEVICE.give + 300).toBeLessThanOrEqual(STORY_TOTAL.device);
    expect(DEVICE.hand + DEVICE.glide).toBeGreaterThan(DEVICE.give);
    expect(UNBOUND.start + UNBOUND.len).toBe(STORY_TOTAL.unbound);
  });

  it("设备页：光点滑到电量处之后才开始扫描，扫描完才上移", () => {
    expect(DEVICE.line + DEVICE.lineDur).toBeGreaterThan(DEVICE.scan[0]);
    expect(DEVICE.line).toBeLessThan(DEVICE.scan[0]);
    expect(DEVICE.scan[1]).toBeLessThanOrEqual(DEVICE.hand);
  });

  it("几条缓动曲线都从 0 到 1，到头就停", () => {
    for (const f of [spring, glide, slide]) {
      expect(f(0)).toBeCloseTo(0, 6);
      expect(f(1)).toBeCloseTo(1, 6);
      expect(f(-3)).toBeCloseTo(0, 6);
      expect(f(7)).toBeCloseTo(1, 6);
    }
    // 回弹的那条会略微过头再回来；滑行的那条不过头
    let overshoot = 0;
    for (let p = 0; p <= 1; p += 0.01) {
      overshoot = Math.max(overshoot, spring(p));
      expect(glide(p)).toBeLessThanOrEqual(1 + 1e-9);
    }
    expect(overshoot).toBeGreaterThan(1);
  });
});
