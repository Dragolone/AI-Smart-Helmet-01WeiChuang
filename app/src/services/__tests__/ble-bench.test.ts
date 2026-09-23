// 工程模式会话单测：用纯 JS 假头盔顶替 react-native-ble-plx / ble-link，
// 钉住：暂停并恢复生产链路、全量扫描列出 FEE0 有无、连接后 GATT 表与特征值判定、
// 每帧 TX/RX 都记日志并按 Seq 配对出延迟、高危事件自动 ACK（可关）、一键握手顺序、自定义帧、超时。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

import { base64ToBytes, bytesToBase64, bytesToHex } from "../ble/bytes";

type NotifyCb = (
  error: null | { errorCode: number; message: string },
  ch: { value: string } | null,
) => void;

const SERVICE = "0000fee0-0000-1000-8000-00805f9b34fb";
const NOTIFY = "0000fee1-0000-1000-8000-00805f9b34fb";
const WRITE = "0000fee2-0000-1000-8000-00805f9b34fb";

class FakeHelmet {
  writes: string[] = [];
  acks: string[] = [];
  notify: NotifyCb | null = null;
  /** 为 true 时不应答（验超时） */
  mute = false;
  flash = 0;

  reply(bytes: number[]): void {
    this.notify?.(null, { value: bytesToBase64(Uint8Array.from(bytes)) });
  }

  push(hex: string): void {
    const bytes = Uint8Array.from(
      hex.split(/\s+/).map((b) => parseInt(b, 16)),
    );
    this.notify?.(null, { value: bytesToBase64(bytes) });
  }

  handle(frame: Uint8Array): void {
    if (this.mute) return;
    const [ins, seq] = frame;
    switch (ins) {
      case 0x01:
        this.reply([ins, seq, 0]);
        break;
      case 0x02: {
        const addr = frame[2];
        const len = frame[3];
        if (addr === 0x40) {
          const id = Array.from("helmet_94173f", (c) => c.charCodeAt(0));
          this.reply([ins, seq, 0, ...id, ...new Array(len - id.length).fill(0)]);
        } else if (addr === 0x00) {
          this.reply([ins, seq, 0, 1, 0, 3]);
        } else if (addr === 0x20) {
          this.reply([ins, seq, 0, ...new Array(len).fill(1)]);
        } else {
          this.reply([ins, seq, 3]);
        }
        break;
      }
      case 0x03:
        this.reply([ins, seq, frame[3] > 100 ? 5 : 0]);
        break;
      case 0x04:
        this.reply([ins, seq, 0]);
        break;
      case 0x07:
        this.reply([ins, seq, 0, this.flash & 255, this.flash >> 8]);
        break;
      case 0x08:
        this.reply([ins, seq, 0, Math.min(this.flash, frame[4])]);
        break;
      default:
        this.reply([ins, seq, 2]);
    }
  }
}

const helmet = new FakeHelmet();
let scanCb: ((e: null, d: unknown) => void) | null = null;
const mockLink = {
  stopBleLink: jest.fn((..._a: unknown[]) => undefined),
  startBleLink: jest.fn(async (..._a: unknown[]) => undefined),
  targets: ["helmet_94173f"],
};

const fakeDevice = {
  id: "periph-1",
  mtu: 247,
  requestMTU: jest.fn(async () => fakeDevice),
  discoverAllServicesAndCharacteristics: jest.fn(async () => fakeDevice),
  services: jest.fn(async () => [
    {
      uuid: SERVICE.toUpperCase(),
      characteristics: async () => [
        {
          uuid: NOTIFY.toUpperCase(),
          isNotifiable: true,
          isIndicatable: false,
          isWritableWithResponse: false,
          isWritableWithoutResponse: false,
          isReadable: false,
        },
        {
          uuid: WRITE.toUpperCase(),
          isNotifiable: false,
          isIndicatable: false,
          isWritableWithResponse: true,
          isWritableWithoutResponse: true,
          isReadable: false,
        },
      ],
    },
  ]),
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
  onDisconnected: jest.fn(() => ({ remove: () => undefined })),
  cancelConnection: jest.fn(async () => fakeDevice),
};

