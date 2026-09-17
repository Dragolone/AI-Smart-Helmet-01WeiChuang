// 「App 别关」一次性提示：头盔第一次连上时弹一次。
// 真机实测（2026-09-17）：用户从多任务里上滑关闭 App 后，双端都不会被头盔事件拉起，摔倒要等下次打开才通知；
// 锁屏/退后台没关系。华为再补一句「最近任务里锁定本应用」。
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import { Modal, Platform, Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";

import { PrimaryButton } from "@/components/form";
import { ThemedText } from "@/components/themed-text";
import { Radius } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";
import { useBleStore } from "@/stores/ble-store";

const SHOWN_KEY = "keepalive_tip_shown";

export function KeepAliveTip() {
  const theme = useTheme();
  const t = useT();
  const anyConnected = useBleStore((s) =>
    Object.values(s.links).some((l) => l.phase === "connected"),
  );
  const [shown, setShown] = useState<boolean | null>(null);
  useEffect(() => {
    SecureStore.getItemAsync(SHOWN_KEY)
      .then((v) => setShown(v === "1"))
      .catch(() => setShown(false));
  }, []);
  // 可见性由状态推导（不在 effect 里 setState）：首次连上 且 从未展示过
  const visible = anyConnected && shown === false;

  const close = () => {
    setShown(true);
    SecureStore.setItemAsync(SHOWN_KEY, "1").catch(() => undefined);
  };

  if (!visible) return null;
  return (
    <Modal transparent animationType="none" onRequestClose={close}>
      <Animated.View entering={FadeIn.duration(180)} style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} />
        <Animated.View
          entering={FadeInDown.duration(240)}
          style={[
            styles.card,
            {
              backgroundColor: theme.backgroundElement,
              borderColor: theme.border,
            },
          ]}
        >
          <ThemedText type="subtitle">{t("keepalive.title")}</ThemedText>
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.body}
          >
            {t("keepalive.body")}
          </ThemedText>
          {Platform.OS === "android" && (
            <View
              style={[
                styles.tip,
                { backgroundColor: theme.backgroundSelected },
              ]}
            >
              <ThemedText type="small" style={styles.tipText}>
                {t("keepalive.androidTip")}
              </ThemedText>
            </View>
          )}
          <PrimaryButton title={t("keepalive.ok")} onPress={close} />
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 380,
    borderRadius: Radius.card,
    borderWidth: 1,
    padding: 20,
    gap: 14,
  },
  body: { lineHeight: 20 },
  tip: { borderRadius: 12, padding: 12 },
  tipText: { lineHeight: 19 },
});
