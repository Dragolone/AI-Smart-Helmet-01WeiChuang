// 有输入框的整页 / 居中弹层包一层：键盘升起时把内容（尤其底部的保存 / 创建 / 加入按钮）让到键盘上方。
// iOS：键盘会压住卡片底部的按钮，「已保存」成功动画也被挡住（2026-10-15 iPhone 14 Pro Max 实测，带候选栏的输入法更明显）。
// Android 同样要让：内容铺到系统栏底下（edge-to-edge）之后，系统不再替 App 把窗口缩到键盘上方，弹层和整页表单底部的
// 按钮都被键盘盖住（2026-10-17 安卓 16 模拟器实测；扫码绑定页 10-08 已因同一原因改过）。
// RN 自带的 KeyboardAvoidingView 按「相对父视图」的位置算和键盘的重叠，页面顶上有导航栏时少算导航栏那一截，
// 按钮仍被挡住一半——先量出自己在窗口里的纵向位置，作为偏移补给它。
import { useRef, useState, type ReactNode } from "react";
import { KeyboardAvoidingView, StyleSheet, View } from "react-native";

export function KeyboardAvoid({ children }: { children: ReactNode }) {
  const ref = useRef<View>(null);
  const [top, setTop] = useState(0);
  return (
    <View
      ref={ref}
      style={styles.flex}
      onLayout={() => ref.current?.measureInWindow((_x, y) => setTop(y))}
    >
      <KeyboardAvoidingView
        behavior="padding"
        keyboardVerticalOffset={top}
        style={styles.flex}
      >
        {children}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
