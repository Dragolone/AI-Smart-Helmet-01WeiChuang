// 表单里文字键盘的回车键：跳到下一格，最后一格直接提交。原来全 App 没接 returnKeyType / onSubmitEditing，
// 登录输完密码按回车只收键盘，还得再点「登录」。数字键盘（phone-pad / number-pad）在 iOS 上没有回车键，
// 系统限制，这里照样给上（安卓的数字键盘有），iOS 上点下一格就是了。
import { useRef } from "react";
import type { TextInput } from "react-native";

export function useEnterChain(
  count: number,
  onSubmit: () => void,
  lastKey: "go" | "done" = "go",
) {
  const inputs = useRef<(TextInput | null)[]>([]);
  return {
    /** 第 i 格（从 0 数）要展开到 FormInput 上的属性：FormInput 会把 ref 和这些原样给 TextInput */
    field: (i: number) => {
      const last = i === count - 1;
      return {
        ref: (el: TextInput | null) => {
          inputs.current[i] = el;
        },
        returnKeyType: last ? lastKey : ("next" as const),
        // 非最后一格：不收键盘，焦点直接给下一格；最后一格走默认（先收键盘再提交）
        ...(last ? null : { submitBehavior: "submit" as const }),
        onSubmitEditing: last ? onSubmit : () => inputs.current[i + 1]?.focus(),
      };
    },
    /** 比如发验证码成功后把焦点给验证码框 */
    focus: (i: number) => inputs.current[i]?.focus(),
  };
}
