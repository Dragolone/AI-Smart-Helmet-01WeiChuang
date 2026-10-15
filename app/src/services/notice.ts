// 只有一个按钮、看完就关的系统提示框。
// 不传按钮时 Android 用系统自带的英文「OK」（中文界面也是，2026-10-16 华为实测），所以这类提示统一走这里。
import { Alert } from "react-native";

import { translate } from "@/i18n";

export function showNotice(title: string, message?: string): void {
  Alert.alert(title, message, [{ text: translate("common.confirm") }]);
}
