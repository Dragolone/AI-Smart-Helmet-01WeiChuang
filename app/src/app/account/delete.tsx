// 注销账号（已登录）：DELETE /users/me 带密码；成功后只清本地会话（服务端账号已不存在，不再调 logout），
// 登录门控翻转自动回到登录页。
import { Ionicons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";

import type { Sos } from "@helmet/shared";
import { authApi } from "@/api/auth";
import { isSessionEnded, toUserMessage } from "@/api/error-messages";
import { FormError, FormInput, PrimaryButton } from "@/components/form";
import { KeyboardAvoid } from "@/components/keyboard-avoid";
import { Card } from "@/components/list";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { showToast } from "@/components/toast";
import { useTheme } from "@/hooks/use-theme";
import { translate, useT, type MessageKey } from "@/i18n";
import { discardRelayQueue } from "@/services/ble-relay-uplink";
import { accountSecureKeysOf, SECURE_KEYS } from "@/services/secure-keys";
import { firstActiveSos } from "@/services/active-sos";
import { sosActiveHref } from "@/services/sos-routes";
import { useAuthStore } from "@/stores/auth-store";

export { RouteErrorBoundary as ErrorBoundary } from "@/components/route-error-boundary";

const CONSEQUENCES: {
  icon: keyof typeof Ionicons.glyphMap;
  key: MessageKey;
}[] = [
  { icon: "hardware-chip-outline", key: "auth.deleteConsequenceDevices" },
  { icon: "call-outline", key: "auth.deleteConsequenceContacts" },
  { icon: "document-text-outline", key: "auth.deleteConsequenceRecords" },
  { icon: "phone-portrait-outline", key: "auth.deleteConsequencePhone" },
];

/**
 * 这个账号留在本机的东西：BLE 中转的积压队列文件、按账号存的几条设置（已绑头盔缓存、当前头盔、
 * 演练 / 一直开麦说明看没看过、换头盔提醒开关）。账号已经不存在，留着就是一份没人管的个人数据（10-17 评审）。
 * 删失败不影响注销本身。
 */
async function forgetAccountLocalData(userId: string): Promise<void> {
  discardRelayQueue(userId);
  await Promise.all(
    accountSecureKeysOf(userId).map((key) =>
      SecureStore.deleteItemAsync(key).catch(() => undefined),
    ),
  );
}

export default function DeleteAccountScreen() {
  const theme = useTheme();
  const t = useT();
  const dropSession = useAuthStore((s) => s.dropSession);
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const deleteAccount = async () => {
    setBusy(true);
    // 清会话之后就拿不到了：先记下是谁
    const userId = useAuthStore.getState().user?.id;
    try {
      await authApi.deleteMe({ password });
      showToast(translate("auth.deleteDone"));
      // 账号已不存在：登录页不再预填这个手机号（登出保留是为了方便，注销不该留）
      await SecureStore.deleteItemAsync(SECURE_KEYS.lastLoginPhone).catch(
        () => undefined,
      );
      // 清会话即触发 Stack.Protected 切到登录组，无需手动导航
      await dropSession();
      // 放在清会话之后：链路停下来时不再替这个账号落盘，设备列表也不会再替它存一份
      if (userId) await forgetAccountLocalData(userId);
    } catch (e) {
      // 会话已失效：正被送回登录页，登录页自有说明
      if (isSessionEnded(e)) return;
      setError(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setError(null);
    if (password.length < 8) {
      setError(t("auth.passwordTooShort"));
      return;
    }
    // 有进行中的求救时不让注销（O15，负责人 10-21 定）：注销会连紧急联系人一起删掉，那一单到点照样变「已通知」，
    // 却一条短信都发不出去。服务器那头也会拦（上线清单 B 线 16），这里先拦住、说清楚；查不了（断网）也注销不了
    setBusy(true);
    let active: Sos | null;
    try {
      active = await firstActiveSos(queryClient);
    } catch (e) {
      if (!isSessionEnded(e)) setError(toUserMessage(e));
      return;
    } finally {
      setBusy(false);
    }
    if (active) {
      const sos = active;
      Alert.alert(
        translate("auth.deleteBlockedSosTitle"),
        translate("auth.deleteBlockedSosBody"),
        [
          { text: translate("common.cancel"), style: "cancel" },
          {
            text: translate("auth.deleteBlockedSosOpen"),
            onPress: () =>
              router.navigate(sosActiveHref(sos.sosId, sos.deviceId)),
          },
        ],
      );
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
      <KeyboardAvoid>
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
            onPress={() => void confirm()}
            loading={busy}
          />
        </View>
      </KeyboardAvoid>
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
