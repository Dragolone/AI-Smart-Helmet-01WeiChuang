// 地图页「此刻的速度」只在定位够新时才算数（2026-10-16 模拟器 + 本地后端）：
// 头盔在线、定位停在 25 分钟前（隧道 / 室内 / GPS 丢了），最后一个点 speed = 5 m/s，
// 原来状态胶囊写「骑行中」、旁边写「位置更新：25 分钟前」、统计栏写 18 km/h。
import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "fs";
import { join } from "path";

import {
  isFreshFix,
  LIVE_FIX_MAX_AGE_MS,
  LIVE_FIX_MAX_AHEAD_MS,
  liveSpeedOf,
} from "../coords";

const NOW = Date.parse("2026-10-16T08:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const fix = (offsetMs: number, speed = 5) => ({
  speed,
  timestamp: at(offsetMs),
});

describe("isFreshFix：定位时间离此刻够不够近", () => {
  it("常量：2 分钟（运动 5 秒一个点，漏 24 个点才算停）、未来 5 分钟（服务端照收的时钟超前）", () => {
    expect(LIVE_FIX_MAX_AGE_MS).toBe(120_000);
    expect(LIVE_FIX_MAX_AHEAD_MS).toBe(300_000);
  });

  it("刚报的点、5 秒前、整 2 分钟前都算新；2 分钟零 1 毫秒前不算", () => {
    expect(isFreshFix(at(0), NOW)).toBe(true);
    expect(isFreshFix(at(-5_000), NOW)).toBe(true);
    expect(isFreshFix(at(-LIVE_FIX_MAX_AGE_MS), NOW)).toBe(true);
    expect(isFreshFix(at(-LIVE_FIX_MAX_AGE_MS - 1), NOW)).toBe(false);
  });

  it("25 分钟前（隧道里那一幕）不算新", () => {
    expect(isFreshFix(at(-25 * 60_000), NOW)).toBe(false);
  });

  it("头盔时钟快 4 分钟的点算新；快 5 分钟零 1 毫秒的不算（服务端也不会照收）", () => {
    expect(isFreshFix(at(4 * 60_000), NOW)).toBe(true);
    expect(isFreshFix(at(LIVE_FIX_MAX_AHEAD_MS), NOW)).toBe(true);
    expect(isFreshFix(at(LIVE_FIX_MAX_AHEAD_MS + 1), NOW)).toBe(false);
  });

  it("时间戳坏的：空串、null、undefined、认不出的字符串都不算新", () => {
    expect(isFreshFix("", NOW)).toBe(false);
    expect(isFreshFix(null, NOW)).toBe(false);
    expect(isFreshFix(undefined, NOW)).toBe(false);
    expect(isFreshFix("昨天下午", NOW)).toBe(false);
    expect(isFreshFix("2026-13-45T99:00:00Z", NOW)).toBe(false);
  });

  it("头盔时钟错乱成 1970 年的点不算新", () => {
    expect(isFreshFix("1970-01-01T00:00:00.000Z", NOW)).toBe(false);
  });

  it("此刻本身认不出（NaN / 无穷）时一律不算新，不会因为 NaN 比较全是 false 而误判成新", () => {
    expect(isFreshFix(at(0), Number.NaN)).toBe(false);
    expect(isFreshFix(at(0), Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("liveSpeedOf：够新且像真的才给速度", () => {
  it("新鲜的点：原样给 speed（m/s）", () => {
    expect(liveSpeedOf(fix(-3_000, 5), NOW)).toBe(5);
    expect(liveSpeedOf(fix(0, 0), NOW)).toBe(0);
  });

  it("过旧的点：给 null（统计栏写「—」，也不凭它判骑行中）", () => {
    expect(liveSpeedOf(fix(-25 * 60_000, 5), NOW)).toBeNull();
    expect(liveSpeedOf(fix(-LIVE_FIX_MAX_AGE_MS - 1, 12), NOW)).toBeNull();
  });

  it("时间戳坏的点：null", () => {
    expect(liveSpeedOf({ speed: 5, timestamp: "" }, NOW)).toBeNull();
    expect(liveSpeedOf({ speed: 5, timestamp: "not-a-date" }, NOW)).toBeNull();
  });

  it("speed 是 NaN / 无穷：null，不写「NaN km/h」", () => {
    expect(liveSpeedOf(fix(0, Number.NaN), NOW)).toBeNull();
    expect(liveSpeedOf(fix(0, Number.POSITIVE_INFINITY), NOW)).toBeNull();
  });

  it("speed 是负数（模组无效值）：null", () => {
    expect(liveSpeedOf(fix(0, -1), NOW)).toBeNull();
    expect(liveSpeedOf(fix(0, -0.01), NOW)).toBeNull();
  });

  it("speed 超过漂移上限 55 m/s（200 km/h）：null；正好 55 照给", () => {
    expect(liveSpeedOf(fix(0, 400), NOW)).toBeNull();
    expect(liveSpeedOf(fix(0, 55), NOW)).toBe(55);
  });

  it("没有定位：null", () => {
    expect(liveSpeedOf(null, NOW)).toBeNull();
    expect(liveSpeedOf(undefined, NOW)).toBeNull();
  });

  it("speed 字段缺失（载荷不全）：null", () => {
    expect(
      liveSpeedOf(
        { timestamp: at(0) } as unknown as { speed: number; timestamp: string },
        NOW,
      ),
    ).toBeNull();
  });
});

describe("地图页接线不变式", () => {
  const src = readFileSync(
    join(__dirname, "..", "..", "..", "app", "(tabs)", "map.tsx"),
    "utf8",
  );

  it("骑行判断和统计栏速度都走 liveSpeedOf，不再直接读最后一个点的 speed", () => {
    expect(src).toContain("liveSpeedOf(liveLoc, clockMs)");
    expect(src).toMatch(/\(liveSpeed \?\? 0\) >= MOVING_MPS/);
    expect(src).not.toMatch(/liveLoc\??\.speed/);
  });

  it("「此刻」用服务端时钟（只读 serverNow），并有定时器推着重算", () => {
    expect(src).toContain(
      'import { serverNow } from "@/services/server-clock"',
    );
    expect(src).toMatch(/setInterval\(tick, 10_000\)/);
  });
});
