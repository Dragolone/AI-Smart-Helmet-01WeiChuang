// 安全（底部标签，2026-10-06 按确认的原型重排；2026-10-07 精简）：
// 标题 + 右上角「设置」→ 状态卡（连接 / 通知 / 联系人，只说能核实的）→「安全记录」一行 → 底部固定的红色 SOS。
// 这一页不再切换头盔：看的始终是设备页的当前头盔（currentHelmetOf），要换去设备页「设为当前」。
// 状态卡正常时只有一句结论和三项核对；出了问题才多一句说明和一个按钮。
// 联系人、通知权限、后台运行说明、演练集中在「设置」（/safety-settings）；记录在 /safety-records（所有头盔排在一起）。
// 红色只用在两处：进行中的 SOS，和头盔身份不符。头盔没连上是不骑车时的常态，用提醒色。
// 没打开过演练的账号，SOS 按钮下面多一行演练入口，打开过一次就收起。
//
// 下面几件事原样保留：
// - SOS：长按 2 秒经 app-relay 注入 manual_sos，与头盔实体键走同一服务端状态机，倒计时页由 WS 推送弹出；
// - 求救记在当前头盔名下（sosTargetOf）；绑了两顶以上时按钮上方写明是哪一顶；
// - 进行中的 SOS 看的是全部头盔。
import { Ionicons } from "@expo/vector-icons";
import { useQueries, useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import type {
  AccidentListItem,
  EventEnvelope,
  EventType,
} from "@helmet/shared";

import { sosActiveHref } from "@/services/sos-routes";
import { contactsApi } from "@/api/contacts";
import { toUserMessage } from "@/api/error-messages";
import { buildRelayEnvelope, relayApi } from "@/api/relay";
import {
  enqueueRelayEvent,
  notifyCriticalAccepted,
} from "@/services/ble-relay-uplink";
import {
  isHelmetGoneError,
  isUnrecoverableRelayError,
} from "@/services/relay-errors";
import { sosApi } from "@/api/sos";
import { AnimatedPressable } from "@/components/animated-pressable";
import { PrimaryButton, SecondaryButton } from "@/components/form";
import { IntercomMiniBar } from "@/components/intercom-mini-bar";
import { Card, IconCircle, type IconName } from "@/components/list";
import { CrossfadeIcon, useJello, useTintStyle } from "@/components/motion";
import { Skeleton } from "@/components/skeleton";
import { StatusChip, type ChipLevel } from "@/components/status-chip";
import { SwitchHelmetPrompt } from "@/components/switch-helmet-prompt";
import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { Radius } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import {
  useHelmetLinks,
  useHelmets,
  useNotifyPermission,
  usePendingSos,
  useSosDrill,
} from "@/hooks/use-safety";
import { useTheme } from "@/hooks/use-theme";
import { translate, useLocale, useT } from "@/i18n";
import { shortDate } from "@/i18n/format";
import { whenForegroundSettled } from "@/services/foreground-settled";
import { openNotificationSettings } from "@/services/notification-settings";
import {
  helmetNameOf,
  isLinkFault,
  linkCheckLevelOf,
  linkLabelKey,
  protectionStateOf,
  sosTargetOf,
  type HelmetLink,
} from "@/services/safety-status";
import { showNotice } from "@/services/notice";

/** 长按求救没成功后，多久之内再长按算同一次（复用 eventId） */
const SOS_RETRY_WINDOW_MS = 60_000;
type UnsentSos = {
  deviceId: string;
  envelope: ReturnType<typeof buildRelayEnvelope>;
  at: number;
};
/** 上一次失败暂存的那条是不是同一顶头盔、还在重试窗口内（放组件外：React Compiler 不让渲染路径里直接碰 Date.now） */
const isRecentUnsent = (
  prev: UnsentSos | null,
  deviceId: string,
): prev is UnsentSos =>
  prev !== null &&
  prev.deviceId === deviceId &&
  Date.now() - prev.at < SOS_RETRY_WINDOW_MS;

type Tone = "success" | "warning" | "danger";

/**
 * 状态卡：结论（图标 + 标题）→ 三个核对项；出了问题才有一句说明和一个动作。
 * 结论不只靠颜色：每档都有各自的图标和文字。
 */
function StatusCard({
  tone,
  icon,
  title,
  body,
  checks,
  actionLabel,
  onAction,
}: {
  tone: Tone;
  icon: IconName;
  title: string;
  body?: string;
  checks?: { level: ChipLevel; label: string; a11y: string }[];
  actionLabel?: string;
  onAction?: () => void;
}) {
  const theme = useTheme();
  const bg =
    tone === "success"
      ? theme.successBg
      : tone === "warning"
        ? theme.warningBg
        : theme.dangerBg;
  // 结论变了（加完联系人、头盔连上）：图标圆的底色和图标都过渡，和首页「安全」格、下面的核对项同一个节奏。
  // 卡片本身保持中性底：整卡涂色看着像模板（负责人 2026-10-15）
  const iconTint = useTintStyle({ backgroundColor: bg });
  return (
    <Card style={styles.statusCard}>
      {/* 只有一句结论时和图标居中对齐；带说明时标题与图标顶端对齐 */}
      <View
        style={[
          styles.statusHead,
          body === undefined && { alignItems: "center" },
        ]}
      >
        <Animated.View style={[styles.statusIcon, iconTint]}>
          <CrossfadeIcon name={icon} size={24} color={theme[tone]} pop />
        </Animated.View>
        <View style={styles.statusText}>
          {/* 状态标题字号本来就大：系统字体超过 1.3 倍时不再跟着放大，免得在词中间断行（华为「超大」档 1.45 倍实测） */}
          <ThemedText
            type="smallBold"
            maxFontSizeMultiplier={TITLE_FONT_CAP}
            style={styles.statusTitle}
          >
            {title}
          </ThemedText>
          {body !== undefined && (
            <ThemedText
              type="small"
              themeColor="textSecondary"
              style={styles.statusBody}
            >
              {body}
            </ThemedText>
          )}
        </View>
      </View>
      {checks && (
        <View style={[styles.checks, { borderTopColor: theme.border }]}>
          {checks.map((c) => (
            // 核对项的字很短（正常时只写头盔名 / 「通知」）：读屏念完整的那一句
            <View key={c.a11y} accessible accessibilityLabel={c.a11y}>
              <StatusChip level={c.level} label={c.label} />
            </View>
          ))}
        </View>
      )}
      {actionLabel && onAction && (
        <SecondaryButton compact title={actionLabel} onPress={onAction} />
      )}
    </Card>
  );
}

/**
 * 「安全记录」一行：副标题写所有头盔里最近的一条 SOS，点了进记录页的 SOS 那一栏。
 * 这一页放的是 SOS 而不是风险提醒：求救之后用户要能在这里找回那条记录。
 */
function RecordsRow({
  latest,
  state,
}: {
  latest: AccidentListItem | undefined;
  /** 没有 latest 时：还在拉 / 拉失败 / 确实没有。拉失败不能说成「暂无」 */
  state: "loading" | "failed" | "empty";
}) {
  const theme = useTheme();
  const t = useT();
  const locale = useLocale();
  const line = latest
    ? t("safety.recordsLatest", {
        date: shortDate(latest.createdAt, locale),
        type: t(
          latest.triggerType === "manual_sos"
            ? "safety.manualSos"
            : "safety.risk.fall",
        ),
        status: t(`safety.status.${latest.status}`),
      })
    : state === "loading"
      ? "…"
      : t(
          state === "failed" ? "safety.latestSosFailed" : "records.sosEmptyAll",
        );
  return (
    <Card>
      <Tappable
        feedback="fill"
        accessibilityRole="button"
        onPress={() => router.navigate("/safety-records?tab=sos")}
        style={styles.recordsRow}
      >
        <IconCircle icon="time-outline" size={36} />
        <View style={styles.recordsBody}>
          <ThemedText type="smallBold" style={styles.recordsTitle}>
            {t("safety.records")}
          </ThemedText>
          <ThemedText
            type="small"
            themeColor="textSecondary"
            numberOfLines={1}
            style={styles.recordsLine}
          >
            {line}
          </ThemedText>
        </View>
        <Ionicons
          name="chevron-forward"
          size={18}
          color={theme.textSecondary}
        />
      </Tappable>
    </Card>
  );
}

/** 通知权限被拒的说明弹窗每次进程只弹一次 */
let notifyAlertShown = false;

export default function SafetyScreen() {
  const theme = useTheme();
  const scheme = useColorScheme();
  const t = useT();

  const helmets = useHelmets();
  const { list } = helmets;
  const links = useHelmetLinks(list, !helmets.stale);
  // 这一页说的是设备页的当前头盔，也就是 App 内求救记在谁名下的那一顶
  const sosTarget = sosTargetOf(list, helmets.chosenId);
  const sosTargetId = sosTarget?.deviceId;
  const link: HelmetLink | null = sosTarget ? links[sosTarget.deviceId] : null;
  // 进行中的 SOS 看全部头盔：不是当前头盔上的那一条也必须在
  const pending = usePendingSos(list.map((d) => d.deviceId));

  // 通知权限被拒 → 锁屏上收不到摔倒提醒，必须显式告知（REGRESSION 8.2「功能降级有提示」）。
  // 用户不知道「关通知 = 锁屏收不到摔倒提醒」（负责人 2026-09-26）：主动弹一次说清楚，
  // 每次进程只弹一次，之后由状态卡持续提醒，不反复打扰
  // 等系统的权限框都走完再弹：第一次登录时它们一个接一个出，被拒一次后系统还会紧接着再问一次，
  // 那几秒里的「被拒」还不是定论，而且夹在两个系统框中间弹的说明框 Android 上会丢
  //（services/foreground-settled.ts）
  const notify = useNotifyPermission();
  useEffect(() => {
    if (notify !== "denied" || notifyAlertShown) return;
    return whenForegroundSettled(() => {
      if (notifyAlertShown) return;
      notifyAlertShown = true;
      Alert.alert(t("safety.notifyAlertTitle"), t("safety.notifyAlertBody"), [
        { text: t("safety.notifyLater"), style: "cancel" },
        {
          text: t("safety.notifyGoSettings"),
          onPress: () => void openNotificationSettings(),
        },
      ]);
    });
  }, [notify, t]);

  const contacts = useQuery({
    queryKey: ["contacts"],
    queryFn: contactsApi.list,
    // 还没拿到列表时每 30 秒再拉一次：否则失败一次后会一直停在「待确认」。拿到后不轮询
    refetchInterval: (q) => (q.state.data === undefined ? 30_000 : false),
  });
  // 没拿到列表（加载中 / 失败）≠ 0 位联系人
  const contactCount = contacts.data ? contacts.data.length : null;

  // 与安全记录页「SOS 记录」同一份缓存（每台一份，最新在前）：实时通道收到 sos_update 时按前缀失效，
  // 30 秒轮询兜底。这里只取所有头盔里最近的一条
  const sosRecords = useQueries({
    queries: list.map((d) => ({
      queryKey: ["accidents", d.deviceId],
      queryFn: () => sosApi.accidents(d.deviceId),
      refetchInterval: 30_000,
    })),
  });
  const latestSos = sosRecords
    .map((q) => q.data?.items[0])
    .filter((a): a is AccidentListItem => a !== undefined)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  // 有一台没拿到就不能下「没有记录」的结论
  const recordsState = sosRecords.some((q) => q.isError)
    ? "failed"
    : sosRecords.some((q) => q.data === undefined)
      ? "loading"
      : "empty";
  const drill = useSosDrill();

  /** 长按 2 秒触发（防误触）：进度从左到右填满按钮 */
  const sosP = useSharedValue(0);
  const sosFillStyle = useAnimatedStyle(() => ({
    width: `${sosP.get() * 100}%`,
  }));
  const sosScaleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(sosP.get(), [0, 1], [1, 0.97]) }],
  }));
  // 长按未满 2 s 就松手：按钮果冻抖一下，提示"要按住"（可用性提示，不是装饰）
  const jello = useJello();
  const sosFired = useRef(false);
  // 上一次长按发送失败已暂存：60 s 内再长按复用同一个 eventId。没网时弹「发送失败」，
  // 用户自然再按一次——两条不同 eventId 一批补传，第二条被服务端当「再按一次 = 立即求救」，60 秒取消窗口没了
  //（10-20 模拟器实测）。同 eventId 服务端幂等（duplicate），只是重试；成功过之后再按才是新动作
  const unsentSos = useRef<UnsentSos | null>(null);
  const fireSos = () => {
    if (!sosTargetId) return;
    sosFired.current = true;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(
      () => {},
    );
    // 一次长按一个 eventId：失败后按原 eventId 进持久队列重试（服务端幂等，不会变成第二次求救）；
    // 成功后立刻核对进行中的 SOS 拉起倒计时页，不等 WS（10-06 不变式评审 F-5）
    // 只复用「失败已暂存」的那条；都在飞 / 都成功的两次长按仍是两个 eventId（第二次 = 立即求救，同实体键）
    const prev = unsentSos.current;
    const envelope = isRecentUnsent(prev, sosTargetId)
      ? prev.envelope
      : buildRelayEnvelope(sosTargetId, "manual_sos", {});
    relayApi
      .push({ deviceId: sosTargetId, envelopes: [envelope] })
      .then(() => {
        // 发成功了：这次动作结束，再长按是新的一次
        if (unsentSos.current?.envelope === envelope) unsentSos.current = null;
      })
      .then(() => notifyCriticalAccepted(sosTargetId))
      .catch((e) => {
        // 服务端明确拒绝（头盔已不在这个账号下 / 无权 / 坏体）：重发也没用，补发队列也会丢掉，不进队列、不说「已暂存」
        if (isUnrecoverableRelayError(e)) {
          if (unsentSos.current?.envelope === envelope)
            unsentSos.current = null;
          showNotice(
            translate("safety.sosSendFailed"),
            `${isHelmetGoneError(e) ? translate("safety.sosHelmetGone") : toUserMessage(e)}\n${translate("safety.sosNotSent")}`,
          );
          return;
        }
        enqueueRelayEvent(envelope as EventEnvelope<EventType>);
        unsentSos.current = { deviceId: sosTargetId, envelope, at: Date.now() };
        showNotice(
          translate("safety.sosSendFailed"),
          `${toUserMessage(e)}\n${translate("safety.sosQueued")}`,
        );
      });
  };

  const [devOpen, setDevOpen] = useState(false);
  const inject = (deviceId: string, type: "possible_fall" | "collision_risk") =>
    relayApi
      .pushEvent(
        deviceId,
        type,
        type === "possible_fall"
          ? { confidence: 0.95 }
          : { riskLevel: "high", direction: "rear" },
      )
      .catch((e) =>
        showNotice(translate("safety.dev.failed"), toUserMessage(e)),
      );

  // 三项核对：正常时字尽量少（头盔只写名字、通知只写「通知」），不正常的那一项写明是什么问题
  const checks =
    sosTarget && link
      ? [
          {
            level: linkCheckLevelOf(link),
            label: helmetNameOf(sosTarget),
            a11y: `${helmetNameOf(sosTarget)}${t("common.a11ySep")}${t(linkLabelKey(link))}`,
          },
          notify === "granted"
            ? {
                level: "ok" as const,
                label: t("safety.check.notify"),
                a11y: t("safety.check.notifyOn"),
              }
            : notify === "denied"
              ? {
                  level: "bad" as const,
                  label: t("safety.check.notifyOff"),
                  a11y: t("safety.check.notifyOff"),
                }
              : {
                  level: "unknown" as const,
                  label: t("safety.check.notifyUnknown"),
                  a11y: t("safety.check.notifyUnknown"),
                },
          contactCount === null
            ? {
                level: "unknown" as const,
                label: t("safety.check.contactsUnknown"),
                a11y: t("safety.check.contactsUnknown"),
              }
            : contactCount === 0
              ? {
                  level: "bad" as const,
                  label: t("safety.check.contactsNone"),
                  a11y: t("safety.check.contactsNone"),
                }
              : {
                  level: "ok" as const,
                  label: t("safety.check.contacts", { n: contactCount }),
                  a11y: t("safety.check.contacts", { n: contactCount }),
                },
        ]
      : undefined;

  const statusCard = () => {
    // 列表还没拿到：不知道绑了几顶，更谈不上连没连上——不能落到「尚未绑定头盔」
    if (!helmets.known) {
      if (!helmets.stale)
        return (
          <Card style={styles.statusCard}>
            <View style={styles.statusHead}>
              <Skeleton width={44} height={44} radius={22} />
              <View style={styles.statusText}>
                <Skeleton width="55%" height={18} />
                <Skeleton width="80%" height={13} />
              </View>
            </View>
          </Card>
        );
      return (
        <StatusCard
          tone="warning"
          icon="cloud-offline-outline"
          title={t("safety.state.loadFailed")}
          body={t("safety.state.loadFailedBody")}
          actionLabel={t("safety.action.retry")}
          onAction={() => void helmets.refetch()}
        />
      );
    }
    const state = protectionStateOf({ link, notify, contacts: contactCount });
    if (state === "noHelmet" || !sosTarget || !link)
      return (
        <StatusCard
          tone="warning"
          icon="shield-half-outline"
          title={t("safety.state.noHelmet")}
          body={t("safety.state.noHelmetBody")}
          actionLabel={t("safety.action.bind")}
          onAction={() => router.navigate("/bind-device")}
        />
      );
    const openDetail = () => router.navigate(`/device/${sosTarget.deviceId}`);
    switch (state) {
      case "linkDown":
        return (
          <StatusCard
            // 头盔关机、不在身边是不骑车时的常态：提醒色。红色只留给身份不符这种故障
            tone={isLinkFault(link) ? "danger" : "warning"}
            icon="bluetooth-outline"
            title={t(linkLabelKey(link))}
            body={t(
              link === "bluetoothOff" || link === "bluetoothDenied"
                ? "safety.state.bluetoothBody"
                : link === "mismatch"
                  ? "safety.state.mismatchBody"
                  : "safety.state.linkDownBody",
            )}
            checks={checks}
            actionLabel={t("safety.action.checkLink")}
            onAction={openDetail}
          />
        );
      case "unknown":
        return (
          <StatusCard
            tone="warning"
            icon="help-circle-outline"
            title={t("safety.state.unknown")}
            body={t(
              helmets.stale
                ? "safety.state.staleBody"
                : "safety.state.unknownBody",
            )}
            checks={checks}
            actionLabel={t("safety.action.helmetDetail")}
            onAction={openDetail}
          />
        );
      case "notifyOff":
        return (
          <StatusCard
            tone="warning"
            icon="notifications-off-outline"
            title={t("safety.state.notifyOff")}
            body={t("safety.state.notifyOffBody")}
            checks={checks}
            actionLabel={t("safety.action.notifySettings")}
            onAction={() => void openNotificationSettings()}
          />
        );
      case "noContacts":
        return (
          <StatusCard
            tone="warning"
            icon="person-add-outline"
            title={t("safety.state.noContacts")}
            body={t("safety.state.noContactsBody")}
            checks={checks}
            actionLabel={t("safety.action.addContact")}
            onAction={() => router.navigate("/add-contact")}
          />
        );
      default:
        // 一切正常：只留结论和三项核对，不放说明也不放按钮
        return (
          <StatusCard
            tone="success"
            icon="shield-checkmark-outline"
            title={t("safety.state.ready")}
            checks={checks}
          />
        );
    }
  };

  return (
    <ThemedView style={styles.flex}>
      <SafeAreaView style={styles.flex}>
        <ScrollView
          contentContainerStyle={styles.container}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.header}>
            <ThemedText
              type="title"
              accessibilityRole="header"
              style={styles.pageTitle}
            >
              {t("safety.title")}
            </ThemedText>
            <Tappable
              feedback="opacity"
              accessibilityRole="button"
              accessibilityLabel={t("safety.settingsA11y")}
              onPress={() => router.navigate("/safety-settings")}
              hitSlop={8}
              style={styles.settingsBtn}
            >
              <Ionicons
                name="settings-outline"
                size={18}
                color={theme.textSecondary}
              />
              <ThemedText type="small" themeColor="textSecondary">
                {t("safety.settings")}
              </ThemedText>
            </Tappable>
          </View>

          {/* 有进行中的 SOS 时，状态卡的位置让给它：哪顶头盔上的都列出来并写明来源 */}
          {pending.length > 0
            ? pending.map((sos) => (
                <Card
                  key={sos.sosId}
                  style={[styles.statusCard, { borderColor: theme.danger }]}
                >
                  <View style={styles.statusHead}>
                    <IconCircle
                      icon="warning-outline"
                      size={44}
                      iconSize={24}
                      color={theme.danger}
                      bg={theme.dangerBg}
                    />
                    <View style={styles.statusText}>
                      <ThemedText
                        type="smallBold"
                        maxFontSizeMultiplier={TITLE_FONT_CAP}
                        style={styles.statusTitle}
                      >
                        {t("safety.state.sos")}
                      </ThemedText>
                      <ThemedText
                        type="small"
                        themeColor="textSecondary"
                        style={styles.statusBody}
                      >
                        {t("safety.state.sosBody", {
                          device: helmetNameOf(
                            list.find((d) => d.deviceId === sos.deviceId) ?? {
                              name: null,
                              deviceId: sos.deviceId,
                            },
                          ),
                        })}
                      </ThemedText>
                    </View>
                  </View>
                  <PrimaryButton
                    danger
                    compact
                    icon="warning-outline"
                    title={t("safety.action.openCountdown")}
                    onPress={() =>
                      router.navigate(sosActiveHref(sos.sosId, sos.deviceId))
                    }
                  />
                </Card>
              ))
            : statusCard()}

          {sosTarget && <RecordsRow latest={latestSos} state={recordsState} />}

          {/* 开发测试：经 app-relay 真实链路注入事件（仅 DEV 构建可见），注入到当前头盔 */}
          {__DEV__ && sosTargetId && (
            <View style={[styles.devBox, { borderColor: theme.border }]}>
              <Tappable
                onPress={() => setDevOpen((v) => !v)}
                style={styles.devHeader}
              >
                <ThemedText type="label" themeColor="textSecondary">
                  {t("safety.dev.title")}
                </ThemedText>
                <Ionicons
                  name={devOpen ? "chevron-up" : "chevron-down"}
                  size={14}
                  color={theme.textSecondary}
                />
              </Tappable>
              {devOpen && (
                <View style={styles.devRow}>
                  <Tappable
                    style={[styles.devBtn, { backgroundColor: theme.dangerBg }]}
                    onPress={() => void inject(sosTargetId, "possible_fall")}
                  >
                    <ThemedText
                      type="smallBold"
                      style={{ color: theme.danger, fontSize: 13 }}
                    >
                      {t("safety.dev.fall")}
                    </ThemedText>
                  </Tappable>
                  <Tappable
                    style={[
                      styles.devBtn,
                      { backgroundColor: theme.warningBg },
                    ]}
                    onPress={() => void inject(sosTargetId, "collision_risk")}
                  >
                    <ThemedText
                      type="smallBold"
                      style={{ color: theme.warning, fontSize: 13 }}
                    >
                      {t("safety.dev.collision")}
                    </ThemedText>
                  </Tappable>
                </View>
              )}
            </View>
          )}
        </ScrollView>

        {/* 「对讲中」小条放在 SOS 上方：不能挡住 SOS，也不能把它挤走 */}
        <IntercomMiniBar style={styles.miniBar} />

        {/* 拇指区固定。有进行中的 SOS 时这里收起：处理入口是上面那张红框卡片 */}
        {sosTarget && pending.length === 0 && (
          <View style={[styles.bottomSos, { borderTopColor: theme.border }]}>
            {/* 只有一顶头盔时没有「记在谁名下」的疑问，这一行不出现 */}
            {list.length > 1 && (
              <View style={styles.sosTargetRow}>
                <Ionicons
                  name="shield-half-outline"
                  size={14}
                  color={theme.textSecondary}
                />
                <ThemedText
                  type="small"
                  themeColor="textSecondary"
                  style={styles.sosTargetText}
                >
                  {t("safety.sosTarget", { device: helmetNameOf(sosTarget) })}
                </ThemedText>
              </View>
            )}
            <AnimatedPressable
              accessibilityRole="button"
              accessibilityLabel={t("safety.sosA11y", {
                device: helmetNameOf(sosTarget),
              })}
              delayLongPress={2000}
              onPressIn={() => {
                // 按下瞬间就要有触觉确认（骑行戴手套看不清屏幕），2 秒后触发时再一次警示振动
                sosFired.current = false;
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(
                  () => {},
                );
                sosP.set(
                  withTiming(1, { duration: 2000, easing: Easing.linear }),
                );
              }}
              onPressOut={() => {
                sosP.set(withTiming(0, { duration: 180 }));
                if (!sosFired.current) jello.trigger();
              }}
              onLongPress={() => {
                fireSos();
                // 触发后倒计时页弹出、这块区域随即收起，松手事件到不了这里——不主动收回的话，
                // 求救结束后按钮回来时进度还停在满格（看起来像一直被按着）
                sosP.set(withTiming(0, { duration: 180 }));
              }}
              style={[
                styles.sosBtn,
                {
                  backgroundColor: theme.sos,
                  shadowColor: theme.sos,
                  shadowOpacity: scheme === "light" ? 0.18 : 0.45,
                },
                sosScaleStyle,
                jello.style,
              ]}
            >
              <Animated.View style={[styles.sosFill, sosFillStyle]} />
              {/* 「SOS」三个字是标志，说明在右边那列：系统字体放大时它最多放大 1.5 倍，把宽度让给说明 */}
              <ThemedText
                type="display"
                maxFontSizeMultiplier={1.5}
                style={styles.sosWord}
              >
                SOS
              </ThemedText>
              <View style={styles.sosDivider} />
              <View style={styles.sosTextCol}>
                <ThemedText type="smallBold" style={styles.sosTitle}>
                  {t("safety.sosHold")}
                </ThemedText>
                <ThemedText type="small" style={styles.sosSub}>
                  {t("safety.sosCancelable")}
                </ThemedText>
              </View>
            </AnimatedPressable>
            {/* 没打开过演练的账号才有这一行：新用户先见过一次求救长什么样，真出事时才敢按、也知道怎么取消 */}
            {drill.unseen && (
              <Tappable
                feedback="opacity"
                accessibilityRole="button"
                onPress={drill.open}
                style={styles.drillLink}
              >
                <ThemedText
                  type="small"
                  themeColor="textSecondary"
                  style={styles.drillLinkText}
                >
                  {t("safety.drillLink")}
                </ThemedText>
              </Tappable>
            )}
          </View>
        )}
      </SafeAreaView>
      <SwitchHelmetPrompt />
    </ThemedView>
  );
}

