// 绑定设备（模态页，API.md §4 POST /devices/bind；Mock 设备绑定码由 provision:device 生成）
import { useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import type { DevicePublic } from "@helmet/shared";

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
  // 扫码页是「回到」这一页并带回参数（不再另开一张绑定页），参数变了要把两个输入框跟着填上。
  // 用「渲染期比对上一次的值」而不是 effect：React 推荐的写法，也不会多渲染一帧空值
  const [filledFrom, setFilledFrom] = useState({
    deviceId: params.deviceId,
    bindCode: params.bindCode,
  });
  if (
    filledFrom.deviceId !== params.deviceId ||
    filledFrom.bindCode !== params.bindCode
  ) {
    setFilledFrom({ deviceId: params.deviceId, bindCode: params.bindCode });
    if (params.deviceId) setDeviceId(params.deviceId);
    if (params.bindCode) setBindCode(params.bindCode);
  }
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const bound = await devicesApi.bind({
        deviceId: deviceId.trim(),
        bindCode: bindCode.trim(),
      });
      // 服务端一确认就收尾，不等列表重新拉取（2026-10-06 iPhone 实测：等待期间页面没有任何变化，
      // 负责人以为没绑上又点了一次）。新设备先直接写进列表缓存，随后后台刷新拿权威数据。
      queryClient.setQueryData<DevicePublic[]>(["devices"], (prev) =>
        prev?.some((d) => d.deviceId === bound.deviceId)
          ? prev
          : [...(prev ?? []), bound],
      );
      void queryClient.invalidateQueries({ queryKey: ["devices"] });
      showToast(t("device.bindSuccess"));
      // 回到发起绑定的那一页（设备页），新设备已经在列表里——绑没绑上一眼可见。
      // 原来是跳去地图页：用户看不到绑定结果，地图页还会先闪一下「还没有设备」。
      // 用 dismissAll 一次关掉绑定流程的全部页面；绝不能在这里再 push 一个标签页路由——
      // 焦点还在绑定页时那样做会在根栈上新压一套 (tabs)（2026-10-05 评审 R-01）
      router.dismissAll();
      // busy 不复位：页面正在关闭，按钮保持不可点，杜绝重复提交
    } catch (e) {
      setError(toUserMessage(e));
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
