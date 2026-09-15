// BLE 中转链路管理器（决策 #29/#31/#35/#38；协议 = docs/hardware/BLE通信协议手册-v0.6，速查 DEVICE_PROTOCOL §1.2）。
// 职责：按已绑定设备扫描 `Helmet-<deviceId 后 6 位>` → 连接（MTU 247）→ 订阅 FEE1 →
// 五步握手（读 deviceId / 固件 → 对时 → 补传高危事件并逐条 ACK）→ 事件帧翻译成 envelope 交
// ble-relay-uplink 入队 → 掉线自动重连。下行设置写入由 ble-relay 通过 writeRegister 调用。
// 纯字节翻译在 services/ble/protocol.ts（可单测）；本文件只碰 react-native-ble-plx 与状态 store。
// 后台保活（iOS bluetooth-central / 华为杀后台）双端实测口径记入 DEVELOPMENT.md 平台限制清单。
import { PermissionsAndroid, Platform } from "react-native";
import type { Device, Subscription } from "react-native-ble-plx";
import { BleErrorCode, BleManager, State } from "react-native-ble-plx";

import { base64ToBytes, bytesToBase64, bytesToHex } from "@/services/ble/bytes";
import {
  ADV_NAME_PREFIX,
  CHAR_NOTIFY_UUID,
  CHAR_WRITE_UUID,
  ERROR_NAMES,
  HIGH_RISK_CODES,
  Ins,
  REQUEST_MTU,
  Reg,
  SERVICE_UUID,
  buildAck,
  buildRead,
  buildResendData,
  buildResendQuery,
  buildTimeSync,
  buildWrite,
  deviceIdFromBytes,
  firmwareFromBytes,
  parseInbound,
  translateEvent,
} from "@/services/ble/protocol";
import type { InboundEvent, InboundResponse } from "@/services/ble/protocol";
import {
  enqueueRelayEvent,
  flushRelayQueue,
} from "@/services/ble-relay-uplink";
import { devLog } from "@/services/dev-log";
import { useBleStore } from "@/stores/ble-store";
import type { BleDeviceLink } from "@/stores/ble-store";

let manager: BleManager | null = null;

/** 惰性单例:BleManager 构造即拉起原生栈,只在真正用 BLE 时创建 */
export function getBleManager(): BleManager {
  if (!manager) manager = new BleManager();
  return manager;
}

/** Android 12+ 需要运行时 BLUETOOTH_SCAN/CONNECT;旧版本靠定位权限;iOS 由系统在首次使用时弹窗 */
export async function requestBlePermissions(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  if (Platform.Version >= 31) {
    const r = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    return Object.values(r).every(
      (v) => v === PermissionsAndroid.RESULTS.GRANTED,
    );
  }
  const r = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  );
  return r === PermissionsAndroid.RESULTS.GRANTED;
}

/** 蓝牙就绪(PoweredOn);未开蓝牙时调用方引导用户去系统设置 */
export async function bleReady(): Promise<boolean> {
  return (await getBleManager().state()) === State.PoweredOn;
}

// ——————————————————————————————————————————————————————————————
// 链路管理
// ——————————————————————————————————————————————————————————————

const COMMAND_TIMEOUT_MS = 3_000;
/** 补传每批条数：手册建议 ≤20，头盔每条间隔 30–50ms */
const RESEND_BATCH = 10;
const RESEND_MAX_ROUNDS = 50;
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
/** 同一 Event_Seq 的重发帧（头盔 1.5s 未收到 ACK 会重发）只 ACK 不重复入队 */
const SEEN_SEQ_LIMIT = 256;

const advName = (deviceId: string) => `${ADV_NAME_PREFIX}${deviceId.slice(-6)}`;
const log = (...args: unknown[]) => devLog("BLE", ...args);

class PendingCommand {
  resolve!: (r: InboundResponse) => void;
  reject!: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<InboundResponse>;
  constructor(ins: number, seq: number, onTimeout: () => void) {
    this.promise = new Promise<InboundResponse>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.timer = setTimeout(() => {
      onTimeout();
      this.reject(
        new Error(
          `BLE 指令 0x${ins.toString(16)} seq=${seq} ${COMMAND_TIMEOUT_MS}ms 无应答`,
        ),
      );
    }, COMMAND_TIMEOUT_MS);
  }
}

