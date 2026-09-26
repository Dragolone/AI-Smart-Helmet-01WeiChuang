// 已登录但这台设备还没同意过隐私政策 → 一次性弹窗（评审 2026-09-26 指出的洞：
// 升级到带勾选框的版本之前就登录着的用户，会话从 SecureStore 恢复、永远不经过登录页，
// 于是永远没机会同意，极光 SDK 也就永远不初始化——被杀后的 SOS 推送对这批人是静默失效的）。
// 口径与登录/注册页一致：不同意就不能继续用（只能退出登录）；同意一次记住，不再问。
import { useState } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import Ionicons from "@expo/vector-icons/Ionicons";
import { router } from "expo-router";

import { PrimaryButton } from "@/components/form";
import { ThemedText } from "@/components/themed-text";
import { Radius } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";
import { useAuthStore } from "@/stores/auth-store";
import { useConsentStore } from "@/stores/consent-store";

export function PrivacyConsentModal() {
  const theme = useTheme();
  const t = useT();
  const authed = useAuthStore((s) => s.tokens !== null);
  const signOut = useAuthStore((s) => s.signOut);
  const hydrated = useConsentStore((s) => s.hydrated);
  const accepted = useConsentStore((s) => s.privacyAccepted);
  const accept = useConsentStore((s) => s.accept);
  const [checked, setChecked] = useState(false);

  // 可见性纯由状态推导；登录页/注册页勾过的这里永远不会出现
  const visible = authed && hydrated && !accepted;
  if (!visible) return null;

  return (
    <Modal transparent animationType="none" onRequestClose={() => undefined}>
      <Animated.View entering={FadeIn.duration(180)} style={styles.backdrop}>
        <Animated.View
          entering={FadeInDown.duration(240)}
          style={[
            styles.card,
            { backgroundColor: theme.backgroundElement, borderColor: theme.border },
          ]}
        >
          <ThemedText type="subtitle">{t("consent.title")}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.body}>
            {t("consent.body")}
          </ThemedText>
          <Pressable
            onPress={() => setChecked((v) => !v)}
            style={styles.row}
            accessibilityRole="checkbox"
            accessibilityState={{ checked }}
          >
            <Ionicons
              name={checked ? "checkbox" : "square-outline"}
              size={20}
              color={checked ? theme.brand : theme.textSecondary}
            />
            <ThemedText type="small" style={styles.text}>
              {t("auth.consentPrefix")}
              <ThemedText
                type="small"
                style={{ color: theme.brand }}
                onPress={() => router.push("/legal/terms")}
                suppressHighlighting
              >
                {t("auth.consentTerms")}
              </ThemedText>
              {t("auth.consentAnd")}
              <ThemedText
                type="small"
                style={{ color: theme.brand }}
                onPress={() => router.push("/legal/privacy")}
                suppressHighlighting
              >
                {t("auth.consentPrivacy")}
              </ThemedText>
            </ThemedText>
          </Pressable>
          <PrimaryButton
            title={t("consent.agree")}
            disabled={!checked}
            onPress={() => void accept()}
          />
          <Pressable onPress={() => void signOut()} hitSlop={8} style={styles.signOut}>
            <ThemedText type="small" themeColor="textSecondary">
              {t("consent.signOut")}
            </ThemedText>
          </Pressable>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
    padding: 16,
  },
  card: { borderWidth: 1, borderRadius: Radius.card, padding: 20, gap: 14 },
  body: { lineHeight: 20 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  text: { flex: 1, lineHeight: 20 },
  signOut: { alignSelf: "center", paddingVertical: 4 },
});
