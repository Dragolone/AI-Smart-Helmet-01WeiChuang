// WS 五类消息的组装（API.md §11）：格式与投递对象。
import type { ValidEnvelope } from '../ingest/envelope';
import type { RealtimeGateway } from './realtime.gateway';
import { RealtimePushService } from './realtime-push.service';

describe('RealtimePushService', () => {
  const pushToUser = jest.fn();
  const svc = new RealtimePushService({
    pushToUser,
  } as unknown as RealtimeGateway);
  const e: ValidEnvelope = {
    schemaVersion: 1,
    eventId: 'e1',
    deviceId: 'helmet_001',
    eventType: 'collision_risk',
    timestamp: new Date('2026-10-16T00:00:00Z'),
    firmwareVersion: '1.0.0',
    payload: { riskLevel: 'high', direction: 'rear' },
  };
  beforeEach(() => pushToUser.mockReset());

  const sent = () =>
    pushToUser.mock.calls[0] as [string, Record<string, unknown>];

  it('device_status：刚收到事件即在线；快照没有 lastSeenAt 时用当下时间', () => {
    const before = Date.now();
    svc.pushDeviceStatus('u1', 'helmet_001', {
      lastSeenAt: null,
      battery: 50,
      charging: false,
      signalLevel: 3,
      sleeping: false,
      firmwareVersion: '1.0.0',
    } as never);
    const [userId, msg] = sent();
    expect(userId).toBe('u1');
    const data = msg.data as { online: boolean; lastSeenAt: string };
    expect(msg.type).toBe('device_status');
    expect(data.online).toBe(true);
    expect(Date.parse(data.lastSeenAt)).toBeGreaterThanOrEqual(before);
  });

  it('device_status：有 lastSeenAt 用快照里的', () => {
    svc.pushDeviceStatus('u1', 'helmet_001', {
      lastSeenAt: new Date('2026-10-16T00:00:05Z'),
      battery: null,
      charging: null,
      signalLevel: null,
      sleeping: false,
      firmwareVersion: null,
    } as never);
    expect((sent()[1].data as { lastSeenAt: string }).lastSeenAt).toBe(
      '2026-10-16T00:00:05.000Z',
    );
  });

  it('risk_event：详情级（带 payload、summary、空 media）', () => {
    svc.pushRiskEvent('u1', e);
    expect(sent()[1]).toMatchObject({
      type: 'risk_event',
      data: {
        eventId: 'e1',
        deviceId: 'helmet_001',
        eventType: 'collision_risk',
        timestamp: '2026-10-16T00:00:00.000Z',
        summary: '碰撞风险 high（rear）',
        payload: { riskLevel: 'high', direction: 'rear' },
        media: [],
      },
    });
  });

  it('device_event：列表项级（不带 payload）', () => {
    svc.pushDeviceEvent('u1', {
      ...e,
      eventType: 'bluetooth_lost',
      payload: {},
    });
    const data = sent()[1].data as Record<string, unknown>;
    expect(sent()[1].type).toBe('device_event');
    expect(data.summary).toBe('与手机蓝牙断连');
    expect(data).not.toHaveProperty('payload');
  });

  it('location_update / sos_update：数据原样包进消息', () => {
    const point = {
      latitude: 1,
      longitude: 2,
      coordinateSystem: 'wgs84',
      accuracy: 1,
      speed: 0,
      heading: 0,
      altitude: null,
      timestamp: 't',
      receivedAt: 'r',
    } as never;
    svc.pushLocation('u1', 'helmet_001', point);
    expect(sent()[1]).toMatchObject({
      type: 'location_update',
      data: { deviceId: 'helmet_001', latitude: 1, longitude: 2 },
    });
    pushToUser.mockReset();
    svc.pushSosUpdate('u1', { sosId: 's1' } as never);
    expect(sent()[1]).toMatchObject({
      type: 'sos_update',
      data: { sosId: 's1' },
    });
  });
});
