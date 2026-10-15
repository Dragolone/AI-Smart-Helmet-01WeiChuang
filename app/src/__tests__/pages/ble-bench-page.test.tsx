// 蓝牙工程模式页（硬件联调用，不登录不上云）：进出页面起停会话、外设排序（指定头盔优先 → 广播含 FEE0 → 信号强）、
// 扫描状态、连接信息与特征值、十四条指令（危险的先确认）、一键握手、自定义 hex、日志的样子 / 分享 / 清空。
// 会话逻辑在 services/ble-bench（已有单测），这里替换成可断言的空函数，只看页面怎么调用。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { Alert, Switch, Text, TextInput } from "react-native";
import { act } from "react-test-renderer";

import { routerState } from "@/__tests__/helpers/native-mocks";
import { flat, render, type Rendered } from "@/__tests__/helpers/render";
import * as bench from "@/services/ble-bench";
import {
  Reg,
  SETTINGS_READ_ADDR,
  SETTINGS_READ_LEN,
} from "@/services/ble/protocol";
import { Colors } from "@/constants/theme";
import {
  useBleBenchStore,
  type BenchPeripheral,
} from "@/stores/ble-bench-store";
import { useThemeStore } from "@/stores/theme-store";
import { Tappable } from "@/components/tappable";
import BleBenchScreen from "@/app/ble-bench";

jest.mock("@/global.css", () => ({}));
jest.mock("@expo/vector-icons", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .iconsMock(),
);
jest.mock("react-native-worklets", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .workletsMock(),
);
jest.mock("react-native-reanimated", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .reanimatedMock(),
);
jest.mock("@shopify/react-native-skia", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .skiaMock(),
);
jest.mock("react-native-safe-area-context", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .safeAreaMock(),
);
jest.mock("expo-router", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .expoRouterMock(),
);
jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: "light" },
  NotificationFeedbackType: { Success: "success" },
}));
jest.mock("@/services/ble-bench", () => {
  const names = [
    "ackLastEvent",
    "connectTo",
    "disconnect",
    "handshake",
    "ping",
    "readRegister",
    "recovery",
    "resendData",
    "resendQuery",
    "reset",
    "sendHex",
    "setAutoAck",
    "shareLog",
    "startBench",
    "startScan",
    "stopBench",
    "timeSync",
    "writeRegister",
  ];
  return Object.fromEntries(
    names.map((n) => [n, jest.fn(() => Promise.resolve(true))]),
  );
});

const dark = Colors.dark;
const b = bench as unknown as Record<string, jest.Mock>;
const peri = (
  id: string,
  over: Partial<BenchPeripheral> = {},
): BenchPeripheral => ({
  id,
  name: null,
  rssi: -70,
  serviceUUIDs: [],
  hasHelmetService: false,
  lastSeenAt: 1,
  ...over,
});
const set = (
  p: Parameters<ReturnType<typeof useBleBenchStore.getState>["patch"]>[0],
) => act(() => useBleBenchStore.getState().patch(p));
const peripheralNames = (r: Rendered) =>
  r
    .texts()
    .filter(
      (x) =>
        x.startsWith("Helmet") ||
        x.startsWith("(无名)") ||
        x.startsWith("Other"),
    );

let alert: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  useThemeStore.setState({ mode: "dark" });
  routerState.params = {};
  useBleBenchStore.getState().reset();
  useBleBenchStore.setState({ log: [], adapter: "on" });
  alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
});
afterEach(() => {
  alert.mockRestore();
  jest.clearAllMocks();
});

describe("会话与外设", () => {
  it("进页面起会话、离开停会话", () => {
    const r = render(<BleBenchScreen />);
    expect(b.startBench).toHaveBeenCalled();
    r.unmount();
    expect(b.stopBench).toHaveBeenCalled();
  });

  it("外设排序：带进来的头盔（★）优先，其次广播含 FEE0，再按信号强弱；点「连接」连那一台", () => {
    routerState.params = { deviceId: "helmet_ABC123" };
    useBleBenchStore.setState({
      peripherals: {
        a: peri("a", { name: "Other-1", rssi: -40 }),
        b: peri("b", { name: "Helmet-x", rssi: -80, hasHelmetService: true }),
        c: peri("c", { name: "Helmet-ABC123", rssi: -90 }),
        d: peri("d", { name: null, rssi: null }),
      },
    });
    const r = render(<BleBenchScreen />);
    expect(peripheralNames(r)).toEqual([
      "Helmet-ABC123  ★",
      "Helmet-x",
      "Other-1",
      "(无名)",
    ]);
    expect(r.allText()).toContain("RSSI -80 · 广播含 FEE0");
    expect(r.allText()).toContain("RSSI - · 广播无 FEE0");
    const connect = r.root.findAll(
      (n) =>
        typeof n.type !== "string" &&
        n.props.title === "连接" &&
        typeof n.props.onPress === "function",
    );
    act(() => connect[1].props.onPress());
    expect(b.connectTo).toHaveBeenCalledWith("b");
  });

  it("扫描状态徽章：蓝牙关 / 无权限 / 无蓝牙；扫描中提示让头盔上电；停了可以重新扫描", () => {
    const r = render(<BleBenchScreen />);
    expect(r.allText()).toContain("已停止");
    expect(r.allText()).toContain("列表为空");
    r.press("重新扫描");
    expect(b.startScan).toHaveBeenCalled();
    set({ phase: "scanning" });
    expect(r.allText()).toContain("扫描中");
    expect(r.allText()).toContain("还没扫到外设");
    for (const [adapter, label] of [
      ["off", "蓝牙已关闭"],
      ["unauthorized", "无蓝牙权限"],
      ["unsupported", "本机无蓝牙"],
    ] as const) {
      set({ adapter });
      expect(r.allText()).toContain(label);
    }
  });
});

