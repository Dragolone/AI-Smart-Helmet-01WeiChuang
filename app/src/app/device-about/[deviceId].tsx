// 「关于这顶头盔」（设备详情页的分类入口）：设备编号、固件、信号、工作状态、最后上报时间、绑定码，
// 以及低频的高级入口（蓝牙工程模式）。内容来自改版前详情页底部折叠的「设备信息」。
// 绑定码规则不变：默认打码，点了才显示，10 秒后自动收起（防旁人看到后绑走）。
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { devicesApi } from "@/api/devices";
import { isSessionEnded, toUserMessage } from "@/api/error-messages";
import { DeviceContext } from "@/components/device-settings-page";
import { Card, ListRow } from "@/components/list";
import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { useTheme } from "@/hooks/use-theme";
import { useLocale, useT } from "@/i18n";
import { shortDate, shortTime } from "@/i18n/format";
import { useBleStore } from "@/stores/ble-store";

export { RouteErrorBoundary as ErrorBoundary } from "@/components/route-error-boundary";

function InfoRow({
  label,
  value,
  mono = false,
  last = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  last?: boolean;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.row,
        !last && {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.border,
        },
      ]}
    >
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
      <ThemedText type={mono ? "code" : "small"} style={styles.rowValue}>
        {value}
      </ThemedText>
    </View>
  );
}

export default function DeviceAboutScreen() {
  const { deviceId } = useLocalSearchParams<{ deviceId: string }>();
  const theme = useTheme();
  const t = useT();
  const locale = useLocale();

  // 与详情首页同一份缓存
  const status = useQuery({
    queryKey: ["device-status", deviceId],
    queryFn: () => devicesApi.status(deviceId),
    refetchInterval: 15_000,
  });
  const detail = useQuery({
    queryKey: ["device-detail", deviceId],
    queryFn: () => devicesApi.detail(deviceId),
  });
  // 服务端还没有固件版本时，用本机蓝牙握手读到的
  const bleFirmwareVersion = useBleStore(
    (st) => st.links[deviceId]?.firmwareVersion,
  );

  // 绑定码默认打码,点击显示 10 秒(防旁人看到后绑走)
  const [bindCodeShown, setBindCodeShown] = useState(false);
  // 定时器要记下来：手动收起再点开时，上一次的定时器还在走，
  // 会在不到 10 秒的时候把刚点开的码收掉（B 线 10-05 指出）
  const bindCodeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearBindCodeTimer = () => {
    if (bindCodeTimer.current) clearTimeout(bindCodeTimer.current);
    bindCodeTimer.current = null;
  };
  const hideBindCode = () => {
    clearBindCodeTimer();
    setBindCodeShown(false);
  };
  const revealBindCode = () => {
    clearBindCodeTimer();
    setBindCodeShown(true);
    bindCodeTimer.current = setTimeout(() => {
      bindCodeTimer.current = null;
      setBindCodeShown(false);
    }, 10_000);
  };
  useEffect(
    () => () => {
      if (bindCodeTimer.current) clearTimeout(bindCodeTimer.current);
    },
    [],
  );

  const s = status.data;
  const firmware = s?.firmwareVersion ?? bleFirmwareVersion;

  return (
    <ThemedView style={styles.flex}>
      <ScrollView
        contentContainerStyle={styles.container}
        showsVerticalScrollIndicator={false}
      >
        <DeviceContext deviceId={deviceId} />
        {status.isError && !s && !isSessionEnded(status.error) && (
          <ThemedText type="small" themeColor="danger">
            {toUserMessage(status.error)}
          </ThemedText>
        )}
        <Card style={styles.card}>
          <InfoRow label={t("device.deviceId")} value={deviceId} mono />
          <InfoRow
            label={t("devices.firmware")}
            value={firmware ?? t("common.unknown")}
          />
          {s && (
            <>
              {/* 离线时这两项是上次上报的值：信号如实标注；工作状态无从确认，不显示成「活动中」 */}
              <InfoRow
                label={t("device.signal")}
                value={
                  s.signalLevel === null
                    ? t("device.notReported")
                    : s.online
                      ? String(s.signalLevel)
                      : t("device.about.lastValue", { value: s.signalLevel })
                }
              />
              <InfoRow
                label={t("device.workState")}
                value={
                  !s.online
                    ? t("device.about.unconfirmed")
                    : s.sleeping
                      ? t("device.sleeping")
                      : t("device.active")
                }
              />
              <InfoRow
                label={t("device.lastHeartbeat")}
                value={
                  s.lastSeenAt
                    ? `${shortDate(s.lastSeenAt, locale)} ${shortTime(s.lastSeenAt, locale)}`
                    : t("device.neverReported")
                }
              />
            </>
          )}
          <View style={styles.row}>
            <ThemedText type="small" themeColor="textSecondary">
              {t("device.bindCode")}
            </ThemedText>
            <View style={styles.bindValue}>
              <ThemedText
                type="code"
                themeColor={bindCodeShown ? "text" : "textSecondary"}
                style={styles.bindCode}
              >
                {bindCodeShown ? (detail.data?.bindCode ?? "—") : "••••••••"}
              </ThemedText>
              <Tappable
                feedback="opacity"
                accessibilityRole="button"
                accessibilityLabel={t(
                  bindCodeShown
                    ? "device.about.hideBindCode"
                    : "device.about.showBindCode",
                )}
                onPress={bindCodeShown ? hideBindCode : revealBindCode}
                style={styles.eye}
              >
                <Ionicons
                  name={bindCodeShown ? "eye-outline" : "eye-off-outline"}
                  size={20}
                  color={theme.textSecondary}
                />
              </Tappable>
            </View>
          </View>
        </Card>

        <ThemedText type="smallBold" style={styles.groupTitle}>
          {t("device.about.advanced")}
        </ThemedText>
        <Card>
          <ListRow
            icon="construct-outline"
            title={t("device.bleBench")}
            onPress={() => router.navigate(`/ble-bench?deviceId=${deviceId}`)}
            last
          />
        </Card>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: 20, gap: 14, paddingBottom: 28 },
  card: { paddingHorizontal: 16 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 14,
    minHeight: 54,
    paddingVertical: 10,
  },
  rowValue: { flexShrink: 1, textAlign: "right" },
  bindValue: { flexDirection: "row", alignItems: "center", gap: 4 },
  bindCode: { fontSize: 14 },
  eye: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    marginRight: -10,
  },
  groupTitle: { fontSize: 16, paddingHorizontal: 4, marginTop: 6 },
});
