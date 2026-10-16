// 与 App 的 cleanHelmetName 同一套用例（app/src/services/__tests__/edge-helmet-name.test.ts），两端整理结果必须一致。
// 看不见的字符一律写成 \u 转义，源码里不放原字符
import { cleanDisplayName, cleanName, cleanNameOrNull } from './display-name';

describe('cleanDisplayName：整理成一行', () => {
  it('换行名压成一行', () => {
    expect(cleanDisplayName('第一行\n第二行\n第三行')).toBe(
      '第一行 第二行 第三行',
    );
    expect(cleanDisplayName('第一行\r\n第二行')).toBe('第一行 第二行');
  });

  it('首尾空白去掉，中间连续的空白（含制表、全角空格、不换行空格）压成一个空格', () => {
    expect(cleanDisplayName('  我的  头盔  ')).toBe('我的 头盔');
    expect(cleanDisplayName('我的\t\t头盔')).toBe('我的 头盔');
    expect(cleanDisplayName('我的\u3000头盔')).toBe('我的 头盔');
    expect(cleanDisplayName('我的\u00A0\u00A0头盔')).toBe('我的 头盔');
  });

  it('字中间夹着的零宽字符 / 方向控制符去掉，字照留', () => {
    expect(cleanDisplayName('我\u200B的\u200E头\u202E盔\uFEFF')).toBe(
      '我的头盔',
    );
    expect(cleanDisplayName('\u200B\u200B 头盔 \u200B')).toBe('头盔');
    expect(cleanDisplayName('A \u200B B')).toBe('A B');
  });

  it.each([
    ['\u200B'],
    ['\u200B\u200C\uFEFF'],
    [' \n\t '],
    ['\u3164'],
    ['\u2800'],
    ['\u200D'],
    ['\u0000\u0007'],
  ])('只含看不见的字符 / 空白 %j → 空串', (raw) => {
    expect(cleanDisplayName(raw)).toBe('');
  });

  it('表情组合要用的零宽连接符和变体选择符保留', () => {
    expect(cleanDisplayName('👨\u200D💻的头盔')).toBe('👨\u200D💻的头盔');
    expect(cleanDisplayName('❤\uFE0F')).toBe('❤\uFE0F');
    expect(cleanDisplayName('🏍\uFE0F 头盔')).toBe('🏍\uFE0F 头盔');
  });

  it('零宽连接符落在开头、结尾或空格旁边没有作用，去掉', () => {
    expect(cleanDisplayName('\u200D头盔\u200D')).toBe('头盔');
    expect(cleanDisplayName('头盔 \u200D\u200D 二号')).toBe('头盔 二号');
    expect(cleanDisplayName('\uFE0F头盔')).toBe('头盔');
  });

  it('幂等；结果里不再有换行、制表或任何看不见的字符', () => {
    for (const raw of [
      '第一行\n第二行',
      ' \u200B我的 \u2060 头盔\t',
      '👨\u200D💻',
      '\u200B\u200B',
    ]) {
      const once = cleanDisplayName(raw);
      expect(cleanDisplayName(once)).toBe(once);
    }
    expect(
      cleanDisplayName(
        '\u0001A\u0002\n\u200B B\u00AD\u2060\u2066C\u2069\uFEFF\u3164',
      ),
    ).toBe('A BC');
  });
});

describe('@Transform 用的两个包装', () => {
  it('cleanName：字符串整理；非字符串原样交给 @IsString', () => {
    expect(cleanName({ value: ' a\nb ' })).toBe('a b');
    expect(cleanName({ value: '\u200B' })).toBe('');
    expect(cleanName({ value: 42 })).toBe(42);
    expect(cleanName({ value: null })).toBeNull();
    expect(cleanName({ value: undefined })).toBeUndefined();
  });

  it('cleanNameOrNull：整理完为空 → null', () => {
    expect(cleanNameOrNull({ value: ' a\nb ' })).toBe('a b');
    expect(cleanNameOrNull({ value: '\u200B\n' })).toBeNull();
    expect(cleanNameOrNull({ value: 7 })).toBe(7);
  });
});
