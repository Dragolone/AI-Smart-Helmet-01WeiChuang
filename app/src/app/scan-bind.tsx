// 扫码绑定：扫头盔/说明卡上的二维码，解析出设备号（+绑定码）后回填绑定页。
// 相机只在本页打开；权限拒绝 → 说明 + 去设置；模拟器/无相机 → 提示手输。
import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useState } from "react";
import { Linking, Platform, StyleSheet, View } from "react-native";

import { PrimaryButton, SecondaryButton } from "@/components/form";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { Radius } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";
import { parseBindQr } from "@/services/bind-qr";

export default function ScanBindScreen() {
  const theme = useTheme();
  const t = useT();
  const [permission, requestPermission] = useCameraPermissions();
  const [bad, setBad] = useState(false);
  const [done, setDone] = useState(false);

  const onScanned = ({ data }: { data: string }) => {
    if (done) return;
    const parsed = parseBindQr(data);
    if (!parsed) {
      // 扫到别的码：提示一下，继续扫
      setBad(true);
      return;
    }
    setDone(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
      () => undefined,
    );
    // dismissTo：回到底下那张绑定页并把扫到的内容带回去。原来用 replace，是把扫码页换成一张新的
    // 绑定页——视觉上又叠了一层，栈里也留下两张绑定页（2026-10-06 iPhone 实测）。
    // 栈里没有绑定页时（直接打开扫码页）自动退化为替换当前页
    router.dismissTo({
      pathname: "/bind-device",
      params: { deviceId: parsed.deviceId, bindCode: parsed.bindCode ?? "" },
    });
  };

  if (!permission) return <ThemedView style={styles.flex} />;
  if (!permission.granted) {
    return (
      <ThemedView style={styles.center}>
        <Ionicons name="camera-outline" size={44} color={theme.textSecondary} />
        <ThemedText type="subtitle" style={styles.title}>
          {t("scan.permissionTitle")}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.body}>
          {t("scan.permissionBody")}
        </ThemedText>
        {permission.canAskAgain ? (
          <PrimaryButton
            compact
            title={t("scan.allow")}
            onPress={() => void requestPermission()}
            style={styles.btn}
          />
        ) : (
          <PrimaryButton
            compact
            title={t("ble.onboarding.go")}
            onPress={() => void Linking.openSettings()}
            style={styles.btn}
          />
        )}
        <SecondaryButton
          compact
          title={t("scan.typeInstead")}
          onPress={() => router.back()}
          style={styles.btn}
        />
      </ThemedView>
    );
  }

  return (
    <View style={styles.flex}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={done ? undefined : onScanned}
      />
      {/* 取景框：四角亮线，中间留空 */}
      <View style={styles.overlay} pointerEvents="none">
        <View style={styles.frame}>
          {(["tl", "tr", "bl", "br"] as const).map((c) => (
            <View
              key={c}
              style={[styles.corner, styles[c], { borderColor: theme.brand }]}
            />
          ))}
        </View>
        <ThemedText type="small" style={styles.hint}>
          {bad ? t("scan.notBindCode") : t("scan.hint")}
        </ThemedText>
      </View>
      <View
        style={[
          styles.bottom,
          { paddingBottom: Platform.OS === "ios" ? 34 : 20 },
        ]}
      >
        <SecondaryButton
          compact
          title={t("scan.typeInstead")}
          onPress={() => router.back()}
        />
      </View>
    </View>
  );
}

const FRAME = 240;
const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: "#000" },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 10,
  },
  title: { textAlign: "center" },
  body: { textAlign: "center", lineHeight: 20, maxWidth: 300 },
  btn: { marginTop: 10, minWidth: 200 },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 20,
  },
  frame: { width: FRAME, height: FRAME },
  corner: { position: "absolute", width: 28, height: 28, borderWidth: 3 },
  tl: {
    top: 0,
    left: 0,
    borderRightWidth: 0,
    borderBottomWidth: 0,
    borderTopLeftRadius: 8,
  },
  tr: {
    top: 0,
    right: 0,
    borderLeftWidth: 0,
    borderBottomWidth: 0,
    borderTopRightRadius: 8,
  },
  bl: {
    bottom: 0,
    left: 0,
    borderRightWidth: 0,
    borderTopWidth: 0,
    borderBottomLeftRadius: 8,
  },
  br: {
    bottom: 0,
    right: 0,
    borderLeftWidth: 0,
    borderTopWidth: 0,
    borderBottomRightRadius: 8,
  },
  hint: {
    color: "#fff",
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: Radius.pill,
    overflow: "hidden",
  },
  bottom: { position: "absolute", left: 20, right: 20, bottom: 0 },
});
