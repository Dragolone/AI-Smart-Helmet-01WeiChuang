// node:test + Node 24 原生类型剥离：零依赖跑 TS 单测（npm test -w mock-device）
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RIDING_LOOP,
  SKI_DOWNHILL,
  buildSkiLoop,
  distanceMeters,
  expandPath,
  expandRoute,
  headingDegrees,
} from './route.ts';

describe('route：距离与航向', () => {
  it('distanceMeters：同点为 0；深圳湾环路相邻航点在几十到两百米量级', () => {
    assert.equal(distanceMeters(RIDING_LOOP[0], RIDING_LOOP[0]), 0);
    for (let i = 0; i < RIDING_LOOP.length - 1; i += 1) {
      const d = distanceMeters(RIDING_LOOP[i], RIDING_LOOP[i + 1]);
      assert.ok(d > 30 && d < 300, `第 ${i} 段 ${d.toFixed(1)}m 超出量级`);
    }
  });

  it('headingDegrees：正北 0、正东 90、正南 180、正西 270，且始终落在 [0, 360)', () => {
    const o = { latitude: 22.5, longitude: 113.9 };
    assert.ok(Math.abs(headingDegrees(o, { latitude: 22.6, longitude: 113.9 }) - 0) < 0.01);
    assert.ok(Math.abs(headingDegrees(o, { latitude: 22.5, longitude: 114.0 }) - 90) < 0.5);
    assert.ok(Math.abs(headingDegrees(o, { latitude: 22.4, longitude: 113.9 }) - 180) < 0.01);
    assert.ok(Math.abs(headingDegrees(o, { latitude: 22.5, longitude: 113.8 }) - 270) < 0.5);
    for (let i = 0; i < RIDING_LOOP.length - 1; i += 1) {
      const h = headingDegrees(RIDING_LOOP[i], RIDING_LOOP[i + 1]);
      assert.ok(h >= 0 && h < 360);
    }
  });
});

describe('route：细分', () => {
  it('expandPath：按步长插值，相邻点距离不超过步长的 1.5 倍；海拔线性插值', () => {
    const path = expandPath(SKI_DOWNHILL, 80);
    assert.ok(path.length > SKI_DOWNHILL.length);
    for (let i = 0; i < path.length - 1; i += 1) {
      assert.ok(distanceMeters(path[i], path[i + 1]) <= 120);
      assert.ok(typeof path[i].altitude === 'number');
    }
    // 海拔单调下降（滑降）
    for (let i = 0; i < path.length - 1; i += 1) {
      assert.ok((path[i].altitude ?? 0) >= (path[i + 1].altitude ?? 0));
    }
  });

  it('expandRoute：环路首尾闭合——最后一点回到起点附近，且不含重复的终点', () => {
    const loop = expandRoute(RIDING_LOOP, 30);
    const last = loop[loop.length - 1];
    assert.ok(distanceMeters(last, RIDING_LOOP[0]) < 45);
    assert.ok(distanceMeters(loop[0], RIDING_LOOP[0]) < 1e-6);
    // 步长 30m / 5s 上报 ≈ 6m/s 骑行速度（README 口径）
    for (let i = 0; i < loop.length - 1; i += 1) {
      assert.ok(distanceMeters(loop[i], loop[i + 1]) <= 45);
    }
  });

  it('buildSkiLoop：滑降段海拔 2110→1790、缆车段回升，全程带海拔', () => {
    const loop = buildSkiLoop();
    assert.ok(loop.every((p) => typeof p.altitude === 'number'));
    assert.equal(loop[0].altitude, 2110);
    const min = Math.min(...loop.map((p) => p.altitude ?? Infinity));
    const max = Math.max(...loop.map((p) => p.altitude ?? -Infinity));
    assert.ok(min >= 1790 && max <= 2110);
  });
});
