// 居中弹层里有输入框时包一层：iOS 上键盘升起会压住卡片底部的按钮（保存 / 创建 / 加入），
// 按钮的「已保存」成功动画也被挡住，用户看不到（2026-10-15 iPhone 14 Pro Max 实测，带候选栏的输入法更明显）。
// Android 的 Modal 窗口自己会随键盘缩，不需要。
import type { ReactNode } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet } from "react-native";

export function KeyboardAvoid({ children }: { children: ReactNode }) {
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.flex}
    >
      {children}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
