// 「等系统的弹框都走完」：App 连续在前台满一小段时间才调用；中途离开前台就重新计。
// 不整模块 mock react-native（见 map/__tests__/audit-nav-links.test.ts 顶部注释）——
// AppState.currentState 按属性覆盖并还原，addEventListener 用 spy 接住回调。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { AppState, type AppStateStatus } from "react-native";

import { setSplashCovering } from "@/components/splash/covering";

import {
  FOREGROUND_SETTLE_MS,
  whenForegroundSettled,
} from "../foreground-settled";

let listeners: ((s: AppStateStatus) => void)[] = [];
const removed = jest.fn();
const original = Object.getOwnPropertyDescriptor(AppState, "currentState");

/** 模拟 App 前后台切换：先改状态，再通知监听者（和系统的顺序一样） */
function appState(next: AppStateStatus): void {
  Object.defineProperty(AppState, "currentState", {
    value: next,
    configurable: true,
  });
  for (const l of [...listeners]) l(next);
}

beforeEach(() => {
  jest.useFakeTimers();
  listeners = [];
  removed.mockReset();
  jest.spyOn(AppState, "addEventListener").mockImplementation(((
    _type: string,
    l: (s: AppStateStatus) => void,
  ) => {
    listeners.push(l);
    return {
      remove: () => {
        removed();
        listeners = listeners.filter((x) => x !== l);
      },
    };
  }) as never);
  Object.defineProperty(AppState, "currentState", {
    value: "active",
    configurable: true,
  });
});

afterEach(() => {
  setSplashCovering(false);
  jest.useRealTimers();
  jest.restoreAllMocks();
  if (original) Object.defineProperty(AppState, "currentState", original);
});

describe("whenForegroundSettled", () => {
  it("一直在前台：满了时间调用一次，之后不再调", () => {
    const run = jest.fn();
    whenForegroundSettled(run);
    jest.advanceTimersByTime(FOREGROUND_SETTLE_MS - 1);
    expect(run).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledTimes(1);

    appState("background");
    appState("active");
    jest.advanceTimersByTime(FOREGROUND_SETTLE_MS * 3);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("第一次登录：系统框一个接一个出，全部点完之后才调用", () => {
    const run = jest.fn();
    // 第一个通知框刚被拒，回到前台 57 ms 后系统又问了一次
    whenForegroundSettled(run);
    jest.advanceTimersByTime(57);
    appState("background");
    jest.advanceTimersByTime(5000); // 用户看了 5 秒才点
    expect(run).not.toHaveBeenCalled();
    // 第二个通知框点完，114 ms 后是蓝牙权限框
    appState("active");
    jest.advanceTimersByTime(114);
    appState("background");
    jest.advanceTimersByTime(4000);
    expect(run).not.toHaveBeenCalled();
    // 蓝牙框点完：从这时起满了时间才调用
    appState("active");
    jest.advanceTimersByTime(FOREGROUND_SETTLE_MS - 1);
    expect(run).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("开始时不在前台（系统框已经盖在上面）：等回到前台再计", () => {
    Object.defineProperty(AppState, "currentState", {
      value: "background",
      configurable: true,
    });
    const run = jest.fn();
    whenForegroundSettled(run);
    jest.advanceTimersByTime(FOREGROUND_SETTLE_MS * 3);
    expect(run).not.toHaveBeenCalled();
    appState("active");
    jest.advanceTimersByTime(FOREGROUND_SETTLE_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("iOS 的系统框是 inactive：同样不算在前台", () => {
    const run = jest.fn();
    whenForegroundSettled(run);
    jest.advanceTimersByTime(200);
    appState("inactive");
    jest.advanceTimersByTime(FOREGROUND_SETTLE_MS * 3);
    expect(run).not.toHaveBeenCalled();
    appState("active");
    jest.advanceTimersByTime(FOREGROUND_SETTLE_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("时间到了但离开前台的事件还没处理到：以当时的状态为准，不调用", () => {
    const run = jest.fn();
    whenForegroundSettled(run);
    // 状态已经变了，监听者还没收到通知
    Object.defineProperty(AppState, "currentState", {
      value: "background",
      configurable: true,
    });
    jest.advanceTimersByTime(FOREGROUND_SETTLE_MS);
    expect(run).not.toHaveBeenCalled();
    // 事件补到、再回到前台：重新计
    appState("background");
    appState("active");
    jest.advanceTimersByTime(FOREGROUND_SETTLE_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("冷启动开屏还盖着：不计时，开屏让开后才开始计（说明框弹在路线动画上，10-21 华为）", () => {
    setSplashCovering(true);
    const run = jest.fn();
    whenForegroundSettled(run);
    jest.advanceTimersByTime(FOREGROUND_SETTLE_MS * 5);
    expect(run).not.toHaveBeenCalled();
    setSplashCovering(false);
    jest.advanceTimersByTime(FOREGROUND_SETTLE_MS - 1);
    expect(run).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("开屏还盖着时取消：让开之后也不调用", () => {
    setSplashCovering(true);
    const run = jest.fn();
    const cancel = whenForegroundSettled(run);
    cancel();
    setSplashCovering(false);
    jest.advanceTimersByTime(FOREGROUND_SETTLE_MS * 3);
    expect(run).not.toHaveBeenCalled();
  });

  it("取消之后（权限状态变了、页面卸载）不再调用，也不留监听", () => {
    const run = jest.fn();
    const cancel = whenForegroundSettled(run);
    jest.advanceTimersByTime(500);
    cancel();
    jest.advanceTimersByTime(FOREGROUND_SETTLE_MS * 3);
    appState("background");
    appState("active");
    jest.advanceTimersByTime(FOREGROUND_SETTLE_MS * 3);
    expect(run).not.toHaveBeenCalled();
    expect(listeners).toHaveLength(0);
  });
});
