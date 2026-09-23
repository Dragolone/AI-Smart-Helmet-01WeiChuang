// 蓝牙工程模式状态（Zustand）：只做展示。会话逻辑全在 services/ble-bench.ts。
import { create } from "zustand";

import type { BleAdapterState } from "@/stores/ble-store";

export type BenchPhase = "idle" | "scanning" | "connecting" | "connected";

export interface BenchPeripheral {
  id: string;
  name: string | null;
  rssi: number | null;
  serviceUUIDs: string[];
  /** 广播包里带了 FEE0（DEVICE_PROTOCOL §10 第 2 条，iOS 后台扫描硬性要求） */
  hasHelmetService: boolean;
  lastSeenAt: number;
}

export interface BenchCharacteristic {
  uuid: string;
  notify: boolean;
  write: boolean;
  writeNoResp: boolean;
  read: boolean;
}

export interface BenchService {
  uuid: string;
  characteristics: BenchCharacteristic[];
}

export type BenchLogTone = "ok" | "error" | "event" | "muted";

export interface BenchLogEntry {
  id: number;
  at: number;
  dir: "tx" | "rx" | "info";
  hex: string;
  text: string;
  tone?: BenchLogTone;
  /** 应答帧：距对应下行帧的毫秒数 */
  latencyMs?: number;
}

export interface BenchState {
  phase: BenchPhase;
  adapter: BleAdapterState;
  peripherals: Record<string, BenchPeripheral>;
  connectedId: string | null;
  connectedName: string | null;
  mtu: number | null;
  services: BenchService[];
  notifyOk: boolean;
  writeOk: boolean;
  autoAck: boolean;
  log: BenchLogEntry[];
  /** 最近一条事件帧（手动 ACK 用） */
  lastEvent: { code: number; seq: number } | null;
  patch: (p: Partial<Omit<BenchState, "patch" | "upsertPeripheral" | "appendLog" | "clearLog" | "reset">>) => void;
  upsertPeripheral: (p: BenchPeripheral) => void;
  appendLog: (e: Omit<BenchLogEntry, "id">) => void;
  clearLog: () => void;
  reset: () => void;
}

/** 日志上限：真机每 5 s 一条位置包，500 条够看十几分钟；导出前清空即可 */
export const BENCH_LOG_LIMIT = 500;

let logSeq = 0;

const INITIAL = {
  phase: "idle" as BenchPhase,
  adapter: "unknown" as BleAdapterState,
  peripherals: {},
  connectedId: null,
  connectedName: null,
  mtu: null,
  services: [],
  notifyOk: false,
  writeOk: false,
  autoAck: true,
  log: [],
  lastEvent: null,
};

export const useBleBenchStore = create<BenchState>((set) => ({
  ...INITIAL,
  patch: (p) => set(p),
  upsertPeripheral: (p) =>
    set((s) => ({ peripherals: { ...s.peripherals, [p.id]: p } })),
  appendLog: (e) =>
    set((s) => {
      logSeq += 1;
      const log = [...s.log, { ...e, id: logSeq }];
      return {
        log: log.length > BENCH_LOG_LIMIT ? log.slice(-BENCH_LOG_LIMIT) : log,
      };
    }),
  clearLog: () => set({ log: [] }),
  // 自动 ACK 开关是用户偏好，重置会话时保留
  reset: () => set((s) => ({ ...INITIAL, autoAck: s.autoAck })),
}));
