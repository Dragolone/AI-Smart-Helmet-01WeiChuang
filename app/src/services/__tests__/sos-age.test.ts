// 补传旧事件文案：与服务端 describeEventAge 同口径（决策 #52；2026-10-07 iPhone 4.14 实测后补到 App 侧）
import { describe, expect, it, jest } from "@jest/globals";

jest.mock("@/i18n", () => ({
  translate: (k: string, p?: Record<string, unknown>) =>
    p ? `${k}:${JSON.stringify(p)}` : k,
}));

import { eventAge, lateEventNote } from "../sos-age";

const NOW = Date.parse("2026-10-07T01:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("eventAge", () => {
  it("缺省 / 解析不了 → null", () => {
    expect(eventAge(undefined, NOW)).toBeNull();
    expect(eventAge("not-a-date", NOW)).toBeNull();
  });
  it("早不到 5 分钟视为时钟偏差，不提；事件时间在未来也不提", () => {
    expect(eventAge(ago(4 * 60_000), NOW)).toBeNull();
    expect(eventAge(ago(-30_000), NOW)).toBeNull();
  });
  it("5 分钟 ～ 90 分钟按分钟；再往上按小时；超过 72 小时不可信不提", () => {
    expect(eventAge(ago(5 * 60_000), NOW)).toEqual({ unit: "minutes", n: 5 });
    expect(eventAge(ago(89 * 60_000), NOW)).toEqual({ unit: "minutes", n: 89 });
    expect(eventAge(ago(90 * 60_000), NOW)).toEqual({ unit: "hours", n: 2 });
    expect(eventAge(ago(3 * 3_600_000), NOW)).toEqual({ unit: "hours", n: 3 });
    expect(eventAge(ago(72 * 3_600_000), NOW)).toEqual({ unit: "hours", n: 72 });
    expect(eventAge(ago(72 * 3_600_000 + 1), NOW)).toBeNull();
  });
});

describe("lateEventNote", () => {
  it("按档位选文案键并带数值；不该提时 null", () => {
    expect(lateEventNote(ago(3 * 3_600_000), NOW)).toBe(
      'sos.lateEventHours:{"n":3}',
    );
    expect(lateEventNote(ago(20 * 60_000), NOW)).toBe(
      'sos.lateEventMinutes:{"n":20}',
    );
    expect(lateEventNote(ago(1000), NOW)).toBeNull();
  });
});