/** 大标题跟随系统字体放大的上限（1.45 倍时词中间断行，1.3 倍正常） */
const TITLE_FONT_CAP = 1.3;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { paddingHorizontal: 20, paddingBottom: 16, gap: 14 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: -4,
  },
  pageTitle: { fontSize: 32, lineHeight: 40, flexShrink: 1 },
  settingsBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    minHeight: 44,
    paddingLeft: 8,
  },
  statusCard: { padding: 18, gap: 14 },
  statusHead: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  statusIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  statusText: { flex: 1, gap: 4, minWidth: 0 },
  statusTitle: { fontSize: 18, lineHeight: 24 },
  statusBody: { fontSize: 13, lineHeight: 19 },
  checks: {
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: 14,
    rowGap: 8,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  recordsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingLeft: 16,
    paddingRight: 12,
    minHeight: 68,
  },
  recordsBody: { flex: 1, minWidth: 0 },
  recordsTitle: { fontSize: 15, lineHeight: 20 },
  recordsLine: { fontSize: 13, lineHeight: 18 },
  miniBar: { paddingHorizontal: 12, paddingBottom: 10 },
  bottomSos: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 22,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sosTargetRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  sosTargetText: { fontSize: 13, lineHeight: 18, flexShrink: 1 },
  drillLink: {
    alignSelf: "center",
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 12,
    marginBottom: -10,
  },
  drillLinkText: { fontSize: 13 },
  // 不加左右内边距：进度条（sosFill）的百分比宽度按内容区算，加了就铺不满整颗按钮
  sosBtn: {
    minHeight: 72,
    paddingVertical: 12,
    // 字放大到一行放不下时内容会顶到两端，被胶囊的圆角裁掉（2026-10-15 边界测试：2 倍字体「SOS」被切）
    paddingHorizontal: 24,
    borderRadius: Radius.pill,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    overflow: "hidden",
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  sosFill: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    backgroundColor: "rgba(255,255,255,0.22)",
  },
  sosWord: { color: "#FFFFFF", fontSize: 26, lineHeight: 30, letterSpacing: 2 },
  sosDivider: {
    width: 1,
    height: 28,
    backgroundColor: "rgba(255,255,255,0.35)",
  },
  sosTextCol: { gap: 2, flexShrink: 1 },
  sosTitle: { color: "#FFFFFF", fontSize: 16, lineHeight: 20 },
  sosSub: { color: "rgba(255,255,255,0.9)", fontSize: 12, lineHeight: 16 },
  devBox: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: Radius.card,
    padding: 12,
    gap: 10,
  },
  devHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 32,
  },
  devRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  devBtn: {
    borderRadius: Radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
});
