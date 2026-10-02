import {
  CLOCK_SKEW_THRESHOLD_MS,
  latestPlausibleTime,
  parseDeviceTime,
} from './device-time';

describe('parseDeviceTime（设备/App 转报时间戳的入库前收敛）', () => {
  it.each([
    ['1970-01-01T00:00:00Z'],
    ['2026-10-03T02:00:00.123Z'],
    ['2026-10-03T10:00:00+08:00'],
    ['9999-12-31T23:59:59Z'],
  ])('可入库范围内原样解析：%s', (iso) => {
    expect(parseDeviceTime(iso)?.getTime()).toBe(new Date(iso).getTime());
  });

  it.each([
    ['年份 0000（JS 合法、PostgreSQL 拒收）', '0000-01-01T00:00:00Z'],
    ['epoch 之前', '1969-12-31T23:59:59Z'],
    ['五位数年份', '+010000-01-01T00:00:00Z'],
    ['公元前', '-000001-01-01T00:00:00Z'],
    ['不存在的月份', '2026-13-45T99:99:99Z'],
    ['非日期文本', 'not-a-date'],
    ['空串', ''],
  ])('%s → null（调用方取服务器时间）', (_, iso) => {
    expect(parseDeviceTime(iso)).toBeNull();
  });

  it.each([[undefined], [null], [123], [{}], [new Date()]])(
    '非字符串 %p → null',
    (value) => {
      expect(parseDeviceTime(value)).toBeNull();
    },
  );
});

describe('latestPlausibleTime', () => {
  it('= 当前时间 + 时钟偏移阈值', () => {
    const before = Date.now();
    const bound = latestPlausibleTime().getTime();
    expect(bound).toBeGreaterThanOrEqual(before + CLOCK_SKEW_THRESHOLD_MS);
    expect(bound).toBeLessThanOrEqual(Date.now() + CLOCK_SKEW_THRESHOLD_MS);
  });
});
