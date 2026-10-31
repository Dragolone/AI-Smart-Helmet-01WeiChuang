import { describe, expect, it } from "@jest/globals";

import {
  accidentPollInterval,
  deliveryPollInterval,
  deliveryStateOf,
  initialOf,
  smsRows,
} from "../sos-delivery";

const sms = (status: "pending" | "sent" | "failed") => ({
  channel: "sms" as const,
  status,
});
const push = (status: "pending" | "sent" | "failed") => ({
  channel: "push" as const,
  status,
});

describe("smsRows", () => {
  it("keeps only the text messages to contacts", () => {
    expect(smsRows([sms("sent"), push("sent"), sms("failed")])).toEqual([
      sms("sent"),
      sms("failed"),
    ]);
    expect(smsRows(undefined)).toEqual([]);
  });
});

describe("deliveryStateOf", () => {
  it("draws no conclusion before the records arrive", () => {
    expect(deliveryStateOf(undefined)).toBe("unknown");
  });
  it("says nobody was notified when there is no contact to text", () => {
    expect(deliveryStateOf([])).toBe("none");
    // 发给本人的推送不算「有人收到」
    expect(deliveryStateOf([push("sent")])).toBe("none");
  });
  it("counts as notified once any contact's message went out", () => {
    expect(deliveryStateOf([sms("failed"), sms("sent"), sms("pending")])).toBe(
      "sent",
    );
  });
  it("is still sending while none went out but some are in flight", () => {
    expect(deliveryStateOf([sms("pending"), sms("failed")])).toBe("sending");
  });
  it("is failed only when every message failed", () => {
    expect(deliveryStateOf([sms("failed"), sms("failed")])).toBe("failed");
    // 本人的推送成功了也不改变「短信全没发出去」
    expect(deliveryStateOf([sms("failed"), push("sent")])).toBe("failed");
  });
});

describe("deliveryPollInterval", () => {
  it("keeps looking while unknown or in flight", () => {
    expect(deliveryPollInterval(undefined)).toBe(3_000);
    expect(deliveryPollInterval([sms("sent"), sms("pending")])).toBe(3_000);
  });
  it("looks less often when only failures are left (the server retries)", () => {
    expect(deliveryPollInterval([sms("sent"), sms("failed")])).toBe(10_000);
  });
  it("stops once everything went out, or there was nobody to notify", () => {
    expect(deliveryPollInterval([sms("sent"), sms("sent")])).toBe(false);
    expect(deliveryPollInterval([])).toBe(false);
    // 本人的推送还在发不拖着页面一直查
    expect(deliveryPollInterval([sms("sent"), push("pending")])).toBe(false);
  });
});

describe("initialOf", () => {
  it("takes the first character", () => {
    expect(initialOf("妈妈")).toBe("妈");
    expect(initialOf("  wang")).toBe("W");
  });
  it("does not split an emoji and falls back when empty", () => {
    expect(initialOf("😀队长")).toBe("😀");
    expect(initialOf("")).toBe("?");
    expect(initialOf(null)).toBe("?");
  });
});

describe("记录结构不对（10-22 夜测：服务端出错把类型写乱）", () => {
  it("不是数组：没有行、状态未知、照常 3 秒后再看；行不是对象的跳过；名字 / 号码不是字符串的当没有", () => {
    for (const bad of [{ not: "a list" }, "x", 42, null]) {
      const v = bad as never;
      expect(smsRows(v)).toEqual([]);
      expect(deliveryStateOf(v)).toBe("unknown");
      expect(deliveryPollInterval(v)).toBe(3_000);
    }
    const rows = smsRows([
      null,
      "x",
      { channel: "push", status: "sent" },
      { channel: "sms", status: "sent", contactName: 12345, target: { a: 1 } },
      {
        channel: "sms",
        status: "failed",
        contactName: "妈妈",
        target: "138****0000",
      },
    ] as never);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ contactName: null, target: "" });
    expect(rows[1]).toMatchObject({
      contactName: "妈妈",
      target: "138****0000",
    });
  });
});

describe("accidentPollInterval", () => {
  it("looks every 5 s while the countdown is running (the push only refreshes the list)", () => {
    expect(accidentPollInterval({ status: "pending", notifications: [] })).toBe(
      5_000,
    );
  });
  it("once notified, follows the delivery cadence and stops when all went out", () => {
    expect(
      accidentPollInterval({
        status: "notified",
        notifications: [sms("pending")],
      }),
    ).toBe(3_000);
    expect(
      accidentPollInterval({
        status: "notified",
        notifications: [sms("failed")],
      }),
    ).toBe(10_000);
    expect(
      accidentPollInterval({
        status: "notified",
        notifications: [sms("sent")],
      }),
    ).toBe(false);
    expect(
      accidentPollInterval({ status: "notified", notifications: [] }),
    ).toBe(false);
  });
  it("does not poll a cancelled single, an unknown status, or when nothing arrived (the error state has a retry button)", () => {
    expect(
      accidentPollInterval({ status: "cancelled", notifications: [] }),
    ).toBe(false);
    expect(
      accidentPollInterval({ status: "weird" as never, notifications: [] }),
    ).toBe(false);
    expect(accidentPollInterval(undefined)).toBe(false);
  });
});
