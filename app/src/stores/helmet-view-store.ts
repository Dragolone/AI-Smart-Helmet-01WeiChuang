// 「正在查看哪顶头盔」（Zustand，仅内存）：安全首页与安全记录页共用，所以从记录页返回后选择还在。
// 只决定页面显示谁的状态和记录——不连接、不断开、不解绑任何设备，也不决定求救发给谁（那条规则见
// services/safety-status.ts 的 sosTargetOf）。
// 不落盘：重开 App 回到默认规则；换账号后旧 id 不在新列表里，同样回到默认规则，不需要另外清理。
import type { DevicePublic } from "@helmet/shared";
import { create } from "zustand";

interface HelmetViewState {
  /** 用户明确选过的头盔；null = 没选过，按默认规则 */
  selectedId: string | null;
  select: (deviceId: string) => void;
}

export const useHelmetViewStore = create<HelmetViewState>((set) => ({
  selectedId: null,
  select: (deviceId) => set({ selectedId: deviceId }),
}));

/**
 * 实际查看的头盔：用户选过且仍在绑定列表里的那顶；否则沿用设备页「当前设备」的规则
 * （第一台在线的，都离线则第一台）。列表为空时没有可查看的头盔。
 */
export function viewedHelmetOf(
  devices: readonly DevicePublic[],
  selectedId: string | null,
): DevicePublic | undefined {
  return (
    devices.find((d) => d.deviceId === selectedId) ??
    devices.find((d) => d.online) ??
    devices[0]
  );
}