/** 一台头盔的连接会话；断线即销毁，重连新建 */
class HelmetSession {
  private seq = 0;
  private pending = new Map<number, PendingCommand>();
  private seenSeqs: number[] = [];
  private monitor: Subscription | null = null;
  private disconnectSub: Subscription | null = null;
  firmwareVersion = "unknown";
  closed = false;

  constructor(
    readonly deviceId: string,
    readonly device: Device,
    private readonly onClosed: (reason: string) => void,
  ) {}

  private patch(p: Partial<BleDeviceLink>): void {
    useBleStore.getState().patchLink(this.deviceId, p);
  }

  async open(): Promise<void> {
    this.disconnectSub = this.device.onDisconnected((_e, _d) =>
      this.close("disconnected"),
    );
    // Step 1：MTU（Android 由 connect 参数请求；iOS 系统自动协商，requestMTU 为 no-op）
    if (Platform.OS === "android") {
      try {
        await this.device.requestMTU(REQUEST_MTU);
      } catch (e) {
        log("requestMTU 失败（继续，短帧仍可用）", e);
      }
    }
    await this.device.discoverAllServicesAndCharacteristics();
    // Step 2：开 Notify（CCCD）——必须先于任何指令，否则应答帧丢失
    this.monitor = this.device.monitorCharacteristicForService(
      SERVICE_UUID,
      CHAR_NOTIFY_UUID,
      (error, ch) => {
        if (error) {
          if (
            !this.closed &&
            error.errorCode !== BleErrorCode.OperationCancelled
          ) {
            log("notify 中断", error.message);
            this.close("notify-error");
          }
          return;
        }
        if (ch?.value) this.onFrame(base64ToBytes(ch.value));
      },
    );
    // Step 3：身份 + 固件（手册勘误：0x40 只读 deviceId，固件单独读 0x00–0x02）
    const idResp = await this.command(
      buildRead(this.nextSeq(), Reg.DEVICE_ID, 16),
    );
    const helmetId = deviceIdFromBytes(idResp.data);
    if (helmetId !== this.deviceId) {
      throw Object.assign(
        new Error(`头盔身份不匹配：广播名匹配但 deviceId=${helmetId}`),
        {
          code: "DEVICE_ID_MISMATCH",
        },
      );
    }
    const fwResp = await this.command(
      buildRead(this.nextSeq(), Reg.FW_MAJOR, 3),
    );
    this.firmwareVersion = firmwareFromBytes(fwResp.data);
    this.patch({ firmwareVersion: this.firmwareVersion });
    // Step 4：对时（头盔 RTC 断电即失，每次连接都校）
    await this.command(
      buildTimeSync(this.nextSeq(), Math.floor(Date.now() / 1000)),
    );
    // Step 5：补传离线期间的高危事件（逐条 ACK 后头盔擦除）
    await this.resendOffline();
  }

  private nextSeq(): number {
    this.seq = (this.seq % 255) + 1;
    return this.seq;
  }

  /** 带应答的指令：按 Seq 匹配应答帧，超时报错 */
  private async command(frame: Uint8Array): Promise<InboundResponse> {
    const seq = frame[1];
    const p = new PendingCommand(frame[0], seq, () => this.pending.delete(seq));
    this.pending.set(seq, p);
    try {
      await this.device.writeCharacteristicWithResponseForService(
        SERVICE_UUID,
        CHAR_WRITE_UUID,
        bytesToBase64(frame),
      );
    } catch (e) {
      clearTimeout(p.timer);
      this.pending.delete(seq);
      throw e;
    }
    const resp = await p.promise;
    if (resp.ins !== frame[0])
      log(
        `应答指令码不符：发 0x${frame[0].toString(16)} 收 0x${resp.ins.toString(16)}`,
      );
    return resp;
  }

  private async sendAck(code: number, eventSeq: number): Promise<void> {
    try {
      await this.device.writeCharacteristicWithoutResponseForService(
        SERVICE_UUID,
        CHAR_WRITE_UUID,
        bytesToBase64(buildAck(code, eventSeq)),
      );
    } catch (e) {
      log("ACK 写入失败（头盔会重发）", e);
    }
  }

