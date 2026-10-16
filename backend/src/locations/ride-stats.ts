// 轨迹统计（纯函数，无 DB）：里程 / 移动时长 / 最高速。
// 只做几何累加，不做任何"骑行判断"——点与点之间断档超过 GAP 视为两段（关机、进隧道、App 被杀）。
export interface RideStatsPoint {
  latitude: number;
  longitude: number;
  /** m/s，设备上报 */
  speed: number;
  timestamp: Date;
}

export interface RideStats {
  /** 米，按相邻点大圆距离累加 */
  distanceMeters: number;
  /** 秒，只累计相邻点间隔 ≤ GAP 且平均速度 ≥ MOVING_MPS 的段 */
  movingSeconds: number;
  /** m/s，设备上报速度的最大值；无点时 null */
  maxSpeed: number | null;
  pointCount: number;
  firstAt: Date | null;
  lastAt: Date | null;
}

const GAP_MS = 10 * 60 * 1000;
export const MOVING_MPS = 0.5;
/** 相邻点隐含速度超过此值视为定位漂移，不计入里程（自行车/滑雪不会到 200 km/h） */
export const GLITCH_MPS = 55;
const EARTH_M = 6_371_000;

export function haversine(a: RideStatsPoint, b: RideStatsPoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) *
      Math.cos(toRad(b.latitude)) *
      Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(s));
}

/** points 必须按 timestamp 升序 */
export function computeRideStats(points: RideStatsPoint[]): RideStats {
  let distanceMeters = 0;
  let movingSeconds = 0;
  let maxSpeed: number | null = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    // 超过漂移阈值的点速（GPS 飞点报 400 m/s）不算最高速度：原来一个飞点就把整段行程的最高速度顶成 1440 km/h，
    // App 把 55 m/s 以上显示成「—」，真实最高速度也跟着没了（10-16 夜测 N15、10-17 评审 R4-7）
    if (
      Number.isFinite(p.speed) &&
      p.speed <= GLITCH_MPS &&
      (maxSpeed === null || p.speed > maxSpeed)
    )
      maxSpeed = p.speed;
    if (i === 0) continue;
    const prev = points[i - 1];
    const dtMs = p.timestamp.getTime() - prev.timestamp.getTime();
    if (dtMs <= 0 || dtMs > GAP_MS) continue;
    const d = haversine(prev, p);
    const impliedMps = d / (dtMs / 1000);
    if (impliedMps > GLITCH_MPS) continue;
    distanceMeters += d;
    if (impliedMps >= MOVING_MPS) movingSeconds += dtMs / 1000;
  }
  return {
    distanceMeters: Math.round(distanceMeters),
    movingSeconds: Math.round(movingSeconds),
    maxSpeed,
    pointCount: points.length,
    firstAt: points[0]?.timestamp ?? null,
    lastAt: points[points.length - 1]?.timestamp ?? null,
  };
}
