// 表单错误跟着输入走：本地校验没过只记「错在哪一条」、改好就收、不提前跳下一条；
// 服务端 / 发码的错存一份输入快照，任一输入变了就收
import { describe, expect, it } from "@jest/globals";
import { useState } from "react";
import { act, create } from "react-test-renderer";

import { useFormErrors, type FormProblem } from "../use-form-errors";

type Form = ReturnType<typeof useFormErrors>;

/** 两个输入框：a 要非空、b 要非空；a 先 b 后，各一条 */
function mount() {
  const h: {
    form: Form;
    a: string;
    b: string;
    consent: boolean;
    setA: (v: string) => void;
    setB: (v: string) => void;
    setConsent: (v: boolean) => void;
  } = {} as never;
  function Probe() {
    const [a, setA] = useState("");
    const [b, setB] = useState("");
    const [consent, setConsent] = useState(false);
    h.form = useFormErrors([a, b], (): FormProblem | null => {
      if (!consent) return { key: "consent", message: "先同意" };
      if (a === "") return { key: "a", message: "填 a", field: "phone" };
      if (b === "") return { key: "b", message: "填 b", field: "password" };
      return null;
    });
    Object.assign(h, { a, b, consent, setA, setB, setConsent });
    return null;
  }
  act(() => {
    create(<Probe />);
  });
  return h;
}
const set = (fn: () => void) => act(fn);

describe("useFormErrors：本地校验", () => {
  it("没过就记下是哪一条并显示；改好了就收，不提前跳到下一条", () => {
    const h = mount();
    set(() => h.setConsent(true));
    let ok = true;
    set(() => {
      ok = h.form.check();
    });
    expect(ok).toBe(false);
    expect(h.form.fieldError("phone")).toBe("填 a");
    expect(h.form.pageError).toBeNull();
    // a 填好了：下一条是 b，但那要等再点提交才说
    set(() => h.setA("x"));
    expect(h.form.fieldError("phone")).toBeNull();
    expect(h.form.fieldError("password")).toBeNull();
    set(() => {
      ok = h.form.check();
    });
    expect(ok).toBe(false);
    expect(h.form.fieldError("password")).toBe("填 b");
    set(() => h.setB("y"));
    expect(h.form.fieldError("password")).toBeNull();
    set(() => {
      ok = h.form.check();
    });
    expect(ok).toBe(true);
  });

  it("没写 field 的是页面级错误；它看的状态（勾选框）变了也跟着收", () => {
    const h = mount();
    set(() => {
      h.form.check();
    });
    expect(h.form.pageError).toBe("先同意");
    expect(h.form.fieldError("phone")).toBeNull();
    set(() => h.setConsent(true));
    expect(h.form.pageError).toBeNull();
  });

  it("没点过提交就不显示：输入再不对也没有红字", () => {
    const h = mount();
    set(() => h.setConsent(true));
    expect(h.form.pageError).toBeNull();
    expect(h.form.fieldError("phone")).toBeNull();
  });
});

describe("useFormErrors：服务端 / 发码的错误", () => {
  it("任一输入框变了就收；勾选框不算输入框", () => {
    const h = mount();
    set(() => h.form.fail("密码不对", "password"));
    expect(h.form.fieldError("password")).toBe("密码不对");
    set(() => h.setConsent(true));
    expect(h.form.fieldError("password")).toBe("密码不对");
    set(() => h.setA("x"));
    expect(h.form.fieldError("password")).toBeNull();
  });

  it("不带 field 的落到页面级", () => {
    const h = mount();
    set(() => h.form.fail("网络连接失败"));
    expect(h.form.pageError).toBe("网络连接失败");
    set(() => h.setB("y"));
    expect(h.form.pageError).toBeNull();
  });

  it("快照取错误到达那一刻的输入：请求在途时用户又改了，错误照样露出来，下一次改动才收", () => {
    const h = mount();
    const fail = h.form.fail; // 请求发出时拿到的那一份，到达时才调
    set(() => h.setA("改在请求途中"));
    set(() => fail("网络连接失败"));
    expect(h.form.pageError).toBe("网络连接失败");
    set(() => h.setA("再改"));
    expect(h.form.pageError).toBeNull();
  });

  it("再次提交（check）和 clear 都会清掉上一条服务端错误", () => {
    const h = mount();
    set(() => h.form.fail("网络连接失败"));
    set(() => {
      h.form.check();
    });
    expect(h.form.pageError).toBe("先同意");
    set(() => h.form.fail("网络连接失败"));
    set(() => h.form.clear());
    expect(h.form.pageError).toBeNull();
  });
});
