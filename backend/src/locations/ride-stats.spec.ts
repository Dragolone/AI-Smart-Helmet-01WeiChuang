import { computeRideStats } from './ride-stats';

const pt = (lat: number, lng: number, speed: number, sec: number) => ({
  latitude: lat,
  longitude: lng,
  speed,
  timestamp: new Date(Date.UTC(2026, 8, 17, 0, 0, sec)),
});

describe('computeRideStats', () => {
  it('returns zeros for no points', () => {
    expect(computeRideStats([])).toEqual({
      distanceMeters: 0,
      movingSeconds: 0,
      maxSpeed: null,
      pointCount: 0,
      firstAt: null,
      lastAt: null,
    });
  });

  it('sums distance and moving time along consecutive points', () => {
    // 纬度每 0.0009° ≈ 100 m；每 10 s 一点 → 10 m/s
    const points = [0, 1, 2, 3].map((i) =>
      pt(22.5 + i * 0.0009, 114, 10, i * 10),
    );
    const s = computeRideStats(points);
    expect(s.distanceMeters).toBeGreaterThan(290);
    expect(s.distanceMeters).toBeLessThan(310);
    expect(s.movingSeconds).toBe(30);
    expect(s.maxSpeed).toBe(10);
    expect(s.pointCount).toBe(4);
    expect(s.firstAt).toEqual(points[0].timestamp);
    expect(s.lastAt).toEqual(points[3].timestamp);
  });

  it('does not bridge gaps longer than 10 min and ignores glitches', () => {
    const points = [
      pt(22.5, 114, 5, 0),
      pt(22.5009, 114, 5, 10),
      // 断档 20 分钟：这一段不算里程也不算时长
      pt(22.6, 114, 5, 10 + 20 * 60),
      pt(22.6009, 114, 5, 10 + 20 * 60 + 10),
      // 漂移：1 秒跳 1 km
      pt(22.61, 114, 5, 10 + 20 * 60 + 11),
    ];
    const s = computeRideStats(points);
    expect(s.distanceMeters).toBeGreaterThan(190);
    expect(s.distanceMeters).toBeLessThan(210);
    expect(s.movingSeconds).toBe(20);
  });

  it('counts stationary segments in distance but not moving time', () => {
    const points = [pt(22.5, 114, 0, 0), pt(22.5, 114, 0, 10)];
    const s = computeRideStats(points);
    expect(s.distanceMeters).toBe(0);
    expect(s.movingSeconds).toBe(0);
  });
});
