// SOS 倒计时全屏页（API.md §7；决策 #8：服务端权威——App 只按 deadline 渲染，
// 取消/立即求救调 API，最终状态以服务端推送/响应为准，本地绝不判断超时）
// 设计对齐定稿套图：警示图标 + 超大倒计时 + 灰色取消 / 红色立即求救双药丸
// 演练模式（?drill=1）：同一页面、同样的警报音/振动/倒计时，但**不碰服务端、不通知任何人**——
// 新用户先见过一次求救长什么样，真出事时才敢按、也知道怎么取消。顶部常驻醒目标记避免混淆。
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { setAudioModeAsync, useAudioPlayer } from "expo-audio";
import * as Haptics from "expo-haptics";
import { useKeepAwake } from "expo-keep-awake";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import {
  Alert,
  AppState,
  BackHandler,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { devLog } from "@/services/dev-log";
import { countdownPollInterval, settleSnapshot } from "@/services/sos-sync";
import type { Sos } from "@helmet/shared";

import { ApiRequestError } from "@/api/client";
import { clearSosAlert } from "@/services/sos-alert";
import { toUserMessage } from "@/api/error-messages";
import { sosApi } from "@/api/sos";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { Radius } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";

function secondsLeft(deadline: string, now: number): number {
  return Math.max(0, Math.ceil((new Date(deadline).getTime() - now) / 1000));
}

export default function SosActiveScreen() {
  const { sosId, deviceId, drill } = useLocalSearchParams<{
    sosId: string;
    deviceId: string;
    drill?: string;
  }>();
  const isDrill = drill === "1";
  const theme = useTheme();
  const t = useT();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<"cancel" | "confirm" | null>(null);
  /** 当前时刻作为被读取的 state：剩余秒数在渲染期由它算出。
   *  不能用"空转 tick（值不读）强制重渲染"——React Compiler 判定无依赖变化会 memo 掉
   *  整个渲染，倒计时数字永远停在首帧（2026-08-17 真机实证）。 */
  const [now, setNow] = useState(() => Date.now());
  /** 演练：本地 60 s deadline + 本地状态；到期在渲染期推导为 notified（真实模式由服务端判定） */
  const [drillState, setDrillState] = useState<{
    deadline: string;
    status: "pending" | "cancelled" | "notified";
  }>(() => ({
    deadline: new Date(Date.now() + 60_000).toISOString(),
    status: "pending",
  }));

  // WS 推送直写 ['sos', sosId] 缓存；进页面时再以 REST 兜底拉一次权威状态
  const sosQuery = useQuery({
    queryKey: ["sos", sosId],
    queryFn: async () => {
      try {
        return settleSnapshot(
          queryClient,
          sosId,
          await sosApi.snapshot(sosId, deviceId),
        );
      } catch {
        // 两条 REST 都失败（离线）才信缓存；有网时缓存可能是迟到的 pending（2026-09-24 实测卡死）
        return (
          (queryClient.getQueryData(["sos", sosId]) as Sos | undefined) ?? null
        );
      }
    },
    // WS 断线时的兜底；正常时由推送更新缓存。单子结束后停止轮询——结束态不会再变，
    // 而 snapshot 一次是两个请求（评审 2026-09-26）。状态未知（null）不算结束，见 sos-sync
    refetchInterval: (q) => countdownPollInterval(q.state.data),
    enabled: !isDrill,
  });
  const drillSos: Sos | null = isDrill
    ? {
        sosId: "drill",
        deviceId: deviceId ?? "",
        triggerEventId: "drill",
        triggerType: "manual_sos",
        status:
          drillState.status === "pending" &&
          now >= new Date(drillState.deadline).getTime()
            ? "notified"
            : drillState.status,
        deadline: drillState.deadline,
        createdAt: drillState.deadline,
        updatedAt: drillState.deadline,
      }
    : null;
  const sos = isDrill ? drillSos : (sosQuery.data ?? null);

  // 每秒推进"当前时刻"，渲染期据此重算剩余秒数（仅展示用途，超时判定在服务端）
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // 倒计时期间保持亮屏——摔倒场景手机可能放在口袋/车把,锁屏会错过取消窗口
  useKeepAwake();

  // 警报音 + 振动:倒计时进行中每秒触发,取消/通知后停止
  const alarm = useAudioPlayer(require("@/assets/sos-alarm.wav"));
  const counting = sos != null && sos.status === "pending";
  useEffect(() => {
    if (!counting) return;
    // 警报音绝不能把页面打崩：锁屏/后台时 AVAudioSession 激活可能失败（expo-audio 同步抛
    // "Session activation failed"，Release 下未捕获即整 App 崩溃，2026-09-16 真机实证——
    // 摔倒时手机恰恰在口袋里）。播放失败只记日志，倒计时与取消按钮照常。
    devLog("SOS", "倒计时页开始警报", AppState.currentState);
    const safePlay = () => {
      try {
        alarm.play();
        devLog("SOS", "警报音 play() 已调用");
      } catch (e) {
        devLog("SOS", "警报音播放失败（后台/锁屏音频会话不可用）", e as Error);
      }
    };
    // 先把音频会话设成可后台播放 + 静音键下也响：摔倒告警必须在锁屏状态出声
    void setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: "doNotMix",
      allowsRecording: false,
      shouldRouteThroughEarpiece: false,
    })
      .catch((e) => devLog("SOS", "音频模式设置失败", e as Error))
      .then(safePlay);
    // 每秒重播警报段(0.9s 素材)+ 振动;不用 player.loop——
    // React Compiler 禁止修改 hook 返回对象的属性
    const t = setInterval(() => {
      alarm.seekTo(0).catch(() => {});
      safePlay();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(
        () => {},
      );
    }, 1000);
    return () => {
      clearInterval(t);
      try {
        alarm.pause();
      } catch {
        // 会话已失效时 pause 也可能抛，忽略
      }
    };
  }, [counting, alarm]);

  const act = (kind: "cancel" | "confirm") => {
    if (isDrill) {
      setDrillState((d) => ({
        ...d,
        status: kind === "cancel" ? "cancelled" : "notified",
      }));
      return;
    }
    setBusy(kind);
    (kind === "cancel" ? sosApi.cancel(sosId) : sosApi.confirm(sosId))
      .then((updated) => {
        queryClient.setQueryData(["sos", sosId], updated);
      })
      .catch((e) => {
        // 这单已经在别处结束（锁屏通知按钮 / 另一台手机 / 到期）：不弹错，拉一次权威状态让页面自己切到结束态
        if (
          e instanceof ApiRequestError &&
          e.code === "SOS_ALREADY_FINALIZED"
        ) {
          void sosQuery.refetch();
          return;
        }
        Alert.alert(t("common.failed"), toUserMessage(e));
      })
      .finally(() => setBusy(null));
  };

  const left = sos ? secondsLeft(sos.deadline, now) : null;
  const finished = sos && sos.status !== "pending";

  // Android 实体返回键：倒计时中不能把这页关进「什么都没有」——关掉后警报停、无提示，
  // 而这单仍登记为「已拉起」，WS / 补拉都不会再弹（10-06 不变式评审 F-4）
  useEffect(() => {
    if (!counting) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => sub.remove();
  }, [counting]);

  // 本页取消 / 确认成功后立刻撤掉锁屏提醒和预排的「还剩 30 / 10 秒」，不等 WS 推终态
  //（WS 没连上时那两条照样会响，10-06 并发评审 F6）
  useEffect(() => {
    if (finished && !isDrill) void clearSosAlert(sosId);
  }, [finished, isDrill, sosId]);

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: theme.background }]}>
      <ThemedView style={styles.container}>
        <View style={styles.hero}>
          {isDrill && (
            <View style={[styles.drillBadge, { backgroundColor: theme.brand }]}>
              <Ionicons name="school-outline" size={16} color={theme.onBrand} />
              <ThemedText
                type="smallBold"
                style={{ color: theme.onBrand, fontSize: 13 }}
              >
                {t("sos.drillBadge")}
              </ThemedText>
            </View>
          )}
          <View style={[styles.warnIcon, { backgroundColor: theme.dangerBg }]}>
            <Ionicons name="warning" size={40} color={theme.danger} />
          </View>
          <ThemedText type="title" style={styles.title}>
            {sos?.triggerType === "manual_sos"
              ? t("safety.manualSos")
              : t("sos.fall")}
          </ThemedText>
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.subtitle}
          >
            {finished
              ? sos.status === "cancelled"
                ? t(isDrill ? "sos.drillCancelledBody" : "sos.cancelledBody")
                : t(isDrill ? "sos.drillNotifiedBody" : "sos.notifiedBody")
              : t("sos.pendingBody")}
          </ThemedText>
        </View>

        <View style={styles.countdownWrap}>
          {!finished && left !== null ? (
            <>
              <ThemedText style={[styles.countdown, { color: theme.danger }]}>
                {left}
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {t("sos.autoSendSuffix")}
              </ThemedText>
              <View
                style={[
                  styles.track,
                  { backgroundColor: theme.backgroundSelected },
                ]}
              >
                <View
                  style={[
                    styles.fill,
                    {
                      width: `${Math.min(100, (left / 60) * 100)}%`,
                      backgroundColor: theme.danger,
                    },
                  ]}
                />
              </View>
            </>
          ) : (
            <Ionicons
              name={
                sos?.status === "cancelled"
                  ? "checkmark-circle"
                  : "notifications"
              }
              size={96}
              color={sos?.status === "cancelled" ? theme.success : theme.danger}
            />
          )}
        </View>

        <View style={styles.actions}>
          {!finished ? (
            <>
              <Pressable
                style={[
                  styles.btn,
                  { backgroundColor: theme.backgroundSelected },
                ]}
                disabled={busy !== null}
                onPress={() => act("cancel")}
              >
                <ThemedText type="smallBold" style={styles.btnText}>
                  {busy === "cancel" ? t("sos.cancelling") : t("sos.imOk")}
                </ThemedText>
              </Pressable>
              <Pressable
                style={[styles.btn, { backgroundColor: theme.danger }]}
                disabled={busy !== null}
                onPress={() => act("confirm")}
              >
                <View style={styles.btnRow}>
                  <Ionicons name="call" size={18} color="#fff" />
                  <ThemedText
                    type="smallBold"
                    style={[styles.btnText, { color: "#fff" }]}
                  >
                    {busy === "confirm" ? t("auth.sending") : t("sos.sendNow")}
                  </ThemedText>
                </View>
              </Pressable>
            </>
          ) : (
            <Pressable
              style={[
                styles.btn,
                { backgroundColor: theme.backgroundSelected },
              ]}
              onPress={() => router.back()}
            >
              <ThemedText type="smallBold" style={styles.btnText}>
                {t("sos.close")}
              </ThemedText>
            </Pressable>
          )}
        </View>
      </ThemedView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, padding: 24, justifyContent: "space-between" },
  hero: { alignItems: "center", gap: 12, marginTop: 24 },
  drillBadge: {
    marginBottom: 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: Radius.pill,
  },
  warnIcon: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { fontSize: 30, lineHeight: 36 },
  subtitle: { textAlign: "center", paddingHorizontal: 16 },
  countdownWrap: { alignItems: "center", gap: 8 },
  countdown: {
    fontSize: 128,
    lineHeight: 140,
    fontWeight: 800,
    fontVariant: ["tabular-nums"],
  },
  track: {
    height: 6,
    borderRadius: 3,
    alignSelf: "stretch",
    overflow: "hidden",
    marginTop: 12,
  },
  fill: { height: 6, borderRadius: 3 },
  actions: { gap: 12, paddingBottom: 8 },
  btn: { borderRadius: Radius.pill, paddingVertical: 18, alignItems: "center" },
  btnRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  btnText: { fontSize: 16 },
});
