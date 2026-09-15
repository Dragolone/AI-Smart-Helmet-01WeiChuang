// BLE 链路状态（Zustand）：只做展示，业务判断全在 services/ble-link.ts。
// 状态语义遵守 CLAUDE.md「BLE 防丢口径」：只暴露 connected/disconnected 与连接阶段，RSSI 不当距离。
import { create } from 'zustand';

export type BleAdapterState =
  | 'unknown'
  | 'unsupported' // 模拟器 / 无蓝牙硬件
  | 'unauthorized' // 用户拒绝蓝牙权限
  | 'off' // 蓝牙关闭，引导去系统设置
  | 'on';

export type BleLinkPhase =
  | 'idle' // 未纳入目标（未绑定 / 链路未启动）
  | 'scanning'
  | 'connecting'
  | 'handshaking'
  | 'connected'
  | 'disconnected' // 曾连上，现掉线；后台自动重连中
  | 'error'; // 握手失败（如 deviceId 不匹配），需人工干预

export interface BleDeviceLink {
  phase: BleLinkPhase;
  /** 握手读到的固件版本（0x00–0x02） */
  firmwareVersion?: string;
  /** 最近一次连上的时刻（ms） */
  connectedAt?: number;
  /** 最近一次收到头盔帧（事件或应答）的时刻（ms） */
  lastFrameAt?: number;
  /** 本次连接收到的事件帧计数（开发面板用） */
  eventsReceived: number;
  /** 补传的高危事件数（握手 Step 5） */
  resent: number;
  errorCode?: string;
}

interface BleState {
  adapter: BleAdapterState;
  links: Record<string, BleDeviceLink>;
  setAdapter: (adapter: BleAdapterState) => void;
  patchLink: (deviceId: string, patch: Partial<BleDeviceLink>) => void;
  removeLink: (deviceId: string) => void;
  reset: () => void;
}

export const EMPTY_LINK: BleDeviceLink = { phase: 'idle', eventsReceived: 0, resent: 0 };

export const useBleStore = create<BleState>((set) => ({
  adapter: 'unknown',
  links: {},
  setAdapter: (adapter) => set({ adapter }),
  patchLink: (deviceId, patch) =>
    set((s) => ({
      links: { ...s.links, [deviceId]: { ...(s.links[deviceId] ?? EMPTY_LINK), ...patch } },
    })),
  removeLink: (deviceId) =>
    set((s) => {
      const links = { ...s.links };
      delete links[deviceId];
      return { links };
    }),
  reset: () => set({ adapter: 'unknown', links: {} }),
}));
