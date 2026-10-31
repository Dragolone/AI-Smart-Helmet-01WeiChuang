// 求救倒计时页结束之后「通知发出去没有」的几个推导（纯函数）。
// 数据是事故详情里的通知记录（API.md §7）：每位联系人一条短信，另有一条发给本人的推送。
// 这里只看短信那几条——页面上列的是「谁收到了」，本人的推送不算。
import type { AccidentDetail, SosNotificationPublic } from "@helmet/shared";

import { avatarInitial } from "./user-name";

type Row = Pick<SosNotificationPublic, "channel" | "status">;

/**
 * 发给紧急联系人的那几条（短信）。记录的结构不对（不是数组、行不是对象、名字 / 号码不是字符串）时只留能显示的
 * （10-22 夜测：服务端出错把类型写乱时，结果页对 .filter / 名字首字报错，整页「暂时无法显示」，人看不到短信发出去没有）
 */
export function smsRows<T extends Row>(
  notifications: readonly T[] | undefined,
): T[] {
  if (!Array.isArray(notifications)) return [];
  return notifications
    .filter((n) => typeof n === "object" && n !== null && n.channel === "sms")
    .map((n) => {
      const r = n as T & { contactName?: unknown; target?: unknown };
      const badName =
        r.contactName !== undefined &&
        r.contactName !== null &&
        typeof r.contactName !== "string";
      const badTarget = r.target !== undefined && typeof r.target !== "string";
      if (!badName && !badTarget) return n;
      return {
        ...r,
        ...(badName ? { contactName: null } : {}),
        ...(badTarget ? { target: "" } : {}),
      } as T;
    });
}

/**
 * 页面标题写哪一句：
 * - unknown：记录还没拿到（加载中或失败），不下结论；
 * - none：一条短信都没有 = 没有紧急联系人；
 * - sent：至少一位已经发出去了；
 * - sending：还没有发出去的，但有在发的；
 * - failed：全都没发出去。
 */
export type DeliveryState = "unknown" | "none" | "sent" | "sending" | "failed";

export function deliveryStateOf(
  notifications: readonly Row[] | undefined,
): DeliveryState {
  // 没拿到（或结构不对）不下结论
  if (!Array.isArray(notifications)) return "unknown";
  const sms = smsRows(notifications);
  if (sms.length === 0) return "none";
  if (sms.some((n) => n.status === "sent")) return "sent";
  // 契约外的状态值（服务端以后加了 queued 之类）按「还在发」算，不下失败结论（10-16 A3）
  if (sms.some((n) => n.status !== "failed")) return "sending";
  return "failed";
}

/**
 * 多久再看一次记录：没拿到、还有在发的 → 3 秒；有失败的（服务端会按退避重发）→ 10 秒；
 * 都发出去了、或本来就没有联系人 → 不再看。
 */
export function deliveryPollInterval(
  notifications: readonly Row[] | undefined,
): number | false {
  if (!Array.isArray(notifications)) return 3_000;
  const sms = smsRows(notifications);
  if (sms.some((n) => n.status !== "sent" && n.status !== "failed"))
    return 3_000;
  if (sms.some((n) => n.status === "failed")) return 10_000;
  return false;
}

/**
 * 求救记录详情页多久再看一次：
 * - 还没拿到记录（加载中 / 失败）：不排轮询——失败态有「重试」按钮，404 之类自己再拉也一样；
 * - pending（还在倒计时）：5 秒。WS 的 sos_update 会让它重拉，但推送会漏（断线、后台），状态自己走到终态要靠这里兜底；
 * - notified：看短信发出去没有，同倒计时页（deliveryPollInterval）；
 * - cancelled 和契约外的状态：终态，不再看。
 */
export function accidentPollInterval(
  detail:
    | (Pick<AccidentDetail, "status"> & { notifications?: readonly Row[] })
    | undefined,
): number | false {
  if (!detail) return false;
  if (detail.status === "pending") return 5_000;
  if (detail.status === "notified")
    return deliveryPollInterval(detail.notifications);
  return false;
}

/** 头像圆里写的那一个字：先去掉看不见的字符再按码点取第一个字（零宽开头不再是空白，ß 不再变 SS；10-16 A2） */
export function initialOf(name: string | null | undefined): string {
  return avatarInitial(name);
}
