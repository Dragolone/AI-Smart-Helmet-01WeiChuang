// 墙钟跳变用单调钟立刻补（2026-10-20）：倒计时页按服务端 deadline 画，偏移原来只从响应的 Date 头学，
// 手机时间一跳（手动改 / 飞行模式后校时）要等下一个响应（最多 10 s 轮询）才追回，期间整屏红「0 秒」或顶格「60」。
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

describe("墙钟跳变用单调钟立刻补", () => {
  it("学到偏移后手机时间被往前拨 90 秒、没有任何新响应：serverNow 不跟着跳（服务端时钟没动）", () => {
    noteServerDate(header(LOCAL), LOCAL);
    expect(serverNow()).toBe(LOCAL);
    jest.setSystemTime(LOCAL + 90_000);
    expect(serverNow()).toBe(LOCAL);
    expect(serverClockOffsetMs()).toBe(-90_000);
  });

  it("往回拨 120 秒同样补上；之后正常流逝照常走", () => {
    noteServerDate(header(LOCAL), LOCAL);
    jest.setSystemTime(LOCAL - 120_000);
    expect(serverNow()).toBe(LOCAL);
    jest.advanceTimersByTime(5_000);
    expect(serverNow()).toBe(LOCAL + 5_000);
  });

  it("补过之后来的真样本不被当成又一次跳变：窗口照常平滑（慢 2 秒的样本不把偏移拉低）", () => {
    noteServerDate(header(LOCAL), LOCAL);
    jest.setSystemTime(LOCAL + 90_000);
    expect(serverNow()).toBe(LOCAL);
    noteServerDate(header(LOCAL - 2_000), LOCAL + 90_000);
    expect(serverClockOffsetMs()).toBe(-90_000);
    expect(serverNow()).toBe(LOCAL);
  });

  it("拨完时间再来一个对得上的样本：锚重新定在新墙钟上，之后不会再被反复补", () => {
    noteServerDate(header(LOCAL), LOCAL);
    jest.setSystemTime(LOCAL + 90_000);
    noteServerDate(header(LOCAL), LOCAL + 90_000);
    expect(serverClockOffsetMs()).toBe(-90_000);
    jest.advanceTimersByTime(10_000);
    expect(serverNow()).toBe(LOCAL + 10_000);
    expect(serverClockOffsetMs()).toBe(-90_000);
  });

  it("30 秒以内的差当正常漂移，不动偏移", () => {
    noteServerDate(header(LOCAL), LOCAL);
    jest.setSystemTime(LOCAL + 10_000);
    expect(serverNow()).toBe(LOCAL + 10_000);
    expect(serverClockOffsetMs()).toBe(0);
  });

  it("还没学到偏移时拨时间：没有锚，照手机时钟走（和原来一样）", () => {
    jest.setSystemTime(LOCAL + 90_000);
    expect(serverNow()).toBe(LOCAL + 90_000);
  });
});
