// 「要不要更换当前头盔」的底部面板（设备页、安全页各挂一个，只在所在页面显示着时弹出）。
// 什么时候该问见 services/switch-reminder.ts；这里只负责问和记下回答。
// 用户点「换成 X」才会更换当前头盔；点「保持不变」、点面板外、按返回键都算不换。
// 同一对头盔这次打开 App 期间只问一次；勾了「以后不再提醒」就把安全设置里的开关关掉。
// 勾选框下面写着开关在哪（负责人 2026-10-08：关掉之后想再打开得找得到）；路径里的三个名字直接取那几处
// 界面上的文案，改了名字这里跟着变。
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useState } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { devicesApi } from "@/api/devices";
import { PrimaryButton, SecondaryButton } from "@/components/form";
import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { showToast } from "@/components/toast";
import { useCurrentHelmetChoice } from "@/hooks/use-safety";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";
import { helmetNameOf } from "@/services/safety-status";
import { useAuthStore } from "@/stores/auth-store";
import { useSwitchReminderStore } from "@/stores/switch-reminder-store";

export function SwitchHelmetPrompt() {
  const theme = useTheme();
  const t = useT();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const userId = useAuthStore((s) => s.user?.id);
  const prompt = useSwitchReminderStore((s) => s.prompt);
  const answer = useSwitchReminderStore((s) => s.answer);
  const setEnabled = useSwitchReminderStore((s) => s.setEnabled);
  const { choose } = useCurrentHelmetChoice();
  // 只读缓存里的设备列表拿名字，不发请求
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: devicesApi.list,
    enabled: false,
  });
  const [mute, setMute] = useState(false);

  if (!prompt || !userId) return null;
  const nameOf = (deviceId: string) =>
    helmetNameOf(
      devices.data?.find((d) => d.deviceId === deviceId) ?? {
        name: null,
        deviceId,
      },
    );
  const other = nameOf(prompt.otherId);
  const current = nameOf(prompt.currentId);
  const where = t("switchReminder.where", {
    tab: t("safety.title"),
    settings: t("safety.settings"),
    item: t("safetySettings.switchReminder"),
  });

  const finish = (switchTo: boolean) => {
    if (switchTo) {
      choose(prompt.otherId);
      showToast(t("switchReminder.switched", { name: other }));
    }
    answer(userId);
    if (mute) setEnabled(userId, false);
    setMute(false);
  };

  return (
    <Modal
      visible={focused}
      transparent
      statusBarTranslucent
      animationType="fade"
      onRequestClose={() => finish(false)}
    >
      <View style={styles.mask}>
        <Pressable
          accessibilityLabel={t("switchReminder.keep")}
          style={StyleSheet.absoluteFill}
          onPress={() => finish(false)}
        />
        <Animated.View
          entering={FadeInDown.duration(220)}
          accessibilityViewIsModal
          style={[
            styles.sheet,
            {
              backgroundColor: theme.backgroundElement,
              borderColor: theme.border,
              // 与其它底部面板同一口径（ble-onboarding）：底部让出安全区
              paddingBottom: Math.max(insets.bottom, 12) + 8,
            },
          ]}
        >
          <ThemedText
            type="smallBold"
            accessibilityRole="header"
            style={styles.title}
          >
            {t("switchReminder.title", { name: other })}
          </ThemedText>
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.body}
          >
            {t("switchReminder.body", { current })}
          </ThemedText>
          <Tappable
            feedback="opacity"
            accessibilityRole="checkbox"
            accessibilityState={{ checked: mute }}
            accessibilityHint={where}
            onPress={() => setMute((v) => !v)}
            style={styles.mute}
          >
            <View
              style={[
                styles.box,
                mute
                  ? { backgroundColor: theme.brand, borderColor: theme.brand }
                  : { borderColor: theme.borderStrong },
              ]}
            >
              {mute && (
                <Ionicons name="checkmark" size={16} color={theme.onBrand} />
              )}
            </View>
            <ThemedText type="small">{t("switchReminder.mute")}</ThemedText>
          </Tappable>
          <ThemedText
            themeColor="textSecondary"
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={styles.where}
          >
            {where}
          </ThemedText>
          <View style={styles.actions}>
            <PrimaryButton
              title={t("switchReminder.switch", { name: other })}
              onPress={() => finish(true)}
            />
            <SecondaryButton
              title={t("switchReminder.keep")}
              onPress={() => finish(false)}
            />
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  mask: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
    padding: 10,
  },
  sheet: {
    borderRadius: 24,
    borderWidth: 1,
    paddingHorizontal: 20,
    paddingTop: 22,
  },
  title: { fontSize: 20, lineHeight: 26 },
  body: { fontSize: 14, lineHeight: 21, marginTop: 8 },
  mute: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 10,
    minHeight: 44,
    marginTop: 8,
  },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  // 和勾选框后面的字左对齐（框 22 + 间距 10）
  where: { fontSize: 13, lineHeight: 19, marginLeft: 32, marginTop: -4 },
  actions: { gap: 10, marginTop: 14 },
});
