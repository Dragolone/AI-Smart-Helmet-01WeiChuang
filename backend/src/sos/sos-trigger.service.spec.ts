import { maskPhone } from '../providers/sms.provider';
import {
  createdPushBody,
  describeEventAge,
  extractSosLocation,
} from './sos-trigger.service';

describe('describeEventAge（补传事件给本人的时间说明，决策 #52）', () => {
  const now = Date.UTC(2026, 9, 3, 6, 0, 0);
  const ago = (ms: number): Date => new Date(now - ms);
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  it.each([
    ['刚发生', 0],
    ['4 分 59 秒前（不到时钟偏移阈值）', 5 * MIN - 1000],
    ['事件时间在未来（头盔时钟快了）', -10 * MIN],
  ])('%s → 不加说明', (_name, ageMs) => {
    expect(describeEventAge(ago(ageMs), now)).toBeNull();
  });

  it.each([
    [5 * MIN, '约 5 分钟前'],
    [12 * MIN, '约 12 分钟前'],
    [89 * MIN, '约 89 分钟前'],
    [90 * MIN, '约 2 小时前'],
    [3 * HOUR, '约 3 小时前'],
    [47.6 * HOUR, '约 48 小时前'],
    [72 * HOUR, '约 72 小时前'],
  ])('%d 毫秒前 → %s', (ageMs, text) => {
    expect(describeEventAge(ago(ageMs), now)).toBe(text);
  });

  it.each([
    ['超过离线缓存能保留的范围（72 小时多 1 秒）', 72 * HOUR + 1000],
    ['头盔时钟回到 2000 年', now - Date.UTC(2000, 0, 1)],
    ['时间戳是 epoch', now],
  ])('%s → 不加说明（时钟不可信，不诱导本人取消）', (_name, ageMs) => {
    expect(describeEventAge(ago(ageMs), now)).toBeNull();
  });
});

describe('createdPushBody（「SOS 倒计时已开始」正文，秒数按 deadline 现算）', () => {
  const now = Date.UTC(2026, 9, 14, 6, 0, 0);
  const deadline = new Date(now + 60_000);

  it('建单当下发：写满 60 秒', () => {
    expect(
      createdPushBody(
        'helmet_001',
        'possible_fall',
        new Date(now),
        deadline,
        now,
      ),
    ).toBe('头盔 helmet_001 检测到疑似摔倒，未取消将于 60 秒后通知紧急联系人');
  });

  it('首投超时后第三次重试（约 45 秒后）：只剩 15 秒就写 15 秒，不再写 60', () => {
    const body = createdPushBody(
      'helmet_001',
      'manual_sos',
      new Date(now),
      deadline,
      now + 45_000,
    );
    expect(body).toBe(
      '头盔 helmet_001 触发手动求救，未取消将于 15 秒后通知紧急联系人',
    );
  });

  it('补传旧事件：带「多久之前」说明', () => {
    expect(
      createdPushBody(
        'helmet_001',
        'possible_fall',
        new Date(now - 3 * 3_600_000),
        deadline,
        now,
      ),
    ).toContain('（约 3 小时前的事件，刚补传到）');
  });

  it('已到期：不再发（到期通知归扫描任务）', () => {
    expect(
      createdPushBody(
        'helmet_001',
        'possible_fall',
        new Date(now),
        deadline,
        now + 60_000,
      ),
    ).toBeNull();
  });
});

describe('extractSosLocation（EVENTS.md 4.3/4.4 位置快照校验）', () => {
  const valid = {
    latitude: 40.949,
    longitude: 115.418,
    coordinateSystem: 'wgs84',
    accuracy: 8,
  };

  it('合法完整快照 → 原样提取', () => {
    expect(extractSosLocation({ location: valid })).toEqual(valid);
  });

  it('精确 (0,0) 是「没定到位」的哨兵 → 按缺失处理（回落最新轨迹点），不钉在赤道上', () => {
    expect(
      extractSosLocation({
        location: { latitude: 0, longitude: 0, coordinateSystem: 'wgs84' },
      }),
    ).toBeNull();
    // 只有一个为 0 是合法坐标（赤道 / 本初子午线上确有陆地）
    expect(
      extractSosLocation({
        location: { latitude: 0, longitude: 103.8, coordinateSystem: 'wgs84' },
      }),
    ).toMatchObject({ latitude: 0, longitude: 103.8 });
  });

  it('最小快照（无 accuracy）→ accuracy 为 null', () => {
    const minimal = {
      latitude: valid.latitude,
      longitude: valid.longitude,
      coordinateSystem: valid.coordinateSystem,
    };
    expect(extractSosLocation({ location: minimal })).toEqual({
      ...minimal,
      accuracy: null,
    });
  });

  it('accuracy 非法（负数/非数值）→ 仅丢 accuracy 不丢整个快照', () => {
    expect(
      extractSosLocation({ location: { ...valid, accuracy: -1 } }),
    ).toEqual({ ...valid, accuracy: null });
    expect(
      extractSosLocation({ location: { ...valid, accuracy: 'high' } }),
    ).toEqual({ ...valid, accuracy: null });
  });

  it.each([
    ['缺 location', {}],
    ['location 非对象', { location: 'somewhere' }],
    ['location 为 null', { location: null }],
    ['纬度越界', { location: { ...valid, latitude: 91 } }],
    ['经度越界', { location: { ...valid, longitude: -181 } }],
    ['纬度非数值', { location: { ...valid, latitude: 'NaN' } }],
    ['坐标系非法', { location: { ...valid, coordinateSystem: 'bd09' } }],
    ['坐标系缺失', { location: { ...valid, coordinateSystem: undefined } }],
  ])('%s → null（回落最新轨迹点由上层负责）', (_name, payload) => {
    expect(extractSosLocation(payload as Record<string, unknown>)).toBeNull();
  });
});

describe('maskPhone（日志脱敏）', () => {
  it('常规手机号保首 3 尾 4', () => {
    expect(maskPhone('13800001111')).toBe('138****1111');
  });

  it('异常短值不越界', () => {
    expect(maskPhone('123')).toBe('1****');
  });
});
