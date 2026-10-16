// 「回到前台再读一次」（语言 / 外观 / 当前头盔读钥匙串失败时用）：只在真回到前台时触发、触发一次就摘掉、
// 同一个 key 连着失败几次也只挂一个监听。
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { AppState } from "react-native";

import { retryWhenActive } from "../retry-when-active";

let listeners: ((state: string) => void)[];
let removed: number;
let spy: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  listeners = [];
  removed = 0;
  spy = jest.spyOn(AppState, "addEventListener").mockImplementation(((
    _type: string,
    cb: (state: string) => void,
  ) => {
    listeners.push(cb);
    return {
      remove: () => {
        removed += 1;
        listeners = listeners.filter((l) => l !== cb);
      },
    };
  }) as never);
});
afterEach(() => spy.mockRestore());

const emit = (state: string) => [...listeners].forEach((l) => l(state));

describe("retryWhenActive", () => {
  it("还在后台 / 刚变成 inactive 不触发；回到前台触发一次并摘掉监听", () => {
    const retry = jest.fn();
    retryWhenActive("a", retry);
    emit("background");
    emit("inactive");
    expect(retry).not.toHaveBeenCalled();
    emit("active");
    expect(retry).toHaveBeenCalledTimes(1);
    expect(removed).toBe(1);
    emit("active");
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("同一个 key 连着登记几次只挂一个监听；不同 key 各挂各的；触发过之后可以再登记", () => {
    const a = jest.fn();
    const b = jest.fn();
    retryWhenActive("x", a);
    retryWhenActive("x", a);
    retryWhenActive("y", b);
    expect(listeners).toHaveLength(2);
    emit("active");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    retryWhenActive("x", a);
    expect(listeners).toHaveLength(1);
  });
});
