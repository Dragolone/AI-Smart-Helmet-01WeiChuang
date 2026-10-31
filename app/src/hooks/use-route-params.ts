// 页面读路由参数一律经这里，每个参数只取一个值（10-22 夜测）：链接里同一个参数写了两次（…?sosId=a&sosId=b）时
// expo-router 给的是数组，类型上却声明成 string——倒计时页拿数组当单号无限重渲染、扫码绑定页把数组塞进输入框抛错，
// 两页都崩到错误页（倒计时页全屏、禁了手势返回，iOS 上只剩杀掉 App）。数组取第一个，与 URLSearchParams.get 一致。
import { useLocalSearchParams } from "expo-router";

export function firstParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function useRouteParams<
  T extends Record<string, string | undefined>,
>(): T {
  const raw = useLocalSearchParams<Record<string, string | string[]>>();
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const one = firstParam(value);
    if (one !== undefined) out[key] = one;
  }
  return out as T;
}

/**
 * 登录页 ↔ 找回密码页经路由参数互相带的号码：只认 1–11 位纯数字，其余（乱写的链接）当没有。
 * 带的是用户在页面里填的号码，不写日志、不落盘，只在 App 内导航用。
 */
export const phoneFromParam = (value: string | undefined): string =>
  value !== undefined && /^\d{1,11}$/.test(value) ? value : "";
