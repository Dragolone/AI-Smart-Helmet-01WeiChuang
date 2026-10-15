import { helmetLabel, pushClock } from './helmet-label';

describe('helmetLabel（给用户看的头盔称呼：有名字用名字）', () => {
  it('起过名用名字', () => {
    expect(helmetLabel({ name: '测试头盔1', deviceId: 'helmet_94173f' })).toBe(
      '测试头盔1',
    );
  });
  it('没起名 / 只有空白：用设备编号', () => {
    expect(helmetLabel({ name: null, deviceId: 'helmet_f8b262' })).toBe(
      'helmet_f8b262',
    );
    expect(helmetLabel({ name: '   ', deviceId: 'helmet_f8b262' })).toBe(
      'helmet_f8b262',
    );
    expect(helmetLabel({ deviceId: 'helmet_f8b262' })).toBe('helmet_f8b262');
  });
});

describe('pushClock（推送里的时刻：北京时间 HH:mm）', () => {
  it('UTC 09:48 → 北京 17:48；跨日不出错', () => {
    expect(pushClock(new Date('2026-10-15T09:48:24.506Z'))).toBe('17:48');
    expect(pushClock(new Date('2026-10-15T16:05:00.000Z'))).toBe('00:05');
  });
  it('没有时间：空串', () => {
    expect(pushClock(null)).toBe('');
  });
});
