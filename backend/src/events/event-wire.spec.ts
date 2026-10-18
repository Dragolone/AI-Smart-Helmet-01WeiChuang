// 事件列表 summary（API.md §6）：每种 MVP 事件类型的中文摘要、危险事件的等级 / 方向拼接、未知类型原样回显。
import type { RawEvent } from '../generated/prisma/client';
import { buildSummary, toWireEventDetail, toWireEventItem } from './event-wire';

describe('buildSummary', () => {
  it.each([
    ['risk_cleared', '危险解除'],
    ['possible_fall', '疑似摔倒'],
    ['manual_sos', '手动求救'],
    ['sleep_entered', '进入休眠'],
    ['sleep_exited', '退出休眠'],
    ['bluetooth_lost', '与手机蓝牙断连'],
    ['video_ready', '视频就绪'],
    ['device_status', '状态心跳'],
    ['location_update', '位置上报'],
  ])('%s → %s', (type, text) => {
    expect(buildSummary(type, {})).toBe(text);
  });

  it('未知类型（如 _invalid / 新版本类型）：原样回显类型名', () => {
    expect(buildSummary('_invalid', {})).toBe('_invalid');
    expect(buildSummary('future_type', { a: 1 })).toBe('future_type');
  });

  it.each([
    ['collision_risk', '碰撞风险'],
    ['obstacle_risk', '障碍物风险'],
  ])('%s：等级与方向有就拼、没有就省', (type, head) => {
    expect(buildSummary(type, { riskLevel: 'high', direction: 'left' })).toBe(
      `${head} high（left）`,
    );
    expect(buildSummary(type, { riskLevel: 'low' })).toBe(`${head} low`);
    expect(buildSummary(type, { direction: 'front' })).toBe(`${head}（front）`);
    expect(buildSummary(type, {})).toBe(head);
    expect(buildSummary(type, { riskLevel: '', direction: '' })).toBe(head);
  });
});

describe('toWireEventItem / toWireEventDetail', () => {
  const row = {
    id: 'r1',
    eventId: 'e1',
    deviceId: 'helmet_001',
    eventType: 'obstacle_risk',
    timestamp: new Date('2026-10-16T00:00:00Z'),
    receivedAt: new Date('2026-10-16T00:00:01Z'),
    businessTime: new Date('2026-10-16T00:00:00Z'),
    payload: { riskLevel: 'medium' },
  } as unknown as RawEvent;

  it('列表项：时间转 ISO，带 summary，不带 payload', () => {
    expect(toWireEventItem(row)).toEqual({
      eventId: 'e1',
      deviceId: 'helmet_001',
      eventType: 'obstacle_risk',
      timestamp: '2026-10-16T00:00:00.000Z',
      deviceTimestamp: '2026-10-16T00:00:00.000Z',
      receivedAt: '2026-10-16T00:00:01.000Z',
      summary: '障碍物风险 medium',
    });
  });

  it('头盔时钟错乱：timestamp 给业务时间（决策 #59），设备原值放 deviceTimestamp', () => {
    const skewed = {
      ...row,
      timestamp: new Date('1970-01-01T00:00:10Z'),
      businessTime: new Date('2026-10-16T00:00:01Z'),
    };
    expect(toWireEventItem(skewed)).toMatchObject({
      timestamp: '2026-10-16T00:00:01.000Z',
      deviceTimestamp: '1970-01-01T00:00:10.000Z',
    });
  });

  it('详情：不传 media 时为空数组；传了原样带上', () => {
    expect(toWireEventDetail(row)).toMatchObject({
      payload: { riskLevel: 'medium' },
      media: [],
    });
    const media = [{ mediaId: 'm1' }] as never;
    expect(toWireEventDetail(row, media).media).toBe(media);
  });
});
