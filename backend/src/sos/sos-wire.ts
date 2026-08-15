import type { Sos, SosStatus, SosTriggerType } from '@helmet/shared';
import type { SosCase } from '../generated/prisma/client';

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
  };
}
