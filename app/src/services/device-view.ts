// 设备详情页的几处纯推导：蓝牙那一行显示什么、电量低的口径、回执该挂在哪一项旁边。
// 只做显示上的归类，不参与连接、在线判断或命令状态机。
import type { CommandPublic } from "@helmet/shared";

import type { BleAdapterState, BleLinkPhase } from "@/stores/ble-store";

/** 状态卡里「手机与头盔的蓝牙」这一行的状态。只看本机蓝牙——设备是否在线是另一行，两件事不合并 */
export type BleRowState =
  | BleLinkPhase // idle / scanning / connecting / handshaking / connected / disconnected / error
  | "off"
  | "unauthorized"
  | "unsupported";

/** 这一行能提供的现有入口：重试连接 / 去开蓝牙 / 去给权限 */
export type BleRowAction = "retry" | "bluetoothSettings" | "appSettings";

/**
 * 与改版前设备页的判断一致：手机蓝牙关着 / 没权限 / 不支持时先说手机这边的原因，否则按链路阶段。
 * 重试入口的条件也照旧：本机对这顶头盔有链路记录、没连上、且蓝牙是开着的。
 */
export function bleRowOf(
  adapter: BleAdapterState,
  phase: BleLinkPhase | undefined,
): { state: BleRowState; action: BleRowAction | null } {
  if (adapter === "off") return { state: "off", action: "bluetoothSettings" };
  if (adapter === "unauthorized")
    return { state: "unauthorized", action: "appSettings" };
  if (adapter === "unsupported") return { state: "unsupported", action: null };
  return {
    state: phase ?? "idle",
    action:
      phase !== undefined && phase !== "connected" && adapter === "on"
        ? "retry"
        : null,
  };
}

/** 电量低的口径：≤ 20%，与电量图变色、设备列表、低电量提醒的第一档是同一条线 */
export const LOW_BATTERY = 20;

export function isBatteryLow(battery: number | null | undefined): boolean {
  return typeof battery === "number" && battery <= LOW_BATTERY;
}

/** 电量极低的口径：≤ 10%，红色；与低电量提醒的第二档（services/battery-alert）是同一条线 */
export const CRITICAL_BATTERY = 10;

export type BatteryTier = "ok" | "low" | "critical" | "none";

/**
 * 电量分三档（负责人 2026-10-15）：≤10% 红（critical）、≤20% 黄（low）、其余正常；没有电量数据是 none。
 * 大图的环 / 光晕 / 数字、其他设备行的电量条都按这个取色。
 */
export function batteryTierOf(battery: number | null | undefined): BatteryTier {
  if (typeof battery !== "number" || Number.isNaN(battery)) return "none";
  if (battery <= CRITICAL_BATTERY) return "critical";
  if (battery <= LOW_BATTERY) return "low";
  return "ok";
}

/**
 * 最近一条下发命令改没改这一项。改了，回执才显示在这一项旁边；
 * 没改的项旁边什么都不显示——不能让别的项的「已生效」看起来像是在说它。
 */
export function commandTouches(
  command: Pick<CommandPublic, "params"> | null | undefined,
  key: string,
): boolean {
  return (
    command != null &&
    Object.prototype.hasOwnProperty.call(command.params ?? {}, key)
  );
}

/** 正文里引用设备编号时最多留几个字 */
export const DEVICE_ID_MAX_SHOWN = 32;

/**
 * 正文里引用的设备编号：超过 max 个字只留前 max 个加「…」。按码点数，不把表情切成半个。
 * 链接里的编号是用户（或别人发来的链接）给的，可以是任意长的一串（华为真机：600 个 x 铺满整屏）；
 * 量产头盔的编号是 13 个字（`helmet_` + 6 位十六进制，DEVICE_PROTOCOL 待办 10），不受影响。
 */
export function shortDeviceId(id: string, max = DEVICE_ID_MAX_SHOWN): string {
  const chars = Array.from(id);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : id;
}