const mockManager = {
  onStateChange: (cb: (s: string) => void, emit: boolean) => {
    if (emit) cb("PoweredOn");
    return { remove: () => undefined };
  },
  startDeviceScan: (
    _u: unknown,
    _o: unknown,
    cb: (e: null, d: unknown) => void,
  ) => {
    scanCb = cb;
  },
  stopDeviceScan: jest.fn(),
  connectToDevice: jest.fn(async () => fakeDevice),
};

jest.mock("react-native-ble-plx", () => ({
  State: {
    PoweredOn: "PoweredOn",
    PoweredOff: "PoweredOff",
    Unauthorized: "Unauthorized",
    Unsupported: "Unsupported",
  },
}));
jest.mock("@/services/ble-link", () => ({
  getBleManager: () => mockManager,
  requestBlePermissions: async () => true,
  stopBleLink: (...a: unknown[]) => mockLink.stopBleLink(...a),
  startBleLink: (...a: unknown[]) => mockLink.startBleLink(...a),
  currentBleTargets: () => mockLink.targets,
}));

import * as bench from "../ble-bench";
import { useBleBenchStore } from "@/stores/ble-bench-store";

const state = () => useBleBenchStore.getState();
const texts = () => state().log.map((e) => `${e.dir}:${e.hex}|${e.text}`);
const tick = () => Promise.resolve();

async function connectHelmet(): Promise<void> {
  await bench.startBench();
  scanCb?.(null, {
    id: "periph-1",
    localName: "Helmet-94173f",
    name: null,
    rssi: -52,
    serviceUUIDs: [SERVICE.toUpperCase()],
  });
  await bench.connectTo("periph-1");
}

beforeEach(() => {
  jest.useFakeTimers();
  helmet.writes = [];
  helmet.acks = [];
  helmet.mute = false;
  helmet.flash = 0;
  mockLink.stopBleLink.mockClear();
  mockLink.startBleLink.mockClear();
});

afterEach(async () => {
  await bench.stopBench();
  jest.useRealTimers();
});

describe("生命周期", () => {
  it("进入暂停生产链路并记下目标，退出按原目标恢复", async () => {
    await bench.startBench();
    expect(mockLink.stopBleLink).toHaveBeenCalledTimes(1);
    expect(state().phase).toBe("scanning");
    await bench.stopBench();
    expect(mockLink.startBleLink).toHaveBeenCalledWith(["helmet_94173f"]);
  });

  it("扫描结果按广播是否含 FEE0 标记", async () => {
    await bench.startBench();
    scanCb?.(null, {
      id: "a",
      localName: "Helmet-94173f",
      rssi: -50,
      serviceUUIDs: [SERVICE.toUpperCase()],
    });
    scanCb?.(null, { id: "b", name: "ESP_TEST", rssi: -70, serviceUUIDs: null });
    const p = state().peripherals;
    expect(p.a).toMatchObject({ name: "Helmet-94173f", hasHelmetService: true, rssi: -50 });
    expect(p.b).toMatchObject({ name: "ESP_TEST", hasHelmetService: false });
  });

  it("连接后列出 GATT 表并判定 FEE1 notify / FEE2 write", async () => {
    await connectHelmet();
    expect(state()).toMatchObject({
      phase: "connected",
      mtu: 247,
      notifyOk: true,
      writeOk: true,
      connectedName: "Helmet-94173f",
    });
    expect(state().services[0].characteristics.map((c) => c.uuid)).toEqual([NOTIFY, WRITE]);
    expect(mockManager.stopDeviceScan).toHaveBeenCalled();
  });
});

