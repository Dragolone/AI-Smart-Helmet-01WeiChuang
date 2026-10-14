import { describe, expect, it } from "@jest/globals";

import {
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
