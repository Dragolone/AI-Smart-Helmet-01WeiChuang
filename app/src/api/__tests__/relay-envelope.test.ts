// App 自己发起的事件（长按求救 / 开发注入）：eventId 在构造时定死，同一次动作重试复用同一个 eventId
//（服务端按它幂等；换了 eventId，倒计时中再来一条 manual_sos 会被当成实体键直接跳过 60 秒，10-06 评审 F-5）
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import { buildRelayEnvelope, relayApi } from "../relay";

// jest.mock 会被提升到 import 之前；工厂里的箭头函数到真正发请求时才读 mockApi
const mockApi = jest.fn(async (_path: string, _opts?: unknown) => ({
  accepted: 1,
  duplicate: 0,
  invalid: 0,
}));
jest.mock("../client", () => ({
  api: (path: string, opts?: unknown) => mockApi(path, opts),
}));

describe("buildRelayEnvelope", () => {
  // 断言按 mockApi.mock.calls 数这一条用例发出的请求：别的用例先跑留下的调用记录不能算进来
  beforeEach(() => {
    mockApi.mockClear();
  });

  it("timestamp 用服务端时钟：手机慢 5 分钟时，刚按下的长按求救不能被写成 5 分钟前的事件", () => {
    const { noteServerDate, __resetServerClockForTests } = jest.requireActual<
      typeof import("@/services/server-clock")
    >("@/services/server-clock");
    const phoneNow = Date.UTC(2026, 9, 14, 6, 0, 0);
    const spy = jest.spyOn(Date, "now").mockReturnValue(phoneNow);
    try {
      // 服务端比手机快 5 分钟
      noteServerDate(new Date(phoneNow + 5 * 60_000).toUTCString(), phoneNow);
      const env = buildRelayEnvelope("helmet_001", "manual_sos");
      expect(env.timestamp).toBe(new Date(phoneNow + 5 * 60_000).toISOString());
    } finally {
      spy.mockRestore();
      __resetServerClockForTests();
    }
  });

  it("一次构造一个 eventId（v4 UUID），重复提交同一个 envelope 带的是同一个 eventId", async () => {
    const env = buildRelayEnvelope("helmet_001", "manual_sos");
    expect(env.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(env).toMatchObject({
      schemaVersion: 1,
      deviceId: "helmet_001",
      eventType: "manual_sos",
      firmwareVersion: "app-relay-dev",
      payload: {},
    });
    await relayApi.push({ deviceId: "helmet_001", envelopes: [env] });
    await relayApi.push({ deviceId: "helmet_001", envelopes: [env] });
    const ids = mockApi.mock.calls.map(
      (c) =>
        (c[1] as { body: { envelopes: { eventId: string }[] } }).body
          .envelopes[0].eventId,
    );
    expect(ids).toEqual([env.eventId, env.eventId]);
  });

  it("两次构造是两个不同的 eventId（两次长按就是两次求救）", () => {
    expect(buildRelayEnvelope("d", "manual_sos").eventId).not.toBe(
      buildRelayEnvelope("d", "manual_sos").eventId,
    );
  });

  it("pushEvent 仍用同一个构造器", async () => {
    await relayApi.pushEvent("helmet_002", "possible_fall", {
      confidence: 0.9,
    });
    const body = (
      mockApi.mock.calls[0][1] as {
        body: { envelopes: Record<string, unknown>[] };
      }
    ).body;
    expect(body.envelopes[0]).toMatchObject({
      deviceId: "helmet_002",
      eventType: "possible_fall",
      payload: { confidence: 0.9 },
    });
  });
});
