// 查询参数的年份下限：PostgreSQL timestamp 不收 0000 年（实测 date/time field value out of range），
// 这类值必须在校验层挡成 400，不能打到库上变 500。目前靠 class-validator 的 strict ISO 校验挡住，这里钉住。
import { isParsableIsoDateTime } from './iso-date';

describe('isParsableIsoDateTime：极端年份', () => {
  it.each([['0000-01-01T00:00:00Z'], ['0001-01-01T00:00:00Z']])(
    '%s → 拒绝（JS 能解析，但库存不下 / 校验器不认）',
    (v) => {
      expect(Number.isNaN(new Date(v).getTime())).toBe(false);
      expect(isParsableIsoDateTime(v)).toBe(false);
    },
  );

  it.each([
    ['1000-01-01T00:00:00Z'],
    ['1969-12-31T23:59:59Z'],
    ['9999-12-31T23:59:59Z'],
  ])('%s → 通过', (v) => {
    expect(isParsableIsoDateTime(v)).toBe(true);
  });

  it('带扩展年份写法（+275760）→ 拒绝', () => {
    expect(isParsableIsoDateTime('+275760-09-13T00:00:00Z')).toBe(false);
  });
});