describe("连接后", () => {
  const connected = () => {
    useBleBenchStore.setState({
      phase: "connected",
      connectedId: "c",
      connectedName: "Helmet-ABC123",
      mtu: 185,
      peripherals: { c: peri("c", { name: "Helmet-ABC123" }) },
      services: [
        {
          uuid: "0000fee0-0000-1000-8000-00805f9b34fb",
          characteristics: [
            {
              uuid: "fee1",
              notify: true,
              write: false,
              writeNoResp: false,
              read: false,
            },
            {
              uuid: "fee2",
              notify: false,
              write: true,
              writeNoResp: true,
              read: true,
            },
          ],
        },
      ],
      notifyOk: true,
      writeOk: true,
    });
  };

  it("设备名、MTU、特征值都通；展开看 GATT；能断开；已连接的那台不再给连接按钮", () => {
    connected();
    const r = render(<BleBenchScreen />);
    expect(r.allText()).toContain("已连接");
    expect(r.texts()).toContain("185");
    const chars = r.root
      .findAllByType(Text)
      .find((t) => String(t.props.children).startsWith("FEE1 notify ✓"))!;
    expect(flat(chars.props.style).color).toBe(dark.success);
    r.press("FEE1 notify ✓");
    expect(r.allText()).toContain("  fee2  write write-no-resp read");
    r.press("断开");
    expect(b.disconnect).toHaveBeenCalled();
  });

  it("特征值不全：红色；没有头盔服务时写没找到；连接中只显示设备名", () => {
    connected();
    useBleBenchStore.setState({ writeOk: false });
    let r = render(<BleBenchScreen />);
    const chars = r.root
      .findAllByType(Text)
      .find((t) => String(t.props.children).includes("FEE2 write ✗"))!;
    expect(flat(chars.props.style).color).toBe(dark.danger);
    useBleBenchStore.setState({
      services: [],
      phase: "connecting",
      mtu: null,
      connectedName: null,
    });
    r = render(<BleBenchScreen />);
    expect(r.allText()).not.toContain("断开");
    expect(r.texts()).toContain("-");
  });

  it("十二条普通指令各调各的；没连上时指令按钮都不可点", () => {
    let r = render(<BleBenchScreen />);
    const cmds = () =>
      r.root.findAll(
        (n) =>
          n.type === Tappable &&
          Array.isArray(n.props.feedback) &&
          n.props.feedback.includes("scale"),
      );
    expect(cmds().every((c) => c.props.disabled === true)).toBe(true);
    connected();
    r = render(<BleBenchScreen />);
    expect(cmds()).toHaveLength(14);
    cmds()
      .slice(0, 12)
      .forEach((c) => act(() => c.props.onPress()));
    expect(b.ping).toHaveBeenCalled();
    expect(b.readRegister.mock.calls).toEqual([
      [Reg.DEVICE_ID, 16],
      [Reg.FW_MAJOR, 3],
      [SETTINGS_READ_ADDR, SETTINGS_READ_LEN],
      [0x10, 10],
    ]);
    expect(b.timeSync).toHaveBeenCalled();
    expect(b.writeRegister.mock.calls).toEqual([
      [Reg.BUZZER_VOLUME, [50]],
      [Reg.BUZZER_VOLUME, [200]],
      [Reg.BUZZER_ENABLED, [1, 90]],
    ]);
    expect(b.resendQuery).toHaveBeenCalled();
    expect(b.resendData).toHaveBeenCalledWith(0, 10);
    expect(b.ackLastEvent).toHaveBeenCalled();
  });

  it("恢复出厂 / 软重启要先确认；确认才发", () => {
    connected();
    const r = render(<BleBenchScreen />);
    const cmds = r.root.findAll(
      (n) =>
        n.type === Tappable &&
        Array.isArray(n.props.feedback) &&
        n.props.feedback.includes("scale"),
    );
    act(() => cmds[12].props.onPress());
    act(() => cmds[13].props.onPress());
    expect(b.recovery).not.toHaveBeenCalled();
    expect(b.reset).not.toHaveBeenCalled();
    const [recoveryTitle, , rb] = alert.mock.calls[0] as [
      string,
      string,
      { style: string; onPress?: () => void }[],
    ];
    expect(recoveryTitle).toBe("恢复出厂参数");
    expect(rb[1].style).toBe("destructive");
    act(() => rb[1].onPress!());
    expect(b.recovery).toHaveBeenCalled();
    const resetButtons = alert.mock.calls[1][2] as { onPress?: () => void }[];
    act(() => resetButtons[1].onPress!());
    expect(b.reset).toHaveBeenCalledWith(0x01);
  });

  it("一键握手；自动 ACK 开关；自定义 hex：空的不能发、发成功清空输入、发失败保留", async () => {
    connected();
    const r = render(<BleBenchScreen />);
    r.press("一键握手（跑完整流程）");
    expect(b.handshake).toHaveBeenCalled();
    // 回调返回的是 Promise（替身）：act 里不能把它交回去，否则 act 变成异步、后面的更新不落地
    act(() => {
      r.root.findByType(Switch).props.onValueChange(false);
    });
    expect(b.setAutoAck).toHaveBeenCalledWith(false);
    const send = () =>
      r.root.find(
        (n) =>
          typeof n.type !== "string" &&
          n.props.title === "发送" &&
          typeof n.props.onPress === "function",
      );
    expect(send().props.disabled).toBe(true);
    act(() => {
      r.root.findByType(TextInput).props.onChangeText("03 07 24 32");
    });
    expect(send().props.disabled).toBe(false);
    b.sendHex.mockImplementationOnce(() => Promise.resolve(false));
    await act(async () => send().props.onPress());
    expect(r.root.findByType(TextInput).props.value).toBe("03 07 24 32");
    await act(async () => send().props.onPress());
    expect(b.sendHex).toHaveBeenLastCalledWith("03 07 24 32");
    expect(r.root.findByType(TextInput).props.value).toBe("");
  });
});

