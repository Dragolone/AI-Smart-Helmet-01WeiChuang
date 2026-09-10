import { Injectable } from '@nestjs/common';
import type {
  LocationPoint as WireLocationPoint,
  Sos,
  WsDeviceEventData,
  WsDeviceStatusData,
  WsLocationData,
  WsMessage,
  WsRiskEventData,
  WsSosData,
} from '@helmet/shared';
import { normalizeDeviceStatus } from '../devices/device-snapshot.service';
import { buildSummary } from '../events/event-wire';
import type { ValidEnvelope } from '../ingest/envelope';
import { RealtimeGateway } from './realtime.gateway';

/** 事件 → §11 WS 消息的组装与投递；已实现 device_status / location_update / sos_update（其余随对应功能加） */
@Injectable()
export class RealtimePushService {
  constructor(private readonly gateway: RealtimeGateway) {}

  /** SOS 创建/取消/确认/超时通知四个时机都推（API.md §11） */
  pushSosUpdate(userId: string, sos: Sos): void {
    const message: WsMessage<WsSosData> = {
      type: 'sos_update',
      data: sos,
      sentAt: new Date().toISOString(),
    };
    this.gateway.pushToUser(userId, message);
  }

  /** collision_risk / obstacle_risk / risk_cleared → 事件详情；当前危险状态由 App 从事件流推导（决策 #27） */
  pushRiskEvent(userId: string, e: ValidEnvelope): void {
    const message: WsMessage<WsRiskEventData> = {
      type: 'risk_event',
      data: { ...this.toEventItem(e), payload: e.payload, media: [] },
      sentAt: new Date().toISOString(),
    };
    this.gateway.pushToUser(userId, message);
  }

  /** sleep_* / bluetooth_lost / video_ready → 事件列表项 */
  pushDeviceEvent(userId: string, e: ValidEnvelope): void {
    const message: WsMessage<WsDeviceEventData> = {
      type: 'device_event',
      data: this.toEventItem(e),
      sentAt: new Date().toISOString(),
    };
    this.gateway.pushToUser(userId, message);
  }

  private toEventItem(e: ValidEnvelope) {
    return {
      eventId: e.eventId,
      deviceId: e.deviceId,
      eventType: e.eventType,
      timestamp: e.timestamp.toISOString(),
      // WS 推送发生在入库后一瞬间，receivedAt 以当下时间为准（与落库值毫秒级差异，展示无感）
      receivedAt: new Date().toISOString(),
      summary: buildSummary(e.eventType, e.payload),
    };
  }

  pushLocation(
    userId: string,
    deviceId: string,
    point: WireLocationPoint,
  ): void {
    const message: WsMessage<WsLocationData> = {
      type: 'location_update',
      data: { deviceId, ...point },
      sentAt: new Date().toISOString(),
    };
    this.gateway.pushToUser(userId, message);
  }

  pushDeviceStatus(userId: string, e: ValidEnvelope): void {
    // 设备输入不可信：与快照同一套收敛规则（值域外字段按缺失）；刚收到事件即在线
    const p = normalizeDeviceStatus(e.payload);
    const data: WsDeviceStatusData = {
      deviceId: e.deviceId,
      online: true,
      lastSeenAt: new Date().toISOString(),
      battery: p.battery ?? null,
      charging: p.charging ?? null,
      signalLevel: p.signalLevel ?? null,
      sleeping: p.sleeping ?? false,
      firmwareVersion: e.firmwareVersion,
    };
    const message: WsMessage<WsDeviceStatusData> = {
      type: 'device_status',
      data,
      sentAt: new Date().toISOString(),
    };
    this.gateway.pushToUser(userId, message);
  }
}
