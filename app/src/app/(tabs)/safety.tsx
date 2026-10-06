// 安全（底部标签，2026-10-06 按确认的原型重排）：
// 标题 + 右上角「设置」→ 正在查看的头盔 → 状态卡（连接 / 通知 / 联系人，只说能核实的）
// → 最近一次 SOS 记录 + 全页唯一的「查看记录」入口 → 底部固定的红色 SOS。
// 联系人、通知权限、后台运行说明、演练集中在「设置」（/safety-settings）；记录在 /safety-records。
// 首页放的是 SOS 记录而不是风险提醒：求救之后用户要能在这一页找回那条记录（风险提醒在记录页里看）。
// 红色只用在两处：进行中的 SOS，和头盔身份不符。头盔没连上是不骑车时的常态，用提醒色。
// 没打开过演练的账号，SOS 按钮下面多一行演练入口，打开过一次就收起。
//
// 这次只动编排，下面几件事原样保留：
// - SOS：长按 2 秒经 app-relay 注入 manual_sos，与头盔实体键走同一服务端状态机，倒计时页由 WS 推送弹出；
// - 求救记在哪顶头盔名下：第一台在线的，否则第一台（sosTargetOf）——不跟着「正在查看的头盔」变；
// - 进行中的 SOS 看的是全部头盔，不受上面选了哪顶影响。
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, Linking, ScrollView, StyleSheet, View } from "react-native";
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

import { contactsApi } from "@/api/contacts";
import { toUserMessage } from "@/api/error-messages";
import { buildRelayEnvelope, relayApi } from "@/api/relay";
import {
  enqueueRelayEvent,
  notifyCriticalAccepted,
} from "@/services/ble-relay-uplink";
import { sosApi } from "@/api/sos";
import { AnimatedPressable } from "@/components/animated-pressable";
import { Badge } from "@/components/badge";
import { PrimaryButton } from "@/components/form";
import {
  HelmetSwitcher,
  helmetNameOf,
  linkLabelKey,
} from "@/components/helmet-switcher";
import { Card, IconCircle, type IconName } from "@/components/list";
import { useJello } from "@/components/motion";
import { Skeleton } from "@/components/skeleton";
import { StatusChip, type ChipLevel } from "@/components/status-chip";
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
import { relativeTime, shortDate, shortTime } from "@/i18n/format";
import {
  isLinkFault,
  linkCheckLevelOf,
  protectionStateOf,
  sosTargetOf,
  type HelmetLink,
} from "@/services/safety-status";

type Tone = "success" | "warning" | "danger";

/** 状态卡：结论（图标 + 标题 + 说明）→ 三个核对项 → 一个动作。结论不只靠颜色：每档都有各自的图标和文字 */
function StatusCard({
  tone,
  icon,
  title,
  body,
  checks,
  actionLabel,
  onAction,
  emphasized = false,
}: {
  tone: Tone;
  icon: IconName;
  title: string;
  body: string[];
  checks?: { level: ChipLevel; label: string }[];
  actionLabel?: string;
  onAction?: () => void;
  /** 需要用户处理的状态：动作行加底色，和「一切正常」时的普通链接区分开 */
  emphasized?: boolean;
}) {
  const theme = useTheme();
  const bg =
    tone === "success"
      ? theme.successBg
      : tone === "warning"
        ? theme.warningBg
        : theme.dangerBg;
  return (
    <Card style={styles.statusCard}>
      <View style={styles.statusHead}>
        <IconCircle
          icon={icon}
          size={44}
          iconSize={24}
          color={theme[tone]}
          bg={bg}
        />
        <View style={styles.statusText}>
          <ThemedText type="smallBold" style={styles.statusTitle}>
            {title}
          </ThemedText>
          {body.map((line) => (
            <ThemedText
              key={line}
              type="small"
              themeColor="textSecondary"
              style={styles.statusBody}
            >
              {line}
            </ThemedText>
          ))}
        </View>
      </View>
      {checks && (
        <View style={[styles.checks, { borderTopColor: theme.border }]}>
          {checks.map((c) => (
            <StatusChip key={c.label} level={c.level} label={c.label} />
          ))}
        </View>
      )}
      {actionLabel && onAction && (
        <Tappable
          feedback="opacity"
          accessibilityRole="button"
          onPress={onAction}
          style={[
            styles.statusAction,
            emphasized && {
              backgroundColor: theme.backgroundSelected,
              paddingHorizontal: 12,
            },
          ]}
        >
          <ThemedText type="small" style={styles.statusActionText}>
            {actionLabel}
          </ThemedText>
          <Ionicons
            name="chevron-forward"
            size={16}
            color={theme.textSecondary}
          />
        </Tappable>
      )}
    </Card>
  );
}

