// sosApi.snapshot：某一单 SOS 的权威状态。钉住 2026-09-24 iPhone 卡死的根因——
// 不在进行中的单必须去事故记录拿最终状态，不能回退到可能被迟到 pending 污染的本地缓存。
import { afterEach, describe, expect, it, jest } from "@jest/globals";

const mockApi = jest.fn(
  async (_path: string, _init?: unknown): Promise<unknown> => null,
);
jest.mock("../client", () => ({
  ...jest.requireActual<typeof import("../client")>("../client"),
  api: (p: string, i?: unknown) => mockApi(p, i),
}));

import { ApiRequestError } from "../client";
import { sosApi } from "../sos";

const pending = { sosId: "s1", deviceId: "d1", status: "pending" };
const cancelled = { sosId: "s1", deviceId: "d1", status: "cancelled" };

afterEach(() => {
  jest.clearAllMocks();
});

describe("sosApi.snapshot", () => {
  it("进行中且是同一单 → 直接用 /sos/active，不再查事故记录", async () => {
    mockApi.mockResolvedValueOnce({ sos: pending });
    expect(await sosApi.snapshot("s1", "d1")).toEqual(pending);
    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi.mock.calls[0][0]).toBe("/devices/d1/sos/active");
  });

  it("active 为空（已取消/已通知）→ 去事故记录拿最终状态", async () => {
    mockApi
      .mockResolvedValueOnce({ sos: null })
      .mockResolvedValueOnce(cancelled);
    expect(await sosApi.snapshot("s1", "d1")).toEqual(cancelled);
    expect(mockApi.mock.calls[1][0]).toBe("/accidents/s1");
  });

  it("active 是另一单（新求救）→ 本单同样查事故记录", async () => {
    mockApi
      .mockResolvedValueOnce({ sos: { ...pending, sosId: "s2" } })
      .mockResolvedValueOnce(cancelled);
    expect(await sosApi.snapshot("s1", "d1")).toEqual(cancelled);
  });

  it("没有 deviceId（推送 / 深链只带 sosId）→ 不查 /devices/undefined/sos/active，直接去事故记录（2026-10-16 C1）", async () => {
    mockApi.mockResolvedValueOnce(cancelled);
    expect(await sosApi.snapshot("s1")).toEqual(cancelled);
    expect(await sosApi.snapshot("s1", null).catch(() => "x")).not.toBe("x");
    expect(mockApi.mock.calls.map((c) => c[0])).toEqual([
      "/accidents/s1",
      "/accidents/s1",
    ]);
  });

  it("倒计时中头盔被解绑：设备接口 404 → 按单号查事故记录（处置权还在本人），不把 404 抛给页面（10-16 评审）", async () => {
    mockApi
      .mockRejectedValueOnce(
        new ApiRequestError(404, { code: "DEVICE_NOT_FOUND", message: "x" }),
      )
      .mockResolvedValueOnce(pending);
    expect(await sosApi.snapshot("s1", "d1")).toEqual(pending);
    expect(mockApi.mock.calls[1][0]).toBe("/accidents/s1");
  });

  it("设备接口别的错误（断网 / 500）照旧抛出，不去查事故记录", async () => {
    mockApi.mockRejectedValueOnce(
      new ApiRequestError(500, { code: "INTERNAL_ERROR", message: "x" }),
    );
    await expect(sosApi.snapshot("s1", "d1")).rejects.toBeInstanceOf(
      ApiRequestError,
    );
    expect(mockApi).toHaveBeenCalledTimes(1);
  });

  it("两条都失败 → 抛出，由页面决定是否信缓存", async () => {
    mockApi.mockRejectedValueOnce(new Error("offline"));
    await expect(sosApi.snapshot("s1", "d1")).rejects.toThrow("offline");
  });
});
