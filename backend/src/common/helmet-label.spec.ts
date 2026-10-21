import { helmetLabel, pushAtPhrase } from './helmet-label';

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
  it('整理规则上线前存下的旧名字：只含零宽字符用编号，带换行压成一行（推送标题不断行）', () => {
    expect(
      helmetLabel({ name: '\u200b\ufeff', deviceId: 'helmet_f8b262' }),
    ).toBe('helmet_f8b262');
    expect(helmetLabel({ name: 'a\nb', deviceId: 'helmet_f8b262' })).toBe(
      'a b',
    );
  });
});

describe('pushAtPhrase（推送里的「已于 HH:mm 」：按用户时区，没有时写明北京时间，O13）', () => {
  const at = new Date('2026-10-15T09:48:24.506Z');
  it('没有时区：按北京时间并写明「北京时间」；跨日不出错', () => {
    expect(pushAtPhrase(at)).toBe('已于北京时间 17:48 ');
    expect(pushAtPhrase(new Date('2026-10-15T16:05:00.000Z'), null)).toBe(
      '已于北京时间 00:05 ',
    );
  });
  it('有时区：写当地时间、不加说明（含半小时时区、跨日、夏令时）', () => {
    expect(pushAtPhrase(at, 'Asia/Shanghai')).toBe('已于 17:48 ');
    expect(pushAtPhrase(at, 'Australia/Sydney')).toBe('已于 20:48 ');
    expect(pushAtPhrase(at, 'Asia/Kolkata')).toBe('已于 15:18 ');
    expect(pushAtPhrase(at, 'America/Los_Angeles')).toBe('已于 02:48 ');
    expect(
      pushAtPhrase(new Date('2026-01-15T09:48:00Z'), 'Australia/Sydney'),
    ).toBe('已于 20:48 ');
    expect(
      pushAtPhrase(new Date('2026-07-15T09:48:00Z'), 'Australia/Sydney'),
    ).toBe('已于 19:48 ');
  });
  it('时区运行环境不认（库里是旧值等）：退回北京时间', () => {
    expect(pushAtPhrase(at, 'Mars/Base')).toBe('已于北京时间 17:48 ');
  });
  it('没有时间：空串', () => {
    expect(pushAtPhrase(null, 'Asia/Shanghai')).toBe('');
    expect(pushAtPhrase(undefined)).toBe('');
  });
});