/** 首页那一条最近的 SOS 记录：图标用中性色，轻重由右侧状态标表达（进行中才是红的） */
function SosRecordRow({ record }: { record: AccidentListItem }) {
  const theme = useTheme();
  const t = useT();
  const locale = useLocale();
  const status =
    record.status === "pending"
      ? { variant: "danger" as const, label: t("safety.status.pending") }
      : record.status === "notified"
        ? { variant: "warning" as const, label: t("safety.status.notified") }
        : { variant: "neutral" as const, label: t("safety.status.cancelled") };
  return (
    <Tappable
      feedback="fill"
      accessibilityRole="button"
      onPress={() => router.push(`/accident/${record.sosId}`)}
      style={styles.recordRow}
    >
      <IconCircle
        icon={
          record.triggerType === "manual_sos"
            ? "hand-left-outline"
            : "body-outline"
        }
        size={36}
      />
      <View style={styles.recordBody}>
        <ThemedText type="small" style={styles.recordTitle} numberOfLines={1}>
          {t(
            record.triggerType === "manual_sos"
              ? "records.sos.manual"
              : "records.sos.fall",
          )}
        </ThemedText>
        <ThemedText
          type="small"
          themeColor="textSecondary"
          style={styles.recordTime}
        >
          {shortDate(record.createdAt, locale)}{" "}
          {shortTime(record.createdAt, locale)}
        </ThemedText>
      </View>
      <Badge variant={status.variant} label={status.label} />
      <Ionicons name="chevron-forward" size={16} color={theme.textSecondary} />
    </Tappable>
  );
}

/** 通知权限被拒的说明弹窗每次进程只弹一次 */
let notifyAlertShown = false;

