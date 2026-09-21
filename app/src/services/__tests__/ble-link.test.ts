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
        if (addr === 0x40) {
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
let stateCb: ((s: string) => void) | null = null;
const destroyed = { count: 0 };

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
    state: async () => "PoweredOn",
    onStateChange: (cb: (s: string) => void, emit: boolean) => {
      stateCb = cb;
      if (emit) cb("PoweredOn");
      return { remove: () => undefined };
    },
    connectedDevices: async () => [],
    startDeviceScan: (
      _u: unknown,
      _o: unknown,
      cb: (e: null, d: unknown) => void,
    ) => {
      scanCb = cb;
    },
    stopDeviceScan: () => undefined,
    destroy: () => {
      destroyed.count += 1;
    },
  })),
}));
jest.mock("@/services/ble-relay-uplink", () => ({
  enqueueRelayEvent: jest.fn(),
  flushRelayQueue: jest.fn(async () => undefined),
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
import {
  isHelmetConnected,
  retryBleLink,
  startBleLink,
  stopBleLink,
  writeHelmetRegister,
} from "../ble-link";

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
  helmet.deviceId = "helmet_94173f";
  helmet.cancelled = 0;
  enqueueMock.mockClear();
  flushMock.mockClear();
  jest.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  stopBleLink();
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
