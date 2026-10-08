// 「要不要更换当前头盔」什么时候该问：当前头盔停满 2 分钟、另一台连续动满 30 秒，才问。
import { describe, expect, it } from "@jest/globals";

import {
  FRESH_MS,
  MOVING_MS,
  STILL_MS,
  nextMotion,
  switchCandidateOf,
  type Motion,
} from "../switch-reminder";

const T0 = 1_000_000;
const still: Motion = { movingSince: null, lastMovingAt: null };
/** 从 since 起一直在动，最近一次上报在 at */
const moving = (since: number, at: number): Motion => ({
  movingSince: since,
  lastMovingAt: at,
});

describe("nextMotion：一顶头盔的运动记录", () => {
  it("速度超过 1 m/s 才算在动；连续运动只记最早的起点", () => {
    const a = nextMotion(undefined, 3, T0);
    expect(a).toEqual({ movingSince: T0, lastMovingAt: T0 });
    const b = nextMotion(a, 4, T0 + 5_000);
    expect(b).toEqual({ movingSince: T0, lastMovingAt: T0 + 5_000 });
    expect(nextMotion(undefined, 1, T0).movingSince).toBeNull();
  });

  it("停下后连续运动的起点清掉，但记得上次动是什么时候", () => {
    const a = nextMotion(moving(T0, T0 + 5_000), 0.2, T0 + 10_000);
    expect(a).toEqual({ movingSince: null, lastMovingAt: T0 + 5_000 });
    // 再动起来：重新计起点
    expect(nextMotion(a, 3, T0 + 60_000).movingSince).toBe(T0 + 60_000);
  });
});

describe("switchCandidateOf：该不该问", () => {
  const base = { currentId: "a", onlineIds: ["a", "b"], watchingSince: T0 };

  it("当前头盔停满 2 分钟、另一台连续动满 30 秒：建议换成那一台", () => {
    const now = T0 + STILL_MS;
    expect(
      switchCandidateOf({
        ...base,
        motions: { a: still, b: moving(now - MOVING_MS, now) },
        now,
      }),
    ).toBe("b");
  });

  it("当前头盔自己在动：不问", () => {
    const now = T0 + STILL_MS;
    expect(
      switchCandidateOf({
        ...base,
        motions: {
          a: moving(now - 60_000, now),
          b: moving(now - MOVING_MS, now),
        },
        now,
      }),
    ).toBeNull();
  });

  it("当前头盔刚停下不到 2 分钟（等红灯）：不问", () => {
    const now = T0 + 10 * 60_000;
    expect(
      switchCandidateOf({
        ...base,
        motions: {
          a: { movingSince: null, lastMovingAt: now - STILL_MS + 1_000 },
          b: moving(now - 5 * 60_000, now),
        },
        now,
      }),
    ).toBeNull();
  });

  it("刚打开 App、还没观察满 2 分钟：没见当前头盔动过也不算停着", () => {
    const now = T0 + STILL_MS - 1_000;
    expect(
      switchCandidateOf({
        ...base,
        motions: { b: moving(T0, now) },
        now,
      }),
    ).toBeNull();
  });

  it("另一台只动了一下（不满 30 秒）：不问", () => {
    const now = T0 + STILL_MS;
    expect(
      switchCandidateOf({
        ...base,
        motions: { a: still, b: moving(now - MOVING_MS + 1_000, now) },
        now,
      }),
    ).toBeNull();
  });

  it("另一台的「在动」是旧消息（很久没有新的上报）：不问", () => {
    const now = T0 + STILL_MS;
    expect(
      switchCandidateOf({
        ...base,
        motions: {
          a: still,
          b: moving(now - 5 * 60_000, now - FRESH_MS - 1_000),
        },
        now,
      }),
    ).toBeNull();
  });

  it("只在在线的头盔里挑；当前头盔不在线时不问（那时当前头盔本来就会换成在线的）", () => {
    const now = T0 + STILL_MS;
    const motions = { a: still, b: moving(now - MOVING_MS, now) };
    expect(
      switchCandidateOf({ ...base, onlineIds: ["a"], motions, now }),
    ).toBeNull();
    expect(
      switchCandidateOf({ ...base, onlineIds: ["b"], motions, now }),
    ).toBeNull();
  });

  it("有几台在动时取设备列表里靠前的那一台", () => {
    const now = T0 + STILL_MS;
    expect(
      switchCandidateOf({
        currentId: "a",
        onlineIds: ["c", "a", "b"],
        watchingSince: T0,
        motions: {
          a: still,
          b: moving(now - MOVING_MS, now),
          c: moving(now - MOVING_MS, now),
        },
        now,
      }),
    ).toBe("c");
  });
});
