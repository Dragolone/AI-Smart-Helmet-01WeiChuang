// 10-17 后端评审数据接入一路的单测：瞬时数据库错误不能把求救改记成无效、时间换算到 UTC 后的年份、
// 分钟级时间（观察项 10）、补传判定（观察项 16）、风险摘要只插值字符串 / 数字。
import { Prisma } from '../generated/prisma/client';
import { isBackfill } from '../common/device-time';
import { buildSummary } from '../events/event-wire';
import { validateEnvelope } from './envelope';
import { dbRejectionCode } from './ingest.service';

const adapterError = (code: string, sqlState?: string) =>
  new Prisma.PrismaClientKnownRequestError('db error', {
    code,
    clientVersion: 'test',
    meta: sqlState
      ? { driverAdapterError: { cause: { originalCode: sqlState } } }
      : undefined,
  });

describe('dbRejectionCode：只有「这条数据被拒」才按 _invalid 留档', () => {
  it.each([
    ['后端被杀 57P01', adapterError('P2039', '57P01')],
    ['死锁 40P01', adapterError('P2039', '40P01')],
    ['语句超时 57014', adapterError('P2039', '57014')],
    ['锁超时 55P03', adapterError('P2039', '55P03')],
    ['连接断开 08006', adapterError('P2039', '08006')],
    ['连接数满（P2037）', adapterError('P2037')],
    ['写冲突（P2034）', adapterError('P2034')],
    ['驱动适配器错误（P2036）', adapterError('P2036')],
    ['连接池超时（P2024）', adapterError('P2024')],
    ['连不上库（P1001）', adapterError('P1001')],
  ])(
    '%s → null（重抛、入口 5xx 让 App / MQTT 重试，不能把摔倒改记成无效）',
    (_n, err) => {
      expect(dbRejectionCode(err)).toBeNull();
    },
  );

  it.each([
    ['值超列长度 P2000', adapterError('P2000'), 'P2000'],
    ['非法值 P2007', adapterError('P2007'), 'P2007'],
    ['数据异常 22P02（P2039）', adapterError('P2039', '22P02'), 'P2039'],
    ['索引行太大 54000（P2039）', adapterError('P2039', '54000'), 'P2039'],
  ])(
    '%s → 原因码（这条数据本身入不了库，按 _invalid 留档）',
    (_n, err, code) => {
      expect(dbRejectionCode(err)).toBe(code);
    },
  );

  it('普通 JS 错误 → null', () => {
    expect(dbRejectionCode(new Error('boom'))).toBeNull();
  });
});

describe('validateEnvelope：时间与 eventId 边界', () => {
  const envelope = (over: Record<string, unknown>) =>
    JSON.stringify({
      schemaVersion: 1,
      eventId: 'e1',
      deviceId: 'helmet_001',
      eventType: 'possible_fall',
      timestamp: '2026-10-15T03:00:00Z',
      firmwareVersion: '1.0.0',
      payload: {},
      ...over,
    });
  const reason = (over: Record<string, unknown>) => {
    const r = validateEnvelope(envelope(over), 'helmet_001');
    return r.ok ? 'ok' : r.reason;
  };

  it.each([['9999-12-31T24:00:00Z'], ['9999-12-31T23:59:59-01:00']])(
    '%s 换算到 UTC 是 10000 年 → 无效（原来照收，读回 Invalid Date 后列表一读就 500）',
    (timestamp) => {
      expect(reason({ timestamp })).toBe('timestamp_out_of_range');
    },
  );

  it('9999-12-31T23:59:59Z 仍在范围内', () => {
    expect(reason({ timestamp: '9999-12-31T23:59:59Z' })).toBe('ok');
  });

  it('只到分钟、带时区（ISO 8601 允许省略秒，观察项 10）→ 接受', () => {
    expect(reason({ timestamp: '2026-10-15T03:00Z' })).toBe('ok');
    expect(reason({ timestamp: '2026-10-15T11:00+08:00' })).toBe('ok');
    expect(reason({ timestamp: '2026-10-15T03:00' })).toBe(
      'timestamp_not_iso8601_with_timezone',
    );
  });
});

describe('isBackfill（补传的旧事件不刷新快照、不当实时推）', () => {
  const now = new Date('2026-10-17T12:00:00Z');
  it('设备时间比收到时早 5 分钟以上 → 补传', () => {
    expect(isBackfill(new Date('2026-10-17T10:00:00Z'), now)).toBe(true);
    expect(isBackfill(new Date('2026-10-17T11:54:59Z'), now)).toBe(true);
  });
  it('刚发生 / 设备时钟错乱（已按收到时间兜底）→ 不是补传', () => {
    expect(isBackfill(new Date('2026-10-17T11:59:00Z'), now)).toBe(false);
    expect(isBackfill(new Date('1970-01-01T00:00:10Z'), now)).toBe(false);
    expect(isBackfill(new Date('2099-01-01T00:00:00Z'), now)).toBe(false);
  });
});

describe('buildSummary：payload 里不是字符串 / 数字的值不插值', () => {
  it('{"toString":1} 这类对象不再让列表 500；数字照常显示', () => {
    expect(() =>
      buildSummary('collision_risk', {
        riskLevel: { toString: 1 },
        direction: ['rear'],
      }),
    ).not.toThrow();
    expect(buildSummary('collision_risk', { riskLevel: { toString: 1 } })).toBe(
      '碰撞风险',
    );
    expect(
      buildSummary('obstacle_risk', { riskLevel: 2, direction: 'front' }),
    ).toBe('障碍物风险 2（front）');
  });
});
