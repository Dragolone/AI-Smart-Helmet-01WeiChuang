// BLE 上行中转队列单测(决策 #31/#35):事件过滤、溢出丢最旧、flush 出队/失败保留
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { Mock } from "jest-mock";
import type { EventEnvelope, EventType } from "@helmet/shared";

import { relayApi } from "@/api/relay";
import {
  enqueueRelayEvent,
  flushRelayQueue,
  setCriticalAcceptedHandler,
} from "../ble-relay-uplink";

jest.mock("@/api/relay", () => ({
  relayApi: { push: jest.fn() },
}));
const pushMock = relayApi.push as unknown as Mock<typeof relayApi.push>;

let seq = 0;
const env = (
  eventType: EventType,
  deviceId = "helmet_test",
): EventEnvelope<EventType> => ({
  schemaVersion: 1,
  eventId: `evt-${++seq}`,
  deviceId,
  eventType,
  timestamp: new Date().toISOString(),
  firmwareVersion: "test",
  payload: {},
});

const drain = async (): Promise<void> => {
  // 清空跨用例遗留队列(模块级状态):成功 flush 直到没有再发生调用
  pushMock.mockResolvedValue({ accepted: 999, duplicate: 0, invalid: 0 });
  for (let i = 0; i < 25; i += 1) {
    const before = pushMock.mock.calls.length;
    await flushRelayQueue();
    if (pushMock.mock.calls.length === before) break;
  }
  pushMock.mockReset();
};

beforeEach(async () => {
  await drain();
  pushMock.mockResolvedValue({ accepted: 1, duplicate: 0, invalid: 0 });
});

describe("2026-10-14 审查：补传回 duplicate 也要拉倒计时", () => {
  it("第一次响应丢失、重传回 accepted=0 duplicate=1：仍通知「云端已建单」", async () => {
    const hits: string[] = [];
    setCriticalAcceptedHandler((deviceId) => hits.push(deviceId));
    pushMock.mockResolvedValue({ accepted: 0, duplicate: 1, invalid: 0 });
    enqueueRelayEvent(env("possible_fall", "helmet_dup"));
    await flushRelayQueue();
    expect(hits).toEqual(["helmet_dup"]);
    setCriticalAcceptedHandler(null);
  });

  it("整批都是 invalid：不通知", async () => {
    const hits: string[] = [];
    setCriticalAcceptedHandler((deviceId) => hits.push(deviceId));
    pushMock.mockResolvedValue({ accepted: 0, duplicate: 0, invalid: 1 });
    enqueueRelayEvent(env("possible_fall", "helmet_inv"));
    await flushRelayQueue();
    expect(hits).toEqual([]);
    setCriticalAcceptedHandler(null);
  });
});

describe("enqueueRelayEvent + flushRelayQueue", () => {
  it("中转范围内事件成功提交后出队(再次 flush 无请求)", async () => {
    enqueueRelayEvent(env("possible_fall"));
    await flushRelayQueue();
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock.mock.calls[0][0].envelopes).toHaveLength(1);
    await flushRelayQueue();
    expect(pushMock).toHaveBeenCalledTimes(1);
  });

  it("范围外事件(video_ready 不走 BLE,决策 #31)本地丢弃", async () => {
    enqueueRelayEvent(env("video_ready"));
    await flushRelayQueue();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("提交失败整批保留,下轮按原 eventId 补传（高危事件入队即触发首发,不等周期）", async () => {
    pushMock.mockRejectedValueOnce(new Error("offline"));
    enqueueRelayEvent(env("manual_sos")); // 高危事件入队立即 flush 一次（深睡定时器不走,靠事件驱动）
    await new Promise((r) => setTimeout(r, 0));
    expect(pushMock).toHaveBeenCalledTimes(1);
    const firstBatch = pushMock.mock.calls[0][0].envelopes;
    await flushRelayQueue();
    expect(pushMock).toHaveBeenCalledTimes(2);
    expect(pushMock.mock.calls[1][0].envelopes).toEqual(firstBatch);
  });

  it("一次 flush 只提交一个设备的事件(接口按设备鉴权)", async () => {
    enqueueRelayEvent(env("device_status", "helmet_a"));
    enqueueRelayEvent(env("device_status", "helmet_b"));
    await flushRelayQueue();
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock.mock.calls[0][0].deviceId).toBe("helmet_a");
    await flushRelayQueue();
    expect(pushMock.mock.calls[1][0].deviceId).toBe("helmet_b");
  });

  it("单批不超过 Contract 上限 100(API.md §12.1)", async () => {
    for (let i = 0; i < 150; i += 1) enqueueRelayEvent(env("location_update"));
    await flushRelayQueue();
    expect(pushMock.mock.calls[0][0].envelopes).toHaveLength(100);
  });
});
