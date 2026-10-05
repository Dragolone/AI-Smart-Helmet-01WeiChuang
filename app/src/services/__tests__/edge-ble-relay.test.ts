// 边界补测（2026-10-03）：BLE 下行命令。ble-relay.test.ts 钉了单键成功/失败与去重；
// 这里补空参数、多键写到一半出错/断连、两条命令交错、底层意外抛错。
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { Mock } from "jest-mock";
import type { WsDeviceCommandData } from "@helmet/shared";

import { relayApi } from "@/api/relay";
import { isHelmetConnected, writeHelmetRegister } from "@/services/ble-link";
import { handleDeviceCommand } from "../ble-relay";

jest.mock("@/api/relay", () => ({
  relayApi: { ack: jest.fn() },
}));
jest.mock("@/services/ble-link", () => ({
  isHelmetConnected: jest.fn(),
  writeHelmetRegister: jest.fn(),
}));
const ackMock = relayApi.ack as unknown as Mock<typeof relayApi.ack>;
const connectedMock = isHelmetConnected as unknown as Mock<typeof isHelmetConnected>;
const writeMock = writeHelmetRegister as unknown as Mock<typeof writeHelmetRegister>;

const cmd = (
  id: string,
  params: Record<string, unknown> | null | undefined,
  deviceId = "helmet_edge",
): WsDeviceCommandData =>
  ({
    deviceId,
    commandId: id,
    type: "set_config",
    params,
    issuedAt: "2026-10-03T00:00:00.000Z",
  }) as WsDeviceCommandData;

const stages = () => ackMock.mock.calls.map((c) => [c[1], c[2]]);

beforeEach(() => {
  ackMock.mockReset();
  ackMock.mockResolvedValue({ commandId: "x", status: "success" });
  connectedMock.mockReset();
  connectedMock.mockReturnValue(true);
  writeMock.mockReset();
  writeMock.mockResolvedValue({ delivered: true, executed: true });
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("handleDeviceCommand 边界", () => {
  it.each([
    ["空对象", {}],
    ["null", null],
    ["缺失", undefined],
  ])("参数为%s：不写任何寄存器，回执 failed + EMPTY_PARAMS（绝不当成功）", async (label, params) => {
    const id = `edge-empty-${label}`;
    expect(await handleDeviceCommand(cmd(id, params))).toBe(true);
    expect(writeMock).not.toHaveBeenCalled();
    expect(stages()).toEqual([
      [id, { stage: "delivered" }],
      [id, { stage: "executed", result: "failed", errorCode: "EMPTY_PARAMS" }],
    ]);
  });

  it("多键：第二个键头盔报错 → 立刻停，第三个键不再写；回执指明是哪个键", async () => {
    writeMock
      .mockResolvedValueOnce({ delivered: true, executed: true })
      .mockResolvedValueOnce({ delivered: true, executed: false, errorCode: "ERR_BATTERY_LOW" });
    await handleDeviceCommand(cmd("edge-stop", { volume: 50, light: 3, vibration: 1 }));
    expect(writeMock.mock.calls.map((c) => c[1])).toEqual([0x24, 0x26]);
    expect(stages()[1]).toEqual([
      "edge-stop",
      { stage: "executed", result: "failed", errorCode: "ERR_BATTERY_LOW:light" },
    ]);
  });

  it("多键：写到第二个键时头盔断连 → 不回执、返回 false；补推后从第一个键重新写（写寄存器幂等）", async () => {
    writeMock
      .mockResolvedValueOnce({ delivered: true, executed: true })
      .mockResolvedValueOnce({ delivered: false });
    const c = cmd("edge-midway", { volume: 50, light: 3 });
    expect(await handleDeviceCommand(c)).toBe(false);
    expect(ackMock).not.toHaveBeenCalled();
    writeMock.mockResolvedValue({ delivered: true, executed: true });
    expect(await handleDeviceCommand(c)).toBe(true);
    expect(writeMock.mock.calls.map((c2) => c2[1])).toEqual([0x24, 0x26, 0x24, 0x26]);
    expect(stages().map((s) => s[1])).toEqual([
      { stage: "delivered" },
      { stage: "executed", result: "success" },
    ]);
  });

  it("布尔设置按 0/1 字节写入；一条命令里布尔与整数混排按下发顺序逐键写", async () => {
    await handleDeviceCommand(
      cmd("edge-mixed", { sosButton: false, heartbeatPeriod: 255, disconnectBeep: true }),
    );
    expect(writeMock.mock.calls).toEqual([
      ["helmet_edge", 0x2c, [0]],
      ["helmet_edge", 0x20, [255]],
      ["helmet_edge", 0x2d, [1]],
    ]);
  });

  it("两条不同命令交错处理：各回各的两条回执，commandId 与设备不串", async () => {
    const release: (() => void)[] = [];
    writeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release.push(() => resolve({ delivered: true, executed: true }));
        }),
    );
    const a = handleDeviceCommand(cmd("edge-A", { volume: 10 }, "helmet_1"));
    const b = handleDeviceCommand(cmd("edge-B", { volume: 20 }, "helmet_2"));
    release[1](); // B 的写入先完成
    release[0]();
    expect(await Promise.all([a, b])).toEqual([true, true]);
    const byCommand = (id: string) =>
      ackMock.mock.calls.filter((c) => c[1] === id).map((c) => [c[0], c[2].stage]);
    expect(byCommand("edge-A")).toEqual([
      ["helmet_1", "delivered"],
      ["helmet_1", "executed"],
    ]);
    expect(byCommand("edge-B")).toEqual([
      ["helmet_2", "delivered"],
      ["helmet_2", "executed"],
    ]);
  });

  it("写寄存器意外抛错（底层 bug / 原生异常）：不回执、不谎报，去重集不占位，可再次处理", async () => {
    writeMock.mockRejectedValueOnce(new Error("native crash"));
    const c = cmd("edge-throw", { volume: 30 });
    expect(await handleDeviceCommand(c)).toBe(false);
    expect(ackMock).not.toHaveBeenCalled();
    expect(await handleDeviceCommand(c)).toBe(true);
    expect(ackMock).toHaveBeenCalledTimes(2);
  });

  it("越界值（服务端校验被绕过 / 两端版本不一致）：不写头盔，回执 failed", async () => {
    await handleDeviceCommand(cmd("edge-range", { volume: 101 }));
    expect(writeMock).not.toHaveBeenCalled();
    expect(stages()[1][1]).toEqual({
      stage: "executed",
      result: "failed",
      errorCode: "UNSUPPORTED_SETTING:volume",
    });
  });
});
