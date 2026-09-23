// 蓝牙工程模式（硬件联调用，2026-09-23 张森淼提出）：不登录、不上云，只对头盔逐条收发字节。
// 与生产链路 ble-link.ts 的区别：全量扫描任意外设、手动选择连接、不核身、不自动握手、
// 每一帧原样记日志。进入时暂停生产链路（同一台头盔只能被一个会话握着），退出时恢复。
// 帧编解码复用 services/ble/protocol.ts，人类可读描述在 services/ble/describe.ts。
import { Platform, Share } from "react-native";
import type { Device, Subscription } from "react-native-ble-plx";
import { State } from "react-native-ble-plx";

import { base64ToBytes, bytesToBase64, bytesToHex } from "@/services/ble/bytes";
import {
  describeInbound,
  describeOutbound,
  parseHexInput,
} from "@/services/ble/describe";
import {
  CHAR_NOTIFY_UUID,
  CHAR_WRITE_UUID,
  HIGH_RISK_CODES,
  Ins,
  REQUEST_MTU,
  Reg,
  SERVICE_UUID,
  SETTINGS_READ_ADDR,
  SETTINGS_READ_LEN,
  buildAck,
  buildPing,
  buildRead,
  buildResendData,
  buildResendQuery,
  buildTimeSync,
  buildWrite,
  parseInbound,
} from "@/services/ble/protocol";
import type { InboundResponse } from "@/services/ble/protocol";
import {
  currentBleTargets,
  getBleManager,
  requestBlePermissions,
  startBleLink,
  stopBleLink,
} from "@/services/ble-link";
import { useBleBenchStore } from "@/stores/ble-bench-store";
import type { BenchLogTone, BenchService } from "@/stores/ble-bench-store";
import type { BleAdapterState } from "@/stores/ble-store";

const RESPONSE_TIMEOUT_MS = 3_000;
const store = () => useBleBenchStore.getState();

let active = false;
let savedTargets: string[] = [];
let stateSub: Subscription | null = null;
let device: Device | null = null;
let monitor: Subscription | null = null;
let disconnectSub: Subscription | null = null;
let seq = 0;

interface Pending {
  frame: Uint8Array;
  at: number;
  resolve: (r: InboundResponse | null) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pending = new Map<number, Pending>();

const info = (text: string, tone: BenchLogTone = "muted") =>
  store().appendLog({ at: Date.now(), dir: "info", hex: "", text, tone });

const ADAPTER: Partial<Record<State, BleAdapterState>> = {
  [State.PoweredOn]: "on",
  [State.PoweredOff]: "off",
  [State.Unauthorized]: "unauthorized",
  [State.Unsupported]: "unsupported",
};

// —— 生命周期 ——

/** 进入工程模式：暂停生产链路、拿蓝牙栈、开全量扫描 */
export async function startBench(): Promise<void> {
  if (active) return;
  active = true;
  savedTargets = currentBleTargets();
  stopBleLink();
  store().reset();
  seq = 0;
  info(
    savedTargets.length > 0
      ? `工程模式已启动，生产链路已暂停（${savedTargets.join(", ")}），退出后恢复`
      : "工程模式已启动",
  );
  const granted = await requestBlePermissions();
  if (!granted) {
    store().patch({ adapter: "unauthorized" });
    info("蓝牙权限被拒，去系统设置打开后重进本页", "error");
    return;
  }
  const mgr = getBleManager();
  stateSub?.remove();
  stateSub = mgr.onStateChange((s) => {
    const adapter = ADAPTER[s] ?? "unknown";
    store().patch({ adapter });
    if (adapter === "on") {
      if (store().phase === "idle") startScan();
    } else if (adapter !== "unknown") {
      info(`蓝牙状态：${s}`, "error");
    }
  }, true);
}

/** 退出工程模式：断开、停扫描、释放，并按进入时的目标恢复生产链路 */
export async function stopBench(): Promise<void> {
  if (!active) return;
  active = false;
  stopScan();
  await disconnect();
  stateSub?.remove();
  stateSub = null;
  store().patch({ phase: "idle" });
  if (savedTargets.length > 0) {
    void startBleLink(savedTargets);
    savedTargets = [];
  }
}

// —— 扫描 / 连接 ——

export function startScan(): void {
  if (!active || store().phase !== "idle") return;
  const mgr = getBleManager();
  store().patch({ phase: "scanning", peripherals: {} });
  info("全量扫描中（不按服务 UUID 过滤，能看到所有外设）");
  // allowDuplicates：同一外设持续上报，RSSI 才会实时刷新
  mgr.startDeviceScan(null, { allowDuplicates: true }, (error, d) => {
    if (error) {
      info(`扫描错误：${error.message}`, "error");
      store().patch({ phase: "idle" });
      return;
    }
    if (!d) return;
    const serviceUUIDs = (d.serviceUUIDs ?? []).map((u) => u.toLowerCase());
    store().upsertPeripheral({
      id: d.id,
      name: d.localName ?? d.name ?? null,
      rssi: d.rssi ?? null,
      serviceUUIDs,
      hasHelmetService: serviceUUIDs.includes(SERVICE_UUID),
      lastSeenAt: Date.now(),
    });
  });
}

export function stopScan(): void {
  if (store().phase !== "scanning") return;
  getBleManager().stopDeviceScan();
  store().patch({ phase: "idle" });
}

function onDisconnected(reason: string): void {
  monitor?.remove();
  monitor = null;
  disconnectSub?.remove();
  disconnectSub = null;
  device = null;
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.resolve(null);
  }
  pending.clear();
  store().patch({
    phase: "idle",
    connectedId: null,
    connectedName: null,
    mtu: null,
    services: [],
    notifyOk: false,
    writeOk: false,
  });
  info(`已断开（${reason}）`, "error");
}

