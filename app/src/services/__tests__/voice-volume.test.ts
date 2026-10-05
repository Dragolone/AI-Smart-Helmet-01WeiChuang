// 对讲发言指示：音量回调每 300 ms 一次，只有「谁在发言」变了才需要重画。
import { describe, expect, it } from "@jest/globals";

import { sameSpeakers } from "../voice-volume";

const T = 10;

describe("sameSpeakers", () => {
  it("音量数值在变但没人跨过阈值：算相同（不重画）", () => {
    expect(sameSpeakers({ a: 0, b: 3 }, { a: 2, b: 9 }, T)).toBe(true);
    expect(sameSpeakers({ a: 40, b: 0 }, { a: 85, b: 1 }, T)).toBe(true);
  });

  it("有人开口或闭口：算不同", () => {
    expect(sameSpeakers({ a: 0 }, { a: 10 }, T)).toBe(false);
    expect(sameSpeakers({ a: 55 }, { a: 9 }, T)).toBe(false);
  });

  it("阈值是闭区间下界：恰好等于阈值算在发言", () => {
    expect(sameSpeakers({ a: 9 }, { a: 10 }, T)).toBe(false);
    expect(sameSpeakers({ a: 10 }, { a: 11 }, T)).toBe(true);
  });

  it("成员进出回调名单：没出现的人按 0 算——安静的人消失算相同，在发言的人消失算不同", () => {
    expect(sameSpeakers({ a: 3, b: 0 }, { a: 3 }, T)).toBe(true);
    expect(sameSpeakers({ a: 3 }, { a: 3, b: 0 }, T)).toBe(true);
    expect(sameSpeakers({ a: 3, b: 60 }, { a: 3 }, T)).toBe(false);
    expect(sameSpeakers({ a: 3 }, { a: 3, b: 60 }, T)).toBe(false);
  });

  it("两张空表相同；退房清空时原来有人在发言则不同", () => {
    expect(sameSpeakers({}, {}, T)).toBe(true);
    expect(sameSpeakers({ a: 70 }, {}, T)).toBe(false);
  });
});
