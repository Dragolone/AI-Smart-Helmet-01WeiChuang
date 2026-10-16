// 保命链路里几个纯展示推导的边界（2026-10-16）：倒计时读钟时刻、补传事件的「年龄」、通知发送结论、头像首字。
// 这些模块属于保命链路，本轮只断言现状、不改行为；发现的问题记在 src/__tests__/EDGE_FINDINGS_1016.md。
import { describe, expect, it, jest } from "@jest/globals";

import { msToNextSecond } from "../countdown";
import { eventAge, lateEventNote } from "../sos-age";
import {
  deliveryPollInterval,
  deliveryStateOf,
  initialOf,
  smsRows,
} from "../sos-delivery";

jest.mock("@/i18n", () => ({
  translate: (k: string, p?: Record<string, unknown>) =>
    p ? `${k}:${JSON.stringify(p)}` : k,
}));

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-10-16T01:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("msToNextSecond 的边", () => {
  it("离截止还剩 1 毫秒：1 毫秒后换数字；还剩 999 毫秒：999 毫秒后", () => {
    expect(msToNextSecond(1_001, 1_000)).toBe(1);
    expect(msToNextSecond(1_999, 1_000)).toBe(999);
  });

  it("截止时刻已过很久（几小时）：仍然按整秒对齐，结果在 1–1000", () => {
    for (const late of [1, 999, 1_000, 3 * HOUR + 123]) {
      const v = msToNextSecond(0, late);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(1000);
    }
    expect(msToNextSecond(0, 3 * HOUR + 123)).toBe(877);
  });

  it("毫秒带小数（性能计时器）也落在 1–1000 之内（现状：小数原样保留）", () => {
    const v = msToNextSecond(10_000, 1_000.25);
    expect(v).toBeCloseTo(999.75);
  });
});

describe("eventAge：补传旧事件的年龄", () => {
  it("差 1 毫秒到 5 分钟不提；正好 5 分钟提「5 分钟」", () => {
    expect(eventAge(ago(5 * MIN - 1), NOW)).toBeNull();
    expect(eventAge(ago(5 * MIN), NOW)).toEqual({ unit: "minutes", n: 5 });
  });

  it("分钟四舍五入：89 分 29 秒写 89 分钟；89 分 30 秒进成 90 分钟就改写「约 2 小时」（1.5 小时按四舍五入进位，现状）", () => {
    expect(eventAge(ago(89 * MIN + 29_000), NOW)).toEqual({
      unit: "minutes",
      n: 89,
    });
    expect(eventAge(ago(89 * MIN + 30_000), NOW)).toEqual({
      unit: "hours",
      n: 2,
    });
  });

  it("小时四舍五入：2 小时 29 分写 2 小时、2 小时 30 分写 3 小时", () => {
    expect(eventAge(ago(2 * HOUR + 29 * MIN), NOW)).toEqual({
      unit: "hours",
      n: 2,
    });
    expect(eventAge(ago(2 * HOUR + 30 * MIN), NOW)).toEqual({
      unit: "hours",
      n: 3,
    });
  });

  it("时间戳 0（未校时的头盔）、一年前：超过 72 小时不可信，不提", () => {
    expect(eventAge(new Date(0).toISOString(), NOW)).toBeNull();
    expect(eventAge(ago(365 * 24 * HOUR), NOW)).toBeNull();
  });

  it("空串当缺省；带时区偏移的写法和 Z 写法同一结果", () => {
    expect(eventAge("", NOW)).toBeNull();
    expect(eventAge("2026-10-16T08:00:00+08:00", NOW)).toEqual(
      eventAge("2026-10-16T00:00:00Z", NOW),
    );
    expect(eventAge("2026-10-16T08:00:00+08:00", NOW)).toEqual({
      unit: "minutes",
      n: 60,
    });
  });

  it("文案：分钟档和小时档各用各的键，数值原样带进去", () => {
    expect(lateEventNote(ago(10 * MIN), NOW)).toBe(
      'sos.lateEventMinutes:{"n":10}',
    );
    expect(lateEventNote(ago(72 * HOUR), NOW)).toBe(
      'sos.lateEventHours:{"n":72}',
    );
    expect(lateEventNote(undefined, NOW)).toBeNull();
  });
});

describe("通知发送结论：短信与推送混在一起", () => {
  const n = (
    channel: "sms" | "push",
    status: "pending" | "sent" | "failed",
  ) => ({ channel, status });

  it("本人的推送发出去了、联系人短信全失败：仍是「失败」（推送不算通知到联系人）", () => {
    expect(
      deliveryStateOf([
        n("push", "sent"),
        n("sms", "failed"),
        n("sms", "failed"),
      ]),
    ).toBe("failed");
  });

  it("只有推送、没有短信：等于没有联系人", () => {
    expect(deliveryStateOf([n("push", "sent")])).toBe("none");
    expect(deliveryPollInterval([n("push", "pending")])).toBe(false);
  });

  it("一条发出、一条在发、一条失败：结论「已发出」，但还要 3 秒再看（在发的那条还没落定）", () => {
    const rows = [n("sms", "sent"), n("sms", "pending"), n("sms", "failed")];
    expect(deliveryStateOf(rows)).toBe("sent");
    expect(deliveryPollInterval(rows)).toBe(3_000);
  });

  it("全发出：不再看；空数组：没有联系人、不再看", () => {
    expect(deliveryPollInterval([n("sms", "sent")])).toBe(false);
    expect(deliveryStateOf([])).toBe("none");
    expect(deliveryPollInterval([])).toBe(false);
  });

  it("契约外的状态值（服务端以后加了 queued）：当作还在发——结论「发送中」、继续 3 秒轮询（改后，2026-10-16 A3）", () => {
    const rows = [{ channel: "sms" as const, status: "queued" as never }];
    expect(deliveryStateOf(rows)).toBe("sending");
    expect(deliveryPollInterval(rows)).toBe(3000);
  });

  it("smsRows 保持原顺序、不改传入的数组", () => {
    const rows = [n("push", "sent"), n("sms", "failed"), n("sms", "sent")];
    const copy = [...rows];
    expect(smsRows(rows)).toEqual([rows[1], rows[2]]);
    expect(rows).toEqual(copy);
  });
});

describe("initialOf：头像圆里的那一个字", () => {
  it("中文、英文小写、数字、表情各取第一个码点", () => {
    expect(initialOf("张三")).toBe("张");
    expect(initialOf("alice")).toBe("A");
    expect(initialOf("138 0000 0000")).toBe("1");
    expect(initialOf("🚑 急救")).toBe("🚑");
  });

  it("全空白、空串、null：问号", () => {
    expect(initialOf("   ")).toBe("?");
    expect(initialOf("　")).toBe("?");
    expect(initialOf("")).toBe("?");
    expect(initialOf(null)).toBe("?");
  });

  it("组合表情只取第一个码点（👨‍👩‍👧 显示 👨）；带附加符号的字母丢掉附加符号（é 写成 E）（现状）", () => {
    expect(initialOf("👨‍👩‍👧 家")).toBe("👨");
    expect(initialOf("émile")).toBe("E");
  });

  it("名字以零宽 / 方向控制字符开头：先清掉再取首字（改后，2026-10-16 A2，与头像圆同一套 avatarInitial）", () => {
    expect(initialOf("​Alice")).toBe("A");
    expect(initialOf("‮Alice")).toBe("A");
  });

  it("大写后变两个字母的（德文 ß → SS）：头像里只放原字（改后）", () => {
    expect(initialOf("ßen")).toBe("ß");
  });
});
