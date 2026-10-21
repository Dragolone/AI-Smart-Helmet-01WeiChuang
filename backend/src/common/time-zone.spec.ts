import { normalizeTimeZone } from './time-zone';

describe('normalizeTimeZone（X-Client-Timezone，O13）', () => {
  it('合法 IANA 名：按 Intl 规范化后返回', () => {
    expect(normalizeTimeZone('Asia/Shanghai')).toBe('Asia/Shanghai');
    expect(normalizeTimeZone('Australia/Sydney')).toBe('Australia/Sydney');
    expect(normalizeTimeZone('asia/shanghai')).toBe('Asia/Shanghai');
    expect(normalizeTimeZone('UTC')).toBe('UTC');
    expect(normalizeTimeZone('Etc/GMT-8')).toBe('Etc/GMT-8');
  });

  it('不合法、没带、带了多个、太长、带奇怪字符：null（不报错）', () => {
    for (const raw of [
      undefined,
      null,
      '',
      'Mars/Base',
      'Asia/Shanghai, Asia/Tokyo',
      ['Asia/Shanghai'],
      'A'.repeat(65),
      '+08:00',
      'Asia/Shanghai\n',
      '../../etc/passwd',
      42,
    ]) {
      expect(normalizeTimeZone(raw)).toBeNull();
    }
  });
});
