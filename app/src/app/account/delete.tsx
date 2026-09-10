// 注销账号（已登录）：DELETE /users/me 带密码；成功后只清本地会话（服务端账号已不存在，不再调 logout），
// 登录门控翻转自动回到登录页。
import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";

import { authApi } from "@/api/auth";
import { toUserMessage } from "@/api/error-messages";
import { FormError, FormInput, PrimaryButton } from "@/components/form";
import { Card } from "@/components/list";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { showToast } from "@/components/toast";
import { useTheme } from "@/hooks/use-theme";
import { translate, useT, type MessageKey } from "@/i18n";
import { useAuthStore } from "@/stores/auth-store";

const CONSEQUENCES: {
  icon: keyof typeof Ionicons.glyphMap;
  key: MessageKey;
}[] = [
  { icon: "hardware-chip-outline", key: "auth.deleteConsequenceDevices" },
  { icon: "call-outline", key: "auth.deleteConsequenceContacts" },
  { icon: "document-text-outline", key: "auth.deleteConsequenceRecords" },
  { icon: "phone-portrait-outline", key: "auth.deleteConsequencePhone" },
];

export default function DeleteAccountScreen() {
  const theme = useTheme();
  const t = useT();
  const dropSession = useAuthStore((s) => s.dropSession);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const deleteAccount = async () => {
    setBusy(true);
    try {
      await authApi.deleteMe({ password });
      showToast(translate("auth.deleteDone"));
      // 清会话即触发 Stack.Protected 切到登录组，无需手动导航
      await dropSession();
    } catch (e) {
      setError(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = () => {
    setError(null);
    if (password.length < 8) {
      setError(t("auth.passwordTooShort"));
      return;
    }
    Alert.alert(
      translate("auth.deleteConfirmTitle"),
      translate("auth.deleteConfirmBody"),
      [
        { text: translate("common.cancel"), style: "cancel" },
        {
          text: translate("auth.deleteConfirmAction"),
          style: "destructive",
          onPress: () => void deleteAccount(),
        },
      ],
    );
  };

  return (
    <ThemedView style={styles.flex}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
        >
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.lead}
          >
            {t("auth.deleteLead")}
          </ThemedText>
          <Card>
            {CONSEQUENCES.map((item, i) => (
              <View
                key={item.key}
                style={[
                  styles.row,
                  i < CONSEQUENCES.length - 1 && {
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: theme.border,
                  },
                ]}
              >
                <Ionicons name={item.icon} size={20} color={theme.danger} />
                <ThemedText type="small" style={styles.rowText}>
                  {t(item.key)}
                </ThemedText>
              </View>
            ))}
          </Card>
          <FormInput
            label={t("auth.deletePasswordLabel")}
            icon="lock-closed-outline"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="current-password"
            placeholder={t("auth.currentPasswordPlaceholder")}
          />
          <FormError message={error} />
        </ScrollView>
        <View style={styles.bottom}>
          <PrimaryButton
            danger
            title={t("auth.deleteAccount")}
            onPress={confirm}
            loading={busy}
          />
        </View>
      </KeyboardAvoidingView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: 20, gap: 12 },
  lead: { fontSize: 13, lineHeight: 18, paddingHorizontal: 4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  rowText: { flex: 1, fontSize: 15 },
  bottom: { paddingHorizontal: 20, paddingTop: 6, paddingBottom: 22 },
});
