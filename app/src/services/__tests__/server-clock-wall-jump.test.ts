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

// 2026-10-20 补分支：拿不到单调钟（运行时没有 performance.now）时整套跳变补偿都得安静退场——
// 倒计时页每秒都调 serverNow，这里一抛整页就崩；也不能拿 undefined 算出 NaN 的锚把偏移带坏
describe("没有单调钟（performance.now 不可用的运行时）", () => {
  it("退回只靠 Date 头学偏移：照常学到偏移；手机时间被拨动时不补、不催，下一个 Date 头按跳变直接采信、一个来回就对上", () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "performance");
    Object.defineProperty(globalThis, "performance", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    try {
      const poke = jest.fn();
      onWallClockForwardJump(poke);
      // 手机比服务端慢 90 秒
      noteServerDate(header(LOCAL + 90_000), LOCAL);
      expect(serverClockOffsetMs()).toBe(90_000);
      expect(serverNow()).toBe(LOCAL + 90_000);
      // 往回拨 120 秒：有单调钟时立刻补；没有就跟着墙钟退（10-20 之前的行为），不抛、偏移不变
      jest.setSystemTime(LOCAL - 120_000);
      expect(() => serverNow()).not.toThrow();
      expect(serverNow()).toBe(LOCAL - 30_000);
      expect(serverClockOffsetMs()).toBe(90_000);
      // 下一个响应：样本与偏移差 120 秒，当跳变直接采信
      noteServerDate(header(LOCAL + 90_000), LOCAL - 120_000);
      expect(serverClockOffsetMs()).toBe(210_000);
      expect(serverNow()).toBe(LOCAL + 90_000);
      // 往前跳 1 小时（睡醒 / 拨快）：没有锚就判断不了，不催补拉、偏移不动
      jest.setSystemTime(LOCAL + 3_600_000);
      expect(serverNow()).toBe(LOCAL + 3_810_000);
      expect(serverClockOffsetMs()).toBe(210_000);
      expect(poke).not.toHaveBeenCalled();
    } finally {
      if (saved) Object.defineProperty(globalThis, "performance", saved);
    }
  });
});
