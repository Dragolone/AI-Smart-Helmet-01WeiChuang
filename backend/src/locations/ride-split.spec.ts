import { RIDE_BREAK_MS, splitRides, thin } from './ride-split';

const T0 = Date.UTC(2026, 9, 7, 0, 0, 0);
const MIN = 60_000;
/** 纬度每 0.0009° ≈ 100 m */
const pt = (meters: number, atMs: number) => ({
  latitude: 22.5 + (meters / 100) * 0.0009,
  longitude: 114,
  speed: 0,
  timestamp: new Date(T0 + atMs),
});
/** 从 fromMs 起每 10 s 一个点、每步 50 m（5 m/s），共 n 个点，起点在 startM 米处 */
const moving = (fromMs: number, n: number, startM = 0) =>
  Array.from({ length: n }, (_, i) => pt(startM + i * 50, fromMs + i * 10_000));
/** 停着不动：从 fromMs 起每 30 s 一个点，共 n 个，都在 atM 米处 */
const parked = (fromMs: number, n: number, atM: number) =>
  Array.from({ length: n }, (_, i) => pt(atM, fromMs + i * 30_000));
const longAfter = new Date(T0 + 48 * 60 * MIN);

describe('splitRides', () => {
  it('没有点、只有一个点、一直没动：都没有行程', () => {
    expect(splitRides([], longAfter)).toEqual([]);
    expect(splitRides([pt(0, 0)], longAfter)).toEqual([]);
    expect(splitRides(parked(0, 40, 0), longAfter)).toEqual([]);
  });

  it('一段连续的运动是一趟', () => {
    const points = moving(0, 10);
    expect(splitRides(points, longAfter)).toEqual([
      { start: 0, end: 9, ongoing: false },
    ]);
  });

  it('路口停一会儿（不满 15 分钟）不切开', () => {
    const a = moving(0, 6); // 0–50 s
    const stop = parked(60_000, 20, 250); // 停 10 分钟
    const b = moving(60_000 + 20 * 30_000, 6, 250);
    const points = [...a, ...stop, ...b];
    expect(splitRides(points, longAfter)).toEqual([
      { start: 0, end: points.length - 1, ongoing: false },
    ]);
  });

  it('停住超过 15 分钟：上一趟结束在最后一个在动的点，再动起来是新的一趟', () => {
    const a = moving(0, 6); // 最后一个在动的点下标 5
    const stop = parked(60_000, 40, 250); // 停 20 分钟（头盔开着，每 30 s 仍在报点）
    const bFrom = 60_000 + 40 * 30_000;
    const b = moving(bFrom, 6, 250);
    const points = [...a, ...stop, ...b];
    const spans = splitRides(points, longAfter);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toEqual({ start: 0, end: 5, ongoing: false });
    // 新的一趟从再动起来的那一步的起点开始（这里是 b 的第一个点：它和停着的位置相同）
    expect(spans[1].start).toBe(a.length + stop.length);
    expect(spans[1].end).toBe(points.length - 1);
  });

  it('断档超过 15 分钟（关机、没信号）：切成两趟，断档不算进任何一趟', () => {
    const a = moving(0, 6);
    const b = moving(RIDE_BREAK_MS + 2 * MIN, 6, 5_000);
    const spans = splitRides([...a, ...b], longAfter);
    expect(spans).toEqual([
      { start: 0, end: 5, ongoing: false },
      { start: 6, end: 11, ongoing: false },
    ]);
  });

  it('定位漂移（隐含速度离谱）不算在动', () => {
    // 两个点之间 10 s 跳了 100 km
    const points = [pt(0, 0), pt(100_000, 10_000), pt(100_000, 20_000)];
    expect(splitRides(points, longAfter)).toEqual([]);
  });

  it('最后一趟：距最后一次在动不超过 15 分钟算进行中，并算到目前收到的最后一个点', () => {
    const a = moving(0, 6); // 最后在动：50 s
    const waiting = parked(60_000, 4, 250); // 路口又停了 2 分钟
    const points = [...a, ...waiting];
    const now = new Date(T0 + 5 * MIN);
    expect(splitRides(points, now)).toEqual([
      { start: 0, end: points.length - 1, ongoing: true },
    ]);
  });

  it('最后一趟：超过 15 分钟没再动就不是进行中了，结束在最后一个在动的点', () => {
    const points = [...moving(0, 6), ...parked(60_000, 4, 250)];
    const now = new Date(T0 + 50_000 + RIDE_BREAK_MS + 1_000);
    expect(splitRides(points, now)).toEqual([
      { start: 0, end: 5, ongoing: false },
    ]);
  });
});