export async function connectTo(id: string): Promise<void> {
  if (!active || store().phase === "connecting" || store().phase === "connected")
    return;
  stopScan();
  const name = store().peripherals[id]?.name ?? id;
  store().patch({ phase: "connecting", connectedName: name });
  info(`连接 ${name} …`);
  const mgr = getBleManager();
  try {
    const d = await mgr.connectToDevice(id, {
      requestMTU: REQUEST_MTU,
      timeout: 10_000,
    });
    device = d;
    disconnectSub = d.onDisconnected(() => onDisconnected("对端断开或超时"));
    if (Platform.OS === "android") {
      try {
        await d.requestMTU(REQUEST_MTU);
      } catch (e) {
        info(`requestMTU 失败（继续）：${(e as Error).message}`, "error");
      }
    }
    await d.discoverAllServicesAndCharacteristics();
    const services: BenchService[] = [];
    for (const s of await d.services()) {
      const chars = await s.characteristics();
      services.push({
        uuid: s.uuid.toLowerCase(),
        characteristics: chars.map((c) => ({
          uuid: c.uuid.toLowerCase(),
          notify: c.isNotifiable || c.isIndicatable,
          write: c.isWritableWithResponse,
          writeNoResp: c.isWritableWithoutResponse,
          read: c.isReadable,
        })),
      });
    }
    const helmet = services.find((s) => s.uuid === SERVICE_UUID);
    const notifyOk =
      helmet?.characteristics.some(
        (c) => c.uuid === CHAR_NOTIFY_UUID && c.notify,
      ) ?? false;
    const writeOk =
      helmet?.characteristics.some(
        (c) => c.uuid === CHAR_WRITE_UUID && (c.write || c.writeNoResp),
      ) ?? false;
    if (notifyOk) {
      // 必须先于任何指令：应答走 FEE1 Notify
      monitor = d.monitorCharacteristicForService(
        SERVICE_UUID,
        CHAR_NOTIFY_UUID,
        (error, ch) => {
          if (error) {
            if (device) info(`Notify 中断：${error.message}`, "error");
            return;
          }
          if (ch?.value) onFrame(base64ToBytes(ch.value));
        },
      );
    }
    store().patch({
      phase: "connected",
      connectedId: id,
      connectedName: name,
      mtu: d.mtu,
      services,
      notifyOk,
      writeOk,
    });
    info(
      `已连接 · MTU ${d.mtu} · ${services.length} 个服务 · ` +
        (helmet
          ? `FEE0 ${notifyOk ? "FEE1 notify ✓" : "FEE1 notify ✗"} ${writeOk ? "FEE2 write ✓" : "FEE2 write ✗"}`
          : "没有 FEE0 服务（GATT 表不对）"),
      helmet && notifyOk && writeOk ? "ok" : "error",
    );
  } catch (e) {
    info(`连接失败：${(e as Error).message}`, "error");
    disconnectSub?.remove();
    disconnectSub = null;
    void device?.cancelConnection().catch(() => undefined);
    device = null;
    store().patch({ phase: "idle", connectedName: null });
  }
}