  private async resendOffline(): Promise<void> {
    let resent = 0;
    for (let round = 0; round < RESEND_MAX_ROUNDS; round += 1) {
      const q = await this.command(buildResendQuery(this.nextSeq()));
      if (q.error !== 0 || q.data.length < 2) break;
      const count = q.data[0] | (q.data[1] << 8);
      if (count === 0) break;
      // 逐条 ACK 后头盔擦除，队列前移，因此 offset 恒为 0
      const r = await this.command(
        buildResendData(this.nextSeq(), 0, Math.min(count, RESEND_BATCH)),
      );
      const got = r.data[0] ?? 0;
      resent += got;
      this.patch({ resent });
      if (got === 0) break;
    }
    if (resent > 0) {
      log(`补传 ${resent} 条离线高危事件`);
      void flushRelayQueue();
    }
  }

  private onFrame(bytes: Uint8Array): void {
    this.patch({ lastFrameAt: Date.now() });
    const frame = parseInbound(bytes);
    if (!frame) {
      log("无法解析的帧", bytesToHex(bytes));
      return;
    }
    if (frame.kind === "response") {
      const p = this.pending.get(frame.seq);
      if (!p) {
        log("无人等待的应答", bytesToHex(bytes));
        return;
      }
      clearTimeout(p.timer);
      this.pending.delete(frame.seq);
      p.resolve(frame);
      return;
    }
    void this.onEvent(frame);
  }

  private async onEvent(ev: InboundEvent): Promise<void> {
    // 高危先 ACK 再处理：ACK 只表示「App 已收到」，头盔据此停止 1.5s 重发（§1.3）
    if (HIGH_RISK_CODES.has(ev.code)) await this.sendAck(ev.code, ev.eventSeq);
    if (this.seenSeqs.includes(ev.eventSeq)) return; // 重发帧：已入队过
    this.seenSeqs.push(ev.eventSeq);
    if (this.seenSeqs.length > SEEN_SEQ_LIMIT) this.seenSeqs.shift();

    const envelope = translateEvent(ev, {
      deviceId: this.deviceId,
      firmwareVersion: this.firmwareVersion,
      receivedAt: new Date(),
    });
    const link = useBleStore.getState().links[this.deviceId];
    this.patch({ eventsReceived: (link?.eventsReceived ?? 0) + 1 });
    if (!envelope) {
      log(
        `事件 0x${ev.code.toString(16)} seq=${ev.eventSeq} 未翻译（未知/无定位/载荷不符）`,
      );
      return;
    }
    enqueueRelayEvent(envelope);
    // 保命链路不等 5s 周期：高危事件立即冲刷
    if (HIGH_RISK_CODES.has(ev.code)) void flushRelayQueue();
  }

  /** 设置写入（ble-relay 调用）：返回头盔错误码，0 = 已执行 */
  async writeRegister(addr: number, data: number[]): Promise<number> {
    const resp = await this.command(buildWrite(this.nextSeq(), addr, data));
    return resp.error;
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.monitor?.remove();
    this.disconnectSub?.remove();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`连接已关闭（${reason}）`));
    }
    this.pending.clear();
    void this.device.cancelConnection().catch(() => undefined);
    this.onClosed(reason);
  }
}

// —— 管理器状态（模块级单例；与登录态同生命周期，由 use-realtime 驱动） ——
let targets: string[] = [];
let running = false;
let scanning = false;
let connecting: string | null = null;
const sessions = new Map<string, HelmetSession>();
/** 握手时 deviceId 与绑定不符的设备：不再自动重连，等用户在设备页手动重试 */
const blocked = new Set<string>();
/** 核身失败的兜底候选外设（peripheral id）：本次链路周期内不再尝试 */
const ignoredPeripherals = new Set<string>();
const reconnectDelay = new Map<string, number>();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let stateSub: Subscription | null = null;

const store = () => useBleStore.getState();

function wanted(): string[] {
  return targets.filter(
    (id) => !sessions.has(id) && connecting !== id && !blocked.has(id),
  );
}

