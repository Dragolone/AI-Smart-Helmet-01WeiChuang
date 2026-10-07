import type {
  AccidentListItem,
  AccidentLocation,
  CoordinateSystem,
  Sos,
  SosNotificationPublic,
  SosStatus,
  SosTriggerType,
} from '@helmet/shared';
import type { SosCase, SosNotification } from '../generated/prisma/client';
import { maskPhone } from '../providers/sms.provider';

/** DB 行 → API.md §7 sos 对象（App 按 deadline 本地倒计时渲染，不自行计时判断超时） */
export function toWireSos(c: SosCase): Sos {
  return {
    sosId: c.id,
    deviceId: c.deviceId,
    triggerEventId: c.triggerEventId,
    triggerType: c.triggerType as SosTriggerType,
    status: c.status as SosStatus,
    deadline: c.deadline.toISOString(),
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    // 10-07 新增可选字段：旧单为空时不下发，App 不显示那句补传说明（Contract：缺省兼容）
    ...(c.triggeredAt ? { triggeredAt: c.triggeredAt.toISOString() } : {}),
  };
}

/** DB 行 → 事故列表项（sos 对象 + 位置快照；快照三要素齐全才算有位置） */
export function toWireAccident(c: SosCase): AccidentListItem {
  const location: AccidentLocation | null =
    c.latitude !== null && c.longitude !== null && c.coordinateSystem !== null
      ? {
          latitude: c.latitude,
          longitude: c.longitude,
          coordinateSystem: c.coordinateSystem as CoordinateSystem,
          accuracy: c.accuracy,
          source: (c.locationSource ?? 'event') as AccidentLocation['source'],
        }
      : null;
  return { ...toWireSos(c), location };
}

/** DB 行 → 通知发送记录；target 出接口前脱敏（手机号打码，push 目标无敏感信息） */
export function toWireNotification(n: SosNotification): SosNotificationPublic {
  return {
    id: n.id,
    channel: n.channel as SosNotificationPublic['channel'],
    target: n.channel === 'sms' ? maskPhone(n.target) : n.target,
    contactName: n.contactName,
    status: n.status as SosNotificationPublic['status'],
    attempts: n.attempts,
    lastError: n.lastError,
    sentAt: n.sentAt ? n.sentAt.toISOString() : null,
    createdAt: n.createdAt.toISOString(),
  };
}
