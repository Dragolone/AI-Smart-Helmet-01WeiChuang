// 隐私政策 / 用户服务协议阅读页（2026-09-23 改版）：路由参数 doc = privacy | terms。
// 正文由后端托管（`/legal/<doc>`，见 constants/legal.ts），本页只是个 WebView 壳子——
// 从前这里渲染 messages/legal.ts 里的内置草案，与托管版内容已分叉；隐私政策必须单一来源，
// 否则包里两份口径不同的政策会卡上架审核（也会让「同意」这个动作指向不确定的内容）。
import { Stack } from "expo-router";
import { useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";

import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { legalUrl, parseLegalDoc, type LegalDoc } from "@/constants/legal";
import { useRouteParams } from "@/hooks/use-route-params";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";

export { RouteErrorBoundary as ErrorBoundary } from "@/components/route-error-boundary";

export default function LegalDocScreen() {
  const t = useT();
  const theme = useTheme();
  const params = useRouteParams<{ doc?: string }>();
  const doc: LegalDoc = parseLegalDoc(params.doc);
  const url = legalUrl(doc);
  // 重试靠换 key 强制重建 WebView：onError 之后单纯 reload() 在 Android 上不稳
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(!url);

  const retry = () => {
    setFailed(!url);
    setAttempt((n) => n + 1);
  };

  return (
    <ThemedView style={styles.flex}>
      <Stack.Screen options={{ title: t(`legal.${doc}.title`) }} />
      {failed ? (
        <View style={styles.center}>
          <ThemedText type="default" style={styles.errorText}>
            {t("legal.loadError")}
          </ThemedText>
          <Pressable onPress={retry} hitSlop={8}>
            <ThemedText type="link">{t("legal.retry")}</ThemedText>
          </Pressable>
          {url ? (
            <Pressable onPress={() => void Linking.openURL(url)} hitSlop={8}>
              <ThemedText type="link">{t("legal.openInBrowser")}</ThemedText>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <WebView
          key={attempt}
          source={{ uri: url }}
          style={{ backgroundColor: theme.background }}
          onError={() => setFailed(true)}
          onHttpError={() => setFailed(true)}
        />
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 24,
  },
  errorText: { textAlign: "center" },
});