export async function disconnect(): Promise<void> {
  const d = device;
  if (!d) return;
  monitor?.remove();
  monitor = null;
  disconnectSub?.remove();
  disconnectSub = null;
  device = null;
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.resolve(null);
  }
  pending.clear();
  try {
    await d.cancelConnection();
  } catch {
    // 已经断了
  }
  store().patch({
    phase: "idle",
    connectedId: null,
    connectedName: null,
    mtu: null,
    services: [],
    notifyOk: false,
    writeOk: false,
  });
  info("已断开（本机主动）");
}

// —— 收发 ——

function nextSeq(): number {
  seq = (seq % 255) + 1;
  return seq;
}

function onFrame(bytes: Uint8Array): void {
  const frame = parseInbound(bytes);
  if (frame?.kind === "response") {
    const p = pending.get(frame.seq);
    let latencyMs: number | undefined;
    if (p) {
      clearTimeout(p.timer);
      pending.delete(frame.seq);
      latencyMs = Date.now() - p.at;
    }
    const d = describeInbound(bytes, p?.frame);
    store().appendLog({
      at: Date.now(),
      dir: "rx",
      hex: bytesToHex(bytes),
      text: p ? d.text : `${d.text}（无人等待的应答）`,
      tone: d.error === 0 ? "ok" : "error",
      latencyMs,
    });
    p?.resolve(frame);
    return;
  }
  const d = describeInbound(bytes);
  store().appendLog({
    at: Date.now(),
    dir: "rx",
    hex: bytesToHex(bytes),
    text: d.text,
    tone: d.kind === "event" ? "event" : "error",
  });
  if (d.kind !== "event" || d.eventCode === undefined || d.eventSeq === undefined)
    return;
  store().patch({ lastEvent: { code: d.eventCode, seq: d.eventSeq } });
  if (d.highRisk && store().autoAck) {
    void sendAck(d.eventCode, d.eventSeq, "自动");
  }
}

/**
 * 发一帧并等同 Seq 的应答（3 s 超时记一条 ⚠）。ACK 无流水号、不等应答。
 * 返回 null = 未连接 / 写入失败 / 超时 / 中途断开。
 */
export async function sendFrame(
  frame: Uint8Array,
  expectResponse = true,
): Promise<InboundResponse | null> {
  const d = device;
  const hex = bytesToHex(frame);
  if (!d || store().phase !== "connected") {
    store().appendLog({
      at: Date.now(),
      dir: "info",
      hex,
      text: "未连接，没有发出",
      tone: "error",
    });
    return null;
  }
  store().appendLog({
    at: Date.now(),
    dir: "tx",
    hex,
    text: describeOutbound(frame),
  });
  let waiter: Promise<InboundResponse | null> = Promise.resolve(null);
  if (expectResponse && frame.length >= 2) {
    const s = frame[1];
    waiter = new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(s);
        info(`seq=${s} ${RESPONSE_TIMEOUT_MS} ms 无应答`, "error");
        resolve(null);
      }, RESPONSE_TIMEOUT_MS);
      pending.set(s, { frame, at: Date.now(), resolve, timer });
    });
  }
  try {
    if (expectResponse || !store().writeOk || !hasWriteNoResp()) {
      await d.writeCharacteristicWithResponseForService(
        SERVICE_UUID,
        CHAR_WRITE_UUID,
        bytesToBase64(frame),
      );
    } else {
      await d.writeCharacteristicWithoutResponseForService(
        SERVICE_UUID,
        CHAR_WRITE_UUID,
        bytesToBase64(frame),
      );
    }
  } catch (e) {
    const p = frame.length >= 2 ? pending.get(frame[1]) : undefined;
    if (p) {
      clearTimeout(p.timer);
      pending.delete(frame[1]);
      p.resolve(null);
    }
    info(`写入失败：${(e as Error).message}`, "error");
    return null;
  }
  return waiter;
}

function hasWriteNoResp(): boolean {
  return store()
    .services.find((s) => s.uuid === SERVICE_UUID)
    ?.characteristics.some((c) => c.uuid === CHAR_WRITE_UUID && c.writeNoResp)
    ? true
    : false;
}

async function sendAck(code: number, eventSeq: number, how: string): Promise<void> {
  const frame = buildAck(code, eventSeq);
  const d = device;
  if (!d) return;
  store().appendLog({
    at: Date.now(),
    dir: "tx",
    hex: bytesToHex(frame),
    text: `${describeOutbound(frame)}（${how}）`,
  });
  try {
    // 与生产链路一致：ACK 走 Write Without Response
    await d.writeCharacteristicWithoutResponseForService(
      SERVICE_UUID,
      CHAR_WRITE_UUID,
      bytesToBase64(frame),
    );
  } catch (e) {
    info(`ACK 写入失败：${(e as Error).message}`, "error");
  }
}

