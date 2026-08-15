import { Injectable } from '@nestjs/common';
import type {
  DeviceStatusPayload,
  LocationPoint as WireLocationPoint,
  WsDeviceStatusData,
  WsLocationData,
  WsMessage,
} from '@helmet/shared';
import type { ValidEnvelope } from '../ingest/envelope';
import { RealtimeGateway } from './realtime.gateway';

/** 事件 → §11 WS 消息的组装与投递；本期实现 device_status / location_update 两类（其余随对应功能加） */
@Injectable()
export class RealtimePushService {
  constructor(private readonly gateway: RealtimeGateway) {}

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
    // 设备输入不可信：逐字段收敛为 §4 status 对象；刚收到事件即在线
    const p = e.payload as Partial<DeviceStatusPayload>;
    const data: WsDeviceStatusData = {
      deviceId: e.deviceId,
      online: true,
      lastSeenAt: new Date().toISOString(),
      battery: typeof p.battery === 'number' ? p.battery : null,
      charging: typeof p.charging === 'boolean' ? p.charging : null,
      signalLevel: typeof p.signalLevel === 'number' ? p.signalLevel : null,
      sleeping: typeof p.sleeping === 'boolean' ? p.sleeping : false,
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
