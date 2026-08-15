import { maskPhone } from '../providers/sms.provider';
import { extractSosLocation } from './sos-trigger.service';

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
