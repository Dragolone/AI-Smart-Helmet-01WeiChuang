// 安全首页状态卡的推导（纯函数）：把「头盔连没连上 / 通知开没开 / 有没有联系人」三件能核实的事
// 归成一个结论。原则：查不到、还在查、数据可能过期的，一律不算「正常」。
// 这里只描述连接与配置，不描述道路环境——App 无从知道周围是否安全。
import type { DevicePublic } from "@helmet/shared";

import type { MessageKey } from "@/i18n";
import type { BleAdapterState, BleLinkPhase } from "@/stores/ble-store";

/** 头盔显示的名字：用户起过名就用它，否则是设备号 */
export const helmetNameOf = (d: Pick<DevicePublic, "name" | "deviceId">) =>
  d.name ?? d.deviceId;

/** 这顶头盔与手机 / 云端的连接结论 */
export type HelmetLink =
  | "connected" // 本机蓝牙已连上
  | "online" // 本机没连，但服务端 90 秒内收到过它的数据（另一条通道在带它）
  | "searching" // 本机没连上，正在搜索 / 连接 / 握手（头盔关机时会一直停在这里）
  | "bluetoothOff"
  | "bluetoothDenied"
  | "disconnected" // 本机曾连上，现在掉线（后台自动重连中）
  | "mismatch" // 握手失败：连到的头盔与绑定信息不符
  | "offline"
  | "unknown"; // 服务端状态拿不到，本机也没有连接证据

export type LinkLevel = "ok" | "unknown" | "down";

/**
 * @param serverFresh 设备列表最近一次拉取是否成功。失败时缓存里的 online 可能是旧的，不能拿来说「在线」。
 */
export function helmetLinkOf(
  device: Pick<DevicePublic, "online">,
  ble: { phase?: BleLinkPhase; adapter: BleAdapterState },
  serverFresh: boolean,
): HelmetLink {
  if (ble.phase === "connected") return "connected";
  // 这台手机刚带着的链路掉了：服务端的「在线」是 90 秒窗口，还会再挂一会儿——以本机看到的为准
  if (ble.phase === "disconnected") {
    if (ble.adapter === "off") return "bluetoothOff";
    if (ble.adapter === "unauthorized") return "bluetoothDenied";
    return "disconnected";
  }
  if (ble.phase === "error") return "mismatch";
  if (!serverFresh) return "unknown";
  if (device.online) return "online";
  if (ble.adapter === "off") return "bluetoothOff";
  if (ble.adapter === "unauthorized") return "bluetoothDenied";
  if (
    ble.phase === "scanning" ||
    ble.phase === "connecting" ||
    ble.phase === "handshaking"
  )
    return "searching";
  return "offline";
}

/** 连接结论对应的一句话（安全页状态卡的标题） */
export const linkLabelKey = (link: HelmetLink): MessageKey =>
  `safety.link.${link}`;

export function linkLevelOf(link: HelmetLink): LinkLevel {
  if (link === "connected" || link === "online") return "ok";
  // 只有「服务端状态拿不到、本机也没有证据」才算确认不了。搜索中是确定的没连上：
  // 头盔关着的时候本机会一直搜下去，不能让卡片长期停在「正在确认」
  if (link === "unknown") return "unknown";
  return "down";
}

/** 核对项 / 头盔列表里一条结论的四档，决定图标和颜色（components/status-chip） */
export type CheckLevel = "ok" | "warn" | "unknown" | "bad";

/**
 * 连接结论在核对项里的轻重。
 * 头盔此刻没连上（关机、不在身边、刚掉线）是不骑车时的常态：用提醒色，不用红色——
 * 红色天天挂在首页上，真出事时就不显眼了。红叉留给要用户动手改的设置（蓝牙关着、没给权限）
 * 和身份不符。
 */
export function linkCheckLevelOf(link: HelmetLink): CheckLevel {
  const level = linkLevelOf(link);
  if (level === "ok") return "ok";
  if (level === "unknown") return "unknown";
  return link === "bluetoothOff" ||
    link === "bluetoothDenied" ||
    link === "mismatch"
    ? "bad"
    : "warn";
}

/**
 * 状态卡用红色的连接状态只有一种：握手身份不符（连到的不是绑定的那顶，需要人工处理）。
 * 其余没连上的情况一律提醒色；首页上另一处红色是进行中的 SOS。
 */
export function isLinkFault(link: HelmetLink): boolean {
  return link === "mismatch";
}

/** 通知权限：undetermined = 系统还没问过用户；unknown = 查询本身失败 */
export type NotifyPermission =
  "granted" | "denied" | "undetermined" | "unknown";

export type ProtectionState =
  | "noHelmet" // 一台都没绑
  | "unknown" // 有一项还确认不了
  | "linkDown"
  | "notifyOff"
  | "noContacts"
  | "ready";

/**
 * 状态卡结论。同时有多项问题时只报最要紧的一项（其余在卡片下方的三个核对项里照样逐项显示）：
 * 连接断开 > 有项目确认不了 > 通知被关 > 没有联系人。
 * @param link null = 没有可查看的头盔
 * @param contacts null = 联系人列表还没拿到（加载中或失败）
 */
export function protectionStateOf(input: {
  link: HelmetLink | null;
  notify: NotifyPermission | null;
  contacts: number | null;
}): ProtectionState {
  const { link, notify, contacts } = input;
  if (link === null) return "noHelmet";
  const level = linkLevelOf(link);
  if (level === "down") return "linkDown";
  if (level === "unknown") return "unknown";
  if (notify === "denied") return "notifyOff";
  if (notify !== "granted") return "unknown";
  if (contacts === null) return "unknown";
  if (contacts === 0) return "noContacts";
  return "ready";
}

/**
 * 「当前头盔」：设备页的大图、安全页默认查看的那顶、App 内求救记在谁名下，都是它。
 * - 只有一台在线：就是它，不看用户选过谁（选的那顶没开机时，不能把求救记到它头上）；
 * - 同时在线多台：用户在设备页「设为当前」的那台，没选过或那台不在线就取第一台在线的；
 * - 都不在线：用户选过的那台，否则第一台。
 * @param chosenId 设备页「设为当前」存下的选择（stores/current-helmet-store）；null = 没选过。
 *   选过的头盔已解绑时不在列表里，自然落回默认规则。
 */
export function currentHelmetOf(
  devices: readonly DevicePublic[],
  chosenId: string | null,
): DevicePublic | undefined {
  const online = devices.filter((d) => d.online);
  if (online.length > 0)
    return online.find((d) => d.deviceId === chosenId) ?? online[0];
  return devices.find((d) => d.deviceId === chosenId) ?? devices[0];
}

/**
 * App 内 SOS 按钮把求救记在哪顶头盔名下：当前头盔（currentHelmetOf）。
 * 2026-10-07 负责人定：在线多台时跟着设备页的「设为当前」走；此前（2026-09-10 起）固定取第一台在线的。
 * 它仍然**不随安全页「正在查看的头盔」变化**——跟着查看走的话，翻看一顶放在家里的头盔时按下求救，
 * 求救单和位置快照会记到那顶头上。
 */
export function sosTargetOf(
  devices: readonly DevicePublic[],
  chosenId: string | null,
): DevicePublic | undefined {
  return currentHelmetOf(devices, chosenId);
}
