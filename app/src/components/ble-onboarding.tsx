// 首次连接引导（决策 #41 落地后的第一屏）：开蓝牙 → 允许权限 → 加省电白名单（Android）。
// 每步带「去设置」，全部满足自动消失；被用户收起后只在出现硬阻塞（蓝牙关/权限拒）时再出现。
// 蓝牙版头盔所有事件都靠这条链路，新用户不知道要开蓝牙/给权限就等于没戴头盔。
import { Ionicons } from "@expo/vector-icons";
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import { AppState, Linking, Platform, StyleSheet, View } from "react-native";
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";
import { HelmetLinkService } from "helmet-link-service";

import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { Radius } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";
import { useBleStore } from "@/stores/ble-store";

const DISMISS_KEY = "ble_onboarding_dismissed";

type Step = {
  key: "bluetooth" | "permission" | "whitelist";
  done: boolean;
  blocking: boolean;
  action: () => void;
};

async function openBluetoothSettings(): Promise<void> {
  if (Platform.OS === "android") {
    await Linking.sendIntent("android.settings.BLUETOOTH_SETTINGS").catch(() =>
      Linking.openSettings(),
    );
    return;
  }
  // iOS 不允许直接跳蓝牙面板（私有 URL 会被拒审），只能到本 App 设置页并提示走控制中心
  await Linking.openSettings();
}

/** 引导步骤的当前状态；Android 白名单状态在回到前台时重查 */
export function useBleOnboardingSteps(): Step[] {
  const adapter = useBleStore((s) => s.adapter);
  const [whitelisted, setWhitelisted] = useState(() =>
    HelmetLinkService.isIgnoringBatteryOptimizations(),
  );
  // 用户去系统设置改完白名单回来时重查一次（回前台事件），不用每 2 s 轮询原生
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      const now = HelmetLinkService.isIgnoringBatteryOptimizations();
      setWhitelisted((prev) => (prev === now ? prev : now));
    });
    return () => sub.remove();
  }, []);
  const steps: Step[] = [
    {
      key: "bluetooth",
      done: adapter === "on",
      blocking: adapter === "off",
      action: () => void openBluetoothSettings(),
    },
    {
      key: "permission",
      done: adapter !== "unauthorized",
      blocking: adapter === "unauthorized",
      action: () => void Linking.openSettings(),
    },
  ];
  if (Platform.OS === "android" && HelmetLinkService.available) {
    steps.push({
      key: "whitelist",
      done: whitelisted,
      blocking: false,
      action: () => HelmetLinkService.requestIgnoreBatteryOptimizations(),
    });
  }
  return steps;
}

export function BleOnboardingCard() {
  const theme = useTheme();
  const t = useT();
  const steps = useBleOnboardingSteps();
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  useEffect(() => {
    SecureStore.getItemAsync(DISMISS_KEY)
      .then((v) => setDismissed(v === "1"))
      .catch(() => setDismissed(false));
  }, []);

  const adapter = useBleStore((s) => s.adapter);
  const allDone = steps.every((s) => s.done);
  const hasBlocker = steps.some((s) => s.blocking);
  // 模拟器/无蓝牙硬件：引导没有意义
  if (adapter === "unsupported" || adapter === "unknown") return null;
  if (dismissed === null || allDone) return null;
  if (dismissed && !hasBlocker) return null;

  const dismiss = () => {
    setDismissed(true);
    SecureStore.setItemAsync(DISMISS_KEY, "1").catch(() => undefined);
  };

  return (
    <Animated.View
      entering={FadeInDown.duration(260)}
      exiting={FadeOut.duration(180)}
      style={[
        styles.card,
        { backgroundColor: theme.backgroundElement, borderColor: theme.brand },
      ]}
    >
      <View style={styles.head}>
        <ThemedText type="smallBold" style={{ fontSize: 15 }}>
          {t("ble.onboarding.title")}
        </ThemedText>
        {!hasBlocker && (
          <Tappable
            feedback="opacity"
            accessibilityRole="button"
            accessibilityLabel={t("common.close")}
            onPress={dismiss}
            hitSlop={8}
          >
            <Ionicons name="close" size={18} color={theme.textSecondary} />
          </Tappable>
        )}
      </View>
      <ThemedText type="small" themeColor="textSecondary" style={styles.body}>
        {t("ble.onboarding.body")}
      </ThemedText>
      {steps.map((step, i) => (
        <View key={step.key} style={styles.row}>
          <View
            style={[
              styles.badge,
              {
                backgroundColor: step.done
                  ? theme.success
                  : theme.backgroundSelected,
              },
            ]}
          >
            {step.done ? (
              <Ionicons name="checkmark" size={14} color="#0E0F12" />
            ) : (
              <ThemedText type="smallBold" style={styles.badgeText}>
                {i + 1}
              </ThemedText>
            )}
          </View>
          <View style={styles.rowText}>
            <ThemedText type="smallBold">
              {t(`ble.onboarding.${step.key}`)}
            </ThemedText>
            {!step.done && (
              <ThemedText type="label" themeColor="textSecondary">
                {t(`ble.onboarding.${step.key}Hint`)}
              </ThemedText>
            )}
          </View>
          {!step.done && (
            <Tappable
              feedback="scale"
              onPress={step.action}
              style={[styles.goBtn, { backgroundColor: theme.brand }]}
            >
              <ThemedText
                type="smallBold"
                style={{ color: theme.onBrand, fontSize: 13 }}
              >
                {t("ble.onboarding.go")}
              </ThemedText>
            </Tappable>
          )}
        </View>
      ))}
    </Animated.View>
  );
}

/** 设备首页的一行横幅：只在硬阻塞（蓝牙关 / 权限拒）时出现，点了去设备页看完整引导 */
export function BleBlockerBanner({ onPress }: { onPress: () => void }) {
  const theme = useTheme();
  const t = useT();
  const adapter = useBleStore((s) => s.adapter);
  if (adapter !== "off" && adapter !== "unauthorized") return null;
  return (
    <Animated.View
      entering={FadeInDown.duration(220)}
      exiting={FadeOut.duration(160)}
    >
      <Tappable
        feedback="fill"
        onPress={onPress}
        style={[
          styles.banner,
          { backgroundColor: theme.dangerBg, borderColor: theme.danger },
        ]}
      >
        <Ionicons name="bluetooth" size={16} color={theme.danger} />
        <ThemedText
          type="small"
          style={[styles.bannerText, { color: theme.danger }]}
        >
          {t(adapter === "off" ? "ble.banner.off" : "ble.banner.unauthorized")}
        </ThemedText>
        <Ionicons name="chevron-forward" size={16} color={theme.danger} />
      </Tappable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: Radius.card, borderWidth: 1, padding: 16, gap: 12 },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  body: { lineHeight: 19, marginTop: -4 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  badge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { fontSize: 12, lineHeight: 16 },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  goBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: Radius.pill,
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: Radius.card,
    borderWidth: 1,
  },
  bannerText: { flex: 1, minWidth: 0, lineHeight: 18 },
});
