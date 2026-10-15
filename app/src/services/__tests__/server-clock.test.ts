// 服务端时钟（F-3）：从 HTTP Date 头学偏移；没学到就是手机时钟；坏头忽略；多次采样平滑。
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

const LOCAL = Date.UTC(2026, 9, 6, 12, 0, 0);

beforeEach(() => {
  __resetServerClockForTests();
  jest.useFakeTimers({ now: LOCAL });
});
afterEach(() => {
  jest.useRealTimers();
});

describe("serverNow", () => {
  it("没学到之前等于手机时钟", () => {
    expect(serverNow()).toBe(LOCAL);
    expect(serverClockOffsetMs()).toBe(0);
  });

  it("手机快 90 秒：第一个 Date 头直接采信，倒计时按服务端时钟算", () => {
    noteServerDate(new Date(LOCAL - 90_000).toUTCString(), LOCAL);
    expect(serverClockOffsetMs()).toBe(-90_000);
    expect(serverNow()).toBe(LOCAL - 90_000);
    jest.advanceTimersByTime(5_000);
    expect(serverNow()).toBe(LOCAL - 85_000); // 偏移恒定，时间照走
  });

  it("之后的慢响应（Date 偏早）不把偏移带偏：取最近几个样本里最大的（2026-10-16 A1，华为 8.10 实测倒计时 52→55 往上跳）", () => {
    noteServerDate(new Date(LOCAL).toUTCString(), LOCAL);
    noteServerDate(new Date(LOCAL - 10_000).toUTCString(), LOCAL); // 一次慢响应
    expect(serverClockOffsetMs()).toBe(0);
    noteServerDate(new Date(LOCAL).toUTCString(), LOCAL);
    expect(serverClockOffsetMs()).toBe(0);
  });

  it("Date 头缺失或不是合法日期：忽略", () => {
    noteServerDate(null, LOCAL);
    noteServerDate(undefined, LOCAL);
    noteServerDate("", LOCAL);
    noteServerDate("not a date", LOCAL);
    expect(serverClockOffsetMs()).toBe(0);
  });
});
