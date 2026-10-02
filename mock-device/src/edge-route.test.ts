// 路线数学的边界：退化输入（同点 / 单点 / 空路径）、跨 180° 经线、路段拼接处不重复不断裂。
// 这些值直接变成 location_update 的 speed / heading / altitude，出 NaN 会被 Ingest 判校验失败。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RIDING_LOOP,
  SKI_DOWNHILL,
  SKI_LIFT,
  buildSkiLoop,
  distanceMeters,
  expandPath,
  expandRoute,
  headingDegrees,
  type RoutePoint,
} from './route.ts';

const near = (actual: number, expected: number, tolerance: number): boolean => Math.abs(actual - expected) <= tolerance;

describe('route 边界：距离与航向', () => {
  it('同一点：距离 0、航向 0（不是 NaN）——静止时 heading 填 0 与 EVENTS.md 4.2 口径一致', () => {
    const p = { latitude: 22.5, longitude: 113.9 };
    assert.equal(distanceMeters(p, p), 0);
    assert.equal(headingDegrees(p, p), 0);
  });

  it('跨 180° 经线：走短弧（约 22km 向东），不是绕地球一圈向西', () => {
    const west = { latitude: 0, longitude: 179.9 };
    const east = { latitude: 0, longitude: -179.9 };
    assert.ok(near(distanceMeters(west, east), 22_239, 50), String(distanceMeters(west, east)));
    assert.ok(near(headingDegrees(west, east), 90, 0.01));
    assert.ok(near(headingDegrees(east, west), 270, 0.01));
  });

  it('距离对称；南北极 / 对跖点等于半个地球周长，不因浮点溢出得到 NaN', () => {
    const a = RIDING_LOOP[3];
    const b = RIDING_LOOP[17];
    assert.equal(distanceMeters(a, b), distanceMeters(b, a));
    const half = Math.PI * 6_371_000;
    assert.ok(near(distanceMeters({ latitude: 90, longitude: 0 }, { latitude: -90, longitude: 0 }), half, 1));
    assert.ok(near(distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 }), half, 1));
    assert.ok(near(distanceMeters({ latitude: 12.3, longitude: 45.6 }, { latitude: -12.3, longitude: -134.4 }), half, 1));
  });

  it('航向始终落在 [0, 360)：正北偏西一点是 359.x 而不是负数', () => {
    const o = { latitude: 22.5, longitude: 113.9 };
    const h = headingDegrees(o, { latitude: 22.6, longitude: 113.8999 });
    assert.ok(h > 359 && h < 360, String(h));
  });
});

describe('route 边界：细分', () => {
  it('空路径 / 单点路径 → 空数组；单点环路 → 就那一个点', () => {
    assert.deepEqual(expandPath([], 30), []);
    assert.deepEqual(expandPath([RIDING_LOOP[0]], 30), []);
    assert.deepEqual(expandRoute([RIDING_LOOP[0]], 30), [RIDING_LOOP[0]]);
  });

  it('两点重合 / 间距不足半步：仍输出 1 个点（不会因 0 段而丢掉该航点）', () => {
    const p = { latitude: 22.5, longitude: 113.9 };
    assert.deepEqual(expandPath([p, p], 30), [p]);
    const close = { latitude: 22.50001, longitude: 113.9 }; // ≈1.1m
    assert.deepEqual(expandPath([p, close], 30), [p]);
  });

  it('段数按四舍五入：100m 路段 / 步长 30m → 3 个点，间距均匀', () => {
    const a = { latitude: 0, longitude: 0 };
    const b = { latitude: 0, longitude: 100 / 111_194.93 };
    const path = expandPath([a, b], 30);
    assert.equal(path.length, 3);
    assert.ok(near(distanceMeters(path[0], path[1]), 100 / 3, 0.01));
    assert.ok(near(distanceMeters(path[1], path[2]), 100 / 3, 0.01));
  });

  it('只有一端带海拔的路段：插值点不带 altitude 字段（不能算出 NaN 再发出去）', () => {
    const a: RoutePoint = { latitude: 40.949, longitude: 115.418, altitude: 2110 };
    const b: RoutePoint = { latitude: 40.9502, longitude: 115.4196 };
    for (const p of [...expandPath([a, b], 30), ...expandPath([b, a], 30)]) {
      assert.equal('altitude' in p, false);
    }
  });

  it('细分不改写入参（内置路线是模块级常量，多次调用结果一致）', () => {
    const snapshot = JSON.stringify(RIDING_LOOP);
    const first = expandRoute(RIDING_LOOP, 30);
    const second = expandRoute(RIDING_LOOP, 30);
    assert.equal(JSON.stringify(RIDING_LOOP), snapshot);
    assert.deepEqual(first, second);
  });
});

describe('route 边界：内置剧本路线', () => {
  it('滑雪循环：滑降段与缆车段首尾相接，接缝处（2110m 起点 / 1790m 终点）各只出现一次', () => {
    assert.deepEqual(SKI_DOWNHILL.at(-1), SKI_LIFT[0]);
    assert.deepEqual(SKI_LIFT.at(-1), SKI_DOWNHILL[0]);
    const loop = buildSkiLoop();
    assert.equal(loop.filter((p) => p.altitude === 2110).length, 1);
    assert.equal(loop.filter((p) => p.altitude === 1790).length, 1);
  });

  it('两条内置循环从末点回到首点时不跳变：间距与航向都和普通一步同量级', () => {
    for (const [name, loop, maxStep] of [
      ['riding', expandRoute(RIDING_LOOP, 30), 45],
      ['ski', buildSkiLoop(), 120],
    ] as const) {
      for (let i = 0; i < loop.length; i += 1) {
        const next = loop[(i + 1) % loop.length];
        const d = distanceMeters(loop[i], next);
        assert.ok(d > 0 && d <= maxStep, `${name} 第 ${i} 步 ${d.toFixed(1)}m`);
        const h = headingDegrees(loop[i], next);
        assert.ok(Number.isFinite(h) && h >= 0 && h < 360, `${name} 第 ${i} 步航向 ${h}`);
        // 上报前保留 1 位小数：359.97 会进位成 360，仍在 Contract 的 0–360 闭区间内
        assert.ok(Number(h.toFixed(1)) <= 360);
      }
    }
  });

  it('所有航点都是合法的 WGS84 坐标，滑雪路线全程带海拔', () => {
    for (const p of [...RIDING_LOOP, ...SKI_DOWNHILL, ...SKI_LIFT]) {
      assert.ok(Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180);
    }
    assert.ok([...SKI_DOWNHILL, ...SKI_LIFT].every((p) => typeof p.altitude === 'number'));
    assert.ok(RIDING_LOOP.every((p) => p.altitude === undefined));
  });
});
