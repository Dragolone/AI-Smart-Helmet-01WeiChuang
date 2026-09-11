// 绑定设备（模态页，API.md §4 POST /devices/bind；Mock 设备绑定码由 provision:device 生成）
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet } from "react-native";

import { devicesApi } from "@/api/devices";
import { toUserMessage } from "@/api/error-messages";
import { FormError, FormInput, PrimaryButton } from "@/components/form";
import { showToast } from "@/components/toast";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { useT } from "@/i18n";

export default function BindDeviceScreen() {
  const t = useT();
  const queryClient = useQueryClient();
  const [deviceId, setDeviceId] = useState("");
  const [bindCode, setBindCode] = useState("");
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
      // 关掉本 modal 后直接落地图页:立刻看到新设备在动(底部卡弹入)
      router.back();
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
});
