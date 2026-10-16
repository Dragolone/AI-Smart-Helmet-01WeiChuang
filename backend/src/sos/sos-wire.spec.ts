// SOS 线上格式（API.md §7）：triggeredAt 缺省兼容、事故位置快照三要素齐全才算有位置、通知目标脱敏。
import type { SosCase, SosNotification } from '../generated/prisma/client';
import { toWireAccident, toWireNotification, toWireSos } from './sos-wire';

const base = {
  id: 's1',
  deviceId: 'helmet_001',
  userId: 'u1',
  triggerEventId: 'e1',
  triggerType: 'possible_fall',
  status: 'pending',
  deadline: new Date('2026-10-16T00:01:00Z'),
  createdAt: new Date('2026-10-16T00:00:00Z'),
  updatedAt: new Date('2026-10-16T00:00:00Z'),
  triggeredAt: null,
  latitude: null,
  longitude: null,
  coordinateSystem: null,
  accuracy: null,
  locationSource: null,
} as unknown as SosCase;

describe('toWireSos', () => {
  it('旧单没有 triggeredAt：不下发这个字段（App 不显示补传说明）；有就带 ISO', () => {
    expect(toWireSos(base)).not.toHaveProperty('triggeredAt');
    expect(
      toWireSos({ ...base, triggeredAt: new Date('2026-10-15T23:00:00Z') }),
    ).toMatchObject({ triggeredAt: '2026-10-15T23:00:00.000Z' });
  });
});

describe('toWireAccident', () => {
  it('坐标三要素缺一：location 为 null', () => {
    expect(toWireAccident(base).location).toBeNull();
    expect(
      toWireAccident({ ...base, latitude: 22.5, longitude: 114 }).location,
    ).toBeNull();
  });

  it('三要素齐全：带位置；locationSource 为空的旧单按 event 处理', () => {
    expect(
      toWireAccident({
        ...base,
        latitude: 22.5,
        longitude: 114,
        coordinateSystem: 'gcj02',
        accuracy: null,
      }).location,
    ).toEqual({
      latitude: 22.5,
      longitude: 114,
      coordinateSystem: 'gcj02',
      accuracy: null,
      source: 'event',
    });
    expect(
      toWireAccident({
        ...base,
        latitude: 0.1,
        longitude: 0.1,
        coordinateSystem: 'wgs84',
        accuracy: 8,
        locationSource: 'last_point',
      }).location?.source,
    ).toBe('last_point');
  });
});

describe('toWireNotification', () => {
  const n = {
    id: 'n1',
    sosId: 's1',
    channel: 'sms',
    target: '13800001111',
    contactName: '妈',
    status: 'sent',
    attempts: 1,
    lastError: null,
    sentAt: new Date('2026-10-16T00:02:00Z'),
    createdAt: new Date('2026-10-16T00:01:00Z'),
  } as unknown as SosNotification;

  it('短信目标打码，push 目标原样；未发送时 sentAt 为 null', () => {
    expect(toWireNotification(n)).toMatchObject({
      target: '138****1111',
      sentAt: '2026-10-16T00:02:00.000Z',
    });
    expect(
      toWireNotification({
        ...n,
        channel: 'push',
        target: 'user:u1',
        sentAt: null,
      }),
    ).toMatchObject({ target: 'user:u1', sentAt: null });
  });
});
