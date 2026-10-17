import { EVENT_TYPES, type EventType } from '@helmet/shared';
import type { EventDetail, EventListItem } from '@helmet/shared';
import type { RawEvent } from '../generated/prisma/client';

/** 校验失败事件在 raw_events 里的占位类型（Ingest 层约定），任何查询接口不得吐出 */
export const INVALID_EVENT_TYPE = '_invalid';

export const isKnownEventType = (t: string): t is EventType =>
  (EVENT_TYPES as readonly string[]).includes(t);

/**
 * 服务端一句话摘要（§6 列表项 summary）：给列表页兜底展示用；
 * App 有更好的本地化文案时可忽略本字段，客户端逻辑不得依赖其内容。
 */
export function buildSummary(
  eventType: string,
  payload: Record<string, unknown>,
): string {
  // payload 是设备 / 算法原样上报的：只插值字符串和数字。原来 String() 一个 {"toString":1} 会抛 TypeError，
  // 这一条之后用户与 Admin 的事件列表一读就 500，直到删掉这行（10-17 评审）
  const label = (v: unknown): string =>
    typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))
      ? String(v)
      : '';
  const level = label(payload.riskLevel);
  const direction = label(payload.direction);
  const risk = (name: string) =>
    `${name}${level ? ` ${level}` : ''}${direction ? `（${direction}）` : ''}`;
  switch (eventType) {
    case 'collision_risk':
      return risk('碰撞风险');
    case 'obstacle_risk':
      return risk('障碍物风险');
    case 'risk_cleared':
      return '危险解除';
    case 'possible_fall':
      return '疑似摔倒';
    case 'manual_sos':
      return '手动求救';
    case 'sleep_entered':
      return '进入休眠';
    case 'sleep_exited':
      return '退出休眠';
    case 'bluetooth_lost':
      return '与手机蓝牙断连';
    case 'video_ready':
      return '视频就绪';
    case 'device_status':
      return '状态心跳';
    case 'location_update':
      return '位置上报';
    default:
      return eventType;
  }
}

/**
 * timestamp 给的是业务时间（决策 #59）：设备时钟可信时就是设备时间，时钟错乱时是收到时间——与轨迹点同口径，
 * App 按它排序、分组、对到轨迹上；设备上报的原值放在 deviceTimestamp。
 */
export function toWireEventItem(e: RawEvent): EventListItem {
  return {
    eventId: e.eventId,
    deviceId: e.deviceId,
    eventType: e.eventType,
    timestamp: e.businessTime.toISOString(),
    deviceTimestamp: e.timestamp.toISOString(),
    receivedAt: e.receivedAt.toISOString(),
    summary: buildSummary(e.eventType, e.payload as Record<string, unknown>),
  };
}

export function toWireEventDetail(
  e: RawEvent,
  media: EventDetail['media'] = [],
): EventDetail {
  return {
    ...toWireEventItem(e),
    payload: e.payload as Record<string, unknown>,
    media,
  };
}
