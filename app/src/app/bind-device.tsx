// 绑定设备（模态页，API.md §4 POST /devices/bind；Mock 设备绑定码由 provision:device 生成）
import { useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { devicesApi } from "@/api/devices";
import { toUserMessage } from "@/api/error-messages";
import {
  FormError,
  FormInput,
  PrimaryButton,
  SecondaryButton,
} from "@/components/form";
import { showToast } from "@/components/toast";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { useT } from "@/i18n";

export default function BindDeviceScreen() {
  const t = useT();
  const queryClient = useQueryClient();
  // 扫码页 replace 回来时带参数预填（scan-bind → parseBindQr）
  const params = useLocalSearchParams<{
    deviceId?: string;
    bindCode?: string;
  }>();
  const [deviceId, setDeviceId] = useState(params.deviceId ?? "");
  const [bindCode, setBindCode] = useState(params.bindCode ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await devicesApi.bind({
        deviceId: deviceId.trim(),
        bindCode: bindCode.trim(),
      });
      await queryClient.invalidateQueries({ queryKey: ["devices"] });
      showToast(t("device.bindSuccess"));
      // 关掉绑定流程的全部页面后落地图页：立刻看到新设备在动（底部卡弹入）。
      // 必须是 dismissAll 而不是 back：扫码进来时根栈是 [(tabs), 绑定页, 绑定页]（扫码页 replace 出第二张），
      // back 只弹掉一张，焦点还在绑定页上，这时去 /map 会在根栈上新压一个 (tabs)——
      // 用户返回时看到的是又一张绑定页，再往下是一套被卸载过清理函数的旧标签页（2026-10-05 评审）
      router.dismissAll();
      router.push("/map");
    } catch (e) {
      setError(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ThemedView style={styles.container}>
      <ThemedText type="small">{t("device.bindLead")}</ThemedText>
      <SecondaryButton
        title={t("scan.action")}
        icon="qr-code-outline"
        onPress={() => router.push("/scan-bind")}
      />
      <View style={styles.orRow}>
        <ThemedText type="label" themeColor="textSecondary">
          {t("scan.orType")}
        </ThemedText>
      </View>
      <FormInput
        label={t("device.deviceId")}
        icon="hardware-chip-outline"
        value={deviceId}
        onChangeText={setDeviceId}
        autoCapitalize="none"
        placeholder={t("device.deviceIdPlaceholder")}
      />
      <FormInput
        label={t("device.bindCode")}
        icon="key-outline"
        value={bindCode}
        onChangeText={setBindCode}
        keyboardType="number-pad"
        maxLength={8}
        placeholder={t("device.bindCodePlaceholder")}
      />
      <FormError message={error} />
      <PrimaryButton
        title={t("device.bindAction")}
        onPress={submit}
        loading={busy}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 12 },
  orRow: { alignItems: "center", marginTop: 2 },
});