describe('splitRides：连续不停的超长行程（常驻模拟设备）', () => {
  const HOUR = 60 * MIN;
  /** 每 60 s 一个点、每步 300 m（5 m/s），从 fromMs 到 toMs（都相对 T0，可为负） */
  const chain = (fromMs: number, toMs: number) => {
    const out: ReturnType<typeof pt>[] = [];
    for (let at = fromMs; at <= toMs; at += MIN) {
      out.push(pt(((at - fromMs) / MIN) * 300, at));
    }
    return out;
  };
  const anchor = new Date(T0);
  const startsOf = (points: ReturnType<typeof pt>[], gridAnchor?: Date) =>
    splitRides(points, longAfter, gridAnchor).map(
      (s) => points[s.start].timestamp.getTime() - T0,
    );

  it('不给网格就不切：还是一趟', () => {
    const points = chain(-30 * HOUR, 20 * HOUR);
    expect(splitRides(points, longAfter)).toEqual([
      { start: 0, end: points.length - 1, ongoing: false },
    ]);
  });

  it('给了网格：在网格点切开，新的一趟从网格点开始', () => {
    const points = chain(-30 * HOUR, 30 * HOUR);
    const spans = splitRides(points, longAfter, anchor);
    // 起点在网格点前 30 小时：前一个网格点（−24 h）时才骑了 6 小时不切，到 0 点已满 30 小时才切
    expect(startsOf(points, anchor)).toEqual([-30 * HOUR, 0, 24 * HOUR]);
    expect(points[spans[0].end].timestamp.getTime() - T0).toBe(-MIN);
    expect(points[spans[1].end].timestamp.getTime() - T0).toBe(24 * HOUR - MIN);
    expect(spans[2].end).toBe(points.length - 1);
  });

  it('只取到网格点之前 24 小时的点，切出来的结果一样（和取数范围无关）', () => {
    const all = chain(-30 * HOUR, 30 * HOUR);
    const windowed = all.filter((p) => p.timestamp.getTime() >= T0 - 24 * HOUR);
    const fromAll = startsOf(all, anchor).filter((at) => at >= 0);
    const fromWindow = startsOf(windowed, anchor).filter((at) => at >= 0);
    expect(fromWindow).toEqual(fromAll);
    expect(fromWindow).toEqual([0, 24 * HOUR]);
  });

  it('取数起点那一刻正好在路口停着（不满 15 分钟）：照样切', () => {
    // 真正的起点在更早，取数范围里第一段是停着的 14 分钟，之后一直在骑
    const points = [
      ...parked(-24 * HOUR, 28, 0), // 停 14 分钟
      ...chain(-24 * HOUR + 14 * MIN, 2 * HOUR),
    ];
    expect(startsOf(points, anchor).filter((at) => at >= 0)).toEqual([0]);
  });

  it('普通的一趟跨过网格点不切', () => {
    const points = chain(-20 * MIN, 20 * MIN);
    expect(splitRides(points, longAfter, anchor)).toEqual([
      { start: 0, end: points.length - 1, ongoing: false },
    ]);
  });

  it('网格点那一刻停着、之后没再动：不多出一趟空的行程', () => {
    const points = [
      ...chain(-25 * HOUR, -5 * MIN),
      ...parked(-4 * MIN, 60, ((25 * HOUR - 5 * MIN) / MIN) * 300), // 停 30 分钟，跨过网格点
    ];
    const spans = splitRides(points, longAfter, anchor);
    // 只有网格点之前那一趟有位移；网格点之后切出来的那段首尾是同一个地方
    const moved = spans.filter(
      (s) => points[s.end].latitude !== points[s.start].latitude,
    );
    expect(moved).toHaveLength(1);
    expect(points[moved[0].start].timestamp.getTime() - T0).toBe(-25 * HOUR);
  });
});

describe('thin', () => {
  const items = Array.from({ length: 1001 }, (_, i) => i);

  it('不超过上限时原样返回', () => {
    expect(thin([1, 2, 3], 10)).toEqual([1, 2, 3]);
    expect(thin([], 10)).toEqual([]);
  });

  it('超过上限时等间隔抽稀，首尾保留、顺序不变、不重复', () => {
    const out = thin(items, 101);
    expect(out).toHaveLength(101);
    expect(out[0]).toBe(0);
    expect(out[100]).toBe(1000);
    expect(out[1]).toBe(10);
    expect(new Set(out).size).toBe(101);
    expect([...out].sort((a, b) => a - b)).toEqual(out);
  });

  it('上限是 2 时只留首尾', () => {
    expect(thin(items, 2)).toEqual([0, 1000]);
  });
});
