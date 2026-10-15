// 链接对不上任何页面时显示这一页（App 的链接前缀 app:// 别的 App 也在用，外面传进来什么都有可能）。
// 不放这一页时是路由库自带的英文「Unmatched Route」：不跟语言、把整条链接原样印出来、也没有回首页的按钮（2026-10-15 边界测试）。
import { router } from "expo-router";
import { StyleSheet } from "react-native";

import { EmptyState } from "@/components/empty-state";
import { ThemedView } from "@/components/themed-view";
import { useT } from "@/i18n";

export default function NotFoundScreen() {
  const t = useT();
  return (
    <ThemedView style={styles.wrap}>
      <EmptyState
        icon="unlink-outline"
        title={t("notFound.title")}
        body={t("notFound.body")}
        actionLabel={t("notFound.home")}
        // 未登录时「/」被登录门控挡住、会落到登录页，正好
        onAction={() => router.replace("/")}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: "center", paddingHorizontal: 24 },
});
