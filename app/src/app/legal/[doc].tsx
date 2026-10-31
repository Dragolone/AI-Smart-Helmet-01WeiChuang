// 隐私政策 / 用户服务协议阅读页（2026-09-23 改版）：路由参数 doc = privacy | terms。
// 正文由后端托管（`/legal/<doc>`，见 constants/legal.ts），本页只是个 WebView 壳子——
// 从前这里渲染 messages/legal.ts 里的内置草案，与托管版内容已分叉；隐私政策必须单一来源，
// 否则包里两份口径不同的政策会卡上架审核（也会让「同意」这个动作指向不确定的内容）。
import { Stack } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { WebView } from "react-native-webview";

import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { legalUrl, parseLegalDoc, type LegalDoc } from "@/constants/legal";
import { useRouteParams } from "@/hooks/use-route-params";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";

export { RouteErrorBoundary as ErrorBoundary } from "@/components/route-error-boundary";

/** 连接挂住时（握手不完成、服务器不回包）WebView 既不 onLoad 也不 onError，加载圈会一直转下去 */
const LOAD_TIMEOUT_MS = 15_000;

export default function LegalDocScreen() {
  const t = useT();
  const theme = useTheme();
  const params = useRouteParams<{ doc?: string }>();
  const doc: LegalDoc = parseLegalDoc(params.doc);
  const url = legalUrl(doc);
  // 重试靠换 key 强制重建 WebView：onError 之后单纯 reload() 在 Android 上不稳
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(!url);

  // 每次挂上一个新的 WebView（首次进入 / 重试）起一个超时，到点还没加载完就走下面已有的错误态（带重试）。
  // 隐私政策打不开在合规上很要紧，不能让人对着一直转的圈干等。加载完（onLoad）、出错、重试、离开页面都清掉它
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearLoadTimer = useCallback(() => {
    if (loadTimer.current) clearTimeout(loadTimer.current);
    loadTimer.current = null;
  }, []);
  useEffect(() => {
    if (!url || failed) return;
    loadTimer.current = setTimeout(() => {
      loadTimer.current = null;
      setFailed(true);
    }, LOAD_TIMEOUT_MS);
    return clearLoadTimer;
  }, [attempt, failed, url, clearLoadTimer]);

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
          // 慢网下页面出来之前整屏空白；库自带的加载视图底色是白的，深色主题下会闪一整屏白，所以自己画
          startInLoadingState
          renderLoading={() => (
            <View
              style={[
                StyleSheet.absoluteFill,
                styles.loading,
                { backgroundColor: theme.background },
              ]}
            >
              <ActivityIndicator color={theme.brand} />
            </View>
          )}
          onLoad={clearLoadTimer}
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
  // 盖在 WebView 上面（库自带的加载视图也是绝对定位铺满）
  loading: { alignItems: "center", justifyContent: "center" },
});
