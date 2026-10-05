// 设备状态页（API.md §4 /devices/{id} + /devices/{id}/status；online 以服务端计算为准）
// 2026-08-16 风格迭代：大标识标题 + 状态药丸 + 电量仪表卡 + 数据行卡片
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import type React from "react";
import { useRef, useState } from "react";
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import ReAnimated, {
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { devicesApi } from "@/api/devices";
import { showToast } from "@/components/toast";
import { helmetErrorText, toUserMessage } from "@/api/error-messages";
import { Badge } from "@/components/badge";
import { BleOnboardingCard } from "@/components/ble-onboarding";
import { DeviceSettingList } from "@/components/device-settings";
import { PulseDot } from "@/components/motion";
import { Tappable } from "@/components/tappable";
import { BatteryChart } from "@/components/battery-chart";
import {
  VolumeSlider,
  VOLUME_LOUD_THRESHOLD,
} from "@/components/volume-slider";
import { FormInput, PrimaryButton } from "@/components/form";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { Radius } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import { useLocale, useT } from "@/i18n";
import { retryBleLink } from "@/services/ble-link";
import { HelmetLinkService } from "helmet-link-service";
import { useBleStore } from "@/stores/ble-store";
import { shortDate, shortTime } from "@/i18n/format";

function InfoRow({
  icon,
  label,
  value,
  onPress,
  valueColor,
  valueLeading,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  onPress?: () => void;
  valueColor?: string;
  valueLeading?: React.ReactNode;
}) {
  const theme = useTheme();
  const Wrapper = onPress ? Tappable : View;
  return (
    <Wrapper
      {...(onPress ? { onPress, feedback: "fill" as const } : {})}
      style={[
        styles.row,
        { backgroundColor: theme.backgroundElement, borderColor: theme.border },
      ]}
    >
      <View style={styles.rowLeft}>
        <Ionicons name={icon} size={16} color={theme.textSecondary} />
        <ThemedText type="label" themeColor="textSecondary">
          {label}
        </ThemedText>
      </View>
      <View style={styles.rowValue}>
        {valueLeading}
        <ThemedText
          type="smallBold"
          style={valueColor ? { color: valueColor } : undefined}
        >
          {value}
        </ThemedText>
      </View>
    </Wrapper>
  );
}

/** 低频信息折叠区：默认收起，首屏只留电量/连接/设置；展开用淡入下滑，箭头旋转 */
function DeviceInfoSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const rot = useSharedValue(0);
  const chevron = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rot.get()}deg` }],
  }));
  return (
    <View style={styles.infoSection}>
      <Tappable
        feedback="opacity"
        onPress={() => {
          rot.set(withTiming(open ? 0 : 90, { duration: 180 }));
          setOpen((v) => !v);
        }}
        style={styles.infoHeader}
      >
        <ThemedText type="smallBold" themeColor="textSecondary">
          {title}
        </ThemedText>
        <ReAnimated.View style={chevron}>
          <Ionicons
            name="chevron-forward"
            size={16}
            color={theme.textSecondary}
          />
        </ReAnimated.View>
      </Tappable>
      {open && (
        <ReAnimated.View
          entering={FadeInDown.duration(200)}
          style={styles.infoBody}
        >
          {children}
        </ReAnimated.View>
      )}
    </View>
  );
}

export default function DeviceDetailScreen() {
  const { deviceId } = useLocalSearchParams<{ deviceId: string }>();
  const theme = useTheme();
  const t = useT();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const [unbinding, setUnbinding] = useState(false);

  const status = useQuery({
    queryKey: ["device-status", deviceId],
    queryFn: () => devicesApi.status(deviceId),
    // 心跳 60s + 在线窗口 90s：15s 轮询兜底（WS 推送为主）
    refetchInterval: 15_000,
  });

  // 24h 电量历史（10 分钟桶；60s 心跳 → 每分钟刷新即可）
  const battery = useQuery({
    queryKey: ["device-battery-history", deviceId],
    queryFn: () => devicesApi.batteryHistory(deviceId, 24),
    refetchInterval: 60_000,
  });

  // 详情（name/bindCode 等静态信息，与状态分开缓存）
  const detail = useQuery({
    queryKey: ["device-detail", deviceId],
    queryFn: () => devicesApi.detail(deviceId),
  });

  // 设备设置（§8 命令+回执状态机）:有未终态命令时 2s 快轮询直到回执/超时
  const settings = useQuery({
    queryKey: ["device-settings", deviceId],
    queryFn: () => devicesApi.settings(deviceId),
    refetchInterval: (q) => {
      const st = q.state.data?.lastCommand?.status;
      return st === "pending" || st === "delivered" ? 2_000 : 30_000;
    },
  });
  const [sending, setSending] = useState(false);

  /** 音量乐观值(负责人口径:滑到哪停在哪,响应中灰显,生效后点亮;
   *  失败/离线回落服务端值——绝不把未生效显示为已生效) */
  const [optimisticVolume, setOptimisticVolume] = useState<number | null>(null);

  // 绑定码默认打码,点击显示 10 秒(防旁人看到后绑走);
  // 睁/闭眼图标即可点提示,不再附加"点击查看"文字(负责人口径)
  const [bindCodeShown, setBindCodeShown] = useState(false);
  // BLE 近场链路状态（services/ble-link 写入 store；本页只显示，不做连接判断）
  // Android 省电白名单（决策 #41）：华为等机型未加白名单时后台链路随时被杀
  const [batteryOptOk, setBatteryOptOk] = useState(() =>
    HelmetLinkService.isIgnoringBatteryOptimizations(),
  );
  // 只订阅本页用到的两个字段：整条 link 每来一帧都会变（lastFrameAt / eventsReceived），
  // 订阅它等于每帧把整页重画一遍
  const blePhase = useBleStore((st) => st.links[deviceId]?.phase);
  const bleFirmwareVersion = useBleStore(
    (st) => st.links[deviceId]?.firmwareVersion,
  );
  const bleLink = blePhase
    ? { phase: blePhase, firmwareVersion: bleFirmwareVersion }
    : undefined;
  const bleAdapter = useBleStore((st) => st.adapter);
  const bleStatusText =
    bleAdapter === "off" ||
    bleAdapter === "unauthorized" ||
    bleAdapter === "unsupported"
      ? t(`device.ble.${bleAdapter}`)
      : t(`device.ble.${bleLink?.phase ?? "idle"}`) +
        (bleLink?.phase === "connected" && bleLink.firmwareVersion
          ? ` · v${bleLink.firmwareVersion}`
          : "");
  const revealBindCode = () => {
    setBindCodeShown(true);
    setTimeout(() => setBindCodeShown(false), 10_000);
  };

  const serverVolume =
    typeof settings.data?.settings.volume === "number"
      ? settings.data.settings.volume
      : 80;
  const lastCmdStatus = settings.data?.lastCommand?.status;
  // 渲染期调整(React 官方 adjusting-state 模式,effect 内 setState 会被
  // react-hooks 规则拒):生效→点亮;失败/离线→回落服务端真实值
  if (
    optimisticVolume !== null &&
    (serverVolume === optimisticVolume ||
      lastCmdStatus === "failed" ||
      lastCmdStatus === "offline")
  ) {
    setOptimisticVolume(null);
  }
  const volumePending =
    optimisticVolume !== null && optimisticVolume !== serverVolume;

  const sendSetting = (key: string, value: string | number | boolean) => {
    if (key === "volume" && typeof value === "number")
      setOptimisticVolume(value);
    setSending(true);
    devicesApi
      .putSettings(deviceId, { settings: { [key]: value } })
      .then(() =>
        queryClient.invalidateQueries({
          queryKey: ["device-settings", deviceId],
        }),
      )
      .catch((e) => Alert.alert(t("device.sendFailed"), toUserMessage(e)))
      .finally(() => setSending(false));
  };

  /** 蜂鸣音量（BLE 协议 v0.6 内存表 0x24：1–100%，默认 80）；超过高音量线先确认，防止贴耳伤听力 */
  // 拖动中：像调耳机音量一样即时生效——每跨一档就下发，但同一 200ms 内只发最后一条，
  // 且拖动阶段封顶在高音量线；超过线的最终值等松手确认后再发
  const navigation = useNavigation();
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const livePending = useRef<number | null>(null);
  const liveSent = useRef<number | null>(null);
  /** 拖动开始时的音量：拖动中已即时下发过中间值（≤ 高音量线）时，取消高音量确认要把它还回去 */
  const dragStart = useRef<number | null>(null);
  const flushLive = () => {
    liveTimer.current = null;
    const v = livePending.current;
    livePending.current = null;
    if (v === null || v === liveSent.current) return;
    liveSent.current = v;
    devicesApi.putSettings(deviceId, { settings: { volume: v } }).catch(() => {
      /* 拖动中的中间值失败不打扰，松手那条会报错 */
    });
  };
  const onVolumeStep = (v: number) => {
    livePending.current = Math.min(v, VOLUME_LOUD_THRESHOLD);
    if (!liveTimer.current) liveTimer.current = setTimeout(flushLive, 200);
  };
  const onVolumeDragging = (dragging: boolean) => {
    // 拖动时关掉 iOS 返回手势，免得向右滑把页面滑走
    navigation.setOptions({ gestureEnabled: !dragging });
    if (dragging) {
      liveSent.current = null;
      dragStart.current = optimisticVolume ?? serverVolume;
    }
  };
  const sendVolume = (v: number) => {
    if (liveTimer.current) {
      clearTimeout(liveTimer.current);
      liveTimer.current = null;
      livePending.current = null;
    }
    if (v > VOLUME_LOUD_THRESHOLD) {
      Alert.alert(
        t("device.volumeLoudTitle"),
        t("device.volumeLoudBody", { n: v }),
        [
          {
            text: t("common.cancel"),
            style: "cancel",
            // 取消 = 回到拖动前的音量。拖动过程中为了"即时生效"已经把 ≤ 高音量线的中间值发过去了
            // （60 → 拖到 90 的路上 80 已下发），所以取消不能"什么都不做"，要把起点值发回去
            // （负责人 2026-09-17 指正：取消后音量停在 80）
            onPress: () => {
              const back = dragStart.current;
              if (
                back !== null &&
                liveSent.current !== null &&
                liveSent.current !== back
              ) {
                sendSetting("volume", back);
              }
            },
          },
          {
            text: t("device.volumeLoudConfirm"),
            style: "destructive",
            onPress: () => sendSetting("volume", v),
          },
        ],
      );
      return;
    }
    sendSetting("volume", v);
  };

  const lastCmd = settings.data?.lastCommand ?? null;
  const cmdStatusText =
    lastCmd == null
      ? null
      : lastCmd.status === "pending"
        ? { text: t("device.cmd.pending"), color: theme.warning }
        : lastCmd.status === "delivered"
          ? { text: t("device.cmd.delivered"), color: theme.warning }
          : lastCmd.status === "success"
            ? {
                text: lastCmd.executedAt
                  ? t("device.cmd.successAt", {
                      time: shortTime(lastCmd.executedAt, locale),
                    })
                  : t("device.cmd.success"),
                color: theme.success,
              }
            : lastCmd.status === "failed"
              ? {
                  // 正文说人话，原始码留在括号里给技术支持看
                  text: lastCmd.errorCode
                    ? `${helmetErrorText(lastCmd.errorCode, t)}（${lastCmd.errorCode}）`
                    : t("device.cmd.failed"),
                  color: theme.danger,
                }
              : {
                  // 离线未送达：绝不显示为已生效
                  text: t("device.cmd.offline"),
                  color: theme.textSecondary,
                };

  const [renameOpen, setRenameOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [renaming, setRenaming] = useState(false);

  const openRename = () => {
    setNameDraft(detail.data?.name ?? "");
    setRenameOpen(true);
  };

  const submitRename = () => {
    setRenaming(true);
    devicesApi
      .rename(deviceId, { name: nameDraft })
      .then(async () => {
        setRenameOpen(false);
        showToast(t("device.renamed"));
        // 列表/详情/地图药丸同步刷新
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: ["device-detail", deviceId],
          }),
          queryClient.invalidateQueries({ queryKey: ["devices"] }),
        ]);
      })
      .catch((e) => Alert.alert(t("device.renameFailed"), toUserMessage(e)))
      .finally(() => setRenaming(false));
  };

  const unbind = () => {
    Alert.alert(t("device.unbind"), t("device.unbindBody", { id: deviceId }), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("device.unbindAction"),
        style: "destructive",
        onPress: () => {
          setUnbinding(true);
          devicesApi
            .unbind(deviceId)
            .then(async () => {
              await queryClient.invalidateQueries({ queryKey: ["devices"] });
              router.back();
            })
            .catch((e) =>
              Alert.alert(t("device.unbindFailed"), toUserMessage(e)),
            )
            .finally(() => setUnbinding(false));
        },
      },
    ]);
  };

  const s = status.data;

  return (
    <ThemedView style={styles.flex}>
      {/* 内容随设置区增长会超出一屏,必须可滚动(Android 实证:小屏下半截不可见且无法下滑) */}
      <ScrollView
        contentContainerStyle={styles.container}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.titleRow}>
          <Pressable style={styles.titlePress} onPress={openRename} hitSlop={6}>
            <ThemedText type="title" style={styles.title} numberOfLines={1}>
              {detail.data?.name ?? deviceId}
            </ThemedText>
            <Ionicons
              name="pencil-outline"
              size={18}
              color={theme.textSecondary}
            />
          </Pressable>
          {s && (
            <Badge
              variant={s.online ? "success" : "neutral"}
              label={s.online ? t("common.online") : t("common.offline")}
            />
          )}
        </View>
        {detail.data?.name && (
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.subId}
          >
            {deviceId}
          </ThemedText>
        )}

        {status.isError && (
          <ThemedText type="small">{toUserMessage(status.error)}</ThemedText>
        )}

        <BleOnboardingCard />

        {s && (
          <>
            <View
              style={[
                styles.batteryCard,
                {
                  backgroundColor: theme.backgroundElement,
                  borderColor: theme.border,
                },
              ]}
            >
              <BatteryChart
                points={battery.data?.points ?? []}
                to={battery.data?.to}
                current={s.battery}
                charging={s.charging}
                labels={{
                  title: t("devices.battery"),
                  window: t("device.batteryWindow"),
                  charging: t("devices.charging"),
                  empty: t("device.batteryEmpty"),
                }}
              />
            </View>

            <InfoRow
              icon={
                bleLink?.phase === "connected"
                  ? "bluetooth"
                  : "bluetooth-outline"
              }
              label={t("device.ble")}
              value={bleStatusText}
              valueLeading={
                bleLink ? (
                  <PulseDot
                    color={
                      bleLink.phase === "connected"
                        ? theme.success
                        : bleLink.phase === "error"
                          ? theme.danger
                          : theme.textSecondary
                    }
                    active={
                      bleLink.phase === "scanning" ||
                      bleLink.phase === "connecting" ||
                      bleLink.phase === "handshaking"
                    }
                  />
                ) : undefined
              }
              valueColor={
                bleLink?.phase === "connected"
                  ? theme.success
                  : bleLink?.phase === "error"
                    ? theme.danger
                    : theme.textSecondary
              }
              onPress={
                bleLink && bleLink.phase !== "connected" && bleAdapter === "on"
                  ? () => retryBleLink(deviceId)
                  : undefined
              }
            />
            {Platform.OS === "android" && HelmetLinkService.available && (
              <InfoRow
                icon={
                  batteryOptOk
                    ? "battery-charging-outline"
                    : "battery-dead-outline"
                }
                label={t("device.batteryOpt")}
                value={
                  batteryOptOk
                    ? t("device.batteryOpt.ok")
                    : t("device.batteryOpt.limited")
                }
                valueColor={batteryOptOk ? theme.success : theme.danger}
                onPress={
                  batteryOptOk
                    ? undefined
                    : () => {
                        HelmetLinkService.requestIgnoreBatteryOptimizations();
                        // 回来后重查一次（系统对话框没有回调）
                        setTimeout(
                          () =>
                            setBatteryOptOk(
                              HelmetLinkService.isIgnoringBatteryOptimizations(),
                            ),
                          1500,
                        );
                      }
                }
              />
            )}

            {/* 设备设置下发（§8;参数为演示项,清单与值域待硬件定稿 ⚠️） */}
            <View
              style={[
                styles.settingsCard,
                {
                  backgroundColor: theme.backgroundElement,
                  borderColor: theme.border,
                },
              ]}
            >
              <View style={styles.settingsHeader}>
                <ThemedText type="smallBold" style={{ fontSize: 15 }}>
                  {t("device.settings")}
                </ThemedText>
              </View>

              <VolumeSlider
                value={optimisticVolume ?? serverVolume}
                pending={volumePending}
                onStep={onVolumeStep}
                onRelease={sendVolume}
                onDraggingChange={onVolumeDragging}
              />

              <DeviceSettingList
                settings={settings.data?.settings}
                disabled={sending}
                onChange={sendSetting}
              />

              {cmdStatusText && (
                <ThemedText type="small" style={{ color: cmdStatusText.color }}>
                  {t("device.lastCommand", { status: cmdStatusText.text })}
                </ThemedText>
              )}
            </View>
          </>
        )}

        {s && (
          <DeviceInfoSection title={t("device.info")}>
            <InfoRow
              icon="cellular-outline"
              label={t("device.signal")}
              value={
                s.signalLevel !== null
                  ? String(s.signalLevel)
                  : t("device.notReported")
              }
            />
            <InfoRow
              icon={s.sleeping ? "moon-outline" : "flash-outline"}
              label={t("device.workState")}
              value={s.sleeping ? t("device.sleeping") : t("device.active")}
            />
            <InfoRow
              icon="construct-outline"
              label={t("device.bleBench")}
              value={t("device.bleBench.open")}
              onPress={() => router.push(`/ble-bench?deviceId=${deviceId}`)}
            />
            <InfoRow
              icon="hardware-chip-outline"
              label={t("devices.firmware")}
              value={s.firmwareVersion ?? t("common.unknown")}
            />
            <InfoRow
              icon="time-outline"
              label={t("device.lastHeartbeat")}
              value={
                s.lastSeenAt
                  ? `${shortDate(s.lastSeenAt, locale)} ${shortTime(s.lastSeenAt, locale)}`
                  : t("device.neverReported")
              }
            />
            <InfoRow
              icon={bindCodeShown ? "eye-outline" : "eye-off-outline"}
              label={t("device.bindCode")}
              value={
                bindCodeShown ? (detail.data?.bindCode ?? "—") : "••••••••"
              }
              valueColor={bindCodeShown ? undefined : theme.textSecondary}
              onPress={
                bindCodeShown ? () => setBindCodeShown(false) : revealBindCode
              }
            />
          </DeviceInfoSection>
        )}

        <View style={styles.footer}>
          <PrimaryButton
            title={t("device.unbind")}
            onPress={unbind}
            loading={unbinding}
            danger
          />
        </View>
      </ScrollView>

      {/* 重命名弹层（跨平台；Alert.prompt 仅 iOS 可用故自建） */}
      <Modal
        visible={renameOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setRenameOpen(false)}
      >
        <Pressable
          style={styles.modalMask}
          onPress={() => setRenameOpen(false)}
        >
          <ReAnimated.View entering={FadeInDown.duration(200)}>
            <Pressable
              style={[
                styles.modalCard,
                {
                  backgroundColor: theme.backgroundElement,
                  borderColor: theme.border,
                },
              ]}
              onPress={() => undefined}
            >
              <ThemedText type="subtitle">{t("device.renameTitle")}</ThemedText>
              <FormInput
                label={t("device.nameLabel")}
                value={nameDraft}
                onChangeText={setNameDraft}
                placeholder={t("device.namePlaceholder")}
                maxLength={20}
                autoFocus
              />
              <PrimaryButton
                title={t("common.save")}
                onPress={submitRename}
                loading={renaming}
              />
            </Pressable>
          </ReAnimated.View>
        </Pressable>
      </Modal>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: 20, gap: 12, paddingBottom: 28 },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  title: { fontSize: 30, lineHeight: 36, flexShrink: 1 },
  titlePress: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
    marginRight: 10,
  },
  subId: { marginTop: -8 },
  modalMask: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    padding: 28,
  },
  modalCard: {
    borderRadius: Radius.card,
    borderWidth: 1,
    padding: 18,
    gap: 14,
  },
  batteryCard: {
    borderRadius: Radius.card,
    borderWidth: 1,
    padding: 16,
    gap: 10,
  },
  settingsCard: {
    borderRadius: Radius.card,
    borderWidth: 1,
    padding: 16,
    gap: 12,
  },
  settingsHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderRadius: Radius.control,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  infoSection: { gap: 8 },
  infoHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    paddingVertical: 6,
  },
  infoBody: { gap: 8 },
  rowValue: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
  footer: { marginTop: 8 },
});