async function ensureScanning(): Promise<void> {
  if (!running || scanning || connecting) return;
  const want = wanted();
  if (want.length === 0) return;
  const mgr = getBleManager();
  scanning = true; // 先占位再 await：并发调用（设备列表轮询触发）不能重复起扫描
  if ((await mgr.state()) !== State.PoweredOn) {
    scanning = false;
    return;
  }
  // 系统层可能仍保持着上次 JS 会话/上次进程的连接（iOS 常见）：直接复用，不再扫描
  try {
    const already = await mgr.connectedDevices([SERVICE_UUID]);
    for (const d of already) {
      const name = d.localName ?? d.name;
      const target = want.find((id) => advName(id) === name);
      if (target) {
        scanning = false;
        log("复用系统已连接的外设", name);
        void connect(target, d);
        return;
      }
    }
  } catch (e) {
    log("查询已连接外设失败", (e as Error).message);
  }
  log("扫描目标", want.map(advName).join(","));
  const seen = new Set<string>();
  for (const id of want) store().patchLink(id, { phase: "scanning" });
  // 按服务 UUID FEE0 过滤扫描，再按广播名 `Helmet-<后6位>` 匹配到具体设备：
  // iOS 退后台后只有带服务 UUID 过滤的扫描才会继续投递（真机实测 2026-09-16，不过滤时锁屏即停），
  // 因此硬件广播包必须携带 FEE0（DEVICE_PROTOCOL §1.2 已向硬件确认项）。
  mgr.startDeviceScan(
    [SERVICE_UUID],
    { allowDuplicates: false },
    (error, device) => {
      if (error) {
        log("扫描错误", error.message);
        scanning = false;
        scheduleReconnect("scan-error");
        return;
      }
      if (!device) return;
      // 广播里的 localName 优先：iOS 的 device.name 是系统缓存的 GAP 名，可能是外设旧名/主机名（真机实测）
      const name = device.localName ?? device.name;
      if (__DEV__ && name && !seen.has(name)) {
        seen.add(name);
        log("发现", name, device.serviceUUIDs?.join(",") ?? "");
      }
      let target = name
        ? wanted().find((id) => advName(id) === name)
        : undefined;
      let byName = true;
      if (!target) {
        // 名字对不上但广播了 FEE0 且只有一个目标：连上去读 0x40 核身（名字被系统缓存/截断时的兜底）
        const advertisesService = device.serviceUUIDs?.some(
          (u) => u.toLowerCase() === SERVICE_UUID,
        );
        const candidates = wanted();
        if (
          !advertisesService ||
          candidates.length !== 1 ||
          ignoredPeripherals.has(device.id)
        )
          return;
        target = candidates[0];
        byName = false;
      }
      mgr.stopDeviceScan();
      scanning = false;
      void connect(target, device, byName);
    },
  );
}

async function connect(
  deviceId: string,
  found: Device,
  byName = true,
): Promise<void> {
  connecting = deviceId;
  store().patchLink(deviceId, { phase: "connecting", errorCode: undefined });
  let session: HelmetSession | null = null;
  try {
    const device = await found.connect({
      requestMTU: REQUEST_MTU,
      timeout: 10_000,
    });
    store().patchLink(deviceId, { phase: "handshaking" });
    session = new HelmetSession(deviceId, device, (reason) => {
      sessions.delete(deviceId);
      store().patchLink(deviceId, { phase: running ? "disconnected" : "idle" });
      log(`${deviceId} 断开：${reason}`);
      if (running) scheduleReconnect(deviceId);
    });
    sessions.set(deviceId, session);
    await session.open();
    reconnectDelay.delete(deviceId);
    store().patchLink(deviceId, {
      phase: "connected",
      connectedAt: Date.now(),
      eventsReceived: 0,
    });
    log(`${deviceId} 已连接，固件 ${session.firmwareVersion}`);
  } catch (e) {
    const code = (e as { code?: string }).code;
    log(`${deviceId} 连接/握手失败`, (e as Error).message);
    sessions.delete(deviceId);
    session?.close("handshake-failed");
    if (code === "DEVICE_ID_MISMATCH" && !byName) {
      // 兜底候选核身失败：只是别人的头盔，忽略这台外设继续扫
      ignoredPeripherals.add(found.id);
      store().patchLink(deviceId, { phase: "disconnected" });
      scheduleReconnect(deviceId);
    } else if (code === "DEVICE_ID_MISMATCH") {
      // 广播名撞车或绑错设备：不自动重试，页面显示错误让用户处理
      blocked.add(deviceId);
      store().patchLink(deviceId, { phase: "error", errorCode: code });
    } else {
      store().patchLink(deviceId, { phase: "disconnected" });
      scheduleReconnect(deviceId);
    }
  } finally {
    connecting = null;
    void ensureScanning();
  }
}

function scheduleReconnect(key: string): void {
  if (!running || reconnectTimer) return;
  const prev = reconnectDelay.get(key) ?? 0;
  const delay =
    prev === 0 ? RECONNECT_MIN_MS : Math.min(prev * 2, RECONNECT_MAX_MS);
  reconnectDelay.set(key, delay);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void ensureScanning();
  }, delay);
}

