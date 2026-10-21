// 页面级错误边界：每个页面文件导出 ErrorBoundary = 它（expo-router 用它包住这一页）。一页渲染出错只换掉这一页，
// 底部标签栏、别的页面和求救倒计时页照常能用；根上的 AppErrorBoundary 只剩兜布局层的错误。
// 10-21 夜测：接口应答字段类型不对（后端契约漂移）时，地图 / 对讲 / 我的这几个常驻标签页一出错，根上的错误边界把整个 App
// 换成「页面暂时无法显示」，标签栏都没了，来单时倒计时页也弹不出来。
import { Ionicons } from "@expo/vector-icons";
import type { ErrorBoundaryProps } from "expo-router";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";

import { PrimaryButton } from "@/components/form";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";
import { devLog } from "@/services/dev-log";

export function RouteErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const theme = useTheme();
  const t = useT();
  useEffect(() => {
    devLog("CRASH", `页面：${error.message}\n${error.stack ?? ""}`);
  }, [error]);
  return (
    <ThemedView style={styles.wrap}>
      <View
        style={[styles.icon, { backgroundColor: theme.backgroundSelected }]}
      >
        <Ionicons
          name="warning-outline"
          size={30}
          color={theme.textSecondary}
        />
      </View>
      <ThemedText type="subtitle" style={styles.center}>
        {t("app.crashTitle")}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary" style={styles.center}>
        {t("app.pageCrashBody")}
      </ThemedText>
      <PrimaryButton
        compact
        title={t("app.crashRetry")}
        onPress={() => void retry()}
        style={styles.btn}
      />
    </ThemedView>
  );
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
  center: { textAlign: "center" },
  btn: { marginTop: 8, alignSelf: "center" },
});