export default function SafetyScreen() {
  const theme = useTheme();
  const scheme = useColorScheme();
  const t = useT();
  const locale = useLocale();

  const helmets = useHelmets();
  const { list, viewed } = helmets;
  const links = useHelmetLinks(list, !helmets.stale);
  const link: HelmetLink | null = viewed ? links[viewed.deviceId] : null;
  // 进行中的 SOS 看全部头盔：正在查看别的头盔时，这一条也必须在
  const pending = usePendingSos(list.map((d) => d.deviceId));

  // 通知权限被拒 → 锁屏上收不到摔倒提醒，必须显式告知（REGRESSION 8.2「功能降级有提示」）。
  // 用户不知道「关通知 = 锁屏收不到摔倒提醒」（负责人 2026-09-26）：主动弹一次说清楚，
  // 每次进程只弹一次，之后由状态卡持续提醒，不反复打扰
  const notify = useNotifyPermission();
  useEffect(() => {
    if (notify !== "denied" || notifyAlertShown) return;
    notifyAlertShown = true;
    Alert.alert(t("safety.notifyAlertTitle"), t("safety.notifyAlertBody"), [
      { text: t("safety.notifyLater"), style: "cancel" },
      {
        text: t("safety.notifyGoSettings"),
        onPress: () => void Linking.openSettings(),
      },
    ]);
  }, [notify, t]);

  const contacts = useQuery({
    queryKey: ["contacts"],
    queryFn: contactsApi.list,
    // 还没拿到列表时每 30 秒再拉一次：否则失败一次后会一直停在「待确认」。拿到后不轮询
    refetchInterval: (q) => (q.state.data === undefined ? 30_000 : false),
  });
  // 没拿到列表（加载中 / 失败）≠ 0 位联系人
  const contactCount = contacts.data ? contacts.data.length : null;

  const viewedId = viewed?.deviceId;
  // 与安全记录页「SOS 记录」同一份缓存（最新在前）：实时通道收到 sos_update 时按前缀失效，30 秒轮询兜底
  const sosRecords = useQuery({
    queryKey: ["accidents", viewedId],
    queryFn: () => sosApi.accidents(viewedId!),
    enabled: !!viewedId,
    refetchInterval: 30_000,
  });
  const latestSos = sosRecords.data?.items[0];
  const drill = useSosDrill();

  /** 长按 2 秒触发（防误触）：进度从左到右填满按钮 */
  const sosP = useSharedValue(0);
  const sosFillStyle = useAnimatedStyle(() => ({
    width: `${sosP.get() * 100}%`,
  }));
  const sosScaleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(sosP.get(), [0, 1], [1, 0.97]) }],
  }));
  const sosTarget = sosTargetOf(list);
  const sosTargetId = sosTarget?.deviceId;
  // 长按未满 2 s 就松手：按钮果冻抖一下，提示"要按住"（可用性提示，不是装饰）
  const jello = useJello();
  const sosFired = useRef(false);
  const fireSos = () => {
    if (!sosTargetId) return;
    sosFired.current = true;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(
      () => {},
    );
    // 一次长按一个 eventId：失败后按原 eventId 进持久队列重试（服务端幂等，不会变成第二次求救）；
    // 成功后立刻核对进行中的 SOS 拉起倒计时页，不等 WS（10-06 不变式评审 F-5）
    const envelope = buildRelayEnvelope(sosTargetId, "manual_sos", {});
    relayApi
      .push({ deviceId: sosTargetId, envelopes: [envelope] })
      .then(() => notifyCriticalAccepted(sosTargetId))
      .catch((e) => {
        enqueueRelayEvent(envelope as EventEnvelope<EventType>);
        Alert.alert(
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
        Alert.alert(translate("safety.dev.failed"), toUserMessage(e)),
      );

  const lastSeenLine = viewed
    ? viewed.lastSeenAt
      ? t("safety.state.lastSeen", {
          ago: relativeTime(viewed.lastSeenAt, locale),
        })
      : t("safety.state.neverSeen")
    : "";
  const checks =
    viewed && link
      ? [
          { level: linkCheckLevelOf(link), label: t(linkLabelKey(link)) },
          notify === "granted"
            ? { level: "ok" as const, label: t("safety.check.notifyOn") }
            : notify === "denied"
              ? { level: "bad" as const, label: t("safety.check.notifyOff") }
              : {
                  level: "unknown" as const,
                  label: t("safety.check.notifyUnknown"),
                },
          contactCount === null
            ? {
                level: "unknown" as const,
                label: t("safety.check.contactsUnknown"),
              }
            : contactCount === 0
              ? {
                  level: "bad" as const,
                  label: t("safety.check.contactsNone"),
                }
              : {
                  level: "ok" as const,
                  label: t("safety.check.contacts", { n: contactCount }),
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
          body={[t("safety.state.loadFailedBody")]}
          actionLabel={t("safety.action.retry")}
          onAction={() => void helmets.refetch()}
          emphasized
        />
      );
    }
    const state = protectionStateOf({ link, notify, contacts: contactCount });
    if (state === "noHelmet" || !viewed || !link)
      return (
        <StatusCard
          tone="warning"
          icon="shield-half-outline"
          title={t("safety.state.noHelmet")}
          body={[t("safety.state.noHelmetBody")]}
          actionLabel={t("safety.action.bind")}
          onAction={() => router.push("/bind-device")}
          emphasized
        />
      );
    const openDetail = () => router.push(`/device/${viewed.deviceId}`);
    switch (state) {
      case "linkDown":
        return (
          <StatusCard
            // 头盔关机、不在身边是不骑车时的常态：提醒色。红色只留给身份不符这种故障
            tone={isLinkFault(link) ? "danger" : "warning"}
            icon="bluetooth-outline"
            title={t(linkLabelKey(link))}
            body={[
              t(
                link === "bluetoothOff" || link === "bluetoothDenied"
                  ? "safety.state.bluetoothBody"
                  : link === "mismatch"
                    ? "safety.state.mismatchBody"
                    : "safety.state.linkDownBody",
              ),
              lastSeenLine,
            ]}
            checks={checks}
            actionLabel={t("safety.action.checkLink")}
            onAction={openDetail}
            emphasized
          />
        );
      case "unknown":
        return (
          <StatusCard
            tone="warning"
            icon="help-circle-outline"
            title={t("safety.state.unknown")}
            body={[
              t(
                helmets.stale
                  ? "safety.state.staleBody"
                  : "safety.state.unknownBody",
              ),
              lastSeenLine,
            ]}
            checks={checks}
            actionLabel={t("safety.action.helmetDetail")}
            onAction={openDetail}
            emphasized
          />
        );
      case "notifyOff":
        return (
          <StatusCard
            tone="warning"
            icon="notifications-off-outline"
            title={t("safety.state.notifyOff")}
            body={[t("safety.state.notifyOffBody")]}
            checks={checks}
            actionLabel={t("safety.action.notifySettings")}
            onAction={() => void Linking.openSettings()}
            emphasized
          />
        );
      case "noContacts":
        return (
          <StatusCard
            tone="warning"
            icon="person-add-outline"
            title={t("safety.state.noContacts")}
            body={[t("safety.state.noContactsBody")]}
            checks={checks}
            actionLabel={t("safety.action.addContact")}
            onAction={() => router.push("/add-contact")}
            emphasized
          />
        );
      default:
        return (
          <StatusCard
            tone="success"
            icon="shield-checkmark-outline"
            title={t("safety.state.ready")}
            body={[lastSeenLine]}
            checks={checks}
            actionLabel={t("safety.action.helmetDetail")}
            onAction={openDetail}
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
              onPress={() => router.push("/safety-settings")}
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

          {viewed && (
            <HelmetSwitcher
              devices={list}
              viewed={viewed}
              links={links}
              locked={pending.length > 0}
              onSelect={helmets.select}
            />
          )}

          {/* 有进行中的 SOS 时，状态卡的位置让给它：不管正在查看哪顶头盔，每一条都列出来并写明来源 */}
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
                      <ThemedText type="smallBold" style={styles.statusTitle}>
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
                      router.push(
                        `/sos-active?sosId=${sos.sosId}&deviceId=${sos.deviceId}`,
                      )
                    }
                  />
                </Card>
              ))
            : statusCard()}

          {viewed && (
            <>
              <View style={styles.sectionHead}>
                <ThemedText
                  type="smallBold"
                  accessibilityRole="header"
                  style={styles.sectionTitle}
                >
                  {t("safety.latestSos")}
                </ThemedText>
                <Tappable
                  feedback="opacity"
                  accessibilityRole="button"
                  onPress={() => router.push("/safety-records?tab=sos")}
                  hitSlop={8}
                  style={styles.sectionAction}
                >
                  <ThemedText type="small" style={styles.sectionActionText}>
                    {t("safety.viewRecords")}
                  </ThemedText>
                  <Ionicons
                    name="chevron-forward"
                    size={14}
                    color={theme.textSecondary}
                  />
                </Tappable>
              </View>
              <Card>
                {latestSos ? (
                  <SosRecordRow record={latestSos} />
                ) : sosRecords.isLoading ? (
                  <View style={styles.recordRow}>
                    <Skeleton width={36} height={36} radius={18} />
                    <View style={styles.recordBody}>
                      <Skeleton width="40%" height={15} />
                      <Skeleton width="55%" height={12} />
                    </View>
                  </View>
                ) : (
                  <View style={styles.emptyRow}>
                    <ThemedText type="small" themeColor="textSecondary">
                      {/* 拉取失败不能说成「暂无」 */}
                      {t(
                        sosRecords.isError
                          ? "safety.latestSosFailed"
                          : "records.sosEmpty",
                      )}
                    </ThemedText>
                  </View>
                )}
              </Card>
            </>
          )}

          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.footnote}
          >
            {t("safety.footnote")}
          </ThemedText>

          {/* 开发测试：经 app-relay 真实链路注入事件（仅 DEV 构建可见），注入到正在查看的头盔 */}
          {__DEV__ && viewedId && (
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
                    onPress={() => void inject(viewedId, "possible_fall")}
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
                    onPress={() => void inject(viewedId, "collision_risk")}
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

        {/* 拇指区固定。有进行中的 SOS 时这里收起：处理入口是上面那张红框卡片 */}
        {sosTarget && pending.length === 0 && (
          <View style={[styles.bottomSos, { borderTopColor: theme.border }]}>
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
            {viewedId !== sosTargetId && (
              <ThemedText
                type="small"
                themeColor="textSecondary"
                style={styles.sosTargetNote}
              >
                {t("safety.sosTargetDiffers")}
              </ThemedText>
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
              <ThemedText type="display" style={styles.sosWord}>
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
    </ThemedView>
  );
}

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
  statusAction: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    minHeight: 44,
    borderRadius: 10,
    marginVertical: -4,
  },
  statusActionText: { fontSize: 14, flexShrink: 1 },
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingHorizontal: 4,
    marginTop: 6,
    marginBottom: -8,
  },
  sectionTitle: { fontSize: 16, flexShrink: 1 },
  sectionAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    minHeight: 44,
    paddingLeft: 8,
  },
  sectionActionText: { fontSize: 14 },
  recordRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    minHeight: 72,
  },
  recordBody: { flex: 1, gap: 3, minWidth: 0 },
  recordTitle: { fontSize: 15 },
  recordTime: { fontSize: 13, lineHeight: 18 },
  emptyRow: {
    paddingHorizontal: 16,
    paddingVertical: 22,
    alignItems: "center",
  },
  footnote: { fontSize: 12, lineHeight: 19, paddingHorizontal: 2 },
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
  sosTargetNote: { fontSize: 12, lineHeight: 17, textAlign: "center" },
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
