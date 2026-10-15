// 服务端时钟（F-3）的边界补测（2026-10-16）。保命链路：只断言现状，不改逻辑。
// 已知：冷启动时第一个慢响应会被直接采信，偏移偏低几秒（改不改负责人定）；
// 手机时间中途跳变时平滑要好几个响应才追上——见 src/__tests__/EDGE_FINDINGS_1016.md A1。
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

const LOCAL = Date.UTC(2026, 9, 16, 1, 0, 0);
const header = (ms: number) => new Date(ms).toUTCString();

beforeEach(() => {
  __resetServerClockForTests();
  jest.useFakeTimers({ now: LOCAL });
});
afterEach(() => {
  jest.useRealTimers();
});

describe("第一次样本", () => {
  it("现状：第一个响应慢了 5 秒（Date 是服务端发出时刻），偏移直接记成 -5 秒，不做平滑", () => {
    // 两边时钟其实一致；响应在路上走了 5 秒
    noteServerDate(header(LOCAL - 5_000), LOCAL);
    expect(serverClockOffsetMs()).toBe(-5_000);
    expect(serverNow()).toBe(LOCAL - 5_000);
  });

  it("改后（10-16 A1）：第一个响应慢了 5 秒，之后一个快响应就把偏移拉回 0——取窗口里最大的样本，不再按 30% 慢慢追", () => {
    noteServerDate(header(LOCAL - 5_000), LOCAL);
    const after: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      noteServerDate(header(LOCAL), LOCAL);
      after.push(serverClockOffsetMs());
    }
    expect(after).toEqual([0, 0, 0]);
  });

  it("窗口只记最近 5 个：一个快响应之后连来 5 个慢 2 秒的，偏移跟着到 -2 秒（第 4 个时还钉在 0）", () => {
    noteServerDate(header(LOCAL), LOCAL);
    for (let i = 0; i < 4; i += 1) noteServerDate(header(LOCAL - 2_000), LOCAL);
    expect(serverClockOffsetMs()).toBe(0);
    noteServerDate(header(LOCAL - 2_000), LOCAL);
    expect(serverClockOffsetMs()).toBe(-2_000);
  });

  it("Date 头只有秒：同一秒内收到的毫秒数不影响，偏移是整秒减去收到时的毫秒", () => {
    noteServerDate("Fri, 16 Oct 2026 01:00:00 GMT", LOCAL + 999);
    expect(serverClockOffsetMs()).toBe(-999);
  });

  it("不传收到时刻：用此刻的手机时钟", () => {
    noteServerDate(header(LOCAL + 90_000));
    expect(serverClockOffsetMs()).toBe(90_000);
  });

  it("手机比服务器慢一整年：照样采信，serverNow 跟着服务器走", () => {
    const year = 365 * 86_400_000;
    noteServerDate(header(LOCAL + year), LOCAL);
    expect(serverNow()).toBe(LOCAL + year);
  });
});

describe("坏头", () => {
  it("忽略的头不算样本：之后第一个好头仍按「第一次」直接采信", () => {
    noteServerDate("garbage", LOCAL);
    noteServerDate("", LOCAL);
    noteServerDate(null, LOCAL);
    noteServerDate(header(LOCAL + 12_000), LOCAL);
    expect(serverClockOffsetMs()).toBe(12_000);
  });

  it("坏头夹在中间：不打断平滑，偏移不变", () => {
    noteServerDate(header(LOCAL + 10_000), LOCAL);
    noteServerDate("Thu, 99 Foo 2026 99:99:99 GMT", LOCAL);
    expect(serverClockOffsetMs()).toBe(10_000);
  });

  it("改后（10-16 A1）：Date 头早于 2024 年的不采信（V8 把「0」解析成 2000 年；服务器时钟没对上）", () => {
    noteServerDate("0", LOCAL);
    expect(serverClockOffsetMs()).toBe(0);
    noteServerDate("Mon, 01 Jan 2018 00:00:00 GMT", LOCAL);
    expect(serverClockOffsetMs()).toBe(0);
    // 之后一个正常的照样按「第一次」采信
    noteServerDate(header(LOCAL - 4_000), LOCAL);
    expect(serverClockOffsetMs()).toBe(-4_000);
  });
});

describe("平滑与时钟跳变", () => {
  it("同一个偏移连续来：保持不变（整数毫秒不漂移）", () => {
    for (let i = 0; i < 50; i += 1)
      noteServerDate(header(LOCAL - 2_000), LOCAL);
    expect(serverClockOffsetMs()).toBe(-2_000);
  });

  it("偏移恒定时 serverNow 随手机时钟走，两者差恒定", () => {
    noteServerDate(header(LOCAL + 7_000), LOCAL);
    for (const step of [1, 999, 60_000]) {
      jest.advanceTimersByTime(step);
      expect(serverNow() - Date.now()).toBe(7_000);
    }
  });

  it("改后（10-16 A1）：学到偏移后手机时间被往前拨 1 小时（手动改时间 / 长时间离线后自动校时）——差 30 秒以上当跳变，第一个响应就直接采信，serverNow 立刻对上", () => {
    noteServerDate(header(LOCAL), LOCAL);
    expect(serverClockOffsetMs()).toBe(0);
    // 手机时钟往前跳 1 小时：同一时刻的服务器时间，在手机上读成 LOCAL + 1h 收到
    const jumped = LOCAL + 3_600_000;
    jest.setSystemTime(jumped);
    noteServerDate(header(LOCAL), jumped);
    expect(serverClockOffsetMs()).toBe(-3_600_000);
    expect(serverNow()).toBe(LOCAL);
  });

  it("改后（10-16 A1）：跳变后一个响应就追回（原来要 23 个）", () => {
    noteServerDate(header(LOCAL), LOCAL);
    const jumped = LOCAL + 3_600_000;
    let n = 0;
    while (Math.abs(serverClockOffsetMs() + 3_600_000) > 1_000 && n < 100) {
      noteServerDate(header(LOCAL), jumped);
      n += 1;
    }
    expect(n).toBe(1);
  });

  it("往回拨也直接采信；跳变后窗口重新开始，紧接着慢 25 秒的样本不算跳变、取最大仍是新值", () => {
    noteServerDate(header(LOCAL), LOCAL);
    noteServerDate(header(LOCAL + 3_600_000), LOCAL);
    expect(serverClockOffsetMs()).toBe(3_600_000);
    noteServerDate(header(LOCAL + 3_600_000 - 25_000), LOCAL);
    expect(serverClockOffsetMs()).toBe(3_600_000);
    // 差 31 秒就当跳变
    noteServerDate(header(LOCAL + 3_600_000 - 31_000), LOCAL);
    expect(serverClockOffsetMs()).toBe(3_600_000 - 31_000);
  });

  it("收到时刻倒退（两个响应乱序到达处理）：照样记样本、取窗口最大，不抛", () => {
    noteServerDate(header(LOCAL), LOCAL);
    expect(() =>
      noteServerDate(header(LOCAL - 1_000), LOCAL - 10_000),
    ).not.toThrow();
    expect(serverClockOffsetMs()).toBe(9_000);
  });
});

describe("重置", () => {
  it("重置后回到手机时钟，下一个样本重新按「第一次」采信", () => {
    noteServerDate(header(LOCAL + 30_000), LOCAL);
    __resetServerClockForTests();
    expect(serverNow()).toBe(LOCAL);
    noteServerDate(header(LOCAL - 4_000), LOCAL);
    expect(serverClockOffsetMs()).toBe(-4_000);
  });
});
