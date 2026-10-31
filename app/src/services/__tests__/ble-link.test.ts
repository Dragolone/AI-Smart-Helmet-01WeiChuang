// BLE 链路管理器会话层单测：用纯 JS 假头盔（按 v0.6 应答）顶替 react-native-ble-plx，
// 钉住握手顺序、Seq 匹配、高危先 ACK 再入队、重发帧去重、补传循环、身份不符封锁、设置写入回执、断连状态。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { Mock } from "jest-mock";

import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  hexToBytes,
} from "../ble/bytes";

// —— 假头盔：记录 App 写入，按协议回应答 ——
type NotifyCb = (
  error: null | { errorCode: number; message: string },
  ch: { value: string } | null,
) => void;

/** 手册 §2.0 出厂默认（0x20–0x2D）：心跳 60s / 运动 5s / 静止 30s / 蜂鸣开 / 音量 80 /
 *  振动中 / 大灯关 / 跌倒检测开 / 灵敏度标准 / 雷达开 / 距离 15m / 障碍开 / SOS 键开 / 断连蜂鸣关 */
const FACTORY_MEM: [number, number][] = [
  [0x20, 60],
  [0x21, 5],
  [0x22, 30],
  [0x23, 1],
  [0x24, 80],
  [0x25, 2],
  [0x26, 0],
  [0x27, 1],
  [0x28, 2],
  [0x29, 1],
  [0x2a, 15],
  [0x2b, 1],
  [0x2c, 1],
  [0x2d, 0],
];

class FakeHelmet {
  writes: string[] = [];
  acks: string[] = [];
  notify: NotifyCb | null = null;
  disconnectCb: ((e: null, d: unknown) => void) | null = null;
  deviceId = "helmet_94173f";
  firmware = [1, 0, 3];
  flash: Uint8Array[] = [];
  /** 内存控制表；0x20–0x2D 预置成手册出厂默认，握手第 6 步读设置要用 */
  mem = new Map<number, number>(FACTORY_MEM);
  /** 写寄存器时返回的错误码（默认 0 = OK） */
  writeError = 0;
  /** 读 0x40（deviceId）时返回的错误码；非 0 时不带数据段 */
  idError = 0;
  cancelled = 0;
  /** 设了就先交给它：返回 true = 这一帧它处理了（不应答 / 回别的），不再走下面的默认应答 */
  override: ((frame: Uint8Array) => boolean) | null = null;

  reply(bytes: number[]): void {
    this.notify?.(null, { value: bytesToBase64(Uint8Array.from(bytes)) });
  }

  push(frame: Uint8Array): void {
    this.notify?.(null, { value: bytesToBase64(frame) });
  }

  handle(frame: Uint8Array): void {
    if (this.override?.(frame)) return;
    const [ins, seq] = frame;
    switch (ins) {
      case 0x02: {
        const addr = frame[2];
        const len = frame[3];
        if (addr === 0x40 && this.idError !== 0) {
          this.reply([ins, seq, this.idError]);
        } else if (addr === 0x40) {
          const id = Array.from(this.deviceId, (c) => c.charCodeAt(0));
          this.reply([
            ins,
            seq,
            0,
            ...id,
            ...new Array(len - id.length).fill(0),
          ]);
        } else if (addr === 0x00) {
          this.reply([ins, seq, 0, ...this.firmware.slice(0, len)]);
        } else if (addr >= 0x20 && addr + len - 1 <= 0x2d) {
          this.reply([
            ins,
            seq,
            0,
            ...Array.from(
              { length: len },
              (_, i) => this.mem.get(addr + i) ?? 0,
            ),
          ]);
        } else {
          this.reply([ins, seq, 3]);
        }
        break;
      }
      case 0x03:
        if (this.writeError === 0) {
          for (let i = 3; i < frame.length; i += 1)
            this.mem.set(frame[2] + i - 3, frame[i]);
        }
        this.reply([ins, seq, this.writeError]);
        break;
      case 0x04:
        this.reply([ins, seq, 0]);
        break;
      case 0x07:
        this.reply([
          ins,
          seq,
          0,
          this.flash.length & 255,
          this.flash.length >> 8,
        ]);
        break;
      case 0x08: {
        // 先快照再推送：App 收到帧会同步 ACK → 擦除，边推边擦会漏
        const batch = this.flash.slice(0, frame[4]);
        for (const f of batch) this.push(f);
        this.reply([ins, seq, 0, batch.length]);
        break;
      }
      default:
        this.reply([ins, seq, 2]);
    }
  }
}

const helmet = new FakeHelmet();
type ScanCb = (e: { message: string } | null, d: unknown) => void;
let scanCb: ScanCb | null = null;
/** 每次 startDeviceScan 挂上的回调都留着（ble-plx 只叠监听不摘旧的） */
const mockScanCbs: ScanCb[] = [];
/** 系统层已连着的外设（connectedDevices 的结果，可挂起 / 拒绝） */
const mockConnected = jest.fn(
  async (_uuids?: string[]): Promise<unknown[]> => [],
);
/** onStateChange 订阅时立即推的适配器状态；null = 状态事件还没到 */
const mockAdapter: { initial: string | null } = { initial: "PoweredOn" };
let stateCb: ((s: string) => void) | null = null;
const destroyed = { count: 0 };
/** 每次 startDeviceScan 的服务 UUID 过滤（null = 全量扫描） */
const mockScans: (string[] | null)[] = [];
/** 设了就让 destroy() 挂在这个 Promise 上（模拟原生销毁还没回来） */
const mockDestroyGate: { promise: Promise<void> | null } = { promise: null };
const mockSvcStart = jest.fn((_title: string, _text: string) => undefined);
/** 适配器状态查询（可挂起，模拟 ensureScanning 的 await 窗口） */
const mockState = jest.fn(async (): Promise<string> => "PoweredOn");
const mockSvcStop = jest.fn(() => undefined);
/** 这一轮测试顺序：入队 / ACK 谁先谁后 */
const mockOrder: string[] = [];

const fakeDevice = {
  id: "periph-1",
  name: "Helmet-94173f",
  localName: "Helmet-94173f",
  serviceUUIDs: ["0000fee0-0000-1000-8000-00805f9b34fb"],
  connect: jest.fn(async () => fakeDevice),
  requestMTU: jest.fn(async () => fakeDevice),
  discoverAllServicesAndCharacteristics: jest.fn(async () => fakeDevice),
  monitorCharacteristicForService: jest.fn(
    (_s: string, _c: string, cb: NotifyCb) => {
      helmet.notify = cb;
      return { remove: () => undefined };
    },
  ),
  writeCharacteristicWithResponseForService: jest.fn(
    async (_s: string, _c: string, v: string) => {
      const bytes = base64ToBytes(v);
      helmet.writes.push(bytesToHex(bytes));
      helmet.handle(bytes);
      return {};
    },
  ),
  writeCharacteristicWithoutResponseForService: jest.fn(
    async (_s: string, _c: string, v: string) => {
      helmet.acks.push(bytesToHex(base64ToBytes(v)));
      mockOrder.push("ack");
      return {};
    },
  ),
  onDisconnected: jest.fn((cb: (e: null, d: unknown) => void) => {
    helmet.disconnectCb = cb;
    return { remove: () => undefined };
  }),
  cancelConnection: jest.fn(async () => {
    helmet.cancelled += 1;
    return fakeDevice;
  }),
};
/** 两个写入假件的默认实现：有的用例换掉了没还原，后加的用例开头先装回来 */
const defaultWrite =
  fakeDevice.writeCharacteristicWithResponseForService.getMockImplementation()!;
const defaultAck =
  fakeDevice.writeCharacteristicWithoutResponseForService.getMockImplementation()!;

jest.mock("react-native-ble-plx", () => ({
  State: {
    PoweredOn: "PoweredOn",
    PoweredOff: "PoweredOff",
    Unauthorized: "Unauthorized",
    Unsupported: "Unsupported",
  },
  BleErrorCode: { OperationCancelled: 2 },
  BleManager: jest.fn().mockImplementation(() => ({
    state: () => mockState(),
    onStateChange: (cb: (s: string) => void, emit: boolean) => {
      stateCb = cb;
      if (emit && mockAdapter.initial) cb(mockAdapter.initial);
      return { remove: () => undefined };
    },
    connectedDevices: (uuids: string[]) => mockConnected(uuids),
    startDeviceScan: (u: unknown, _o: unknown, cb: ScanCb) => {
      mockScans.push(u as string[] | null);
      mockScanCbs.push(cb);
      scanCb = cb;
    },
    stopDeviceScan: () => undefined,
    destroy: () => {
      destroyed.count += 1;
      return mockDestroyGate.promise ?? undefined;
    },
  })),
}));
jest.mock("@/services/ble-relay-uplink", () => ({
  enqueueRelayEvent: jest.fn(() => {
    mockOrder.push("enqueue");
  }),
  flushRelayQueue: jest.fn(async () => undefined),
}));
jest.mock("helmet-link-service", () => ({
  HelmetLinkService: {
    available: true,
    start: (title: string, text: string) => mockSvcStart(title, text),
    stop: () => mockSvcStop(),
  },
}));
const mockTranslate = jest.fn((k: string, _p?: unknown) => k);
jest.mock("@/i18n", () => ({
  translate: (k: string, p?: unknown) => mockTranslate(k, p),
}));
jest.mock("@/services/dev-log", () => ({ devLog: jest.fn() }));
import { devicesApi } from "@/api/devices";

jest.mock("@/api/devices", () => ({
  devicesApi: {
    reportSettings: jest.fn(async () => ({
      settings: {},
      applied: [],
      skipped: [],
    })),
  },
}));

import {
  enqueueRelayEvent,
  flushRelayQueue,
} from "@/services/ble-relay-uplink";
import { useBleStore } from "@/stores/ble-store";
import { setSplashCovering } from "@/components/splash/covering";
import { AppState, PermissionsAndroid, Platform } from "react-native";
import { BleManager } from "react-native-ble-plx";
import {
  __resetServerClockForTests,
  noteServerDate,
} from "@/services/server-clock";
import {
  bleStackReleased,
  currentBleTargets,
  isHelmetConnected,
  refreshServiceNotification,
  retryBleLink,
  setBleTargetNameResolver,
  setBleTargets,
  startBleLink,
  stopBleLink,
  writeHelmetRegister,
} from "../ble-link";

const override = (obj: object, key: string, value: unknown): void => {
  Object.defineProperty(obj, key, {
    value,
    configurable: true,
    writable: true,
  });
};
const originalOS = Platform.OS;
const originalVersion = Platform.Version;
const originalAppState = AppState.currentState;

const enqueueMock = enqueueRelayEvent as unknown as Mock<
  typeof enqueueRelayEvent
>;
const flushMock = flushRelayQueue as unknown as Mock<typeof flushRelayQueue>;
const tick = async (n = 12) => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};
const link = () => useBleStore.getState().links["helmet_94173f"];

/** 启动链路并让扫描回调发现假头盔，等握手完成 */
async function connectHelmet(): Promise<void> {
  await startBleLink(["helmet_94173f"]);
  await tick();
  scanCb?.(null, fakeDevice);
  for (
    let i = 0;
    i < 40 && link()?.phase !== "connected" && link()?.phase !== "error";
    i += 1
  )
    await tick();
}

