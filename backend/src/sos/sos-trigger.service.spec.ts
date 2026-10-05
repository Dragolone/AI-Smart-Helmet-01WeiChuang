import { maskPhone } from '../providers/sms.provider';
import { describeEventAge, extractSosLocation } from './sos-trigger.service';

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
