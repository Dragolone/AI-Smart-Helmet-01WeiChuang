import { describe, expect, it } from "@jest/globals";

import { msToNextSecond } from "../countdown";

const left = (deadline: number, now: number) =>
  Math.max(0, Math.ceil((deadline - now) / 1000));

describe("msToNextSecond", () => {
  const deadline = 1_700_000_060_000;
  it("lands exactly where the displayed second changes", () => {
    // 还剩 5.3 秒，显示 6；0.3 秒后剩 5.0 秒，显示变成 5
    expect(msToNextSecond(deadline, deadline - 5_300)).toBe(300);
    expect(left(deadline, deadline - 5_300)).toBe(6);
    expect(left(deadline, deadline - 5_300 + 300)).toBe(5);
  });
  it("waits a full second when sitting exactly on a boundary", () => {
    expect(msToNextSecond(deadline, deadline - 5_000)).toBe(1000);
  });
  it("never skips a number even when every timer fires late", () => {
    // 模拟定时器每次都晚 40 毫秒：读到的数字仍然是 60、59、58 … 一个不落
    let now = deadline - 59_870;
    const seen = [left(deadline, now)];
    while (now < deadline) {
      now += msToNextSecond(deadline, now) + 40;
      seen.push(left(deadline, now));
    }
    expect(seen).toEqual(Array.from({ length: 61 }, (_, i) => 60 - i));
  });
  it("keeps ticking once a second after the deadline has passed", () => {
    expect(msToNextSecond(deadline, deadline + 250)).toBe(750);
    expect(msToNextSecond(deadline, deadline + 2_000)).toBe(1000);
  });
});
