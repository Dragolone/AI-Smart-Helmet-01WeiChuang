// 设备设置的分类页（「安全检测与预警」「提醒方式」共用这一个骨架）：
// 顶部写明这是哪顶头盔（离线时补一句），下面按组列出设置项，回执显示在被改的那一项下面。
// 读写都走 hooks/use-device-settings——与详情首页是同一个 deviceId、同一份缓存，
// 所以在首页点了前照灯再进来、或在这里改完返回，等待中的命令和失败结果都接得上。
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { ScrollView, StyleSheet, View } from "react-native";
import type { DeviceSettingKey } from "@helmet/shared";

import { devicesApi } from "@/api/devices";
import { isSessionEnded, toUserMessage } from "@/api/error-messages";
import { DeviceGone, isDeviceGone } from "@/components/device-gone";
import { DeviceSettingList } from "@/components/device-settings";
import { Card } from "@/components/list";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { useDeviceSettings } from "@/hooks/use-device-settings";
import { useTheme } from "@/hooks/use-theme";
import { useT, type MessageKey } from "@/i18n";
import { helmetNameOf } from "@/services/safety-status";

/** 这一页说的是哪顶头盔；头盔离线时如实说明修改不会送达（不禁用控件：下发与回执规则以服务端为准） */
export function DeviceContext({ deviceId }: { deviceId: string }) {
  const theme = useTheme();
  const t = useT();
  const detail = useQuery({
    queryKey: ["device-detail", deviceId],
    queryFn: () => devicesApi.detail(deviceId),
  });
  const status = useQuery({
    queryKey: ["device-status", deviceId],
    queryFn: () => devicesApi.status(deviceId),
    refetchInterval: 15_000,
  });
  return (
    <View style={styles.context}>
      <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
        {helmetNameOf({ name: detail.data?.name ?? null, deviceId })}
      </ThemedText>
      {status.data && !status.data.online && (
        <View style={styles.offline}>
          <Ionicons
            name="cloud-offline-outline"
            size={15}
            color={theme.warning}
          />
          <ThemedText type="small" style={styles.offlineText}>
            {t("device.offlineNote")}
          </ThemedText>
        </View>
      )}
    </View>
  );
}

export function DeviceSettingsPage({
  deviceId,
  groups,
  note,
}: {
  deviceId: string;
  groups: { title?: MessageKey; keys: readonly DeviceSettingKey[] }[];
  /** 页面底部的一句说明 */
  note?: MessageKey;
}) {
  const t = useT();
  const settings = useDeviceSettings(deviceId);
  // 与上面 DeviceContext 同一份缓存（15 秒轮询），只为下发回执知道头盔此刻在不在线
  const status = useQuery({
    queryKey: ["device-status", deviceId],
    queryFn: () => devicesApi.status(deviceId),
    refetchInterval: 15_000,
  });
  // 乱链接 / 已解绑的头盔：不画开关（点了全都报错），同详情首页给空态（优化清单 10）
  if (isDeviceGone(status.error, settings.error))
    return <DeviceGone deviceId={deviceId} />;
  return (
    <ThemedView style={styles.flex}>
      <ScrollView
        contentContainerStyle={styles.container}
        showsVerticalScrollIndicator={false}
      >
        <DeviceContext deviceId={deviceId} />
        {/* 当前值没拿到时如实说，不让一排没有高亮的选项看起来像「全都关着」 */}
        {settings.isError &&
          settings.values === undefined &&
          !isSessionEnded(settings.error) && (
            <ThemedText type="small" themeColor="danger">
              {toUserMessage(settings.error)}
            </ThemedText>
          )}
        {groups.map((group) => (
          <View key={group.keys.join(",")} style={styles.group}>
            {group.title && (
              <ThemedText type="smallBold" style={styles.groupTitle}>
                {t(group.title)}
              </ThemedText>
            )}
            <Card style={styles.card}>
              <DeviceSettingList
                keys={group.keys}
                settings={settings.values}
                disabled={settings.sending}
                onChange={settings.send}
                lastCommand={settings.lastCommand}
                online={status.data?.online ?? false}
              />
            </Card>
          </View>
        ))}
        {note && (
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.note}
          >
            {t(note)}
          </ThemedText>
        )}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: 20, gap: 14, paddingBottom: 28 },
  context: { gap: 6, paddingHorizontal: 4 },
  offline: { flexDirection: "row", alignItems: "center", gap: 6 },
  offlineText: { fontSize: 13, lineHeight: 18, flexShrink: 1 },
  group: { gap: 10 },
  groupTitle: { fontSize: 16, paddingHorizontal: 4, marginTop: 6 },
  card: { paddingHorizontal: 16 },
  note: { fontSize: 12, lineHeight: 19, paddingHorizontal: 4 },
});
