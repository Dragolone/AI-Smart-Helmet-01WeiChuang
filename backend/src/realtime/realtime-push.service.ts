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
  WsVoiceTakenOverData,
} from '@helmet/shared';
import type { DeviceSnapshot } from '../devices/device-snapshot.service';
import { buildSummary } from '../events/event-wire';
import { businessTime } from '../common/device-time';
import type { StoredEnvelope } from '../ingest/envelope';
import { RealtimeGateway } from './realtime.gateway';

/** 事件 → §11 WS 消息的组装与投递：device_status / location_update / sos_update / risk_event / device_event */
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

  /** 本账号在另一台手机上进了对讲（决策 #62）：同账号的连接都发，发起的那台按 clientId 认出是自己、不理 */
  pushVoiceTakenOver(userId: string, data: WsVoiceTakenOverData): void {
    const message: WsMessage<WsVoiceTakenOverData> = {
      type: 'voice_taken_over',
      data,
      sentAt: new Date().toISOString(),
    };
    this.gateway.pushToUser(userId, message);
  }

  /** collision_risk / obstacle_risk / risk_cleared → 事件详情；当前危险状态由 App 从事件流推导（决策 #27） */
  pushRiskEvent(userId: string, e: StoredEnvelope): void {
    const message: WsMessage<WsRiskEventData> = {
      type: 'risk_event',
      data: { ...this.toEventItem(e), payload: e.payload, media: [] },
      sentAt: new Date().toISOString(),
    };
    this.gateway.pushToUser(userId, message);
  }

  /** sleep_* / bluetooth_lost / video_ready → 事件列表项 */
  pushDeviceEvent(userId: string, e: StoredEnvelope): void {
    const message: WsMessage<WsDeviceEventData> = {
      type: 'device_event',
      data: this.toEventItem(e),
      sentAt: new Date().toISOString(),
    };
    this.gateway.pushToUser(userId, message);
  }

  /** 与 GET /devices/{id}/events 的列表项同口径（event-wire toWireEventItem）：timestamp 是业务时间（决策 #59） */
  private toEventItem(e: StoredEnvelope) {
    return {
      eventId: e.eventId,
      deviceId: e.deviceId,
      eventType: e.eventType,
      timestamp: businessTime(e.timestamp, e.receivedAt).toISOString(),
      deviceTimestamp: e.timestamp.toISOString(),
      receivedAt: e.receivedAt.toISOString(),
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

  /** 推刚刷新过的设备快照（与 GET /devices/{id}/status 同一份数据）；刚收到事件即在线 */
  pushDeviceStatus(
    userId: string,
    deviceId: string,
    snapshot: DeviceSnapshot,
  ): void {
    const data: WsDeviceStatusData = {
      deviceId,
      online: true,
      lastSeenAt: (snapshot.lastSeenAt ?? new Date()).toISOString(),
      battery: snapshot.battery,
      charging: snapshot.charging,
      signalLevel: snapshot.signalLevel,
      sleeping: snapshot.sleeping,
      firmwareVersion: snapshot.firmwareVersion,
    };
    const message: WsMessage<WsDeviceStatusData> = {
      type: 'device_status',
      data,
      sentAt: new Date().toISOString(),
    };
    this.gateway.pushToUser(userId, message);
  }
}
