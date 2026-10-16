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

  reply(bytes: number[]): void {
    this.notify?.(null, { value: bytesToBase64(Uint8Array.from(bytes)) });
  }

  push(frame: Uint8Array): void {
    this.notify?.(null, { value: bytesToBase64(frame) });
  }

  handle(frame: Uint8Array): void {
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
let scanCb: ((e: null, d: unknown) => void) | null = null;
/** 每次 startDeviceScan 挂上的回调都留着（ble-plx 只叠监听不摘旧的） */
const mockScanCbs: ((e: null, d: unknown) => void)[] = [];
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
      if (emit) cb("PoweredOn");
      return { remove: () => undefined };
    },
    connectedDevices: async () => [],
    startDeviceScan: (
      u: unknown,
      _o: unknown,
      cb: (e: null, d: unknown) => void,
    ) => {
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
import { AppState, Platform } from "react-native";
import { BleManager } from "react-native-ble-plx";
import {
  __resetServerClockForTests,
  noteServerDate,
} from "@/services/server-clock";
import {
  bleStackReleased,
  currentBleTargets,
  isHelmetConnected,
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
    expect(link()?.errorCode).toBe("DEVICE_ID_MISMATCH");
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
    expect(link()?.resent).toBe(2);
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
    expect(link()?.errorCode).toBeUndefined();
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
