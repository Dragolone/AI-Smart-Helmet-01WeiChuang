import { validateSync } from 'class-validator';
import { IsIsoDateTime, isParsableIsoDateTime } from './iso-date';

class Query {
  @IsIsoDateTime()
  from!: string;
}

const errorsFor = (from: unknown) =>
  validateSync(Object.assign(new Query(), { from }));

describe('IsIsoDateTime（查询参数时间）', () => {
  it.each([
    '2026-10-14T00:00:00Z',
    '2026-10-14T08:00:00+08:00',
    '2026-10-14T00:00:00.123Z',
    '2026-10-14',
  ])('%s → 通过', (value) => {
    expect(isParsableIsoDateTime(value)).toBe(true);
    expect(errorsFor(value)).toHaveLength(0);
  });

  it.each([
    ['紧凑写法', '20261007'],
    ['周日期', '2026-W41'],
    ['序数日期', '2026-280'],
    ['紧凑日期时间', '20261007T000000Z'],
    ['不存在的日期', '2026-02-30T00:00:00Z'],
    ['非字符串', 20261007],
  ])(
    '%s %s → 拒绝（IsISO8601 会放过前四种，new Date() 却解析不了）',
    (_name, value) => {
      expect(isParsableIsoDateTime(value)).toBe(false);
      expect(errorsFor(value)).toHaveLength(1);
    },
  );
});
