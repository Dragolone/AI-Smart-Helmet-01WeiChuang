// 只有一个按钮、看完就关的系统提示框。
// 不传按钮时 Android 用系统自带的英文「OK」（中文界面也是，2026-10-16 华为实测），所以这类提示统一走这里。
import { Alert } from "react-native";

import { isSessionEnded, toUserMessage } from "@/api/error-messages";
import { translate } from "@/i18n";

export function showNotice(title: string, message?: string): void {
  Alert.alert(title, message, [{ text: translate("common.confirm") }]);
}

/**
 * 接口失败的提示框：标题 + 原因（默认按错误码，调用方可给自己的说明）。
 * 会话已被服务端否定时不弹：界面正被送回登录页，登录页顶部（App 在后台时是本地通知）已经说了登录失效，
 * 这里再弹一个「XX 失败 · 登录已失效」就是同一件事说两遍，而且是压在登录页上面（10-17 评审）
 */
export function showFailure(
  title: string,
  err: unknown,
  message?: string,
): void {
  if (isSessionEnded(err)) return;
  showNotice(title, message ?? toUserMessage(err));
}
