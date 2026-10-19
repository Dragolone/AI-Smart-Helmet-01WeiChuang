// 墙钟跳变（2026-10-20）：往回拨用单调钟立刻补；往前跳和「手机睡了一觉」分不开（performance.now 不含休眠），
// 不动偏移、只通知订阅方立刻补拉。倒计时页按服务端 deadline 画，偏移原来只从响应的 Date 头学。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

import {
  __resetServerClockForTests,
  noteServerDate,
  onWallClockForwardJump,
  serverClockOffsetMs,
  serverNow,
} from "../server-clock";

const LOCAL = Date.UTC(2026, 9, 20, 1, 0, 0);
const header = (ms: number) => new Date(ms).toUTCString();

beforeEach(() => {
  __resetServerClockForTests();
  jest.useFakeTimers({ now: LOCAL });
});
afterEach(() => {
  jest.useRealTimers();
});

describe("往回拨：用单调钟立刻补", () => {
  it("学到偏移后手机时间被往回拨 120 秒、没有任何新响应：serverNow 不跟着退（服务端时钟没动）", () => {
    noteServerDate(header(LOCAL), LOCAL);
    jest.setSystemTime(LOCAL - 120_000);
    expect(serverNow()).toBe(LOCAL);
    expect(serverClockOffsetMs()).toBe(120_000);
    jest.advanceTimersByTime(5_000);
    expect(serverNow()).toBe(LOCAL + 5_000);
  });

  it("补过之后来的真样本不被当成又一次跳变：窗口照常平滑（慢 2 秒的样本不把偏移拉低）", () => {
    noteServerDate(header(LOCAL), LOCAL);
    jest.setSystemTime(LOCAL - 120_000);
    expect(serverNow()).toBe(LOCAL);
    noteServerDate(header(LOCAL - 2_000), LOCAL - 120_000);
    expect(serverClockOffsetMs()).toBe(120_000);
    expect(serverNow()).toBe(LOCAL);
  });
});

describe("往前跳：分不清拨快还是睡醒，不动偏移、只催一次补拉", () => {
  it("手机睡了一觉（墙钟走了 1 小时、单调钟没走）：偏移不变、serverNow 跟着墙钟走（本来就对）；订阅方被催一次", () => {
    noteServerDate(header(LOCAL), LOCAL);
    const poke = jest.fn();
    onWallClockForwardJump(poke);
    jest.setSystemTime(LOCAL + 3_600_000);
    expect(serverNow()).toBe(LOCAL + 3_600_000);
    expect(serverClockOffsetMs()).toBe(0);
    expect(poke).toHaveBeenCalledTimes(1);
    serverNow();
    expect(poke).toHaveBeenCalledTimes(1);
  });

  it("真被拨快 90 秒：先跟着墙钟（和原来一样），补拉回来的 Date 头一个来回就纠正，之后不再反复催", () => {
    noteServerDate(header(LOCAL), LOCAL);
    const poke = jest.fn();
    onWallClockForwardJump(poke);
    jest.setSystemTime(LOCAL + 90_000);
    expect(serverNow()).toBe(LOCAL + 90_000);
    expect(poke).toHaveBeenCalledTimes(1);
    noteServerDate(header(LOCAL), LOCAL + 90_000);
    expect(serverClockOffsetMs()).toBe(-90_000);
    expect(serverNow()).toBe(LOCAL);
    jest.advanceTimersByTime(10_000);
    expect(serverNow()).toBe(LOCAL + 10_000);
    expect(poke).toHaveBeenCalledTimes(1);
  });

  it("订阅方抛错不影响时钟；退订后不再被催", () => {
    noteServerDate(header(LOCAL), LOCAL);
    const bad = jest.fn(() => {
      throw new Error("boom");
    });
    const off = onWallClockForwardJump(bad);
    jest.setSystemTime(LOCAL + 60_000);
    expect(() => serverNow()).not.toThrow();
    expect(bad).toHaveBeenCalledTimes(1);
    off();
    jest.setSystemTime(LOCAL + 200_000);
    serverNow();
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it("30 秒以内的差当正常漂移，不动偏移也不催", () => {
    noteServerDate(header(LOCAL), LOCAL);
    const poke = jest.fn();
    onWallClockForwardJump(poke);
    jest.setSystemTime(LOCAL + 10_000);
    expect(serverNow()).toBe(LOCAL + 10_000);
    expect(poke).not.toHaveBeenCalled();
  });

  it("还没学到偏移时拨时间：没有锚，照手机时钟走、不催", () => {
    const poke = jest.fn();
    onWallClockForwardJump(poke);
    jest.setSystemTime(LOCAL + 90_000);
    expect(serverNow()).toBe(LOCAL + 90_000);
    expect(poke).not.toHaveBeenCalled();
  });
});
