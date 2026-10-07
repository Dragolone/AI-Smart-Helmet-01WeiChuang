// 把一串定位点切成一趟一趟的行程（纯函数，无 DB）。App 地图页「行程」列表用（API.md §5）。
// 这是展示用的分段，不是骑行状态判断，也不触发任何业务流程——规则由负责人 2026-10-07 定：
// 相邻点断档超过 15 分钟，或停住不动超过 15 分钟，上一趟就结束。
// 「在动」的口径与 ride-stats 的 movingSeconds 一致：相邻两点的隐含速度 ≥ MOVING_MPS，且不是定位漂移。
import {
  GLITCH_MPS,
  MOVING_MPS,
  haversine,
  type RideStatsPoint,
} from './ride-stats';

/** 断档或停住超过这么久，算上一趟结束 */
export const RIDE_BREAK_MS = 15 * 60 * 1000;
/** 里程不到这个数不算一趟（头盔放着不动时的定位漂移） */
export const MIN_RIDE_METERS = 50;
/**
 * 一趟连续进行到这么久，就在下一个网格点切开（见 splitRides 的 gridAnchor）。
 * 真实头盔的电量撑不到；常驻的模拟设备不停地循环骑，不切的话是「一趟骑了好几天」，
 * 起点早已在查询范围之外，今天的列表里反而没有它。
 */
export const RIDE_MAX_MS = 24 * 60 * 60 * 1000;

export interface RideSpan {
  /** points 里的下标，含两端 */
  start: number;
  end: number;
  /** 截至 now 还没结束 */
  ongoing: boolean;
}

/**
 * @param points 必须按 timestamp 升序
 * @param now 查询时刻：最后一趟距最后一次在动不超过 RIDE_BREAK_MS 就算进行中
 * @param gridAnchor 给了就启用「超长行程切开」：网格点是 gridAnchor + n × RIDE_MAX_MS。
 *   跨过网格点时，这一趟若已经进行了 RIDE_MAX_MS − RIDE_BREAK_MS 以上，就在网格点结束，
 *   新的一趟从网格点之后的第一个点开始。
 *   为什么切在网格点而不是「起点 + 24 小时」：起点可能早在取数范围之外，按起点算的话
 *   不同的查询范围会切出不同的结果。网格点只看它之前 RIDE_MAX_MS 内的点，所以只要取数从
 *   「网格点 − RIDE_MAX_MS」开始，结果就和取数范围无关（留出的 RIDE_BREAK_MS 正好盖住
 *   取数起点那一刻恰好在路口停着的情况）。
 */
export function splitRides(
  points: RideStatsPoint[],
  now: Date,
  gridAnchor?: Date,
): RideSpan[] {
  const spans: RideSpan[] = [];
  const anchor = gridAnchor?.getTime();
  const gridCell = (at: Date) =>
    Math.floor((at.getTime() - (anchor ?? 0)) / RIDE_MAX_MS);
  /** 当前这一趟的第一个点；-1 = 此刻不在行程中 */
  let start = -1;
  /** 当前这一趟里最后一个「刚动过」的点：停下之后这一趟就结束在它这里 */
  let lastMove = -1;
  const close = () => {
    if (start >= 0) spans.push({ start, end: lastMove, ongoing: false });
    start = -1;
    lastMove = -1;
  };
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const p = points[i];
    const dtMs = p.timestamp.getTime() - prev.timestamp.getTime();
    if (dtMs > RIDE_BREAK_MS) {
      // 关机、进隧道、App 被杀：这段时间发生了什么不知道，不往两头的行程上算
      close();
      continue;
    }
    if (dtMs <= 0) continue;
    if (anchor !== undefined && start >= 0) {
      const cell = gridCell(p.timestamp);
      if (cell > gridCell(prev.timestamp)) {
        const boundary = anchor + cell * RIDE_MAX_MS;
        if (
          boundary - points[start].timestamp.getTime() >=
          RIDE_MAX_MS - RIDE_BREAK_MS
        ) {
          spans.push({ start, end: lastMove, ongoing: false });
          start = i;
          lastMove = i;
          continue;
        }
      }
    }
    const mps = haversine(prev, p) / (dtMs / 1000);
    if (mps >= MOVING_MPS && mps <= GLITCH_MPS) {
      if (start < 0) start = i - 1;
      lastMove = i;
    } else if (
      start >= 0 &&
      p.timestamp.getTime() - points[lastMove].timestamp.getTime() >
        RIDE_BREAK_MS
    ) {
      close();
    }
  }
  if (start >= 0) {
    const ongoing =
      now.getTime() - points[lastMove].timestamp.getTime() <= RIDE_BREAK_MS;
    // 进行中的一趟算到目前收到的最后一个点（含路口停着的那几个）
    spans.push({ start, end: ongoing ? points.length - 1 : lastMove, ongoing });
  }
  return spans;
}

/**
 * 等间隔抽稀到最多 max 个：首尾一定保留，顺序不变。画线和回放用——统计一律用抽稀前的全部点算。
 */
export function thin<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  if (max <= 1) return [items[0]];
  const step = (items.length - 1) / (max - 1);
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.round(i * step)]);
  return out;
}