describe("收发", () => {
  it("PING：TX 与 RX 各一条，RX 按 Seq 配对带延迟", async () => {
    await connectHelmet();
    const resp = await bench.ping();
    expect(resp).toMatchObject({ kind: "response", ins: 1, error: 0 });
    expect(helmet.writes).toEqual(["01 01"]);
    const t = texts();
    expect(t).toContain("tx:01 01|PING seq=1");
    const rx = state().log.find((e) => e.dir === "rx");
    expect(rx).toMatchObject({ hex: "01 01 00", text: "应答 PING seq=1 · STATUS_OK", tone: "ok" });
    expect(typeof rx?.latencyMs).toBe("number");
  });

  it("读 deviceId 的应答按请求地址解释", async () => {
    await connectHelmet();
    await bench.readRegister(0x40, 16);
    expect(texts().some((x) => x.includes('deviceId "helmet_94173f"'))).toBe(true);
  });

  it("写越界：应答 ERR_PARAM_VALUE 标红", async () => {
    await connectHelmet();
    const r = await bench.writeRegister(0x24, [200]);
    expect(r?.error).toBe(5);
    const rx = state().log.filter((e) => e.dir === "rx").pop();
    expect(rx).toMatchObject({ tone: "error", text: "应答 WRITE seq=1 · ERR_PARAM_VALUE" });
  });

  it("3 s 无应答记一条错误并返回 null", async () => {
    await connectHelmet();
    helmet.mute = true;
    const p = bench.ping();
    jest.advanceTimersByTime(3_000);
    expect(await p).toBeNull();
    expect(texts().some((x) => x.includes("无应答"))).toBe(true);
  });

  it("高危事件自动 ACK（Write Without Response），关掉后不 ACK，手动 ACK 补发", async () => {
    await connectHelmet();
    helmet.push("05 01 65 00 00 00 88 79 A2 6A 5F 2D 55 ED 4E CD 01 17 7C 29 07");
    await tick();
    expect(helmet.acks).toEqual(["06 01 65 00 00 00 00"]);
    expect(texts().some((x) => x.startsWith("rx:05 01 65") && x.includes("possible_fall seq=101"))).toBe(true);
    expect(texts().some((x) => x.includes("ACK possible_fall seq=101（自动）"))).toBe(true);

    bench.setAutoAck(false);
    helmet.push("05 03 66 00 00 00 88 79 A2 6A 03 01 02 7D 00 12 37 ED 4E CD 01 17 7C 29 07");
    await tick();
    expect(helmet.acks).toHaveLength(1);
    await bench.ackLastEvent();
    expect(helmet.acks[1]).toBe("06 03 66 00 00 00 00");
    bench.setAutoAck(true);
  });

  it("周期事件（心跳）不 ACK", async () => {
    await connectHelmet();
    helmet.push("05 07 0A 00 00 00 00 00 00 00 55 00");
    await tick();
    expect(helmet.acks).toEqual([]);
    expect(texts().some((x) => x.includes("device_status seq=10"))).toBe(true);
  });

  it("一键握手按固定顺序发帧，有离线事件时插入补传取数", async () => {
    await connectHelmet();
    helmet.flash = 2;
    await bench.handshake();
    expect(helmet.writes.map((w) => w.slice(0, 2))).toEqual(["02", "02", "04", "07", "08", "02"]);
    expect(helmet.writes[0]).toBe("02 01 40 10");
    expect(helmet.writes[1]).toBe("02 02 00 03");
    expect(helmet.writes[4]).toBe("08 05 00 00 02");
    expect(helmet.writes[5]).toBe("02 06 20 0e");
    expect(texts().pop()).toContain("一键握手完成");
  });

  it("自定义帧：合法即发；非法记错误不发", async () => {
    await connectHelmet();
    expect(await bench.sendHex("03 07 24 32")).toBe(true);
    expect(helmet.writes).toEqual(["03 07 24 32"]);
    expect(await bench.sendHex("zz")).toBe(false);
    expect(helmet.writes).toHaveLength(1);
  });

  it("未连接时不发，只记一条", async () => {
    await bench.startBench();
    expect(await bench.ping()).toBeNull();
    expect(texts().some((x) => x.includes("未连接"))).toBe(true);
    expect(helmet.writes).toEqual([]);
  });

  it("导出文本含表头与每条记录", async () => {
    await connectHelmet();
    await bench.ping();
    const text = bench.exportLogText();
    expect(text).toContain("蓝牙工程模式日志");
    expect(text).toContain("TX 01 01");
    expect(text).toContain("应答 PING seq=1");
  });
});