beforeEach(() => {
  helmet.writes = [];
  helmet.acks = [];
  helmet.flash = [];
  // 恢复出厂默认而不是清空：真头盔的内存表永远有值，清空会让读设置读到一片 0
  helmet.mem = new Map(FACTORY_MEM);
  helmet.writeError = 0;
  helmet.idError = 0;
  helmet.deviceId = "helmet_94173f";
  helmet.cancelled = 0;
  helmet.override = null;
  mockConnected.mockReset();
  mockConnected.mockResolvedValue([]);
  mockAdapter.initial = "PoweredOn";
  enqueueMock.mockClear();
  flushMock.mockClear();
  mockScans.length = 0;
  mockScanCbs.length = 0;
  mockOrder.length = 0;
  mockDestroyGate.promise = null;
  mockSvcStart.mockClear();
  mockSvcStop.mockClear();
  mockState.mockReset();
  mockState.mockResolvedValue("PoweredOn");
  fakeDevice.connect.mockReset();
  fakeDevice.connect.mockResolvedValue(fakeDevice);
  override(AppState, "currentState", "active");
  jest.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(async () => {
  stopBleLink();
  await bleStackReleased();
  jest.useRealTimers();
  override(Platform, "OS", originalOS);
  override(Platform, "Version", originalVersion);
  override(AppState, "currentState", originalAppState);
  jest.restoreAllMocks();
});

describe("握手", () => {
  it("严格按 读 0x40 → 读 0x00–0x02 → 对时 → 补传查询 顺序，Seq 递增；完成后 phase=connected 且带固件版本", async () => {
    await connectHelmet();
    expect(link()?.phase).toBe("connected");
    expect(link()?.firmwareVersion).toBe("1.0.3");
    expect(isHelmetConnected("helmet_94173f")).toBe(true);
    expect(helmet.writes.slice(0, 4).map((w) => w.slice(0, 5))).toEqual([
      "02 01",
      "02 02",
      "04 03",
      "07 04",
    ]);
    expect(helmet.writes[0]).toBe("02 01 40 10");
    expect(helmet.writes[1]).toBe("02 02 00 03");
    expect(helmet.writes[3]).toBe("07 04");
    // 对时载荷是当前 UTC 秒（小端 4B）
    const ts = hexToBytes(helmet.writes[2].slice(6));
    const utc = ts[0] | (ts[1] << 8) | (ts[2] << 16) | (ts[3] << 24);
    expect(Math.abs(utc - Math.floor(Date.now() / 1000))).toBeLessThan(5);
  });

  it("头盔 deviceId 与绑定不符 → phase=error DEVICE_ID_MISMATCH，断开且不再自动重连", async () => {
    helmet.deviceId = "helmet_other1";
    await connectHelmet();
    expect(link()?.phase).toBe("error");
    expect(helmet.cancelled).toBeGreaterThan(0);
    expect(isHelmetConnected("helmet_94173f")).toBe(false);
    // 手动重试后解除封锁，可再次发现
    helmet.deviceId = "helmet_94173f";
    retryBleLink("helmet_94173f");
    await tick();
    scanCb?.(null, fakeDevice);
    for (let i = 0; i < 40 && link()?.phase !== "connected"; i += 1)
      await tick();
    expect(link()?.phase).toBe("connected");
  });

  it("补传：查询到 2 条离线高危事件 → 0x08 拉取 → 每条入队并 ACK → 再次查询为 0", async () => {
    const fall = (seq: number) =>
      hexToBytes(
        `05 01 ${seq.toString(16).padStart(2, "0")} 00 00 00 00 00 00 00 5F 2D 55 ED 4E CD 01 17 7C 29 07`,
      );
    helmet.flash = [fall(0x10), fall(0x11)];
    // 假头盔在收到 ACK 后擦除：模拟 handle 0x06（ACK 无应答，走 withoutResponse 通道）
    fakeDevice.writeCharacteristicWithoutResponseForService.mockImplementation(
      async (_s, _c, v) => {
        const b = base64ToBytes(v);
        helmet.acks.push(bytesToHex(b));
        const seq = b[2] | (b[3] << 8) | (b[4] << 16) | (b[5] << 24);
        helmet.flash = helmet.flash.filter((f) => (f[2] | (f[3] << 8)) !== seq);
        return {};
      },
    );
    await connectHelmet();
    expect(link()?.phase).toBe("connected");
    expect(helmet.acks).toEqual([
      "06 01 10 00 00 00 00",
      "06 01 11 00 00 00 00",
    ]);
    expect(enqueueMock).toHaveBeenCalledTimes(2);
    expect(helmet.writes.filter((w) => w.startsWith("07 "))).toHaveLength(2);
    expect(helmet.writes.filter((w) => w.startsWith("08 "))).toEqual([
      "08 05 00 00 02",
    ]);
    expect(flushMock).toHaveBeenCalled();
  });
});

describe("事件", () => {
  it("高危事件：先 ACK 再入队并立即冲刷；同 Event_Seq 重发帧只 ACK 不重复入队", async () => {
    await connectHelmet();
    enqueueMock.mockClear();
    flushMock.mockClear();
    const frame = hexToBytes(
      "05 02 65 00 00 00 00 00 00 00 01 FC 08 ED 4E CD 01 17 7C 29 07",
    );
    helmet.push(frame);
    await tick();
    expect(helmet.acks).toEqual(["06 02 65 00 00 00 00"]);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const env = enqueueMock.mock.calls[0][0];
    expect(env.eventType).toBe("manual_sos");
    expect(env.deviceId).toBe("helmet_94173f");
    expect(env.firmwareVersion).toBe("1.0.3");
    expect(flushMock).toHaveBeenCalledTimes(1);
    helmet.push(frame); // 头盔 1.5s 未收到 ACK 的重发
    await tick();
    expect(helmet.acks).toHaveLength(2);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it("周期事件不 ACK、不立即冲刷；无定位的位置包丢弃；事件计数累加", async () => {
    await connectHelmet();
    enqueueMock.mockClear();
    flushMock.mockClear();
    helmet.push(hexToBytes("05 07 70 00 00 00 00 00 00 00 55 00"));
    helmet.push(
      hexToBytes(
        "05 06 71 00 00 00 00 00 00 00 ED 4E CD 01 17 7C 29 07 44 00 FF FF FF FF 7F",
      ),
    );
    await tick();
    expect(helmet.acks).toHaveLength(0);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0][0].eventType).toBe("device_status");
    expect(flushMock).not.toHaveBeenCalled();
    expect(link()?.eventsReceived).toBe(2);
  });
});

describe("握手第 6 步：上报头盔实际设置（决策 #45）", () => {
  const reportMock = devicesApi.reportSettings as unknown as Mock<
    typeof devicesApi.reportSettings
  >;
  beforeEach(() => {
    reportMock.mockClear();
  });

  it("读回 0x20–0x2D 并上报，云端据此纠正显示", async () => {
    await connectHelmet();
    expect(reportMock).toHaveBeenCalledTimes(1);
    expect(reportMock.mock.calls[0][0]).toBe("helmet_94173f");
    expect(reportMock.mock.calls[0][1]).toEqual({
      settings: {
        heartbeatPeriod: 60,
        locationPeriodMoving: 5,
        locationPeriodStill: 30,
        buzzer: true,
        volume: 80,
        vibration: 2,
        light: 0,
        fallDetect: true,
        fallSensitivity: 2,
        radar: true,
        radarDistance: 15,
        obstacleWarn: true,
        sosButton: true,
        disconnectBeep: false,
      },
    });
  });

  it("大灯掉电不保存：头盔那头变成高亮，重连后上报的就是高亮", async () => {
    helmet.mem.set(0x26, 2);
    await connectHelmet();
    const body = reportMock.mock.calls[0][1] as { settings: { light: number } };
    expect(body.settings.light).toBe(2);
  });

  it("上报失败不影响链路（离线/服务端报错都照常连上）", async () => {
    reportMock.mockRejectedValueOnce(new Error("network"));
    await expect(connectHelmet()).resolves.toBeUndefined();
  });
});

describe("目标上限", () => {
  it("绑定上千顶时链路只盯列表最前面的 20 顶（2026-10-15 边界测试：1 万顶把 App 撑死）", () => {
    const ids = Array.from({ length: 10_000 }, (_, i) => `helmet_e${i}`);
    setBleTargets(ids);
    expect(currentBleTargets()).toHaveLength(20);
    expect(currentBleTargets()[0]).toBe("helmet_e0");
    expect(currentBleTargets()[19]).toBe("helmet_e19");
    setBleTargets([]);
  });
});

describe("设置写入与断连", () => {
  it("writeHelmetRegister：应答 OK → executed；错误码 → errorCode 名称；未连接 → 未送达", async () => {
    expect(await writeHelmetRegister("helmet_94173f", 0x24, [70])).toEqual({
      delivered: false,
    });
    await connectHelmet();
    expect(await writeHelmetRegister("helmet_94173f", 0x24, [70])).toEqual({
      delivered: true,
      executed: true,
    });
    expect(helmet.mem.get(0x24)).toBe(70);
    // 只校验「写指令 + 地址 + 值」，不钉死 Seq——握手步数变了它就会漂
    expect(helmet.writes.at(-1)).toMatch(/^03 [0-9a-f]{2} 24 46$/);
    helmet.writeError = 5;
    expect(await writeHelmetRegister("helmet_94173f", 0x24, [200])).toEqual({
      delivered: true,
      executed: false,
      errorCode: "ERR_PARAM_VALUE",
    });
  });

  it("外设断开 → phase=disconnected、会话销毁；stopBleLink 释放原生栈并清空状态", async () => {
    await connectHelmet();
    helmet.disconnectCb?.(null, fakeDevice);
    await tick();
    expect(link()?.phase).toBe("disconnected");
    expect(isHelmetConnected("helmet_94173f")).toBe(false);
    const before = destroyed.count;
    stopBleLink();
    expect(destroyed.count).toBe(before + 1);
    expect(useBleStore.getState().links).toEqual({});
  });

  it("蓝牙关闭 → adapter=off，目标显示 disconnected；重新打开后恢复扫描", async () => {
    await connectHelmet();
    stateCb?.("PoweredOff");
    expect(useBleStore.getState().adapter).toBe("off");
    helmet.disconnectCb?.(null, fakeDevice);
    await tick();
    expect(link()?.phase).toBe("disconnected");
    stateCb?.("PoweredOn");
    expect(useBleStore.getState().adapter).toBe("on");
  });
});

describe("2026-10-05 评审：ACK 的时机与摔倒 / 求救的短载荷", () => {
  it("先入队再 ACK：头盔收到 ACK 就擦除，ACK 必须晚于 App 已经接住", async () => {
    await connectHelmet();
    // 两个假件的实现都在这里现挂：前面的用例（补传）换过 ACK 的实现没有还原
    enqueueMock.mockImplementation(() => {
      mockOrder.push("enqueue");
    });
    fakeDevice.writeCharacteristicWithoutResponseForService.mockImplementation(
      async (_s, _c, v) => {
        helmet.acks.push(bytesToHex(base64ToBytes(v)));
        mockOrder.push("ack");
        return {};
      },
    );
    mockOrder.length = 0;
    helmet.push(
      hexToBytes(
        "05 02 65 00 00 00 00 00 00 00 01 FC 08 ED 4E CD 01 17 7C 29 07",
      ),
    );
    await tick();
    expect(mockOrder).toEqual(["enqueue", "ack"]);
  });

  it("摔倒帧被截短（MTU 没协商上去，21 字节的帧只到了 20 字节）：照样入队上云并立即冲刷，不再「ACK 了却丢了」", async () => {
    await connectHelmet();
    enqueueMock.mockClear();
    flushMock.mockClear();
    helmet.push(
      hexToBytes("05 01 66 00 00 00 00 00 00 00 5F 2D 55 ED 4E CD 01 17 7C 29"),
    );
    await tick();
    expect(helmet.acks).toEqual(["06 01 66 00 00 00 00"]);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const env = enqueueMock.mock.calls[0][0];
    expect(env.eventType).toBe("possible_fall");
    expect(env.payload).toEqual({
      confidence: 0.95,
      impactG: 4.5,
      tiltDeg: 85,
    });
    expect(flushMock).toHaveBeenCalledTimes(1);
  });

  it("碰撞帧载荷不全：翻译不了、不入队，但仍 ACK（留着只会被头盔无限重发）", async () => {
    await connectHelmet();
    enqueueMock.mockClear();
    helmet.push(hexToBytes("05 03 67 00 00 00 00 00 00 00 02 01"));
    await tick();
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(helmet.acks).toEqual(["06 03 67 00 00 00 00"]);
  });
});

describe("2026-10-05 评审：握手读 deviceId 失败 ≠ 身份不符", () => {
  it("头盔对 0x40 回错误码（硬件故障等）：按普通握手失败处理——不拉黑，退避后还会重连", async () => {
    helmet.idError = 0x07;
    await startBleLink(["helmet_94173f"]);
    await tick();
    expect(mockScans).toHaveLength(1);
    scanCb?.(null, fakeDevice);
    for (let i = 0; i < 40 && mockScans.length < 2; i += 1) await tick();
    // 握手失败后立刻回到扫描（没被拉黑——拉黑的设备不在扫描目标里，不会有第二次扫描）
    expect(mockScans).toHaveLength(2);
    expect(link()?.phase).toBe("scanning");
    expect(helmet.cancelled).toBeGreaterThan(0);
    // 这次头盔正常了就能连上
    helmet.idError = 0;
    scanCb?.(null, fakeDevice);
    for (let i = 0; i < 40 && link()?.phase !== "connected"; i += 1)
      await tick();
    expect(link()?.phase).toBe("connected");
  });
});

describe("2026-10-05 评审：扫描兜底必须回得来", () => {
  const FEE0 = ["0000fee0-0000-1000-8000-00805f9b34fb"];
  let appStateCb: ((s: string) => void) | null;
  beforeEach(() => {
    jest.useFakeTimers();
    appStateCb = null;
    jest.spyOn(AppState, "addEventListener").mockImplementation(((
      _: string,
      cb: (s: string) => void,
    ) => {
      appStateCb = cb;
      return { remove: () => undefined };
    }) as never);
  });
  const start = async () => {
    await startBleLink(["helmet_94173f"]);
    await jest.advanceTimersByTimeAsync(0);
  };

  it("前台：过滤 20 s 无命中 → 全量；全量 20 s 仍无命中 → 回到过滤，两种交替（原来切到全量就再也不回来）", async () => {
    await start();
    expect(mockScans).toEqual([FEE0]);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(mockScans).toEqual([FEE0, null]);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(mockScans).toEqual([FEE0, null, FEE0]);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(mockScans).toEqual([FEE0, null, FEE0, null]);
  });

  it("iOS · 全量扫描中退后台 / 锁屏：立刻换回过滤扫描（后台只投递带服务 UUID 过滤的结果，不换就永远连不上）", async () => {
    await start();
    await jest.advanceTimersByTimeAsync(20_000);
    expect(mockScans.at(-1)).toBeNull();
    override(AppState, "currentState", "background");
    appStateCb?.("background");
    await jest.advanceTimersByTimeAsync(0);
    expect(mockScans.at(-1)).toEqual(FEE0);
    // 后台期间一直保持过滤扫描，不再切全量
    const n = mockScans.length;
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(mockScans).toHaveLength(n);
    // 这时头盔上电：能连上
    scanCb?.(null, fakeDevice);
    for (let i = 0; i < 40 && link()?.phase !== "connected"; i += 1)
      await tick();
    expect(link()?.phase).toBe("connected");
  });

  it("过滤扫描中退后台：原样继续扫，不重开（后台正该是过滤扫描）", async () => {
    await start();
    override(AppState, "currentState", "background");
    appStateCb?.("background");
    await jest.advanceTimersByTimeAsync(0);
    expect(mockScans).toEqual([FEE0]);
  });

  it("前台中途重开一轮（切出去又回来）：上一轮剩下的兜底计时不算数，从这一轮重新数 20 s", async () => {
    await start();
    await jest.advanceTimersByTimeAsync(10_000);
    appStateCb?.("active");
    await jest.advanceTimersByTimeAsync(0);
    expect(mockScans).toEqual([FEE0, FEE0]);
    await jest.advanceTimersByTimeAsync(10_000); // 上一轮的 20 s 到点
    expect(mockScans).toEqual([FEE0, FEE0]);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(mockScans).toEqual([FEE0, FEE0, null]);
  });

  it("Android · 后台也要两种扫描交替：华为 P30 上过滤扫描扫不到仿真头盔，只做过滤的话退后台后永远连不上", async () => {
    override(Platform, "OS", "android");
    override(Platform, "Version", 29);
    const { PermissionsAndroid } =
      require("react-native") as typeof import("react-native");
    jest
      .spyOn(PermissionsAndroid, "request")
      .mockResolvedValue(PermissionsAndroid.RESULTS.GRANTED);
    await start();
    await jest.advanceTimersByTimeAsync(20_000);
    expect(mockScans).toEqual([FEE0, null]);
    // 全量扫描中退后台：先从过滤重开一轮（息屏后全量会被系统暂停，定时器随后可能被冻住，不能冻在全量上）
    override(AppState, "currentState", "background");
    appStateCb?.("background");
    await jest.advanceTimersByTimeAsync(0);
    expect(mockScans).toEqual([FEE0, null, FEE0]);
    // 之后在后台照常交替
    await jest.advanceTimersByTimeAsync(20_000);
    expect(mockScans).toEqual([FEE0, null, FEE0, null]);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(mockScans).toEqual([FEE0, null, FEE0, null, FEE0]);
  });

  it("iOS · 后台时过滤扫描 20 s 无命中：不切全量；回到前台重开一轮，兜底重新计时", async () => {
    override(AppState, "currentState", "background");
    await start();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockScans).toEqual([FEE0]);
    override(AppState, "currentState", "active");
    appStateCb?.("active");
    await jest.advanceTimersByTimeAsync(0);
    expect(mockScans).toEqual([FEE0, FEE0]);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(mockScans).toEqual([FEE0, FEE0, null]);
  });

  it("停掉再启动（登出重登 / 工程模式暂停恢复）：从过滤扫描开始，不沿用上一轮的全量", async () => {
    await start();
    await jest.advanceTimersByTimeAsync(20_000);
    expect(mockScans.at(-1)).toBeNull();
    stopBleLink();
    await jest.advanceTimersByTimeAsync(0);
    mockScans.length = 0;
    await start();
    expect(mockScans).toEqual([FEE0]);
    // 上一轮剩下的兜底定时器不会来搅这一轮
    await jest.advanceTimersByTimeAsync(19_000);
    expect(mockScans).toEqual([FEE0]);
  });
});

describe("2026-10-05 评审：Android 前台服务在「搜索中」就要起来", () => {
  beforeEach(() => {
    override(Platform, "OS", "android");
    override(Platform, "Version", 29); // 走定位权限那条路
    const { PermissionsAndroid } =
      require("react-native") as typeof import("react-native");
    jest
      .spyOn(PermissionsAndroid, "request")
      .mockResolvedValue(PermissionsAndroid.RESULTS.GRANTED);
  });

  it("链路一启动（头盔还没开机、一次都没连上过）就起服务，文案是「搜索中」", async () => {
    await startBleLink(["helmet_94173f"]);
    await tick();
    expect(mockSvcStart).toHaveBeenCalledTimes(1);
    expect(mockSvcStart.mock.calls[0][1]).toBe("device.ble.serviceSearching");
  });

  it("10-16 N23：通知里写用户起的头盔名；没起名 / 查不到写设备号后 6 位；最多列 3 顶、长名截断", async () => {
    setBleTargetNameResolver((id) =>
      id === "helmet_94173f"
        ? "我的头盔"
        : id === "helmet_aaaaaa"
          ? "一二三四五六七八九十十一十二十三"
          : null,
    );
    mockTranslate.mockClear();
    await startBleLink([
      "helmet_94173f",
      "helmet_aaaaaa",
      "helmet_bbbbbb",
      "helmet_cccccc",
    ]);
    await tick();
    expect(mockSvcStart).toHaveBeenCalledTimes(1);
    expect(mockTranslate).toHaveBeenCalledWith("device.ble.serviceSearching", {
      names: "我的头盔, 一二三四五六七八九十十一…, bbbbbb, …",
    });
    setBleTargetNameResolver(null);
  });

  it("10-25：切语言后常驻通知立刻按新语言重写，不等下一次连上 / 断开；链路没在跑就不碰服务", async () => {
    refreshServiceNotification();
    expect(mockSvcStart).not.toHaveBeenCalled();
    expect(mockSvcStop).not.toHaveBeenCalled();
    await startBleLink(["helmet_94173f"]);
    await tick();
    mockSvcStart.mockClear();
    mockTranslate.mockImplementation((k: string) => `zh:${k}`);
    try {
      refreshServiceNotification();
      expect(mockSvcStart).toHaveBeenCalledWith(
        "zh:device.ble.serviceTitle",
        "zh:device.ble.serviceSearching",
      );
    } finally {
      mockTranslate.mockImplementation((k: string) => k);
    }
  });

  it("启动时没有目标（设备列表还没拉到）不起服务；目标补上后起", async () => {
    await startBleLink([]);
    await tick();
    expect(mockSvcStart).not.toHaveBeenCalled();
    setBleTargets(["helmet_94173f"]);
    expect(mockSvcStart).toHaveBeenCalledTimes(1);
  });

  it("蓝牙权限被拒：不起服务", async () => {
    const { PermissionsAndroid } =
      require("react-native") as typeof import("react-native");
    jest
      .spyOn(PermissionsAndroid, "request")
      .mockResolvedValue(PermissionsAndroid.RESULTS.DENIED);
    await startBleLink(["helmet_94173f"]);
    await tick();
    expect(mockSvcStart).not.toHaveBeenCalled();
    expect(useBleStore.getState().adapter).toBe("unauthorized");
  });

  it("2026-10-14 审查：拒绝后去系统设置授权、回前台 → 不弹框、只查一次，授了就重启链路", async () => {
    const { PermissionsAndroid } =
      require("react-native") as typeof import("react-native");
    let appStateCb: ((s: string) => void) | null = null;
    jest.spyOn(AppState, "addEventListener").mockImplementation(((
      _: string,
      cb: (s: string) => void,
    ) => {
      appStateCb = cb;
      return { remove: () => undefined };
    }) as never);
    const request = jest
      .spyOn(PermissionsAndroid, "request")
      .mockResolvedValue(PermissionsAndroid.RESULTS.DENIED);
    const check = jest
      .spyOn(PermissionsAndroid, "check")
      .mockResolvedValue(false);
    await startBleLink(["helmet_94173f"]);
    await tick();
    expect(useBleStore.getState().adapter).toBe("unauthorized");
    expect(appStateCb).not.toBeNull();
    // 回前台但还没授权：只 check，不再 request（否则会反复弹授权框）
    appStateCb!("active");
    await tick();
    expect(request).toHaveBeenCalledTimes(1);
    expect(mockSvcStart).not.toHaveBeenCalled();
    // 授了权再回前台：重新走一遍启动
    check.mockResolvedValue(true);
    request.mockResolvedValue(PermissionsAndroid.RESULTS.GRANTED);
    appStateCb!("active");
    await tick();
    await tick();
    expect(request).toHaveBeenCalledTimes(2);
    expect(mockSvcStart).toHaveBeenCalled();
  });

  it("起服务抛错（Android 12+ 后台起前台服务被拒）：链路照常，握手不被带崩", async () => {
    mockSvcStart.mockImplementation(() => {
      throw new Error("ForegroundServiceStartNotAllowedException");
    });
    await connectHelmet();
    expect(link()?.phase).toBe("connected");
    mockSvcStart.mockImplementation(() => undefined);
  });
});

describe("2026-10-05 评审：重建 BleManager 要等上一个销毁完", () => {
  const constructed = () =>
    (BleManager as unknown as Mock<() => unknown>).mock.calls.length;

  it("destroy 还没回来时再次启动：不新建（库里的单例还是那个正在销毁的实例），销毁完才建", async () => {
    await startBleLink(["helmet_94173f"]);
    await tick();
    let release!: () => void;
    mockDestroyGate.promise = new Promise<void>((r) => (release = r));
    stopBleLink();
    const before = constructed();
    const starting = startBleLink(["helmet_94173f"]);
    await tick();
    expect(constructed()).toBe(before);
    release();
    await starting;
    await tick();
    expect(constructed()).toBe(before + 1);
    expect(mockScans.length).toBeGreaterThan(0);
  });

  it("等销毁期间又停了（登出）：不再新建", async () => {
    await startBleLink(["helmet_94173f"]);
    await tick();
    let release!: () => void;
    mockDestroyGate.promise = new Promise<void>((r) => (release = r));
    stopBleLink();
    const before = constructed();
    const starting = startBleLink(["helmet_94173f"]);
    await tick();
    stopBleLink();
    release();
    await starting;
    await tick();
    expect(constructed()).toBe(before);
  });

  it("destroy 抛错 / 拒绝：不卡住后续启动", async () => {
    await startBleLink(["helmet_94173f"]);
    await tick();
    mockDestroyGate.promise = Promise.reject(new Error("native gone"));
    stopBleLink();
    await expect(bleStackReleased()).resolves.toBeUndefined();
  });
});

describe("B 线 10-06 评审 F3：解绑 / 停链路撞上连接或握手在途", () => {
  it("连接在途时解绑：连上后立刻断开，不建会话、不握手", async () => {
    let finishConnect!: (d: typeof fakeDevice) => void;
    fakeDevice.connect.mockImplementationOnce(
      () => new Promise<typeof fakeDevice>((r) => (finishConnect = r)),
    );
    await startBleLink(["helmet_94173f"]);
    await tick();
    scanCb?.(null, fakeDevice);
    await tick();
    setBleTargets([]); // 用户在设备详情页点了解绑
    finishConnect(fakeDevice);
    await tick(20);
    expect(helmet.cancelled).toBeGreaterThan(0);
    expect(helmet.writes).toHaveLength(0); // 一条指令都没发
    expect(isHelmetConnected("helmet_94173f")).toBe(false);
    expect(useBleStore.getState().links["helmet_94173f"]).toBeUndefined();
  });

  it("握手在途（对时之后、补传之前）解绑：不补传离线事件——否则 ACK 擦除后在服务端按未绑定丢掉", async () => {
    // 让对时指令（0x04）的写入挂起，这时解绑
    let release!: () => void;
    const origImpl =
      fakeDevice.writeCharacteristicWithResponseForService.getMockImplementation();
    fakeDevice.writeCharacteristicWithResponseForService.mockImplementation(
      async (_s, _c, v) => {
        const bytes = base64ToBytes(v);
        if (bytes[0] === 0x04) {
          await new Promise<void>((r) => (release = r));
          setBleTargets([]);
        }
        helmet.writes.push(bytesToHex(bytes));
        helmet.handle(bytes);
        return {};
      },
    );
    helmet.flash = [
      hexToBytes(
        "05 01 65 00 00 00 00 00 00 00 5F 2D 55 ED 4E CD 01 17 7C 29 07",
      ),
    ];
    await startBleLink(["helmet_94173f"]);
    await tick();
    scanCb?.(null, fakeDevice);
    for (let i = 0; i < 40 && !release; i += 1) await tick();
    release();
    await tick(40);
    // 没有发补传查询（0x07），离线事件还在头盔 Flash 里，也没有 ACK
    expect(helmet.writes.some((w) => w.startsWith("07 "))).toBe(false);
    expect(helmet.flash).toHaveLength(1);
    expect(helmet.acks).toHaveLength(0);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(isHelmetConnected("helmet_94173f")).toBe(false);
    // 已解绑的设备不该在页面上留一行「已断开」
    expect(useBleStore.getState().links["helmet_94173f"]).toBeUndefined();
    fakeDevice.writeCharacteristicWithResponseForService.mockImplementation(
      origImpl as never,
    );
  });
});

describe("10-29 评审：解绑最后一顶", () => {
  it("解绑最后一顶后不再起扫描轮：断开回调重开扫描时目标名单已经换掉了（原来按旧名单把刚解绑的那顶又扫 20 s）", async () => {
    await connectHelmet();
    expect(isHelmetConnected("helmet_94173f")).toBe(true);
    const scansBefore = mockScans.length;
    setBleTargets([]);
    await tick(40);
    expect(mockScans.length).toBe(scansBefore);
    expect(isHelmetConnected("helmet_94173f")).toBe(false);
    expect(useBleStore.getState().links["helmet_94173f"]).toBeUndefined();
  });
});

describe("2026-10-07 iPhone 8.9 实测：解绑撞上握手最后一步（读回设置）", () => {
  it("设置读回在途时解绑：会话已关、不能再被标成「已连接」，页面也不留行（上报步骤吞错，原来握手照样「成功」）", async () => {
    const origImpl =
      fakeDevice.writeCharacteristicWithResponseForService.getMockImplementation();
    fakeDevice.writeCharacteristicWithResponseForService.mockImplementation(
      async (_s, _c, v) => {
        const bytes = base64ToBytes(v);
        helmet.writes.push(bytesToHex(bytes));
        // 读设置（0x02 读 0x20 起 14 字节）这一条：先解绑，再让头盔应答
        if (bytes[0] === 0x02 && bytes[2] === 0x20) {
          setBleTargets([]);
          return {};
        }
        helmet.handle(bytes);
        return {};
      },
    );
    await startBleLink(["helmet_94173f"]);
    await tick();
    scanCb?.(null, fakeDevice);
    await tick(60);
    expect(helmet.writes.some((w) => w.startsWith("02 05 20"))).toBe(true);
    expect(isHelmetConnected("helmet_94173f")).toBe(false);
    expect(useBleStore.getState().links["helmet_94173f"]).toBeUndefined();
    const { devLog } = jest.requireMock<{ devLog: Mock }>("@/services/dev-log");
    expect(
      devLog.mock.calls.some((c) => String(c[0]).includes("已连接，固件")),
    ).toBe(false);
    fakeDevice.writeCharacteristicWithResponseForService.mockImplementation(
      origImpl as never,
    );
  });
});

describe("B 线 10-06 评审 F4：扫描轮次令牌", () => {
  it("查适配器状态期间停了链路：这一轮不再 startDeviceScan（ble-plx 只叠监听，泄漏的监听会劫持连接）", async () => {
    let answer!: (s: string) => void;
    mockState.mockImplementationOnce(
      () => new Promise<string>((r) => (answer = r)),
    );
    await startBleLink(["helmet_94173f"]);
    await tick();
    expect(mockScans).toHaveLength(0);
    stopBleLink();
    answer("PoweredOn");
    await tick();
    expect(mockScans).toHaveLength(0);
  });

  it("查适配器状态期间前后台切换重开了一轮：旧的那一轮作废，只剩新的一轮在扫", async () => {
    jest.useFakeTimers();
    const holder: { cb: ((s: string) => void) | null } = { cb: null };
    jest.spyOn(AppState, "addEventListener").mockImplementation(((
      _: string,
      cb: (s: string) => void,
    ) => {
      holder.cb = cb;
      return { remove: () => undefined };
    }) as never);
    await startBleLink(["helmet_94173f"]);
    await jest.advanceTimersByTimeAsync(0);
    expect(mockScans).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(20_000); // 切到全量
    expect(mockScans).toHaveLength(2);
    // 下一轮（回到过滤）的 state() 挂起时，退后台 → 又重开一轮
    let answer!: (s: string) => void;
    mockState.mockImplementationOnce(
      () => new Promise<string>((r) => (answer = r)),
    );
    await jest.advanceTimersByTimeAsync(20_000);
    expect(mockScans).toHaveLength(2); // 第三轮卡在 state()
    override(AppState, "currentState", "background");
    holder.cb?.("background");
    await jest.advanceTimersByTimeAsync(0);
    answer("PoweredOn"); // 旧的第三轮这时才返回
    await jest.advanceTimersByTimeAsync(0);
    // 只多了一轮（后台重开的那一轮），卡住的旧轮没有再起一次扫描
    expect(mockScans).toHaveLength(3);
  });

  it("停掉的那一轮迟到的扫描回调不认：不会再去连接", async () => {
    await startBleLink(["helmet_94173f"]);
    await tick();
    const staleCb = scanCb;
    stopBleLink();
    await bleStackReleased();
    fakeDevice.connect.mockClear();
    staleCb?.(null, fakeDevice);
    await tick();
    expect(fakeDevice.connect).not.toHaveBeenCalled();
  });

  it("被换掉的那一轮迟到的发现回调不认（新一轮还在扫、目标也还在）：不会由旧监听发起连接", async () => {
    jest.useFakeTimers();
    await startBleLink(["helmet_94173f"]);
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(20_000); // 切全量：第二轮，旧监听仍挂在 ble-plx 上
    expect(mockScanCbs).toHaveLength(2);
    fakeDevice.connect.mockClear();
    mockScanCbs[0](null, fakeDevice); // 旧监听迟到的回调
    await jest.advanceTimersByTimeAsync(0);
    expect(fakeDevice.connect).not.toHaveBeenCalled();
    mockScanCbs[1](null, fakeDevice); // 当前这一轮的才算
    await jest.advanceTimersByTimeAsync(0);
    expect(fakeDevice.connect).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(50); // 让这次连接走完，别把 connecting 留给下一个用例
  });

  it("一次只连一台：连接在途时第二个发现回调不再发起连接", async () => {
    let finishConnect!: (d: typeof fakeDevice) => void;
    fakeDevice.connect.mockImplementationOnce(
      () => new Promise<typeof fakeDevice>((r) => (finishConnect = r)),
    );
    await startBleLink(["helmet_94173f", "helmet_other2"]);
    await tick();
    scanCb?.(null, fakeDevice);
    await tick();
    scanCb?.(null, {
      ...fakeDevice,
      id: "periph-2",
      name: "Helmet-other2",
      localName: "Helmet-other2",
    });
    await tick();
    expect(fakeDevice.connect).toHaveBeenCalledTimes(1);
    finishConnect(fakeDevice);
    await tick(40);
    expect(isHelmetConnected("helmet_94173f")).toBe(true);
  });
});

describe("B 线 10-06 评审 F-3：头盔对时用服务端时钟", () => {
  it("手机快 90 秒时，TIME SYNC 帧里写的是服务端时间", async () => {
    noteServerDate(new Date(Date.now() - 90_000).toUTCString(), Date.now());
    await connectHelmet();
    const sync = helmet.writes.find((w) => w.startsWith("04 "));
    expect(sync).toBeDefined();
    const ts = hexToBytes(sync!).slice(2, 6);
    const utc = ts[0] | (ts[1] << 8) | (ts[2] << 16) | (ts[3] << 24);
    const localSec = Math.floor(Date.now() / 1000);
    expect(localSec - utc).toBeGreaterThanOrEqual(85);
    expect(localSec - utc).toBeLessThanOrEqual(95);
    __resetServerClockForTests();
  });
});

// —— 2026-10-19 补分支：全量覆盖率里 ble-link 没走到的分支（权限、复用系统连接、兜底核身、退避、异常应答、收帧边角） ——
describe("补分支（2026-10-19）", () => {
  const ID = "helmet_94173f";
  const FEE0_UUID = "0000fee0-0000-1000-8000-00805f9b34fb";
  const { PERMISSIONS, RESULTS } = PermissionsAndroid;
  const reportSettingsMock = devicesApi.reportSettings as unknown as Mock<
    typeof devicesApi.reportSettings
  >;
  const devLogMock = () =>
    jest.requireMock<{ devLog: Mock }>("@/services/dev-log").devLog;
  /** 开发日志里有没有哪一行带这段字 */
  const logged = (text: string) =>
    devLogMock().mock.calls.some((c) =>
      c.some((a) => String(a).includes(text)),
    );
  const managerCount = () =>
    (BleManager as unknown as Mock<() => unknown>).mock.calls.length;
  const until = async (cond: () => boolean, rounds = 60) => {
    for (let i = 0; i < rounds && !cond(); i += 1) await tick();
  };
  const scanError = () =>
    scanCb?.({ message: "Cannot start scanning operation" }, null);
  /** 未处理的拒绝要到宏任务边界才报：用例结束前让一次，免得记到后面的用例头上 */
  const flushMacrotask = () =>
    new Promise<void>((r) => {
      setImmediate(r);
    });
  const asAndroid = (version: number) => {
    override(Platform, "OS", "android");
    override(Platform, "Version", version);
  };
  /** 链路同一时刻只挂一个 AppState 监听（扫描用的，或权限被拒后等回前台的） */
  const captureAppState = () => {
    const holder: { cb: ((s: string) => void) | null } = { cb: null };
    jest.spyOn(AppState, "addEventListener").mockImplementation(((
      _: string,
      cb: (s: string) => void,
    ) => {
      holder.cb = cb;
      return { remove: () => undefined };
    }) as never);
    return holder;
  };

  beforeEach(() => {
    fakeDevice.writeCharacteristicWithResponseForService.mockImplementation(
      defaultWrite,
    );
    fakeDevice.writeCharacteristicWithoutResponseForService.mockImplementation(
      defaultAck,
    );
    devLogMock().mockClear();
    reportSettingsMock.mockClear();
  });

  describe("权限：Android 12+、申请抛错、等权限期间停链路", () => {
    it("Android 12+：一次申请扫描 + 连接两项，都给了才启动并起前台服务", async () => {
      asAndroid(31);
      const multi = jest
        .spyOn(PermissionsAndroid, "requestMultiple")
        .mockResolvedValue({
          [PERMISSIONS.BLUETOOTH_SCAN]: RESULTS.GRANTED,
          [PERMISSIONS.BLUETOOTH_CONNECT]: RESULTS.GRANTED,
        } as never);
      await startBleLink([ID]);
      await tick();
      expect(multi).toHaveBeenCalledWith([
        PERMISSIONS.BLUETOOTH_SCAN,
        PERMISSIONS.BLUETOOTH_CONNECT,
      ]);
      expect(mockSvcStart).toHaveBeenCalledTimes(1);
      expect(mockScans).toHaveLength(1);
    });

    it("Android 12+ 只给了扫描、没给连接：未授权、不起服务；去设置里补上后回前台只查这两项（不弹框），都给了才重启", async () => {
      asAndroid(31);
      const app = captureAppState();
      const multi = jest
        .spyOn(PermissionsAndroid, "requestMultiple")
        .mockResolvedValue({
          [PERMISSIONS.BLUETOOTH_SCAN]: RESULTS.GRANTED,
          [PERMISSIONS.BLUETOOTH_CONNECT]: RESULTS.DENIED,
        } as never);
      const granted = new Set<string>([PERMISSIONS.BLUETOOTH_SCAN]);
      const check = jest
        .spyOn(PermissionsAndroid, "check")
        .mockImplementation(async (p) => granted.has(p));
      await startBleLink([ID]);
      await tick();
      expect(useBleStore.getState().adapter).toBe("unauthorized");
      expect(mockSvcStart).not.toHaveBeenCalled();

      app.cb?.("active");
      await tick();
      expect(check.mock.calls.map((c) => c[0])).toEqual([
        PERMISSIONS.BLUETOOTH_SCAN,
        PERMISSIONS.BLUETOOTH_CONNECT,
      ]);
      expect(multi).toHaveBeenCalledTimes(1);
      expect(mockSvcStart).not.toHaveBeenCalled();

      granted.add(PERMISSIONS.BLUETOOTH_CONNECT);
      multi.mockResolvedValue({
        [PERMISSIONS.BLUETOOTH_SCAN]: RESULTS.GRANTED,
        [PERMISSIONS.BLUETOOTH_CONNECT]: RESULTS.GRANTED,
      } as never);
      app.cb?.("active");
      await tick();
      await tick();
      expect(multi).toHaveBeenCalledTimes(2);
      expect(mockSvcStart).toHaveBeenCalledTimes(1);
    });

    it("申请权限本身抛错（安卓界面还没挂上 Activity 时会抛）：按未授权处理；回前台查到已授权就重启", async () => {
      asAndroid(29);
      const app = captureAppState();
      const request = jest
        .spyOn(PermissionsAndroid, "request")
        .mockRejectedValueOnce(
          new Error(
            "Tried to use permissions API while not attached to an Activity.",
          ),
        )
        .mockResolvedValue(RESULTS.GRANTED);
      jest.spyOn(PermissionsAndroid, "check").mockResolvedValue(true);
      await startBleLink([ID]);
      await tick();
      expect(useBleStore.getState().adapter).toBe("unauthorized");
      expect(mockSvcStart).not.toHaveBeenCalled();

      app.cb?.("active");
      await tick();
      await tick();
      expect(request).toHaveBeenCalledTimes(2);
      expect(mockSvcStart).toHaveBeenCalledTimes(1);
    });

    it("回前台查权限时系统接口抛错：当成没授权，不重启、也不再弹框", async () => {
      asAndroid(29);
      const app = captureAppState();
      const request = jest
        .spyOn(PermissionsAndroid, "request")
        .mockResolvedValue(RESULTS.DENIED);
      jest
        .spyOn(PermissionsAndroid, "check")
        .mockRejectedValue(new Error("no activity"));
      await startBleLink([ID]);
      await tick();
      app.cb?.("active");
      await flushMacrotask();
      expect(request).toHaveBeenCalledTimes(1);
      expect(mockSvcStart).not.toHaveBeenCalled();
      expect(useBleStore.getState().adapter).toBe("unauthorized");
    });

    it("拒绝后切到后台（不是回到前台）：不去查权限", async () => {
      asAndroid(29);
      const app = captureAppState();
      jest
        .spyOn(PermissionsAndroid, "request")
        .mockResolvedValue(RESULTS.DENIED);
      const check = jest
        .spyOn(PermissionsAndroid, "check")
        .mockResolvedValue(true);
      await startBleLink([ID]);
      await tick();
      app.cb?.("background");
      await tick();
      expect(check).not.toHaveBeenCalled();
      expect(mockSvcStart).not.toHaveBeenCalled();
    });

    it("等权限框期间停了链路（登出 / 进工程模式）：授权回来不起服务、不建 BleManager；拒绝也不挂「回前台重启」的监听", async () => {
      asAndroid(29);
      const app = captureAppState();
      let answer!: (r: string) => void;
      jest
        .spyOn(PermissionsAndroid, "request")
        .mockImplementation(
          () => new Promise<string>((r) => (answer = r)) as never,
        );
      const check = jest
        .spyOn(PermissionsAndroid, "check")
        .mockResolvedValue(true);
      const before = managerCount();
      let starting = startBleLink([ID]);
      await tick();
      stopBleLink();
      answer(RESULTS.GRANTED);
      await starting;
      await tick();
      expect(mockSvcStart).not.toHaveBeenCalled();
      expect(managerCount()).toBe(before);
      expect(mockScans).toHaveLength(0);

      starting = startBleLink([ID]);
      await tick();
      stopBleLink();
      answer(RESULTS.DENIED);
      await starting;
      expect(useBleStore.getState().adapter).toBe("unknown");
      expect(app.cb).toBeNull();
      app.cb?.("active");
      await tick();
      expect(check).not.toHaveBeenCalled();
      expect(mockSvcStart).not.toHaveBeenCalled();
    });

    it("开屏还在播、这次要弹授权框（O27）：等开屏让开再弹；已授过权的不等", async () => {
      asAndroid(29);
      const request = jest
        .spyOn(PermissionsAndroid, "request")
        .mockResolvedValue(RESULTS.GRANTED);
      const check = jest
        .spyOn(PermissionsAndroid, "check")
        .mockResolvedValue(false);
      setSplashCovering(true);
      try {
        const starting = startBleLink([ID]);
        await tick();
        expect(check).toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
        setSplashCovering(false);
        await starting;
        expect(request).toHaveBeenCalledTimes(1);
        expect(mockSvcStart).toHaveBeenCalledTimes(1);

        stopBleLink();
        await bleStackReleased();
        check.mockResolvedValue(true);
        setSplashCovering(true);
        await startBleLink([ID]);
        expect(request).toHaveBeenCalledTimes(2); // 授过权：requestMultiple / request 不会弹框，直接拿结果
      } finally {
        setSplashCovering(false);
      }
    });

    it("开屏一直不让开：最多等 5 s 就弹；等的时候停了链路就不弹", async () => {
      jest.useFakeTimers();
      asAndroid(29);
      const request = jest
        .spyOn(PermissionsAndroid, "request")
        .mockResolvedValue(RESULTS.GRANTED);
      jest.spyOn(PermissionsAndroid, "check").mockResolvedValue(false);
      setSplashCovering(true);
      try {
        const starting = startBleLink([ID]);
        await jest.advanceTimersByTimeAsync(4_999);
        expect(request).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        await starting;
        expect(request).toHaveBeenCalledTimes(1);

        stopBleLink();
        await bleStackReleased();
        const again = startBleLink([ID]);
        await jest.advanceTimersByTimeAsync(1_000);
        stopBleLink();
        await jest.advanceTimersByTimeAsync(5_000);
        await again;
        expect(request).toHaveBeenCalledTimes(1);
      } finally {
        setSplashCovering(false);
      }
    });

    it("链路已在跑时再次启动（退出工程模式恢复）：只更新目标，不再申请权限、不重建 BleManager", async () => {
      asAndroid(29);
      const request = jest
        .spyOn(PermissionsAndroid, "request")
        .mockResolvedValue(RESULTS.GRANTED);
      await startBleLink([ID]);
      await tick();
      const before = managerCount();
      await startBleLink([ID, "helmet_aaaaaa"]);
      expect(request).toHaveBeenCalledTimes(1);
      expect(managerCount()).toBe(before);
      expect(currentBleTargets()).toEqual([ID, "helmet_aaaaaa"]);
    });
  });

  describe("系统里已连着的头盔与 iOS 状态恢复", () => {
    const managerOptions = () =>
      (
        BleManager as unknown as Mock<
          (o: { restoreStateFunction: (r: unknown) => void }) => unknown
        >
      ).mock.calls.at(-1)![0];

    it("系统还连着这顶头盔（上次 JS 会话 / 进程留下的连接）：不扫描，直接复用它握手；名字先看 localName，没有再看 name", async () => {
      mockConnected.mockResolvedValue([
        {
          ...fakeDevice,
          id: "periph-x",
          localName: "Helmet-zzzzzz",
          name: "Helmet-zzzzzz",
        },
        { ...fakeDevice, localName: null, name: "Helmet-94173f" },
      ]);
      await startBleLink([ID]);
      await until(() => link()?.phase === "connected");
      expect(link()?.phase).toBe("connected");
      expect(mockConnected).toHaveBeenCalledWith([FEE0_UUID]);
      expect(mockScans).toHaveLength(0);
    });

    it("查系统已连接外设失败：照常扫描", async () => {
      mockConnected.mockRejectedValueOnce(
        new Error("BluetoothManagerDestroyed"),
      );
      await startBleLink([ID]);
      await tick();
      expect(mockScans).toEqual([[FEE0_UUID]]);
      expect(logged("查询已连接外设失败")).toBe(true);
    });

    it("查系统已连接外设期间停了链路：这一轮作废——查回来成功还是失败都不再连、不再扫", async () => {
      let answer!: (v: unknown[]) => void;
      mockConnected.mockImplementationOnce(
        () => new Promise<unknown[]>((r) => (answer = r)),
      );
      await startBleLink([ID]);
      await tick();
      stopBleLink();
      answer([{ ...fakeDevice }]);
      await tick();
      expect(fakeDevice.connect).not.toHaveBeenCalled();
      expect(mockScans).toHaveLength(0);

      await bleStackReleased();
      let fail!: (e: Error) => void;
      mockConnected.mockImplementationOnce(
        () => new Promise<unknown[]>((_r, rej) => (fail = rej)),
      );
      await startBleLink([ID]);
      await tick();
      stopBleLink();
      fail(new Error("BluetoothManagerDestroyed"));
      await tick();
      expect(mockScans).toHaveLength(0);
      expect(logged("查询已连接外设失败")).toBe(false);
    });

    it("iOS 状态恢复回调（后台被回收后由外设事件拉起）：链路在跑就立即去接系统交还的头盔，不等适配器状态事件、不扫描", async () => {
      mockAdapter.initial = null;
      await startBleLink([ID]);
      await tick();
      expect(mockConnected).not.toHaveBeenCalled();
      mockConnected.mockResolvedValue([{ ...fakeDevice }]);
      managerOptions().restoreStateFunction({
        connectedPeripherals: [
          { localName: "Helmet-94173f", name: "iPhone" },
          { localName: null, name: "Helmet-aaaaaa" },
        ],
      });
      await until(() => link()?.phase === "connected");
      expect(link()?.phase).toBe("connected");
      expect(mockScans).toHaveLength(0);
      expect(devLogMock()).toHaveBeenCalledWith(
        "BLE",
        "系统恢复 BLE 状态",
        "Helmet-94173f,Helmet-aaaaaa",
      );
    });

    it("链路停了之后迟到的恢复回调（没带外设）：只记一笔，不去找头盔", async () => {
      mockAdapter.initial = null;
      await startBleLink([ID]);
      await tick();
      const { restoreStateFunction } = managerOptions();
      stopBleLink();
      restoreStateFunction(null);
      await tick();
      expect(mockConnected).not.toHaveBeenCalled();
      expect(mockScans).toHaveLength(0);
      expect(devLogMock()).toHaveBeenCalledWith(
        "BLE",
        "系统恢复 BLE 状态",
        "(无已连接外设)",
      );
    });
  });

  describe("扫描回调：广播名对不上时按 FEE0 兜底核身", () => {
    const nameless = (id: string, uuids: string[] | null) => ({
      ...fakeDevice,
      id,
      name: null,
      localName: null,
      serviceUUIDs: uuids,
    });

    it("广播包里没有 localName 也没带 FEE0（安卓全量扫描常见）：用系统给的设备名匹配", async () => {
      await startBleLink([ID]);
      await tick();
      scanCb?.(null, { ...fakeDevice, localName: null, serviceUUIDs: null });
      await until(() => link()?.phase === "connected");
      expect(link()?.phase).toBe("connected");
    });

    it("没有名字但广播了 FEE0、且只盯一顶：连上去读 0x40 核身，是这顶就连上（UUID 报成大写也认）", async () => {
      await startBleLink([ID]);
      await tick();
      scanCb?.(null, nameless("periph-9", [FEE0_UUID.toUpperCase()]));
      await until(() => link()?.phase === "connected");
      expect(link()?.phase).toBe("connected");
      expect(helmet.writes[0]).toBe("02 01 40 10");
    });

    it("兜底核身发现是别人的头盔：只忽略这台外设、继续扫，不拉黑自己的设备；它再出现也不连", async () => {
      helmet.deviceId = "helmet_other1";
      await startBleLink([ID]);
      await tick();
      scanCb?.(null, nameless("periph-9", [FEE0_UUID]));
      await until(() => mockScans.length >= 2);
      expect(link()?.phase).toBe("scanning");
      expect(fakeDevice.connect).toHaveBeenCalledTimes(1);

      scanCb?.(null, nameless("periph-9", [FEE0_UUID]));
      await tick();
      expect(fakeDevice.connect).toHaveBeenCalledTimes(1);

      helmet.deviceId = ID;
      scanCb?.(null, fakeDevice);
      await until(() => link()?.phase === "connected");
      expect(link()?.phase).toBe("connected");
    });

    it("没名字又不带 FEE0、或带 FEE0 但同时盯着两顶：都不去碰（定不了是哪一顶）", async () => {
      await startBleLink([ID]);
      await tick();
      scanCb?.(null, nameless("periph-8", null));
      await tick();
      expect(fakeDevice.connect).not.toHaveBeenCalled();

      setBleTargets([ID, "helmet_aaaaaa"]);
      scanCb?.(null, nameless("periph-9", [FEE0_UUID]));
      await tick();
      expect(fakeDevice.connect).not.toHaveBeenCalled();
    });

    it("10-25 审查：名字明摆着是另一顶头盔（Helmet-xxxxxx、不是要连的这顶）：带 FEE0、只盯一顶也不去连；只是大小写不同的照样核身连上", async () => {
      await startBleLink([ID]);
      await tick();
      const peer = (id: string, name: string) => ({
        ...fakeDevice,
        id,
        localName: name,
        name,
        serviceUUIDs: [FEE0_UUID],
      });
      scanCb?.(null, peer("periph-5", "Helmet-a1b2c3"));
      await tick();
      expect(fakeDevice.connect).not.toHaveBeenCalled();
      scanCb?.(null, peer("periph-6", "Helmet-94173F"));
      await until(() => link()?.phase === "connected");
      expect(link()?.phase).toBe("connected");
    });

    it("10-25 审查：兜底候选握手失败但不是身份不符（如广播 FEE0 的手环不应答）：这台外设冷却 30 s，期间再出现不连，过了再试", async () => {
      jest.useFakeTimers();
      helmet.override = (f) => f[0] === 0x02 && f[2] === 0x40;
      await startBleLink([ID]);
      await jest.advanceTimersByTimeAsync(0);
      scanCb?.(null, nameless("periph-9", [FEE0_UUID]));
      await until(() => link()?.phase === "handshaking");
      await jest.advanceTimersByTimeAsync(3_000);
      await until(() => link()?.phase === "scanning");
      expect(fakeDevice.connect).toHaveBeenCalledTimes(1);
      scanCb?.(null, nameless("periph-9", [FEE0_UUID]));
      await tick();
      expect(fakeDevice.connect).toHaveBeenCalledTimes(1);
      helmet.override = null;
      await jest.advanceTimersByTimeAsync(30_000);
      scanCb?.(null, nameless("periph-9", [FEE0_UUID]));
      await until(() => link()?.phase === "connected");
      expect(fakeDevice.connect).toHaveBeenCalledTimes(2);
      expect(link()?.phase).toBe("connected");
    });

    it("10-25 审查：核身前推来的事件帧（Notify 已开、0x40 应答还没回）不入队、不 ACK；核身后头盔重发的同一帧照常入队并 ACK", async () => {
      enqueueMock.mockImplementation(() => undefined);
      enqueueMock.mockClear();
      fakeDevice.writeCharacteristicWithoutResponseForService.mockImplementation(
        async (_s, _c, v) => {
          helmet.acks.push(bytesToHex(base64ToBytes(v)));
          return {};
        },
      );
      const fall = hexToBytes(
        "05 01 66 00 00 00 00 00 00 00 5F 2D 55 ED 4E CD 01 17 7C 29 07",
      );
      let pushed = false;
      helmet.override = (f) => {
        if (f[0] === 0x02 && f[2] === 0x40 && !pushed) {
          pushed = true;
          helmet.push(fall);
        }
        return false;
      };
      await startBleLink([ID]);
      await tick();
      scanCb?.(null, fakeDevice);
      await until(() => link()?.phase === "connected");
      expect(pushed).toBe(true);
      expect(enqueueMock).not.toHaveBeenCalled();
      expect(helmet.acks).toEqual([]);
      expect(logged("核身前收到事件")).toBe(true);
      helmet.push(fall);
      await tick();
      expect(enqueueMock).toHaveBeenCalledTimes(1);
      expect(helmet.acks).toEqual(["06 01 66 00 00 00 00"]);
    });

    it("10-25 审查：握手还没核完身份时来的设置写入：不写进头盔、回「未送达」；这时也不算已连接", async () => {
      let result: unknown;
      let connectedMidway: boolean | undefined;
      helmet.override = (f) => {
        if (f[0] === 0x02 && f[2] === 0x40 && connectedMidway === undefined) {
          connectedMidway = isHelmetConnected(ID);
          void writeHelmetRegister(ID, 0x24, [3]).then((r) => (result = r));
        }
        return false;
      };
      await startBleLink([ID]);
      await tick();
      scanCb?.(null, fakeDevice);
      await until(() => link()?.phase === "connected");
      await until(() => result !== undefined);
      expect(connectedMidway).toBe(false);
      expect(result).toEqual({ delivered: false });
      expect(helmet.writes.some((w) => w.startsWith("03 "))).toBe(false);
      expect(isHelmetConnected(ID)).toBe(true);
    });
    it("开发日志里同一个名字只记一次「发现」；广播里没带服务 UUID 也照记", async () => {
      await startBleLink([ID]);
      await tick();
      const band = {
        ...fakeDevice,
        id: "periph-7",
        localName: "Mi Band 8",
        name: "Mi Band 8",
        serviceUUIDs: null,
      };
      scanCb?.(null, band);
      scanCb?.(null, band);
      expect(devLogMock().mock.calls.filter((c) => c[1] === "发现")).toEqual([
        ["BLE", "发现", "Mi Band 8", ""],
      ]);
      expect(fakeDevice.connect).not.toHaveBeenCalled();
    });
  });

  describe("扫描出错与掉线重连的退避", () => {
    it("扫描出错：停掉这一轮，2 s 后重扫；连续出错按 2 → 4 → 8 → 16 → 30 s 退避，封顶 30 s", async () => {
      jest.useFakeTimers();
      await startBleLink([ID]);
      await jest.advanceTimersByTimeAsync(0);
      expect(mockScans).toHaveLength(1);
      const waits = [2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
      for (const [i, wait] of waits.entries()) {
        scanError();
        await jest.advanceTimersByTimeAsync(wait - 1);
        expect(mockScans).toHaveLength(i + 1);
        await jest.advanceTimersByTimeAsync(1);
        expect(mockScans).toHaveLength(i + 2);
      }
    });

    it("外设掉线：立刻重新扫描，不等退避定时器（安卓后台 JS 定时器不走，10-25 审查）；重扫期间仍标已断开；退避到点不重复起扫描；重新连上", async () => {
      jest.useFakeTimers();
      await connectHelmet();
      expect(link()?.phase).toBe("connected");
      for (let round = 0; round < 2; round += 1) {
        const n = mockScans.length;
        helmet.disconnectCb?.(null, fakeDevice);
        await jest.advanceTimersByTimeAsync(0); // 只让微任务走完，时间不动
        expect(mockScans).toHaveLength(n + 1);
        expect(link()?.phase).toBe("disconnected");
        await jest.advanceTimersByTimeAsync(2_000);
        expect(mockScans).toHaveLength(n + 1);
        scanCb?.(null, fakeDevice);
        await until(() => link()?.phase === "connected");
        expect(link()?.phase).toBe("connected");
      }
    });

    it("扫描出错累起来的退避：扫描恢复、连上头盔后清零——掉线后再出一次错，2 s 就重扫（10-19 夜测）", async () => {
      jest.useFakeTimers();
      await startBleLink([ID]);
      await jest.advanceTimersByTimeAsync(0);
      for (const wait of [2_000, 4_000, 8_000]) {
        scanError();
        await jest.advanceTimersByTimeAsync(wait);
      }
      expect(mockScans).toHaveLength(4);
      scanCb?.(null, fakeDevice);
      await until(() => link()?.phase === "connected");
      expect(link()?.phase).toBe("connected");

      helmet.disconnectCb?.(null, fakeDevice);
      await jest.advanceTimersByTimeAsync(2_000);
      expect(mockScans).toHaveLength(5);
      scanError();
      await jest.advanceTimersByTimeAsync(1_999);
      expect(mockScans).toHaveLength(5);
      await jest.advanceTimersByTimeAsync(1);
      // 退避是 2 s 没错，但 30 s 里已经起扫 5 次（出错的三次也算）：第 6 次压到最早那次出了窗口再起
      //（安卓 5 次 / 30 s 的限制，10-31）——此刻 t=18 s，等到 t≈30 s
      expect(mockScans).toHaveLength(5);
      await jest.advanceTimersByTimeAsync(12_100);
      expect(mockScans).toHaveLength(6);
    });

    it("带设备号的重试（设备页「重试连接」）：扫描出错的退避也清零、立即重扫，之后再出错从 2 s 算", async () => {
      jest.useFakeTimers();
      await startBleLink([ID]);
      await jest.advanceTimersByTimeAsync(0);
      for (const wait of [2_000, 4_000]) {
        scanError();
        await jest.advanceTimersByTimeAsync(wait);
      }
      expect(mockScans).toHaveLength(3);
      scanError(); // 不重试的话这次要等 8 s
      retryBleLink(ID);
      await jest.advanceTimersByTimeAsync(0);
      expect(mockScans).toHaveLength(4);
      scanError();
      await jest.advanceTimersByTimeAsync(2_000);
      expect(mockScans).toHaveLength(5);
    });

    it("不带设备号的重试（开发面板「全部重连」）：扫描出错累起来的退避清零、立即重扫，之后再出错从 2 s 算", async () => {
      jest.useFakeTimers();
      await startBleLink([ID]);
      await jest.advanceTimersByTimeAsync(0);
      for (const wait of [2_000, 4_000]) {
        scanError();
        await jest.advanceTimersByTimeAsync(wait);
      }
      expect(mockScans).toHaveLength(3);
      scanError(); // 不重试的话这次要等 8 s
      retryBleLink();
      await jest.advanceTimersByTimeAsync(0);
      expect(mockScans).toHaveLength(4);
      scanError();
      await jest.advanceTimersByTimeAsync(2_000);
      expect(mockScans).toHaveLength(5);
    });

    it("不带设备号的重试：身份不符被拉黑的头盔也解除，马上重新扫描", async () => {
      helmet.deviceId = "helmet_other1";
      await connectHelmet();
      expect(link()?.phase).toBe("error");
      const n = mockScans.length;
      helmet.deviceId = ID;
      retryBleLink();
      await tick();
      expect(mockScans).toHaveLength(n + 1);
      scanCb?.(null, fakeDevice);
      await until(() => link()?.phase === "connected");
      expect(link()?.phase).toBe("connected");
    });
  });

  describe("握手的异常应答", () => {
    it("指令 3 s 没有应答：握手失败、断开，回到扫描（不拉黑）", async () => {
      jest.useFakeTimers();
      helmet.override = (f) => f[0] === 0x02 && f[2] === 0x40;
      await startBleLink([ID]);
      await jest.advanceTimersByTimeAsync(0);
      scanCb?.(null, fakeDevice);
      await until(() => link()?.phase === "handshaking");
      await jest.advanceTimersByTimeAsync(2_999);
      expect(link()?.phase).toBe("handshaking");
      await jest.advanceTimersByTimeAsync(1);
      await until(() => link()?.phase === "scanning");
      expect(helmet.cancelled).toBeGreaterThan(0);
      expect(isHelmetConnected(ID)).toBe(false);
      expect(link()?.phase).toBe("scanning");
      expect(logged("3000ms 无应答")).toBe(true);
    });

    it("写特征值失败（GATT 报错）：握手失败、断开，回到扫描；再发现时能正常连上", async () => {
      fakeDevice.writeCharacteristicWithResponseForService.mockRejectedValueOnce(
        new Error("GATT_ERROR 133"),
      );
      await startBleLink([ID]);
      await tick();
      scanCb?.(null, fakeDevice);
      await until(() => mockScans.length >= 2);
      expect(isHelmetConnected(ID)).toBe(false);
      expect(helmet.cancelled).toBeGreaterThan(0);
      expect(link()?.phase).toBe("scanning");

      scanCb?.(null, fakeDevice);
      await until(() => link()?.phase === "connected");
      expect(link()?.phase).toBe("connected");
    });

    it("读 deviceId 回了手册之外的错误码：按普通握手失败处理（日志带原始错误码），不拉黑", async () => {
      helmet.idError = 0x20;
      await startBleLink([ID]);
      await tick();
      scanCb?.(null, fakeDevice);
      await until(() => mockScans.length >= 2);
      expect(link()?.phase).toBe("scanning");
      expect(logged("读 deviceId 失败：error=0x20")).toBe(true);
    });

    it("应答的指令码和发出去的对不上（Seq 对得上）：只记日志，照常当作这条指令的应答", async () => {
      helmet.override = (f) => {
        if (f[0] !== 0x04) return false;
        helmet.reply([0x01, f[1], 0x00]);
        return true;
      };
      await connectHelmet();
      expect(link()?.phase).toBe("connected");
      expect(logged("应答指令码不符：发 0x4 收 0x1")).toBe(true);
    });

    it("头盔读设置回错误（老固件不支持读 0x20–0x2D）：跳过上报，照常连上", async () => {
      helmet.override = (f) => {
        if (f[0] !== 0x02 || f[2] !== 0x20) return false;
        helmet.reply([0x02, f[1], 0x03]);
        return true;
      };
      await connectHelmet();
      expect(link()?.phase).toBe("connected");
      expect(reportSettingsMock).not.toHaveBeenCalled();
    });

    it("云端没采纳其中几项设置：日志逐项写出键和原因，链路照常", async () => {
      reportSettingsMock.mockResolvedValueOnce({
        settings: {},
        applied: ["volume"],
        skipped: [
          { key: "light", reason: "recent_command", message: "30 s 内有命令" },
          { key: "buzzer", reason: "invalid", message: "类型不符" },
        ],
      });
      await connectHelmet();
      expect(link()?.phase).toBe("connected");
      expect(
        logged("采纳 1 项，跳过 light(recent_command)、buzzer(invalid)"),
      ).toBe(true);
    });

    it("Android：协商 MTU 失败不影响握手（短帧照样能用）", async () => {
      asAndroid(29);
      jest
        .spyOn(PermissionsAndroid, "request")
        .mockResolvedValue(RESULTS.GRANTED);
      fakeDevice.requestMTU.mockClear();
      fakeDevice.requestMTU.mockRejectedValueOnce(new Error("MTU 协商失败"));
      await connectHelmet();
      expect(fakeDevice.requestMTU).toHaveBeenCalledWith(247);
      expect(link()?.phase).toBe("connected");
    });

    it("补传：头盔不认补传查询（回错误码，哪怕带了数据段）或查询应答不足 2 字节：不再拉取，照常连上", async () => {
      for (const tail of [
        [0x02, 0x05, 0x00],
        [0x00, 0x01],
      ]) {
        helmet.override = (f) => {
          if (f[0] !== 0x07) return false;
          helmet.reply([0x07, f[1], ...tail]);
          return true;
        };
        helmet.writes = [];
        await connectHelmet();
        expect(link()?.phase).toBe("connected");
        expect(helmet.writes.some((w) => w.startsWith("08 "))).toBe(false);
        stopBleLink();
        await bleStackReleased();
      }
    });

    it("补传：头盔说有离线事件、拉取却回 0 条：立即停下，不空转 50 轮", async () => {
      helmet.override = (f) => {
        if (f[0] === 0x07) helmet.reply([0x07, f[1], 0x00, 0x02, 0x00]);
        else if (f[0] === 0x08) helmet.reply([0x08, f[1], 0x00]);
        else return false;
        return true;
      };
      await connectHelmet();
      expect(link()?.phase).toBe("connected");
      expect(helmet.writes.filter((w) => w.startsWith("08 "))).toHaveLength(1);
      expect(flushMock).not.toHaveBeenCalled();
    });

    it("断开落在握手收尾前后哪一刻，都不会把已断开的会话标成已连接（含 open() 刚返回、还没登记的那一瞬）", async () => {
      let hitGap = false;
      for (let depth = 0; depth <= 16; depth += 1) {
        let fired = false;
        // 设置上报是握手最后一步：从它返回起数 depth 个微任务再断开，扫过「握手中 → 刚握完 → 已登记」整段
        reportSettingsMock.mockImplementationOnce(async () => {
          let p: Promise<void> = Promise.resolve();
          for (let i = 0; i < depth; i += 1) p = p.then(() => undefined);
          void p.then(() => {
            fired = true;
            helmet.disconnectCb?.(null, fakeDevice);
          });
          return { settings: {}, applied: [], skipped: [] };
        });
        devLogMock().mockClear();
        await startBleLink([ID]);
        await tick();
        scanCb?.(null, fakeDevice);
        await until(() => fired, 200);
        await tick(4);
        expect(fired).toBe(true);
        expect(isHelmetConnected(ID)).toBe(false);
        expect(link()?.phase).not.toBe("connected");
        if (logged("握手期间会话已关闭，不登记")) {
          hitGap = true;
          expect(logged("已连接，固件")).toBe(false);
        }
        stopBleLink();
        await bleStackReleased();
      }
      expect(hitGap).toBe(true);
    });
  });

  describe("通知通道与收帧", () => {
    it("通知通道报错（如对端断开）：关闭会话、显示已断开，立刻重新扫描（10-25），2 s 后的退避不再多起一轮", async () => {
      jest.useFakeTimers();
      await connectHelmet();
      const n = mockScans.length;
      helmet.notify?.(
        { errorCode: 201, message: "Device was disconnected" },
        null,
      );
      expect(link()?.phase).toBe("disconnected");
      expect(isHelmetConnected(ID)).toBe(false);
      expect(helmet.cancelled).toBeGreaterThan(0);
      await jest.advanceTimersByTimeAsync(0);
      expect(mockScans).toHaveLength(n + 1);
      await jest.advanceTimersByTimeAsync(2_000);
      expect(mockScans).toHaveLength(n + 1);
    });

    it("「操作已取消」（订阅是自己摘的）、已关会话上迟到的报错：都不算通知中断", async () => {
      await connectHelmet();
      helmet.notify?.(
        { errorCode: 2, message: "Operation was cancelled" },
        null,
      );
      expect(isHelmetConnected(ID)).toBe(true);
      const staleNotify = helmet.notify;
      helmet.disconnectCb?.(null, fakeDevice);
      staleNotify?.(
        { errorCode: 201, message: "Device was disconnected" },
        null,
      );
      expect(logged("notify 中断")).toBe(false);
      expect(link()?.phase).toBe("disconnected");
    });

    it("空通知（0 字节）：不当一帧处理", async () => {
      await connectHelmet();
      helmet.notify?.(null, { value: "" });
      expect(logged("无法解析的帧")).toBe(false);
    });

    it("解析不了的帧（事件帧不足 10 字节）：丢掉，不入队、不 ACK，链路照常", async () => {
      await connectHelmet();
      enqueueMock.mockClear();
      helmet.push(hexToBytes("05 01 66"));
      await tick();
      expect(enqueueMock).not.toHaveBeenCalled();
      expect(helmet.acks).toHaveLength(0);
      expect(link()?.eventsReceived).toBe(0);
      expect(isHelmetConnected(ID)).toBe(true);
      expect(logged("无法解析的帧")).toBe(true);
    });

    it("周期事件的重发帧（同一 Event_Seq）：不重复入队，也不 ACK", async () => {
      await connectHelmet();
      enqueueMock.mockClear();
      const status = hexToBytes("05 07 70 00 00 00 00 00 00 00 55 00");
      helmet.push(status);
      helmet.push(status);
      await tick();
      expect(enqueueMock).toHaveBeenCalledTimes(1);
      expect(helmet.acks).toHaveLength(0);
      expect(link()?.eventsReceived).toBe(1);
    });

    it("去重只记最近 256 个 Event_Seq：更早的那条再来会再入队一次，但 eventId 不变（服务端按它幂等，不会重复建单）", async () => {
      await connectHelmet();
      enqueueMock.mockClear();
      const status = (seq: number) =>
        Uint8Array.from([
          0x05,
          0x07,
          seq & 255,
          seq >> 8,
          0,
          0,
          0,
          0,
          0,
          0,
          0x55,
          0x00,
        ]);
      for (let seq = 1; seq <= 257; seq += 1) helmet.push(status(seq));
      helmet.push(status(257)); // 最近的仍认得
      helmet.push(status(1)); // 最早的已被挤出去
      await tick();
      expect(enqueueMock).toHaveBeenCalledTimes(258);
      const ids = enqueueMock.mock.calls.map((c) => c[0].eventId);
      expect(ids[257]).toBe(ids[0]);
    });

    it("ACK 写入失败：事件照样入队并立即冲刷；头盔重发同一条时补一个 ACK，不重复入队", async () => {
      await connectHelmet();
      enqueueMock.mockClear();
      flushMock.mockClear();
      fakeDevice.writeCharacteristicWithoutResponseForService.mockRejectedValueOnce(
        new Error("GATT busy"),
      );
      const sos = hexToBytes(
        "05 02 65 00 00 00 00 00 00 00 01 FC 08 ED 4E CD 01 17 7C 29 07",
      );
      helmet.push(sos);
      await tick();
      expect(enqueueMock).toHaveBeenCalledTimes(1);
      expect(flushMock).toHaveBeenCalledTimes(1);
      expect(helmet.acks).toHaveLength(0);
      expect(logged("ACK 写入失败")).toBe(true);

      helmet.push(sos); // 头盔 1.5 s 没收到 ACK 的重发
      await tick();
      expect(enqueueMock).toHaveBeenCalledTimes(1);
      expect(helmet.acks).toEqual(["06 02 65 00 00 00 00"]);
    });
  });

  describe("断开、解绑与目标同步的收尾", () => {
    // 下面两条里取消连接被拒若没被吞掉，就是一个未处理的拒绝，jest 会直接判用例失败
    it("断开时取消连接被拒（外设早已断开）：吞掉，状态照常落到已断开", async () => {
      await connectHelmet();
      fakeDevice.cancelConnection.mockRejectedValueOnce(
        new Error("Device is not connected"),
      );
      helmet.disconnectCb?.(null, fakeDevice);
      await flushMacrotask();
      expect(link()?.phase).toBe("disconnected");
      expect(isHelmetConnected(ID)).toBe(false);
    });

    it("连接在途时解绑、随后取消连接又被拒：照样不建会话、不发指令，页面不留行", async () => {
      let finishConnect!: (d: typeof fakeDevice) => void;
      fakeDevice.connect.mockImplementationOnce(
        () => new Promise<typeof fakeDevice>((r) => (finishConnect = r)),
      );
      fakeDevice.cancelConnection.mockRejectedValueOnce(
        new Error("Device is not connected"),
      );
      await startBleLink([ID]);
      await tick();
      scanCb?.(null, fakeDevice);
      await tick();
      setBleTargets([]);
      finishConnect(fakeDevice);
      await tick(20);
      await flushMacrotask();
      expect(helmet.writes).toHaveLength(0);
      expect(isHelmetConnected(ID)).toBe(false);
      expect(useBleStore.getState().links[ID]).toBeUndefined();
    });

    it("停链路后（还没重启）设备列表又刷到这顶、旧的连接这时才失败：保留它那一行（未启动），不重连也不报错", async () => {
      jest.useFakeTimers();
      let failConnect!: (e: Error) => void;
      fakeDevice.connect.mockImplementationOnce(
        () => new Promise<typeof fakeDevice>((_r, rej) => (failConnect = rej)),
      );
      await startBleLink([ID]);
      await jest.advanceTimersByTimeAsync(0);
      scanCb?.(null, fakeDevice);
      await tick();
      expect(link()?.phase).toBe("connecting");
      stopBleLink(); // 进工程模式
      setBleTargets([ID]); // 链路停着时设备列表照常刷新
      failConnect(new Error("Operation was cancelled"));
      await jest.advanceTimersByTimeAsync(60_000);
      expect(link()?.phase).toBe("idle");
      expect(mockScans).toHaveLength(1);
    });

    it("已连上时切前后台：不动扫描；掉线后立刻重扫（10-25），之后按正在扫描处理——退后台不打断过滤扫描，回前台重开一轮，退避到点不再多起", async () => {
      jest.useFakeTimers();
      const app = captureAppState();
      await connectHelmet();
      const n = mockScans.length;
      app.cb?.("background");
      app.cb?.("active");
      await jest.advanceTimersByTimeAsync(0);
      expect(mockScans).toHaveLength(n);
      expect(link()?.phase).toBe("connected");

      helmet.disconnectCb?.(null, fakeDevice);
      await jest.advanceTimersByTimeAsync(0);
      expect(mockScans).toHaveLength(n + 1);
      app.cb?.("background");
      await jest.advanceTimersByTimeAsync(0);
      expect(mockScans).toHaveLength(n + 1);
      app.cb?.("active");
      await jest.advanceTimersByTimeAsync(0);
      expect(mockScans).toHaveLength(n + 2);
      await jest.advanceTimersByTimeAsync(2_000);
      expect(mockScans).toHaveLength(n + 2);
    });

    it("设备列表轮询又拉到同一批目标：什么都不动（不重扫、不重发常驻通知）", async () => {
      asAndroid(29);
      jest
        .spyOn(PermissionsAndroid, "request")
        .mockResolvedValue(RESULTS.GRANTED);
      await startBleLink([ID]);
      await tick();
      mockSvcStart.mockClear();
      const n = mockScans.length;
      setBleTargets([ID]);
      await tick();
      expect(mockSvcStart).not.toHaveBeenCalled();
      expect(mockScans).toHaveLength(n);
    });
  });

  describe("适配器状态", () => {
    it("启动时蓝牙关着：目标显示已断开；这时点重试也不扫（查到适配器没开）；打开蓝牙后自动开始扫", async () => {
      mockAdapter.initial = "PoweredOff";
      mockState.mockResolvedValue("PoweredOff");
      await startBleLink([ID]);
      await tick();
      expect(useBleStore.getState().adapter).toBe("off");
      expect(link()?.phase).toBe("disconnected");
      retryBleLink(ID);
      await tick();
      expect(mockScans).toHaveLength(0);

      mockState.mockResolvedValue("PoweredOn");
      stateCb?.("PoweredOn");
      await tick();
      expect(mockScans).toHaveLength(1);
      expect(link()?.phase).toBe("scanning");
    });

    it("适配器报手册之外的状态（如 Resetting）：页面显示 unknown、停掉这一轮扫描；连着的那顶先不动（等系统断开回调），没连上的标已断开", async () => {
      await startBleLink([ID, "helmet_aaaaaa"]);
      await tick();
      scanCb?.(null, fakeDevice);
      await until(() => link()?.phase === "connected" && mockScans.length >= 2);
      expect(mockScans).toHaveLength(2);
      stateCb?.("Resetting");
      expect(useBleStore.getState().adapter).toBe("unknown");
      expect(link()?.phase).toBe("connected");
      expect(useBleStore.getState().links["helmet_aaaaaa"]?.phase).toBe(
        "disconnected",
      );
      fakeDevice.connect.mockClear();
      scanCb?.(null, {
        ...fakeDevice,
        id: "periph-2",
        localName: "Helmet-aaaaaa",
      });
      await tick();
      expect(fakeDevice.connect).not.toHaveBeenCalled();
    });
  });

  describe("设置写入的边角", () => {
    it("手册之外的错误码写成 ERR_0x..；写入抛错 / 3 s 无应答 → 未送达（绝不假装成功），会话不受影响", async () => {
      jest.useFakeTimers();
      await connectHelmet();
      helmet.writeError = 0x20;
      expect(await writeHelmetRegister(ID, 0x24, [70])).toEqual({
        delivered: true,
        executed: false,
        errorCode: "ERR_0x20",
      });
      helmet.writeError = 0;

      fakeDevice.writeCharacteristicWithResponseForService.mockRejectedValueOnce(
        new Error("GATT write failed"),
      );
      expect(await writeHelmetRegister(ID, 0x24, [70])).toEqual({
        delivered: false,
      });

      helmet.override = (f) => f[0] === 0x03; // 头盔收到了但不应答
      const waiting = writeHelmetRegister(ID, 0x24, [70]);
      await jest.advanceTimersByTimeAsync(3_000);
      await expect(waiting).resolves.toEqual({ delivered: false });
      expect(isHelmetConnected(ID)).toBe(true);

      // 超时之后的迟到应答没人等了，不会错配给下一条
      helmet.override = null;
      devLogMock().mockClear();
      helmet.reply([0x03, hexToBytes(helmet.writes.at(-1)!)[1], 0x00]);
      expect(logged("无人等待的应答")).toBe(true);
      expect(await writeHelmetRegister(ID, 0x24, [75])).toEqual({
        delivered: true,
        executed: true,
      });
      expect(helmet.mem.get(0x24)).toBe(75);
    });
  });
});

describe("补分支（2026-10-20）", () => {
  const ID = "helmet_94173f";
  const managers = () =>
    BleManager as unknown as Mock<() => { destroy: () => unknown }>;

  // 「destroy 抛错 / 拒绝」那条测的是异步拒绝；原生模块已经失效时 destroy() 会在调用当下同步抛。
  // 这时 releasing 若没被重置成已就绪的 Promise，startBleLink 的 `await releasing` 会一直等一个永不回来的销毁——
  // 登出重登 / 退出工程模式后链路再也起不来，摔倒事件只留在头盔 Flash 里
  it("原生 destroy 同步抛错（原生模块已失效）：停链路不抛、销毁视为已完成，下一次启动照常新建 BleManager 并开始扫描", async () => {
    await startBleLink([ID]);
    await tick();
    const results = managers().mock.results;
    const current = results[results.length - 1].value as {
      destroy: () => unknown;
    };
    current.destroy = () => {
      throw new Error("native module gone");
    };
    expect(() => stopBleLink()).not.toThrow();
    await expect(bleStackReleased()).resolves.toBeUndefined();
    const built = managers().mock.calls.length;
    const scans = mockScans.length;
    await startBleLink([ID]);
    await tick();
    expect(managers().mock.calls.length).toBe(built + 1);
    expect(mockScans.length).toBeGreaterThan(scans);
    expect(link()?.phase).toBe("scanning");
  });

  // ble-plx 扫描回调的类型是 (error, device | null)：两样都空时不能当成命中去连 null.connect()（会抛进原生回调里），
  // 也不能停掉这一轮——停了就得等 20 s 兜底才重扫，这期间上电的头盔连不上
  it("扫描回调既没报错也没给设备（空回调）：不崩、不当命中、不重开一轮；随后真发现头盔照常连上", async () => {
    await startBleLink([ID]);
    await tick();
    const scans = mockScans.length;
    expect(() => scanCb?.(null, null)).not.toThrow();
    await tick();
    expect(fakeDevice.connect).not.toHaveBeenCalled();
    expect(mockScans.length).toBe(scans);
    expect(link()?.phase).toBe("scanning");
    scanCb?.(null, fakeDevice);
    for (let i = 0; i < 40 && link()?.phase !== "connected"; i += 1)
      await tick();
    expect(link()?.phase).toBe("connected");
  });
});

// —— 10-31：安卓 BluetoothLeScanner 限 30 s 内起扫 5 次（第 6 次起被系统静默拦掉、30 s 没有结果）。
// 原来连接 / 握手一失败就 finally 立刻重扫、扫到又连：GATT 一直报错时 30 s 内起扫 300 次 ——
describe("10-31：起扫限频与连接失败的退避", () => {
  const ID = "helmet_94173f";
  const until = async (cond: () => boolean, rounds = 60) => {
    for (let i = 0; i < rounds && !cond(); i += 1) await tick();
  };
  /** 每 100 ms 看一眼：新起了一轮扫描就把外设再报上来（真机上广播 100 ms 一次） */
  const feed = async (ms: number, device: unknown = fakeDevice) => {
    let seen = mockScans.length;
    for (let t = 0; t < ms; t += 100) {
      await jest.advanceTimersByTimeAsync(100);
      if (mockScans.length > seen) {
        seen = mockScans.length;
        scanCb?.(null, device);
      }
    }
  };

  it("GATT 一直立刻报错：30 s 内起扫不超过 5 次，连接按退避 2 / 4 / 8 … s 来；头盔好了之后能连上", async () => {
    jest.useFakeTimers();
    fakeDevice.connect.mockRejectedValue(new Error("gatt 133"));
    await startBleLink([ID]);
    await jest.advanceTimersByTimeAsync(0);
    scanCb?.(null, fakeDevice);
    await feed(30_000);
    expect(mockScans.length).toBeLessThanOrEqual(5);
    expect(fakeDevice.connect.mock.calls.length).toBeLessThanOrEqual(6);
    expect(link()?.phase).toBe("disconnected");
    fakeDevice.connect.mockResolvedValue(fakeDevice);
    await feed(40_000);
    await until(() => link()?.phase === "connected");
    expect(link()?.phase).toBe("connected");
  });

  it("握手一直 3 s 无应答：30 s 内起扫不超过 5 次", async () => {
    jest.useFakeTimers();
    helmet.override = (f) => f[0] === 0x02 && f[2] === 0x40;
    await startBleLink([ID]);
    await jest.advanceTimersByTimeAsync(0);
    scanCb?.(null, fakeDevice);
    await feed(30_000);
    expect(mockScans.length).toBeLessThanOrEqual(5);
    expect(fakeDevice.connect.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("第一次失败照旧立刻重试（后台偶发一次 GATT 133 时这一下最管用），第二次起才等", async () => {
    jest.useFakeTimers();
    fakeDevice.connect.mockRejectedValueOnce(new Error("gatt 133"));
    await startBleLink([ID]);
    await jest.advanceTimersByTimeAsync(0);
    scanCb?.(null, fakeDevice);
    await until(() => mockScans.length === 2); // 失败后马上重扫
    scanCb?.(null, fakeDevice);
    await until(() => link()?.phase === "connected");
    expect(link()?.phase).toBe("connected");
    expect(fakeDevice.connect).toHaveBeenCalledTimes(2);
  });

  it("信号边缘连上又掉、反复：30 s 内起扫不超过 5 次，窗口过去照样能再连上", async () => {
    jest.useFakeTimers();
    await startBleLink([ID]);
    await jest.advanceTimersByTimeAsync(0);
    let seen = mockScans.length;
    for (let t = 0; t < 30_000; t += 100) {
      await jest.advanceTimersByTimeAsync(100);
      if (mockScans.length > seen) {
        seen = mockScans.length;
        scanCb?.(null, fakeDevice);
        await until(() => link()?.phase === "connected", 40);
        helmet.disconnectCb?.(null, fakeDevice);
      }
    }
    expect(mockScans.length).toBeLessThanOrEqual(5);
    await feed(31_000);
    await until(() => link()?.phase === "connected");
    expect(link()?.phase).toBe("connected");
  });

  it("两顶都没连上、其中一顶连不上在退避里：另一顶出现照样马上连（重扫不停，只跳过退避中的那顶）", async () => {
    jest.useFakeTimers();
    const bad = {
      ...fakeDevice,
      id: "periph-2",
      name: "Helmet-bbbbbb",
      localName: "Helmet-bbbbbb",
      connect: jest.fn(async () => {
        throw new Error("gatt 133");
      }),
    };
    await startBleLink([ID, "helmet_bbbbbb"]);
    await jest.advanceTimersByTimeAsync(0);
    scanCb?.(null, bad);
    await until(() => mockScans.length === 2);
    scanCb?.(null, bad); // 第二次失败：进退避
    await until(() => mockScans.length === 3);
    scanCb?.(null, bad); // 退避中：不连
    await tick();
    expect(bad.connect).toHaveBeenCalledTimes(2);
    scanCb?.(null, fakeDevice);
    await until(() => link()?.phase === "connected");
    expect(link()?.phase).toBe("connected");
    expect(bad.connect).toHaveBeenCalledTimes(2); // 退避里的那顶没有被多连一次
  });

  it("退避中用户点「重试连接」：清掉退避、立刻重扫并连上", async () => {
    jest.useFakeTimers();
    fakeDevice.connect.mockRejectedValue(new Error("gatt 133"));
    await startBleLink([ID]);
    await jest.advanceTimersByTimeAsync(0);
    scanCb?.(null, fakeDevice);
    await until(() => mockScans.length === 2);
    scanCb?.(null, fakeDevice);
    await until(() => fakeDevice.connect.mock.calls.length === 2);
    await jest.advanceTimersByTimeAsync(500);
    const n = mockScans.length;
    fakeDevice.connect.mockResolvedValue(fakeDevice);
    retryBleLink(ID);
    await until(() => mockScans.length === n + 1);
    scanCb?.(null, fakeDevice);
    await until(() => link()?.phase === "connected");
    expect(link()?.phase).toBe("connected");
  });
});
