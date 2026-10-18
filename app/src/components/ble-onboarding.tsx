// 首次连接引导（决策 #41 落地后的第一屏）：开蓝牙 → 允许权限 → 加省电白名单（Android）。
// 每步带「去设置」。蓝牙版头盔所有事件都靠这条链路，新用户不知道要开蓝牙/给权限就等于没戴头盔。
// 这里有三样：三步的状态与入口（useBleOnboardingSteps，设备详情状态卡、安全设置页也用）、
// 设备详情页第一次进入时弹一次的引导面板（BleFirstConnectGuide）、设备首页的硬阻塞横幅（BleBlockerBanner）。
import { Ionicons } from "@expo/vector-icons";
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import {
  AppState,
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { HelmetLinkService } from "helmet-link-service";

import { SecondaryButton } from "@/components/form";
import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { Radius } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";
import { bleNeedsLocationPermission } from "@/services/ble-platform";
import { SECURE_KEYS } from "@/services/secure-keys";
import { useBleStore } from "@/stores/ble-store";

const DISMISS_KEY = SECURE_KEYS.bleOnboardingDismissed;

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

/** 步骤文案用哪一套：安卓 12 以下「允许使用蓝牙」那一步实际要开的是位置信息（见 services/ble-platform） */
function stepCopyOf(key: Step["key"]): Step["key"] | "permissionLocation" {
  return key === "permission" && bleNeedsLocationPermission()
    ? "permissionLocation"
    : key;
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

/**
 * 首次连接引导（设备详情页）：进入页面时从底部弹出一次，三步各带「去设置」。
 * 2026-10-06 设备详情改版前它是一张常驻在页面顶部的卡片；改版后头盔的连接、权限、后台运行状态
 * 都写在状态卡对应的行里，常驻卡片会把同一件事说两遍，所以改成只在第一次需要时弹一次：
 * - 三步里还有没做的、且用户从没关过它 → 弹；
 * - 用户关掉、或三步都做完 → 记下来，之后不再弹（沿用原来那张卡片的「已收起」标记，
 *   收起过旧卡片的用户不会再被打扰）。之后蓝牙被关、权限被收回，由状态卡里的行提示。
 */
export function BleFirstConnectGuide() {
  const theme = useTheme();
  const t = useT();
  const insets = useSafeAreaInsets();
  const steps = useBleOnboardingSteps();
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  // 等页面进场动画走完再弹：转场中途弹 Modal，iOS 上可能弹不出来
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    SecureStore.getItemAsync(DISMISS_KEY)
      .then((v) => setDismissed(v === "1"))
      .catch(() => setDismissed(false));
    const id = setTimeout(() => setSettled(true), 450);
    return () => clearTimeout(id);
  }, []);

  const adapter = useBleStore((s) => s.adapter);
  const allDone = steps.every((s) => s.done);
  // 三步都做完了：引导的任务已经完成，记为看过（以后关蓝牙不会把它再弹出来）
  useEffect(() => {
    if (dismissed !== false || !allDone) return;
    SecureStore.setItemAsync(DISMISS_KEY, "1")
      .catch(() => undefined)
      .then(() => setDismissed(true));
  }, [dismissed, allDone]);

  const dismiss = () => {
    setDismissed(true);
    SecureStore.setItemAsync(DISMISS_KEY, "1").catch(() => undefined);
  };

  const visible =
    settled &&
    dismissed === false &&
    !allDone &&
    // 模拟器/无蓝牙硬件、蓝牙状态还没确定：引导没有意义
    adapter !== "unsupported" &&
    adapter !== "unknown";

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={dismiss}
    >
      <View style={styles.mask}>
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel={t("common.close")}
          onPress={dismiss}
        />
        <Animated.View
          entering={FadeInDown.duration(220)}
          accessibilityViewIsModal
          style={[
            styles.sheet,
            {
              backgroundColor: theme.backgroundElement,
              borderColor: theme.border,
              paddingBottom: Math.max(insets.bottom, 12) + 8,
            },
          ]}
        >
          <View style={styles.head}>
            <ThemedText type="smallBold" style={styles.sheetTitle}>
              {t("ble.onboarding.title")}
            </ThemedText>
            <Tappable
              feedback="opacity"
              accessibilityRole="button"
              accessibilityLabel={t("common.close")}
              onPress={dismiss}
              style={[
                styles.close,
                { backgroundColor: theme.backgroundSelected },
              ]}
            >
              <Ionicons name="close" size={20} color={theme.text} />
            </Tappable>
          </View>
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.body}
          >
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
                  {t(`ble.onboarding.${stepCopyOf(step.key)}`)}
                </ThemedText>
                {/* 说明是整句话：不用全大写的 label 样式（英文下一整句大写读起来费劲，2026-10-15） */}
                {!step.done && (
                  <ThemedText type="small" themeColor="textSecondary">
                    {t(`ble.onboarding.${stepCopyOf(step.key)}Hint`)}
                  </ThemedText>
                )}
              </View>
              {!step.done && (
                <Tappable
                  feedback="scale"
                  accessibilityRole="button"
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
          <SecondaryButton title={t("keepalive.ok")} onPress={dismiss} />
        </Animated.View>
      </View>
    </Modal>
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
          {t(
            adapter === "off"
              ? "ble.banner.off"
              : bleNeedsLocationPermission()
                ? "ble.banner.unauthorizedLocation"
                : "ble.banner.unauthorized",
          )}
        </ThemedText>
        <Ionicons name="chevron-forward" size={16} color={theme.danger} />
      </Tappable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  mask: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
    padding: 10,
  },
  sheet: { borderRadius: 24, borderWidth: 1, padding: 20, gap: 14 },
  sheetTitle: { fontSize: 20, lineHeight: 26, flexShrink: 1 },
  close: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  body: { lineHeight: 20, marginTop: -6 },
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
