// 表单错误跟着输入走（10-31 评审）。原来错误是页面里一份 state、只在提交开头清：
// 注销页输 3 位点注销，输到 10 位还写「至少 8 位」；登录密码错之后改密码，红框一直在。
import { useEffect, useRef, useState } from "react";

import type { FormField } from "@/components/form";

/** key = 错在哪一条（文案相同的两条，如旧密码太短 / 新密码太短，也要不同）；field 省略 = 页面级错误 */
export type FormProblem = { key: string; message: string; field?: FormField };

/**
 * inputs = 页面上所有输入框的值（服务端错误按它们是否变过来收）；validate = 提交时的本地校验，
 * 返回第一条没过的、全过返回 null（它可以读别的状态，比如同意勾选框，那些变了不影响服务端错误）。
 */
export function useFormErrors(
  inputs: readonly unknown[],
  validate: () => FormProblem | null,
) {
  // 本地校验没过：只记下错在哪一条。显示时用当前输入重跑 validate，还是这一条才显示，改好了就收，
  // 不提前跳到下一条（填一格红字满页跳更烦）
  const [failedKey, setFailedKey] = useState<string | null>(null);
  // 服务端 / 发验证码的错误查不出来：存下当时的输入，任一输入变了就收
  const [remote, setRemote] = useState<{
    problem: FormProblem;
    at: readonly unknown[];
  } | null>(null);
  // 请求在途时用户可能又改了输入：快照取错误到达那一刻的，不然刚到就被判成「已经变了」、一声不响
  const latest = useRef(inputs);
  useEffect(() => {
    latest.current = inputs;
  });

  const current = failedKey === null ? null : validate();
  const problem =
    current !== null && current.key === failedKey
      ? current
      : remote !== null &&
          remote.at.length === inputs.length &&
          remote.at.every((v, i) => Object.is(v, inputs[i]))
        ? remote.problem
        : null;

  return {
    pageError: problem && !problem.field ? problem.message : null,
    fieldError: (field: FormField) =>
      problem?.field === field ? problem.message : null,
    /** 提交开头调：全过返回 true；没过记下是哪一条、返回 false */
    check: () => {
      const found = validate();
      setRemote(null);
      setFailedKey(found?.key ?? null);
      return found === null;
    },
    /** 记一条服务端 / 发验证码的错误 */
    fail: (message: string, field?: FormField) => {
      setFailedKey(null);
      setRemote({
        problem: { key: "remote", message, field },
        at: latest.current,
      });
    },
    clear: () => {
      setFailedKey(null);
      setRemote(null);
    },
  };
}
