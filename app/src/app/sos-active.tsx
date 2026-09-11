// SOS 倒计时全屏页（API.md §7；决策 #8：服务端权威——App 只按 deadline 渲染，
// 取消/立即求救调 API，最终状态以服务端推送/响应为准，本地绝不判断超时）
// 设计对齐定稿套图：警示图标 + 超大倒计时 + 灰色取消 / 红色立即求救双药丸
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAudioPlayer } from "expo-audio";
import * as Haptics from "expo-haptics";
import { useKeepAwake } from "expo-keep-awake";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Sos } from "@helmet/shared";

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
  const { sosId, deviceId } = useLocalSearchParams<{
    sosId: string;
    deviceId: string;
  }>();
  const theme = useTheme();
  const t = useT();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<"cancel" | "confirm" | null>(null);
  /** 当前时刻作为被读取的 state：剩余秒数在渲染期由它算出。
   *  不能用"空转 tick（值不读）强制重渲染"——React Compiler 判定无依赖变化会 memo 掉
   *  整个渲染，倒计时数字永远停在首帧（2026-08-17 真机实证）。 */
  const [now, setNow] = useState(() => Date.now());

  // WS 推送直写 ['sos', sosId] 缓存；进页面时再以 REST 兜底拉一次权威状态
  const sosQuery = useQuery({
    queryKey: ["sos", sosId],
    queryFn: async () => {
      const { sos } = await sosApi.active(deviceId);
      return sos && sos.sosId === sosId
        ? sos
        : ((queryClient.getQueryData(["sos", sosId]) as Sos | undefined) ??
            null);
    },
    refetchInterval: 10_000, // WS 断线时的兜底；正常时由推送更新缓存
  });
  const sos = sosQuery.data ?? null;

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
    alarm.play();
    // 每秒重播警报段(0.9s 素材)+ 振动;不用 player.loop——
    // React Compiler 禁止修改 hook 返回对象的属性
    const t = setInterval(() => {
      alarm.seekTo(0).catch(() => {});
      alarm.play();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(
        () => {},
      );
    }, 1000);
    return () => {
      clearInterval(t);
      alarm.pause();
    };
  }, [counting, alarm]);

  const act = (kind: "cancel" | "confirm") => {
    setBusy(kind);
    (kind === "cancel" ? sosApi.cancel(sosId) : sosApi.confirm(sosId))
      .then((updated) => {
        queryClient.setQueryData(["sos", sosId], updated);
      })
      .catch((e) => Alert.alert(t("common.failed"), toUserMessage(e)))
      .finally(() => setBusy(null));
  };

  const left = sos ? secondsLeft(sos.deadline, now) : null;
  const finished = sos && sos.status !== "pending";

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: theme.background }]}>
      <ThemedView style={styles.container}>
        <View style={styles.hero}>
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
                ? t("sos.cancelledBody")
                : t("sos.notifiedBody")
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
