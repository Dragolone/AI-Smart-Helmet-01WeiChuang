// 外观设置（跟随系统 / 深色 / 浅色）和蓝牙工程模式的展示状态。
// 外观这里只留 stores/__tests__/edge-theme-locale-1016.test.ts 没覆盖到的几条：存过的合法值读回来用、
// 改外观先同步原生和内存再落盘、旧版 RN 没有 setColorScheme 也能切。默认深色、乱值 / 读失败、落盘失败不抛那几条在那边。
// 注意：theme-store 记着「读盘前用户已经选过」（模块级），所以这个文件里读盘的用例要排在 setMode 的用例前面。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { Appearance } from "react-native";

import { BENCH_LOG_LIMIT, useBleBenchStore } from "../ble-bench-store";
import { THEME_MODES, useThemeStore } from "../theme-store";

const mockKv = new Map<string, string>();
const mockFail = { get: false, set: false };
jest.mock("expo-secure-store", () => ({
  getItemAsync: async (k: string) => {
    if (mockFail.get) throw new Error("keychain locked");
    return mockKv.get(k) ?? null;
  },
  setItemAsync: async (k: string, v: string) => {
    if (mockFail.set) throw new Error("write failed");
    mockKv.set(k, v);
  },
}));

let native: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  mockKv.clear();
  mockFail.get = false;
  mockFail.set = false;
  useThemeStore.setState({ mode: "dark", hydrated: false });
  native = jest
    .spyOn(Appearance, "setColorScheme")
    .mockImplementation(() => undefined);
});
afterEach(() => {
  native.mockRestore();
});

describe("外观设置", () => {
  it.each(THEME_MODES.map((m) => [m]))(
    "存过 %s：读回来用它；跟随系统时原生设为 unspecified",
    async (mode) => {
      mockKv.set("helmet.theme", mode);
      await useThemeStore.getState().hydrate();
      expect(useThemeStore.getState().mode).toBe(mode);
      expect(native).toHaveBeenCalledWith(
        mode === "system" ? "unspecified" : mode,
      );
    },
  );

  it("改外观：先同步原生和内存，再落盘", async () => {
    await useThemeStore.getState().setMode("light");
    expect(useThemeStore.getState().mode).toBe("light");
    expect(native).toHaveBeenCalledWith("light");
    expect(mockKv.get("helmet.theme")).toBe("light");
  });

  it("旧版 RN 没有 setColorScheme（抛错）也不影响切换", async () => {
    native.mockImplementation(() => {
      throw new Error("not a function");
    });
    await useThemeStore.getState().setMode("system");
    expect(useThemeStore.getState().mode).toBe("system");
    await expect(useThemeStore.getState().hydrate()).resolves.toBeUndefined();
  });
});

describe("蓝牙工程模式状态", () => {
  beforeEach(() => {
    useBleBenchStore.setState({ autoAck: true });
    useBleBenchStore.getState().reset();
  });

  it("扫到的设备按 id 覆盖更新", () => {
    const p = {
      id: "AA",
      name: "HELMET",
      rssi: -60,
      serviceUUIDs: ["FEE0"],
      hasHelmetService: true,
      lastSeenAt: 1,
    };
    useBleBenchStore.getState().upsertPeripheral(p);
    useBleBenchStore
      .getState()
      .upsertPeripheral({ ...p, rssi: -40, lastSeenAt: 2 });
    expect(Object.keys(useBleBenchStore.getState().peripherals)).toEqual([
      "AA",
    ]);
    expect(useBleBenchStore.getState().peripherals.AA.rssi).toBe(-40);
  });

  it("日志编号递增、超过上限只留最近的", () => {
    const { appendLog } = useBleBenchStore.getState();
    for (let i = 0; i < BENCH_LOG_LIMIT + 5; i++)
      appendLog({ at: i, dir: "rx", hex: "", text: `#${i}` });
    const log = useBleBenchStore.getState().log;
    expect(log).toHaveLength(BENCH_LOG_LIMIT);
    expect(log[0].text).toBe("#5");
    expect(log[log.length - 1].text).toBe(`#${BENCH_LOG_LIMIT + 4}`);
    for (let i = 1; i < log.length; i++)
      expect(log[i].id).toBe(log[i - 1].id + 1);
    useBleBenchStore.getState().clearLog();
    expect(useBleBenchStore.getState().log).toEqual([]);
  });

  it("重置会话：其它都回初值，但自动 ACK 这个偏好保留", () => {
    useBleBenchStore.getState().patch({
      phase: "connected",
      connectedId: "AA",
      mtu: 185,
      autoAck: false,
    });
    useBleBenchStore.getState().reset();
    expect(useBleBenchStore.getState()).toMatchObject({
      phase: "idle",
      connectedId: null,
      mtu: null,
      autoAck: false,
    });
  });
});
