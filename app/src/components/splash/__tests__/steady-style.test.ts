// steady()：样式没变就交回同一个对象（Reanimated 靠比引用判断要不要往原生推更新，见 steady-style.ts）
import { describe, expect, it } from "@jest/globals";

import { steady } from "../steady-style";

describe("steady", () => {
  it("数值都一样时交回上一次那个对象，包括 transform 这种每次新建的数组", () => {
    const a = steady("t.same", {
      opacity: 1,
      transform: [{ translateY: 0 }, { scale: 1 }],
    });
    const b = steady("t.same", {
      opacity: 1,
      transform: [{ translateY: 0 }, { scale: 1 }],
    });
    expect(b).toBe(a);
  });

  it("有一项变了就交出新的，之后以新的为准", () => {
    const a = steady("t.move", { transform: [{ translateY: 0 }] });
    const b = steady("t.move", { transform: [{ translateY: 4 }] });
    expect(b).not.toBe(a);
    expect(steady("t.move", { transform: [{ translateY: 4 }] })).toBe(b);
    // 回到最初的值也算变了
    expect(steady("t.move", { transform: [{ translateY: 0 }] })).not.toBe(b);
  });

  it("多一项、少一项、transform 里换了种类或个数，都算变了", () => {
    const a = steady("t.shape", { opacity: 1, transform: [{ scale: 1 }] });
    expect(steady("t.shape", { transform: [{ scale: 1 }] })).not.toBe(a);
    const b = steady("t.shape", { opacity: 1, transform: [{ scale: 1 }] });
    expect(
      steady("t.shape", { opacity: 1, transform: [{ translateX: 1 }] }),
    ).not.toBe(b);
    const c = steady("t.shape", { opacity: 1, transform: [{ scale: 1 }] });
    expect(
      steady("t.shape", {
        opacity: 1,
        transform: [{ scale: 1 }, { rotate: "0deg" }],
      }),
    ).not.toBe(c);
  });

  it("交出去的对象被就地改过（Reanimated 会把颜色换成数字），不影响下一次的判断", () => {
    const a = steady("t.color", { color: "rgb(174,180,192)", opacity: 1 });
    (a as { color: unknown }).color = 0xffaeb4c0;
    // 同样的输入：还是交回那一个
    expect(steady("t.color", { color: "rgb(174,180,192)", opacity: 1 })).toBe(
      a,
    );
    expect(
      steady("t.color", { color: "rgb(255,255,255)", opacity: 1 }),
    ).not.toBe(a);
  });

  it("不同的 id 各记各的", () => {
    const a = steady("t.one", { opacity: 0.5 });
    const b = steady("t.two", { opacity: 0.5 });
    expect(b).not.toBe(a);
    expect(steady("t.one", { opacity: 0.5 })).toBe(a);
  });
});
