// 开屏还盖着时，App 自己的提示框 / Toast / Modal 先压着（2026-10-21 华为：说明框弹在路线动画上）。
import { afterEach, describe, expect, it, jest } from "@jest/globals";

import {
  isSplashCovering,
  setSplashCovering,
  splashGoneWithin,
  subscribeSplashCovering,
  whenSplashGone,
} from "../covering";

afterEach(() => {
  setSplashCovering(false);
  jest.useRealTimers();
});

describe("whenSplashGone", () => {
  it("没盖着：立刻做", () => {
    const run = jest.fn();
    whenSplashGone(run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("盖着：等让开才做，只做一次；之后再盖上、再让开也不重复", () => {
    setSplashCovering(true);
    const run = jest.fn();
    whenSplashGone(run);
    expect(run).not.toHaveBeenCalled();
    setSplashCovering(false);
    expect(run).toHaveBeenCalledTimes(1);
    setSplashCovering(true);
    setSplashCovering(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("排着好几件：让开时按顺序都做；取消掉的那件不做", () => {
    setSplashCovering(true);
    const order: string[] = [];
    whenSplashGone(() => order.push("a"));
    const cancel = whenSplashGone(() => order.push("b"));
    whenSplashGone(() => order.push("c"));
    cancel();
    setSplashCovering(false);
    expect(order).toEqual(["a", "c"]);
  });

  it("重复设成同一个值不通知订阅者", () => {
    const l = jest.fn();
    const off = subscribeSplashCovering(l);
    setSplashCovering(false);
    expect(l).not.toHaveBeenCalled();
    setSplashCovering(true);
    setSplashCovering(true);
    expect(l).toHaveBeenCalledTimes(1);
    expect(isSplashCovering()).toBe(true);
    off();
    setSplashCovering(false);
    expect(l).toHaveBeenCalledTimes(1);
  });
});

describe("splashGoneWithin（O27：系统授权框等开屏，最多 5 s）", () => {
  it("没盖着：立刻兑现，不留定时器", async () => {
    jest.useFakeTimers();
    await splashGoneWithin(5_000);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("盖着：让开就兑现，定时器撤掉", async () => {
    jest.useFakeTimers();
    setSplashCovering(true);
    const done = jest.fn();
    void splashGoneWithin(5_000).then(done);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(done).not.toHaveBeenCalled();
    setSplashCovering(false);
    await Promise.resolve();
    expect(done).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("一直盖着：满时限就兑现，不再挂在订阅上（之后让开不会再回调）", async () => {
    jest.useFakeTimers();
    setSplashCovering(true);
    const done = jest.fn();
    void splashGoneWithin(5_000).then(done);
    await jest.advanceTimersByTimeAsync(4_999);
    expect(done).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledTimes(1);
    const l = jest.fn();
    const off = subscribeSplashCovering(l);
    setSplashCovering(false);
    off();
    expect(l).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
  });
});
