// 蓝牙版 App 中转入口（docs/API.md §12.1，决策 #29/#31）:App 替绑定设备批量提交事件。
// 未来 BLE 中转模块的正式通道;开发期也用它注入测试事件(与 MQTT 同 envelope 同幂等,
// 非 Mock 特殊逻辑——蓝牙版产品里事件本来就走这条路)。
import type {
  AppRelayRequest,
  AppRelayResponse,
  RelayAckRequest,
  RelayAckResponse,
} from '@helmet/shared';

import { api } from './client';

/** RFC4122 v4(Math.random 版):envelope.eventId 幂等去重用,开发触发场景强度足够 */
function uuid4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export const relayApi = {
  push: (body: AppRelayRequest) =>
    api<AppRelayResponse>('/ingest/app-relay', { method: 'POST', body }),

  /** BLE 下行命令回执（API.md §8,决策 #36）:幂等,重复/终态后提交返回当前状态不报错 */
  ack: (deviceId: string, commandId: string, body: RelayAckRequest) =>
    api<RelayAckResponse>(
      `/devices/${encodeURIComponent(deviceId)}/commands/${encodeURIComponent(commandId)}/relay-ack`,
      { method: 'POST', body },
    ),

  /** 便捷:构造单条合规 envelope 并提交(EVENTS.md §1) */
  pushEvent: (
    deviceId: string,
    eventType: string,
    payload: Record<string, unknown> = {},
  ) =>
    relayApi.push({
      deviceId,
      envelopes: [buildRelayEnvelope(deviceId, eventType, payload)],
    }),
};

/**
 * App 自己发起的事件（长按求救 / 开发注入）的 envelope。eventId 在这里定死：
 * 同一次动作重试必须复用同一个 eventId——服务端按它幂等；换了 eventId，倒计时中再来一条 manual_sos
 * 会被当成「倒计时中按实体键」直接跳过 60 秒通知联系人（10-06 不变式评审 F-5）
 */
export interface AppRelayEnvelope {
  schemaVersion: 1;
  eventId: string;
  deviceId: string;
  eventType: string;
  timestamp: string;
  firmwareVersion: string;
  payload: Record<string, unknown>;
}

export const buildRelayEnvelope = (
  deviceId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
): AppRelayEnvelope => ({
  schemaVersion: 1,
  eventId: uuid4(),
  deviceId,
  eventType,
  timestamp: new Date().toISOString(),
  firmwareVersion: 'app-relay-dev',
  payload,
});
