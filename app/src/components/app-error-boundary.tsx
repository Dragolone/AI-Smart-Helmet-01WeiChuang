// 根级错误边界：渲染期未捕获异常在 Release 下等于整 App 退出/白屏，这里兜成一屏「出错了 · 重试」。
// 只兜 React 渲染错误；异步/事件错误由各处 try/catch + Toast 处理。开发构建保留 RN 红屏（不拦）。
import { Ionicons } from "@expo/vector-icons";
import { Component, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { PrimaryButton } from "@/components/form";
import { ThemedText } from "@/components/themed-text";
import { Colors } from "@/constants/theme";
import { translate } from "@/i18n";
import { devLog } from "@/services/dev-log";

type State = { error: Error | null };

export class AppErrorBoundary extends Component<
  { children: ReactNode; scheme: "light" | "dark" },
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    devLog("CRASH", `${error.message}\n${info.componentStack ?? ""}`);
  }

  render() {
    if (!this.state.error || __DEV__) return this.props.children;
    const c = Colors[this.props.scheme];
    return (
      <View style={[styles.wrap, { backgroundColor: c.background }]}>
        <View style={[styles.icon, { backgroundColor: c.backgroundSelected }]}>
          <Ionicons name="warning-outline" size={30} color={c.textSecondary} />
        </View>
        <ThemedText type="subtitle" style={styles.title}>
          {translate("app.crashTitle")}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.body}>
          {translate("app.crashBody")}
        </ThemedText>
        <PrimaryButton
          compact
          title={translate("app.crashRetry")}
          onPress={() => this.setState({ error: null })}
          style={styles.btn}
        />
      </View>
    );
  }
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 10,
  },
  icon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  title: { textAlign: "center" },
  body: { textAlign: "center", lineHeight: 20, maxWidth: 300 },
  btn: { marginTop: 14, minWidth: 180 },
});
