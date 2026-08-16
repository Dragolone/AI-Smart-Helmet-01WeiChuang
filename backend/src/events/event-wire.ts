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
  const p = payload as Record<string, string | number | undefined>;
  switch (eventType) {
    case 'collision_risk':
      return `碰撞风险${p.riskLevel ? ` ${String(p.riskLevel)}` : ''}${p.direction ? `（${String(p.direction)}）` : ''}`;
    case 'obstacle_risk':
      return `障碍物风险${p.riskLevel ? ` ${String(p.riskLevel)}` : ''}${p.direction ? `（${String(p.direction)}）` : ''}`;
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

export function toWireEventItem(e: RawEvent): EventListItem {
  return {
    eventId: e.eventId,
    deviceId: e.deviceId,
    eventType: e.eventType,
    timestamp: e.timestamp.toISOString(),
    receivedAt: e.receivedAt.toISOString(),
    summary: buildSummary(e.eventType, e.payload as Record<string, unknown>),
  };
}

export function toWireEventDetail(e: RawEvent): EventDetail {
  return {
    ...toWireEventItem(e),
    payload: e.payload as Record<string, unknown>,
    // 关联媒体随 §9 媒体模块落地（Week 9-10 PR-B）；Contract 字段先行，落地前恒为空
    media: [],
  };
}