// —— 按钮对应的指令（编号见 docs/BLE_BENCH.md） ——

export const ping = () => sendFrame(buildPing(nextSeq()));
export const readRegister = (addr: number, len: number) =>
  sendFrame(buildRead(nextSeq(), addr, len));
export const writeRegister = (addr: number, data: number[]) =>
  sendFrame(buildWrite(nextSeq(), addr, data));
export const timeSync = () =>
  sendFrame(buildTimeSync(nextSeq(), Math.floor(Date.now() / 1000)));
export const resendQuery = () => sendFrame(buildResendQuery(nextSeq()));
export const resendData = (offset: number, count: number) =>
  sendFrame(buildResendData(nextSeq(), offset, count));
export const recovery = () =>
  sendFrame(Uint8Array.from([Ins.RECOVERY, nextSeq()]));
/** RESET 带 1 字节参数（硬件 09-23 对照表：`0A <seq> 01` 软重启） */
export const reset = (param = 0x01) =>
  sendFrame(Uint8Array.from([Ins.RESET, nextSeq(), param & 255]));

export async function ackLastEvent(): Promise<void> {
  const ev = store().lastEvent;
  if (!ev) {
    info("还没收到过事件帧，没有可 ACK 的", "error");
    return;
  }
  await sendAck(ev.code, ev.seq, "手动");
}

export const setAutoAck = (on: boolean) => {
  store().patch({ autoAck: on });
  info(on ? "自动 ACK 已打开" : "自动 ACK 已关闭：高危事件不再回 ACK，可验头盔 1.5 s 重发 ×3 后入 Flash");
};

/** 自定义帧：hex 文本 → 发送；返回 false = 输入非法 */
export async function sendHex(input: string): Promise<boolean> {
  const bytes = parseHexInput(input);
  if (!bytes) {
    info("自定义帧格式不对：至少 2 字节，十六进制成对，如 03 07 24 32", "error");
    return false;
  }
  const isAck = bytes[0] === Ins.ACK;
  await sendFrame(bytes, !isAck);
  return true;
}

/** 一键握手：生产链路的固定流程（DEVICE_PROTOCOL §1.2「连接后固定流程」），任一步无应答即停 */
export async function handshake(): Promise<void> {
  info("一键握手开始：读 deviceId → 读固件 → 对时 → 补传查询/取数 → 读设置表");
  const id = await readRegister(Reg.DEVICE_ID, 16);
  if (!id) return info("握手中止：读 deviceId 无应答", "error");
  const fw = await readRegister(Reg.FW_MAJOR, 3);
  if (!fw) return info("握手中止：读固件无应答", "error");
  const ts = await timeSync();
  if (!ts) return info("握手中止：对时无应答", "error");
  const q = await resendQuery();
  if (!q) return info("握手中止：补传查询无应答", "error");
  const count = q.data.length >= 2 ? q.data[0] | (q.data[1] << 8) : 0;
  if (count > 0) {
    const r = await resendData(0, Math.min(count, 10));
    if (!r) return info("握手中止：补传取数无应答", "error");
  }
  const cfg = await readRegister(SETTINGS_READ_ADDR, SETTINGS_READ_LEN);
  if (!cfg) return info("握手中止：读设置表无应答", "error");
  info("一键握手完成", "ok");
}

// —— 导出 ——

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const stamp = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

export function exportLogText(): string {
  const s = store();
  const head = [
    `蓝牙工程模式日志 ${new Date().toISOString()}`,
    `设备 ${s.connectedName ?? "(未连接)"} MTU ${s.mtu ?? "-"} 自动ACK ${s.autoAck ? "开" : "关"}`,
    "",
  ];
  const lines = s.log.map((e) => {
    const dir = e.dir === "tx" ? "TX" : e.dir === "rx" ? "RX" : "--";
    const lat = e.latencyMs !== undefined ? ` (${e.latencyMs} ms)` : "";
    return `${stamp(e.at)} ${dir} ${e.hex.padEnd(24)} ${e.text}${lat}`;
  });
  return [...head, ...lines].join("\n");
}

export async function shareLog(): Promise<void> {
  try {
    await Share.share({ message: exportLogText() });
  } catch {
    // 用户取消分享
  }
}

/** 高危事件码集合（页面按钮着色用） */
export const HIGH_RISK = HIGH_RISK_CODES;