describe("日志", () => {
  it("空时说还没有；有了按收 / 发 / 信息打标签，hex 大写，应答带延迟，颜色按结果", () => {
    let r = render(<BleBenchScreen />);
    expect(r.allText()).toContain("还没有收发记录");
    const add = useBleBenchStore.getState().appendLog;
    act(() => {
      add({
        at: Date.UTC(2026, 9, 16, 1, 2, 3),
        dir: "tx",
        hex: "03a1",
        text: "PING",
      });
      add({
        at: Date.UTC(2026, 9, 16, 1, 2, 4),
        dir: "rx",
        hex: "83a1",
        text: "应答 OK",
        tone: "ok",
        latencyMs: 42,
      });
      add({
        at: Date.UTC(2026, 9, 16, 1, 2, 5),
        dir: "rx",
        hex: "",
        text: "摔倒事件",
        tone: "event",
      });
      add({
        at: Date.UTC(2026, 9, 16, 1, 2, 6),
        dir: "info",
        hex: "",
        text: "写入失败",
        tone: "error",
      });
      add({
        at: Date.UTC(2026, 9, 16, 1, 2, 7),
        dir: "info",
        hex: "",
        text: "提示",
      });
    });
    r = render(<BleBenchScreen />);
    expect(r.allText()).toContain("5 条");
    expect(r.texts()).toEqual(
      expect.arrayContaining([
        "TX",
        "RX",
        "--",
        "03A1",
        "83A1",
        "应答 OK · 42 ms",
      ]),
    );
    const color = (text: string) =>
      flat(
        r.root
          .findAllByType(Text)
          .find(
            (t) =>
              r.texts().includes(text) &&
              String(t.props.children).startsWith(text.split(" ")[0]),
          )!.props.style,
      ).color;
    expect(color("摔倒事件")).toBe(dark.warning);
    expect(color("写入失败")).toBe(dark.danger);
    expect(color("提示")).toBe(dark.textSecondary);
  });

  it("分享导出；清空", () => {
    act(() =>
      useBleBenchStore
        .getState()
        .appendLog({ at: 1, dir: "info", hex: "", text: "x" }),
    );
    const r = render(<BleBenchScreen />);
    r.press("分享");
    expect(b.shareLog).toHaveBeenCalled();
    r.press("清空");
    expect(useBleBenchStore.getState().log).toEqual([]);
  });

  it("超过 200 条只显示最近的 200 条", () => {
    act(() => {
      for (let i = 0; i < 230; i++)
        useBleBenchStore
          .getState()
          .appendLog({ at: i, dir: "info", hex: "", text: `#${i}` });
    });
    const r = render(<BleBenchScreen />);
    expect(r.allText()).toContain("230 条");
    expect(r.texts()).not.toContain("#29");
    expect(r.texts()).toContain("#30");
    expect(r.texts()).toContain("#229");
  });
});
