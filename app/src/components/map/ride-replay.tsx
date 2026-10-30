// 地图页「一趟行程」抽屉的下半部分：一行读数、路上的安全事件、回放控制。
// 轨迹没取到时这里如实写出来并给重试；上面的小结来自行程列表，不受影响。
// 回放按轨迹点走：进度 = 第几个点 /（点数 − 1），页面持有 index，这里只管画和上报操作。
import { Ionicons } from "@expo/vector-icons";
import { useRef } from "react";
import {
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from "react-native";
import type { LocationPoint } from "@helmet/shared";

import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/hooks/use-theme";
import { useLocale, useT } from "@/i18n";
import { shortTime } from "@/i18n/format";

import { plausibleSpeed } from "./coords";
import { endTimeLabel } from "./ride-list";

/** 进度条上那颗点的半径：轨道两端各内缩这么多，点在 0%–100% 全程都落在条内 */
const THUMB_R = 11;
const BUBBLE_W = 52;
/** 读屏「调整」手势（上下轻扫）一次走多少：全程的 5%，短轨迹至少走一个点 */
const A11Y_STEP = 0.05;

export type TrackStatus = "loading" | "error" | "empty" | "ready";

export interface ReplayEvent {
  key: string;
  /** 落在轨迹的第几个点 */
  index: number;
  /** 08:21 */
  time: string;
  /** 碰撞风险 */
  name: string;
  /** 这一处并了几个事件（事件密的时候同一段路只标一处，见 services/rides 的 groupEvents） */
  count: number;
  /** 碰撞 / 摔倒 / 求救用红色，其余用提醒色，和安全记录列表一个口径 */
  danger?: boolean;
}

/** 轻量进度条（点按 / 拖动）——不引第三方 Slider。
 *  视觉层全部 pointerEvents=none，触摸永远落在外层容器上，locationX 的参照系稳定不跳变。 */
function SeekBar({
  ratio,
  marks,
  bubble,
  onSeek,
  onStep,
  label,
}: {
  ratio: number;
  /** 事件在进度条上的位置（0–1） */
  marks: readonly { at: number; danger?: boolean }[];
  /** 拖到哪一刻了；null = 没在回放，不显示 */
  bubble: string | null;
  onSeek: (ratio: number) => void;
  /** 读屏的增 / 减操作：往后 / 往前走一步 */
  onStep: (dir: 1 | -1) => void;
  label: string;
}) {
  const theme = useTheme();
  const width = useRef(1);
  const handle = (x: number) =>
    onSeek(
      Math.min(
        1,
        Math.max(0, (x - THUMB_R) / Math.max(1, width.current - THUMB_R * 2)),
      ),
    );
  const at = `${ratio * 100}%` as const;
  return (
    <View
      style={styles.seekTouch}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ now: Math.round(ratio * 100), min: 0, max: 100 }}
      // 声明了 adjustable 就要接得住增减：不然读屏用户上下轻扫没有任何反应
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === "increment") onStep(1);
        else if (e.nativeEvent.actionName === "decrement") onStep(-1);
      }}
      onLayout={(e: LayoutChangeEvent) => {
        width.current = Math.max(1, e.nativeEvent.layout.width);
      }}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      // 拖进度时不让外面的抽屉、横向的事件条把手势抢走
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => handle(e.nativeEvent.locationX)}
      onResponderMove={(e) => handle(e.nativeEvent.locationX)}
    >
      <View pointerEvents="none" style={styles.seekRail}>
        <View
          style={[
            styles.seekTrack,
            { backgroundColor: theme.backgroundSelected },
          ]}
        >
          <View
            style={[
              styles.seekFill,
              { backgroundColor: theme.brand, width: at },
            ]}
          />
        </View>
        {marks.map((m, i) => (
          <View
            key={i}
            style={[
              styles.seekMark,
              {
                left: `${m.at * 100}%`,
                backgroundColor: m.danger ? theme.danger : theme.warning,
                borderColor: theme.backgroundElement,
              },
            ]}
          />
        ))}
        <View
          style={[
            styles.seekThumb,
            {
              left: at,
              backgroundColor: theme.brand,
              borderColor: theme.backgroundElement,
            },
          ]}
        />
        {bubble !== null && (
          <View style={[styles.bubbleAnchor, { left: at }]}>
            <View style={[styles.bubble, { backgroundColor: theme.text }]}>
              <ThemedText
                style={[styles.bubbleText, { color: theme.background }]}
              >
                {bubble}
              </ThemedText>
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

interface Props {
  status: TrackStatus;
  points: readonly LocationPoint[];
  /** 这一趟超过 24 小时，只画了最后 24 小时 */
  clipped: boolean;
  events: readonly ReplayEvent[];
  /** 事件太多没标全时，还有几条没标 */
  moreEvents: number;
  /** 路上的事件没取到：要说出来，不能让人以为这一趟什么都没发生 */
  eventsFailed: boolean;
  /** 回放停在 / 走到的那个事件 */
  activeEventKey: string | null;
  /** null = 还没开始回放 */
  replayIdx: number | null;
  playing: boolean;
  speed: 1 | 2 | 4;
  /** 读数那一行要换成别的话时用（「正在找这个时刻的行程…」） */
  note?: string | null;
  /** 失败时读数写什么（带重试）；不给就是「轨迹加载失败」 */
  failText?: string | null;
  onTogglePlay: () => void;
  onCycleSpeed: () => void;
  onSeek: (index: number) => void;
  onRetry: () => void;
  onRetryEvents: () => void;
}

export function RideReplay({
  status,
  points,
  clipped,
  events,
  moreEvents,
  eventsFailed,
  activeEventKey,
  replayIdx,
  playing,
  speed,
  note,
  failText,
  onTogglePlay,
  onCycleSpeed,
  onSeek,
  onRetry,
  onRetryEvents,
}: Props) {
  const theme = useTheme();
  const t = useT();
  const locale = useLocale();
  const ready = status === "ready" && points.length > 1;
  const last = Math.max(1, points.length - 1);
  const point = replayIdx !== null ? points[replayIdx] : undefined;
  const activeEvent = events.find((e) => e.key === activeEventKey) ?? null;

  let readout: string;
  if (note) readout = note;
  else if (status === "loading") readout = t("map.ride.trackLoading");
  else if (status === "error")
    readout = failText ?? t("map.ride.trackFailed");
  else if (!ready) readout = t("map.ride.trackEmpty");
  else if (activeEvent)
    readout =
      activeEvent.count > 1
        ? t("map.ride.eventAtMany", {
            time: activeEvent.time,
            name: activeEvent.name,
            n: activeEvent.count,
          })
        : t("map.ride.eventAt", {
            time: activeEvent.time,
            name: activeEvent.name,
          });
  else if (point) {
    // 漂移出来的速度（超过 200 km/h）写「—」，和小结里的最高速度同一个把关
    const mps = plausibleSpeed(point.speed);
    const speed = mps !== null ? Math.round(mps * 3.6) : "—";
    readout =
      point.altitude != null
        ? t("map.ride.readoutAlt", {
            time: shortTime(point.timestamp, locale),
            speed,
            alt: Math.round(point.altitude),
          })
        : t("map.ride.readout", {
            time: shortTime(point.timestamp, locale),
            speed,
          });
  } else readout = t(clipped ? "map.ride.clipped" : "map.ride.hint");

  return (
    <View style={styles.wrap}>
      <View style={styles.readoutRow}>
        <ThemedText
          type="small"
          numberOfLines={1}
          accessibilityLiveRegion="polite"
          style={[
            styles.readout,
            {
              color:
                ready && activeEvent && !note
                  ? theme.warning
                  : theme.textSecondary,
            },
          ]}
        >
          {readout}
        </ThemedText>
        {status === "error" && !note && (
          <Tappable
            feedback="opacity"
            accessibilityRole="button"
            hitSlop={8}
            onPress={onRetry}
            style={[styles.retry, { borderColor: theme.borderStrong }]}
          >
            <ThemedText type="smallBold" style={styles.retryText}>
              {t("map.retry")}
            </ThemedText>
          </Tappable>
        )}
      </View>

      {ready && eventsFailed && (
        <Tappable
          feedback="opacity"
          accessibilityRole="button"
          onPress={onRetryEvents}
          style={styles.eventHit}
        >
          <View style={[styles.eventChip, { borderColor: theme.borderStrong }]}>
            <Ionicons name="refresh" size={14} color={theme.textSecondary} />
            <ThemedText
              type="small"
              themeColor="textSecondary"
              style={styles.eventText}
            >
              {t("map.ride.eventsFailed")}
            </ThemedText>
          </View>
        </Tappable>
      )}

      {ready && events.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.eventScroll}
          contentContainerStyle={styles.eventRow}
        >
          {events.map((e) => {
            const on = e.key === activeEventKey;
            const fg = e.danger ? theme.danger : theme.warning;
            return (
              <Tappable
                key={e.key}
                feedback="opacity"
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => onSeek(e.index)}
                style={styles.eventHit}
              >
                <View
                  style={[
                    styles.eventChip,
                    {
                      borderColor: fg,
                      backgroundColor: on
                        ? e.danger
                          ? theme.dangerBg
                          : theme.warningBg
                        : "transparent",
                    },
                  ]}
                >
                  <View style={[styles.eventDot, { backgroundColor: fg }]} />
                  <ThemedText
                    type="smallBold"
                    style={[styles.eventText, { color: fg }]}
                  >
                    {e.count > 1
                      ? t("map.ride.eventChipMany", {
                          time: e.time,
                          name: e.name,
                          n: e.count,
                        })
                      : t("map.ride.eventChip", { time: e.time, name: e.name })}
                  </ThemedText>
                </View>
              </Tappable>
            );
          })}
          {moreEvents > 0 && (
            <ThemedText
              type="small"
              themeColor="textSecondary"
              style={styles.eventMore}
            >
              {t("map.ride.moreEvents", { n: moreEvents })}
            </ThemedText>
          )}
        </ScrollView>
      )}

      <View
        style={[styles.controls, !ready && styles.controlsOff]}
        pointerEvents={ready ? "auto" : "none"}
      >
        <View style={styles.controlRow}>
          <Tappable
            haptic
            accessibilityRole="button"
            accessibilityLabel={t(playing ? "map.pause" : "map.play")}
            disabled={!ready}
            onPress={onTogglePlay}
            style={[styles.playBtn, { borderColor: theme.brand }]}
          >
            <Ionicons
              name={playing ? "pause" : "play"}
              size={20}
              color={theme.brand}
            />
          </Tappable>
          <Tappable
            accessibilityRole="button"
            accessibilityLabel={t("map.ride.speedA11y", { n: speed })}
            disabled={!ready}
            onPress={onCycleSpeed}
            style={[
              styles.speedBtn,
              { backgroundColor: theme.backgroundSelected },
            ]}
          >
            <ThemedText type="smallBold" style={styles.speedText}>
              ×{speed}
            </ThemedText>
          </Tappable>
          <View style={styles.seekColumn}>
            <SeekBar
              ratio={replayIdx !== null && ready ? replayIdx / last : 0}
              marks={
                ready
                  ? events.map((e) => ({
                      at: e.index / last,
                      danger: e.danger,
                    }))
                  : []
              }
              bubble={point ? shortTime(point.timestamp, locale) : null}
              label={t("map.ride.seek")}
              onSeek={(r) => {
                if (ready) onSeek(Math.round(r * last));
              }}
              onStep={(dir) => {
                if (!ready) return;
                const step = Math.max(1, Math.round(last * A11Y_STEP));
                const from = replayIdx ?? 0;
                onSeek(Math.max(0, Math.min(last, from + dir * step)));
              }}
            />
          </View>
        </View>
        <View style={styles.seekLabels}>
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.seekLabel}
          >
            {ready ? shortTime(points[0].timestamp, locale) : "--:--"}
          </ThemedText>
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.seekLabel}
          >
            {ready
              ? endTimeLabel(
                  points[0].timestamp,
                  points[last].timestamp,
                  locale,
                  t,
                )
              : "--:--"}
          </ThemedText>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  readoutRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 32,
  },
  readout: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    lineHeight: 18,
    fontVariant: ["tabular-nums"],
  },
  retry: {
    height: 32,
    paddingHorizontal: 14,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  retryText: { fontSize: 13, lineHeight: 18 },
  eventScroll: { flexGrow: 0, marginHorizontal: -16 },
  eventRow: { alignItems: "center", paddingHorizontal: 16, gap: 8 },
  // 触控区 44 高，看得见的药丸 32 高
  eventHit: { height: 44, justifyContent: "center", alignSelf: "flex-start" },
  eventChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
  },
  eventDot: { width: 6, height: 6, borderRadius: 3 },
  eventText: { fontSize: 13, lineHeight: 18, fontVariant: ["tabular-nums"] },
  eventMore: { fontSize: 13, lineHeight: 18, paddingHorizontal: 4 },
  // 进度条上方要露出时间气泡：给它留出地方
  controls: { marginTop: 18 },
  controlsOff: { opacity: 0.35 },
  controlRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  playBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  speedBtn: {
    width: 48,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  speedText: { fontSize: 14, lineHeight: 20, fontVariant: ["tabular-nums"] },
  seekColumn: { flex: 1, minWidth: 0 },
  seekTouch: { height: 44, justifyContent: "center" },
  seekRail: { marginHorizontal: THUMB_R, justifyContent: "center" },
  seekTrack: { height: 6, borderRadius: 3, overflow: "hidden" },
  seekFill: { height: 6, borderRadius: 3 },
  seekMark: {
    position: "absolute",
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    marginLeft: -5,
    top: "50%",
    marginTop: -5,
  },
  seekThumb: {
    position: "absolute",
    width: THUMB_R * 2,
    height: THUMB_R * 2,
    borderRadius: THUMB_R,
    borderWidth: 3,
    marginLeft: -THUMB_R,
    top: "50%",
    marginTop: -THUMB_R,
  },
  bubbleAnchor: {
    position: "absolute",
    width: 0,
    height: 0,
    top: "50%",
    marginTop: -THUMB_R - 30,
  },
  bubble: {
    position: "absolute",
    left: -BUBBLE_W / 2,
    width: BUBBLE_W,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  bubbleText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: 700,
    fontVariant: ["tabular-nums"],
  },
  // 两端的钟点对齐进度条的两头（左边让出播放钮 48 + 倍速钮 48 + 两个间距 10）
  seekLabels: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginLeft: 116 + THUMB_R,
    marginRight: THUMB_R,
  },
  seekLabel: { fontSize: 12, lineHeight: 16, fontVariant: ["tabular-nums"] },
});
