// 设备页（首页标签）的几个推导（纯函数）：大图多大、其他设备怎么排、安全那一格写什么。
import type { DevicePublic } from "@helmet/shared";

import type { MessageKey } from "@/i18n";
import {
  linkLevelOf,
  type HelmetLink,
  type ProtectionState,
} from "@/services/safety-status";

export const RING_MAX = 280;
export const RING_MIN = 200;
/** 两格摘要的高度 */
export const TILE_HEIGHT = 108;
/** 「其他设备」一行的高度 */
export const OTHER_ROW_HEIGHT = 60;
/** 「其他设备」小标题连同上下间距 */
const OTHERS_HEAD = 44;
/** 大图以外固定要占的高度：标题栏 48 + 名字 46 + 状态 26 + 上下留白 44（含大图与两格摘要之间的 16）+ 底部内边距 16 */
const FIXED = 180;

/**
 * 头盔大图（电量环）的边长：一屏放得下时尽量大，设备多了缩到 200，再放不下页面改为滚动。
 * @param viewportHeight 滚动区可见高度
 * @param others 「其他设备」的行数
 */
export function heroRingSize(viewportHeight: number, others: number): number {
  const lower =
    TILE_HEIGHT + (others > 0 ? OTHERS_HEAD + OTHER_ROW_HEIGHT * others : 0);
  const room = Math.floor(viewportHeight - FIXED - lower);
  return Math.max(RING_MIN, Math.min(RING_MAX, room));
}

/**
 * 「其他设备」：除当前头盔外的全部，连着的排前面，各自保持原有先后。
 * @param isLinked 这顶头盔此刻是否连着（设备页用连接结论判断，见 linkLevelOf）
 */
export function otherDevicesOf(
  devices: readonly DevicePublic[],
  currentId: string,
  isLinked: (d: DevicePublic) => boolean,
): DevicePublic[] {
  const rest = devices.filter((d) => d.deviceId !== currentId);
  return [...rest.filter(isLinked), ...rest.filter((d) => !isLinked(d))];
}

export type SafetyTileTone = "ok" | "warn" | "fault" | "unknown";

/**
 * 「安全」那一格：只写安全页状态卡的结论里最要紧的一项，颜色轻重也与状态卡一致
 * （没连上是提醒色，红色只留给身份不符；确认不了的不算正常，也不亮提醒色）。
 */
export function safetyTileOf(
  state: ProtectionState,
  link: HelmetLink,
): { text: MessageKey; tone: SafetyTileTone } {
  switch (state) {
    case "ready":
      return { text: "devices.safety.ready", tone: "ok" };
    case "linkDown":
      if (link === "mismatch")
        return { text: "safety.link.mismatch", tone: "fault" };
      if (link === "bluetoothOff")
        return { text: "safety.link.bluetoothOff", tone: "warn" };
      if (link === "bluetoothDenied")
        return { text: "safety.link.bluetoothDenied", tone: "warn" };
      return { text: "devices.safety.linkDown", tone: "warn" };
    case "notifyOff":
      return { text: "safety.state.notifyOff", tone: "warn" };
    case "noContacts":
      return { text: "devices.safety.noContacts", tone: "warn" };
    default:
      return { text: "devices.safety.unknown", tone: "unknown" };
  }
}

/**
 * 电量环把 270° 拆成三段各 90° 来画（components/battery-arc）：进度 p（0–1）在第 i 段（0 / 1 / 2）里
 * 走了多少（0–1）。在动画线程里调用。
 */
export function arcSegment(p: number, i: number): number {
  "worklet";
  return Math.max(0, Math.min(1, p * 3 - i));
}

/** 大图下面那颗状态药丸写什么 */
export function linkPillOf(link: HelmetLink): {
  text: MessageKey;
  linked: boolean;
  searching: boolean;
} {
  if (link === "connected")
    return { text: "devices.link.connected", linked: true, searching: false };
  if (link === "online")
    return { text: "common.online", linked: true, searching: false };
  if (link === "searching")
    return { text: "devices.link.searching", linked: false, searching: true };
  if (linkLevelOf(link) === "unknown")
    return { text: "devices.link.unknown", linked: false, searching: false };
  return { text: "devices.link.notConnected", linked: false, searching: false };
}