function applyAdapterState(state: State): void {
  const map: Partial<Record<State, ReturnType<typeof store>["adapter"]>> = {
    [State.PoweredOn]: "on",
    [State.PoweredOff]: "off",
    [State.Unauthorized]: "unauthorized",
    [State.Unsupported]: "unsupported",
  };
  store().setAdapter(map[state] ?? "unknown");
  log("蓝牙状态", state);
  if (state === State.PoweredOn) {
    void ensureScanning();
  } else {
    // 蓝牙关闭/权限收回：系统会断开所有连接；会话由 onDisconnected 自行清理
    if (scanning) {
      getBleManager().stopDeviceScan();
      scanning = false;
    }
    for (const id of targets) {
      if (!sessions.has(id))
        store().patchLink(id, { phase: running ? "disconnected" : "idle" });
    }
  }
}

/**
 * 启动链路：目标 = 当前账号已绑定的 deviceId 列表。幂等；重复调用只更新目标。
 * 权限被拒 / 蓝牙关闭不抛错，状态落 store 供页面提示；模拟器（Unsupported）直接静默。
 */
export async function startBleLink(deviceIds: string[]): Promise<void> {
  setBleTargets(deviceIds);
  if (running) return;
  running = true;
  log("链路启动，目标设备", deviceIds.join(",") || "(无)");
  const granted = await requestBlePermissions();
  if (!granted) {
    store().setAdapter("unauthorized");
    return;
  }
  const mgr = getBleManager();
  stateSub?.remove();
  stateSub = mgr.onStateChange((s) => applyAdapterState(s), true);
}

/** 绑定/解绑后同步目标；被移除的设备立即断开 */
export function setBleTargets(deviceIds: string[]): void {
  const next = Array.from(new Set(deviceIds));
  const unchanged =
    next.length === targets.length && next.every((id) => targets.includes(id));
  if (unchanged && running) return;
  for (const id of targets) {
    if (!next.includes(id)) {
      sessions.get(id)?.close("unbound");
      store().removeLink(id);
    }
  }
  targets = next;
  for (const id of targets) {
    if (!store().links[id])
      store().patchLink(id, { phase: running ? "scanning" : "idle" });
  }
  if (running) void ensureScanning();
}

export function stopBleLink(): void {
  running = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stateSub?.remove();
  stateSub = null;
  if (scanning) {
    getBleManager().stopDeviceScan();
    scanning = false;
  }
  for (const s of sessions.values()) s.close("stopped");
  sessions.clear();
  targets = [];
  reconnectDelay.clear();
  blocked.clear();
  ignoredPeripherals.clear();
  store().reset();
  // 释放原生栈：否则 JS 重载/登出后系统仍握着外设连接，头盔不再广播、下次扫描找不到
  manager?.destroy();
  manager = null;
}

/** 手动重连（设备页 / 开发面板）：清退避立即重扫 */
export function retryBleLink(deviceId?: string): void {
  if (deviceId) {
    reconnectDelay.delete(deviceId);
    blocked.delete(deviceId);
  } else {
    reconnectDelay.clear();
    blocked.clear();
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  void ensureScanning();
}

export const isHelmetConnected = (deviceId: string): boolean =>
  sessions.has(deviceId);

export type RegisterWriteResult =
  | { delivered: false }
  | { delivered: true; executed: true }
  | { delivered: true; executed: false; errorCode: string };

/**
 * 设置写入入口（ble-relay 调用）：未连接 → 未送达（服务端 30s 超时判 offline，绝不假装成功）；
 * 已连接 → 写寄存器并把头盔错误码翻译成回执 errorCode。
 */
export async function writeHelmetRegister(
  deviceId: string,
  addr: number,
  data: number[],
): Promise<RegisterWriteResult> {
  const s = sessions.get(deviceId);
  if (!s || s.closed) return { delivered: false };
  try {
    const err = await s.writeRegister(addr, data);
    if (err === 0) return { delivered: true, executed: true };
    return {
      delivered: true,
      executed: false,
      errorCode: ERROR_NAMES[err] ?? `ERR_0x${err.toString(16)}`,
    };
  } catch (e) {
    log("写寄存器失败", (e as Error).message);
    return { delivered: false };
  }
}

export const BLE_INS = Ins;
