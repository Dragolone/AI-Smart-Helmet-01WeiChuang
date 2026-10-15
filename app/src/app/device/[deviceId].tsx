// 设备详情（API.md §4 /devices/{id} + /devices/{id}/status；online 以服务端计算为准）
// 2026-10-06 按确认的原型重排信息层级，功能与下发逻辑不变：
//   头盔名称 + 设备编号 → 一张头盔状态卡 → 常用控制（前照灯、蜂鸣音量）→ 设备设置三个分类入口。
// - 状态卡只有一张：电量（沿用原有样式：环形电量 + 24 小时柱状图）下面依次是手机与头盔的蓝牙、
//   设备在线与最近上报；异常就写在对应那一行，卡片外面不再另放提示条，同一件事不说第二遍。
//   首次连接引导不再是常驻卡片，改成第一次进来时弹一次的底部面板（BleFirstConnectGuide）。
//   蓝牙连接和设备在线是两件事，各占一行，不合并成一个「已连接」。
// - 重命名：名字旁边的铅笔图标；解除绑定：页面最底部（负责人 2026-10-08 定，10-06 那版收在右上角「更多」里）。
//   解绑的确认流程没有变。
// - 其余设置分到 /device-safety、/device-alerts，设备信息与绑定码在 /device-about；
//   各页用同一个 deviceId、同一份设置缓存（hooks/use-device-settings），进出页面不丢等待中的命令。
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import { useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import ReAnimated, { FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { devicesApi } from "@/api/devices";
import { showToast } from "@/components/toast";
import { ApiRequestError } from "@/api/client";
import { toUserMessage } from "@/api/error-messages";
import { devLog } from "@/services/dev-log";
import type { DevicePublic } from "@helmet/shared";
import {
  BleFirstConnectGuide,
  useBleOnboardingSteps,
} from "@/components/ble-onboarding";
import {
  CommandFeedback,
  DeviceSettingList,
  levelLabelKey,
} from "@/components/device-settings";
import { Card, ListRow, type IconName } from "@/components/list";
import { Skeleton } from "@/components/skeleton";
import { Tappable } from "@/components/tappable";
import { BatteryChart } from "@/components/battery-chart";
import {
  VolumeSlider,
  VOLUME_LOUD_THRESHOLD,
} from "@/components/volume-slider";
import { EmptyState } from "@/components/empty-state";
import { FormInput, PrimaryButton } from "@/components/form";
import { KeyboardAvoid } from "@/components/keyboard-avoid";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { Radius } from "@/constants/theme";
import { useDeviceSettings } from "@/hooks/use-device-settings";
import { useTheme } from "@/hooks/use-theme";
import { useLocale, useT, type MessageKey } from "@/i18n";
import { relativeTime } from "@/i18n/format";
import { retryBleLink } from "@/services/ble-link";
import {
  bleRowOf,
  isBatteryLow,
  type BleRowState,
} from "@/services/device-view";
import { useBleStore } from "@/stores/ble-store";

type RowTone = "ok" | "warn" | "bad" | "neutral";

/** 蓝牙没连上时，「蓝牙未连接」下面那句说明原因的话（文案沿用改版前蓝牙那一行的各状态） */
const BLE_DETAIL: Partial<Record<BleRowState, MessageKey>> = {
  scanning: "device.ble.scanning",
  connecting: "device.ble.connecting",
  handshaking: "device.ble.handshaking",
  disconnected: "device.status.bleReconnecting",
  error: "device.ble.error",
  idle: "device.ble.idle",
  off: "device.ble.off",
  unauthorized: "device.ble.unauthorized",
  unsupported: "device.ble.unsupported",
};

/**
 * 状态卡里的一行：图标 + 结论（+ 一句原因）+ 右侧的时间或入口。
 * 轻重只落在图标颜色上，文字保持正文色——不靠颜色也读得出来，也不把整张卡染色。
 */
function StatusRow({
  icon,
  tone,
  title,
  detail,
  trailing,
  actionLabel,
  onAction,
}: {
  icon: IconName;
  tone: RowTone;
  title: string;
  detail?: string;
  trailing?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const theme = useTheme();
  const color =
    tone === "ok"
      ? theme.success
      : tone === "warn"
        ? theme.warning
        : tone === "bad"
          ? theme.danger
          : theme.textSecondary;
  const body = (
    <>
      <Ionicons name={icon} size={18} color={color} />
      <View style={styles.statusRowText}>
        <ThemedText type="small" style={styles.statusRowTitle}>
          {title}
        </ThemedText>
        {detail ? (
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.statusRowDetail}
          >
            {detail}
          </ThemedText>
        ) : null}
      </View>
      {trailing ? (
        <ThemedText
          type="small"
          themeColor="textSecondary"
          style={styles.statusRowTrailing}
        >
          {trailing}
        </ThemedText>
      ) : null}
      {actionLabel && onAction ? (
        <View style={styles.statusRowAction}>
          <ThemedText type="smallBold" style={styles.statusRowActionText}>
            {actionLabel}
          </ThemedText>
          <Ionicons name="chevron-forward" size={14} color={theme.text} />
        </View>
      ) : null}
    </>
  );
  return onAction ? (
    <Tappable
      feedback="opacity"
      accessibilityRole="button"
      onPress={onAction}
      style={styles.statusRow}
    >
      {body}
    </Tappable>
  ) : (
    <View style={styles.statusRow}>{body}</View>
  );
}

export default function DeviceDetailScreen() {
  const { deviceId } = useLocalSearchParams<{ deviceId: string }>();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
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

  // 设备设置（§8 命令+回执状态机）：与分类页共用，见 hooks/use-device-settings
  const settings = useDeviceSettings(deviceId);

  /** 音量乐观值(负责人口径:滑到哪停在哪,响应中灰显,生效后点亮;
   *  失败/离线回落服务端值——绝不把未生效显示为已生效) */
  const [optimisticVolume, setOptimisticVolume] = useState<number | null>(null);

  // BLE 近场链路状态（services/ble-link 写入 store；本页只显示，不做连接判断）
  // 只订阅本页用到的字段：整条 link 每来一帧都会变（lastFrameAt / eventsReceived），
  // 订阅它等于每帧把整页重画一遍
  const blePhase = useBleStore((st) => st.links[deviceId]?.phase);
  const bleAdapter = useBleStore((st) => st.adapter);
  const bleRow = bleRowOf(bleAdapter, blePhase);
  // 开蓝牙 / 给权限 / Android 省电白名单（决策 #41）：与首次连接引导、安全设置页是同一组状态和入口
  const linkSteps = useBleOnboardingSteps();
  const whitelist = linkSteps.find((step) => step.key === "whitelist");
  const bleAction =
    bleRow.action === "retry"
      ? { label: t("device.status.retry"), run: () => retryBleLink(deviceId) }
      : bleRow.action === "bluetoothSettings"
        ? {
            label: t("ble.onboarding.go"),
            run: () => linkSteps.find((x) => x.key === "bluetooth")?.action(),
          }
        : bleRow.action === "appSettings"
          ? {
              label: t("ble.onboarding.go"),
              run: () => void Linking.openSettings(),
            }
          : null;

  const serverVolume =
    typeof settings.values?.volume === "number" ? settings.values.volume : 80;
  const lastCmdStatus = settings.lastCommand?.status;
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
    settings.send(key, value);
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

  const [renameOpen, setRenameOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  // 改好了：按钮先画勾，画完再关弹层
  const [renamed, setRenamed] = useState(false);

  const openRename = () => {
    setNameDraft(detail.data?.name ?? "");
    setRenamed(false);
    setRenameOpen(true);
  };

  const submitRename = () => {
    setRenaming(true);
    devicesApi
      .rename(deviceId, { name: nameDraft })
      .then(async () => {
        setRenamed(true);
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
          devLog("DEVICE", "解绑：发请求");
          devicesApi
            .unbind(deviceId)
            .then(() => {
              devLog("DEVICE", "解绑：服务端成功，返回");
              // 服务端一确认就收尾，不等列表重新拉取（2026-10-06 iPhone 实测：等待期间页面不动，
              // 还能再点一次解绑，得到「设备不存在」）。先把这台从列表缓存里拿掉，再后台刷新。
              queryClient.setQueryData<DevicePublic[]>(["devices"], (prev) =>
                prev?.filter((d) => d.deviceId !== deviceId),
              );
              void queryClient.invalidateQueries({ queryKey: ["devices"] });
              showToast(t("device.unbindDone"));
              router.back();
              // unbinding 不复位：页面正在关闭，「解除绑定」保持不可点
            })
            .catch((e) => {
              setUnbinding(false);
              Alert.alert(t("device.unbindFailed"), toUserMessage(e));
            });
        },
      },
    ]);
  };

  const s = status.data;
  const online = s?.online ?? false;
  // 充着电就不催充电了
  const lowBattery = !!s && isBatteryLow(s.battery) && !s.charging;

  // 分类入口下面那句摘要：只用头盔确认过的值拼；一项都还没拿到时退回一句固定说明
  const boolSummary = (
    key: "fallDetect" | "radar" | "buzzer",
    on: MessageKey,
    off: MessageKey,
  ) => {
    const v = settings.values?.[key];
    return typeof v === "boolean" ? t(v ? on : off) : null;
  };
  const vibrationLevel = levelLabelKey("vibration", settings.values?.vibration);
  const safetySummary =
    [
      boolSummary("fallDetect", "device.sum.fallOn", "device.sum.fallOff"),
      boolSummary("radar", "device.sum.radarOn", "device.sum.radarOff"),
    ]
      .filter((x) => x !== null)
      .join(" · ") || t("device.cat.safetySummary");
  const alertsSummary =
    [
      vibrationLevel
        ? t("device.sum.vibration", { level: t(vibrationLevel) })
        : null,
      boolSummary("buzzer", "device.sum.buzzerOn", "device.sum.buzzerOff"),
    ]
      .filter((x) => x !== null)
      .join(" · ") || t("device.cat.alertsSummary");

  // 这顶头盔已不在本账号下（别的手机解绑了、点了旧推送 / 深链）：服务端 404 DEVICE_NOT_FOUND。
  // 原来只在顶上写一行「找不到头盔」，下面照样画改名、常用控制、实时画面、解除绑定，点了全都报错（2026-10-15）
  const gone = [status.error, detail.error].some(
    (e) => e instanceof ApiRequestError && e.code === "DEVICE_NOT_FOUND",
  );
  if (gone)
    return (
      <ThemedView style={[styles.flex, styles.goneWrap]}>
        <EmptyState
          icon="help-circle-outline"
          title={t("device.goneTitle")}
          body={t("device.goneBody", { id: deviceId })}
          actionLabel={t("device.goneBack")}
          onAction={() => router.navigate("/")}
        />
      </ThemedView>
    );

  return (
    <ThemedView style={styles.flex}>
      {/* 内容会超出一屏,必须可滚动(Android 实证:小屏下半截不可见且无法下滑) */}
      <ScrollView
        // 最底下是「解除绑定」：让出 iPhone 底部横条，别让按钮贴着它
        contentContainerStyle={[
          styles.container,
          { paddingBottom: 28 + insets.bottom },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.identity}>
          <View style={styles.titleRow}>
            <ThemedText type="title" style={styles.title}>
              {detail.data?.name ?? deviceId}
            </ThemedText>
            <Tappable
              feedback="opacity"
              accessibilityRole="button"
              accessibilityLabel={t("device.renameTitle")}
              hitSlop={8}
              disabled={unbinding}
              onPress={openRename}
              style={[
                styles.renameBtn,
                { backgroundColor: theme.backgroundSelected },
              ]}
            >
              <Ionicons name="pencil" size={16} color={theme.textSecondary} />
            </Tappable>
          </View>
          {detail.data?.name && (
            <ThemedText type="code" themeColor="textSecondary">
              {deviceId}
            </ThemedText>
          )}
        </View>

        {status.isError && (
          <ThemedText type="small">{toUserMessage(status.error)}</ThemedText>
        )}

        {s ? (
          <Card style={styles.statusCard}>
            {/* 电量沿用原有样式（环形电量 + 24 小时柱状图）。离线时数字是上次上报的，标题如实改口 */}
            <BatteryChart
              points={battery.data?.points ?? []}
              to={battery.data?.to}
              current={s.battery}
              charging={s.charging}
              labels={{
                title: online
                  ? t("devices.battery")
                  : t("device.status.lastBattery"),
                window: t("device.batteryWindow"),
                charging: t("devices.charging"),
                empty: t("device.batteryEmpty"),
              }}
            />
            {lowBattery && (
              <View style={styles.inlineNote}>
                <Ionicons
                  name="alert-circle-outline"
                  size={16}
                  color={theme.warning}
                />
                <ThemedText type="small" style={styles.inlineNoteText}>
                  {t("device.status.batteryLow")}
                </ThemedText>
              </View>
            )}
            <View style={[styles.statusRows, { borderTopColor: theme.border }]}>
              <StatusRow
                icon={
                  bleRow.state === "connected"
                    ? "bluetooth"
                    : "bluetooth-outline"
                }
                tone={
                  bleRow.state === "connected"
                    ? "ok"
                    : bleRow.state === "error"
                      ? "bad"
                      : bleRow.state === "idle" ||
                          bleRow.state === "unsupported"
                        ? "neutral"
                        : "warn"
                }
                title={t(
                  bleRow.state === "connected"
                    ? "device.status.bleConnected"
                    : "device.status.bleNotConnected",
                )}
                detail={
                  BLE_DETAIL[bleRow.state]
                    ? t(BLE_DETAIL[bleRow.state]!)
                    : undefined
                }
                actionLabel={bleAction?.label}
                onAction={bleAction?.run}
              />
              <StatusRow
                icon={online ? "cloud-outline" : "cloud-offline-outline"}
                tone={online ? "ok" : "warn"}
                title={t(
                  online ? "device.status.online" : "device.status.offline",
                )}
                trailing={
                  s.lastSeenAt
                    ? t(
                        online
                          ? "device.status.lastReport"
                          : "device.status.lastReportOffline",
                        { ago: relativeTime(s.lastSeenAt, locale) },
                      )
                    : t("device.neverReported")
                }
              />
              {!online && (
                <ThemedText
                  type="small"
                  themeColor="textSecondary"
                  style={styles.offlineHint}
                >
                  {t("device.status.offlineHint")}
                </ThemedText>
              )}
              {whitelist && !whitelist.done && (
                <StatusRow
                  icon="battery-dead-outline"
                  tone="warn"
                  title={t("device.status.backgroundLimited")}
                  actionLabel={t("ble.onboarding.go")}
                  onAction={whitelist.action}
                />
              )}
            </View>
          </Card>
        ) : (
          !status.isError && (
            <Card style={styles.statusCard}>
              <View style={styles.skeletonHead}>
                <Skeleton width={64} height={64} radius={32} />
                <Skeleton width="40%" height={16} />
              </View>
              <Skeleton width="100%" height={96} radius={8} />
            </Card>
          )
        )}

        <ThemedText type="smallBold" style={styles.sectionTitle}>
          {t("device.quickControls")}
        </ThemedText>
        <Card style={styles.controlsCard}>
          <DeviceSettingList
            keys={["light"]}
            settings={settings.values}
            disabled={settings.sending}
            onChange={sendSetting}
            lastCommand={settings.lastCommand}
            icons={{ light: "flashlight-outline" }}
          />
          <View style={[styles.volumeBlock, { borderTopColor: theme.border }]}>
            <VolumeSlider
              value={optimisticVolume ?? serverVolume}
              pending={volumePending}
              onStep={onVolumeStep}
              onRelease={sendVolume}
              onDraggingChange={onVolumeDragging}
              icon="volume-medium-outline"
            />
            <CommandFeedback
              command={settings.lastCommand}
              settingKey="volume"
            />
          </View>
        </Card>

        <ThemedText type="smallBold" style={styles.sectionTitle}>
          {t("device.settings")}
        </ThemedText>
        <Card>
          <ListRow
            icon="shield-checkmark-outline"
            title={t("device.cat.safety")}
            subtitle={safetySummary}
            onPress={() => router.navigate(`/device-safety/${deviceId}`)}
          />
          <ListRow
            icon="notifications-outline"
            title={t("device.cat.alerts")}
            subtitle={alertsSummary}
            onPress={() => router.navigate(`/device-alerts/${deviceId}`)}
          />
          <ListRow
            icon="videocam-outline"
            title={t("device.videoPreview")}
            subtitle={t("device.videoPreview.open")}
            onPress={() => router.navigate("/video-preview")}
          />
          <ListRow
            icon="information-circle-outline"
            title={t("device.cat.about")}
            subtitle={t("device.cat.aboutSummary")}
            onPress={() => router.navigate(`/device-about/${deviceId}`)}
            last
          />
        </Card>

        {/* 解除绑定放在最底部（与「我的」页底部的退出登录同一种放法）；请求在路上时换成转圈，不能再点 */}
        {unbinding ? (
          <View style={styles.unbind}>
            <ActivityIndicator color={theme.textSecondary} />
          </View>
        ) : (
          <Tappable
            feedback="opacity"
            accessibilityRole="button"
            onPress={unbind}
            style={styles.unbind}
          >
            <ThemedText
              type="small"
              style={[styles.unbindText, { color: theme.danger }]}
            >
              {t("device.unbind")}
            </ThemedText>
          </Tappable>
        )}
      </ScrollView>

      {/* 首次连接引导：第一次进来、三步还没做完时弹一次；之后的状态由上面状态卡里的行负责 */}
      <BleFirstConnectGuide />

      {/* 重命名弹层（跨平台；Alert.prompt 仅 iOS 可用故自建） */}
      <Modal
        visible={renameOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setRenameOpen(false)}
      >
        <KeyboardAvoid>
          <Pressable
            // 遮罩只负责「点空白处关闭」，不能自成一个读屏焦点（会把整张卡片合成一块）
            accessible={false}
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
                // 只用来挡住「点卡片关弹层」；不能自成一个读屏焦点，否则里面的选项 / 输入框被合成一块、读屏选不中
                accessible={false}
                onPress={() => undefined}
              >
                <ThemedText type="subtitle">
                  {t("device.renameTitle")}
                </ThemedText>
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
                  success={renamed}
                  onSuccessShown={() => setRenameOpen(false)}
                />
              </Pressable>
            </ReAnimated.View>
          </Pressable>
        </KeyboardAvoid>
      </Modal>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  goneWrap: { justifyContent: "center", paddingHorizontal: 24 },
  container: { padding: 20, gap: 12, paddingBottom: 28 },
  identity: { gap: 4, marginBottom: 4 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { fontSize: 28, lineHeight: 36, flexShrink: 1 },
  renameBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  unbind: {
    alignSelf: "center",
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 16,
    marginTop: 8,
  },
  unbindText: { fontSize: 15 },
  statusCard: { padding: 16, gap: 12 },
  skeletonHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  inlineNote: { flexDirection: "row", alignItems: "center", gap: 6 },
  inlineNoteText: { fontSize: 13, lineHeight: 18, flexShrink: 1 },
  statusRows: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 4,
    marginBottom: -6,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 48,
    paddingVertical: 6,
  },
  statusRowText: { flex: 1, minWidth: 0, gap: 1 },
  statusRowTitle: { fontSize: 14 },
  statusRowDetail: { fontSize: 12, lineHeight: 17 },
  statusRowTrailing: { fontSize: 12, lineHeight: 17, flexShrink: 1 },
  statusRowAction: { flexDirection: "row", alignItems: "center", gap: 2 },
  statusRowActionText: { fontSize: 13 },
  offlineHint: { fontSize: 12, lineHeight: 18, paddingBottom: 8 },
  sectionTitle: { fontSize: 16, paddingHorizontal: 4, marginTop: 10 },
  controlsCard: { paddingHorizontal: 16 },
  volumeBlock: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 14,
    gap: 8,
  },
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
});
