// splitRides / thin 的边角：没在骑时遇到断档、重复时间戳、抽稀到 1 个。
import { splitRides, thin } from './ride-split';

const T0 = Date.UTC(2026, 9, 16, 0, 0, 0);
const pt = (meters: number, atMs: number) => ({
  latitude: 22.5 + (meters / 100) * 0.0009,
  longitude: 114,
  speed: 0,
  timestamp: new Date(T0 + atMs),
});
const later = new Date(T0 + 48 * 3_600_000);

describe('splitRides：边角', () => {
  it('还没开始骑就断档 16 分钟（停着 → 断档 → 骑）：断档不影响后面那一趟', () => {
    const points = [
      pt(0, 0),
      pt(0, 30_000),
      // 断档 16 分钟
      pt(0, 30_000 + 16 * 60_000),
      pt(50, 30_000 + 16 * 60_000 + 10_000),
      pt(100, 30_000 + 16 * 60_000 + 20_000),
    ];
    expect(splitRides(points, later)).toEqual([
      { start: 2, end: 4, ongoing: false },
    ]);
  });

  it('相邻两点时间戳相同或倒退：跳过这一对，不算速度（防除零 / 负速度）', () => {
    const points = [
      pt(0, 0),
      pt(50, 10_000),
      pt(5_000, 10_000), // 同一时刻跳到 5 km 外：不能算成无穷大速度
      pt(100, 5_000), // 时间倒退
      pt(150, 30_000),
    ];
    const spans = splitRides(points, later);
    expect(spans).toHaveLength(1);
    expect(spans[0].start).toBe(0);
  });
});

describe('thin：边角', () => {
  it('max ≤ 1：只留第一个', () => {
    expect(thin([1, 2, 3], 1)).toEqual([1]);
    expect(thin([1, 2, 3], 0)).toEqual([1]);
  });

  it('不超过上限：原样复制（不是同一个数组）', () => {
    const src = [1, 2];
    const out = thin(src, 5);
    expect(out).toEqual([1, 2]);
    expect(out).not.toBe(src);
  });
});
