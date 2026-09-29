// 实时视频预览（决策 #37/#49，DEVICE_PROTOCOL §1.3）：手机连头盔 SoftAP → RTSP over TCP 拉流 → libVLC 硬解。
// 约束（§1.3 App 侧硬要求）：本页不发任何外网请求（此时手机在没有互联网的头盔热点上）；
// Android 进程绑在头盔热点期间连不上云端，所以只在前台持有，离开 / 退后台 / 摔倒求救入队时立即释放。
import { useLocalSearchParams } from "expo-router";
import { File, Paths } from "expo-file-system";
import { useKeepAwake } from "expo-keep-awake";
import type { ComponentType, Ref } from "react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Platform,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import type { VLCPlayerProps } from "react-native-vlc-media-player";

import { PrimaryButton, SecondaryButton } from "@/components/form";
import { showToast } from "@/components/toast";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { Radius } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";
import { flushRelayQueue, onSosRelayEvent } from "@/services/ble-relay-uplink";
import { devLog } from "@/services/dev-log";
import {
  HELMET_HOTSPOT,
  JOIN_TIMEOUT_MS,
  NO_PICTURE_HINT_MS,
  VLC_INIT_OPTIONS,
  holdsHelmetWifi,
  initialPreviewState,
  previewReducer,
  showsPlayer,
  toFsPath,
} from "@/services/video-preview";
import { HelmetWifi } from "helmet-wifi";

interface VlcHandle {
  snapshot(path: string): void;
}
// 库的 d.ts 声明了 VLCPlayer 类却没有导出，只能 require；类型用库自带的 props 补上
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { VLCPlayer } = require("react-native-vlc-media-player") as {
  VLCPlayer: ComponentType<VLCPlayerProps & { ref?: Ref<VlcHandle> }>;
};

const SNAPSHOT_WAIT_MS = 2_000;
const SNAPSHOT_CALLBACK_TIMEOUT_MS = 4_000;

/** iOS 的 saveVideoSnapshotAt 异步落盘：回调先到、文件后到 */
async function waitForFile(uri: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (new File(uri).exists) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return new File(uri).exists;
}

export default function VideoPreviewScreen() {
  const t = useT();
  const theme = useTheme();
  const { width } = useWindowDimensions();
  useKeepAwake();

  // 开发期无头盔测试（DEVELOPMENT.md「视频预览无硬件测试」）：
  //   ?url=rtsp://<电脑IP>:8554/ch0 换成 tools/rtsp-mock 的测试流；仍会先连名为 X821cam 的热点
  //   （用另一台手机开同名热点、电脑连上去跑测试流，连接 + 绑定整条路径都能测）
  //   ?join=0 再跳过连热点（手机和电脑在同一个普通 Wi-Fi 下，只测播放器）
  const params = useLocalSearchParams<{ url?: string; join?: string }>();
  const devUrl =
    __DEV__ &&
    typeof params.url === "string" &&
    params.url.startsWith("rtsp://")
      ? params.url
      : undefined;
  const streamUrl = devUrl ?? HELMET_HOTSPOT.streamUrl;
  const skipJoin = !HelmetWifi.available || (__DEV__ && params.join === "0");

  const [state, dispatch] = useReducer(previewReducer, initialPreviewState);
  const [snapping, setSnapping] = useState(false);
  const playerRef = useRef<VlcHandle>(null);
  const holdingWifi = useRef(false);
  const connectStartedAt = useRef(0);
  const pendingShot = useRef<string | null>(null);

  /** 同步释放：求救回调里调用时，紧接着的上传才能走回蜂窝 / 原 Wi-Fi */
  const releaseWifi = useCallback(() => {
    if (!holdingWifi.current) return;
    holdingWifi.current = false;
    HelmetWifi.release();
    // 绑定期间积压的中转事件立刻补传，不等 5 s 周期
    void flushRelayQueue();
  }, []);

  // 连头盔热点
  useEffect(() => {
    if (state.phase !== "joining") return;
    if (skipJoin) {
      dispatch({ type: "joined" });
      return;
    }
    if (!HelmetWifi.canConnectProgrammatically()) {
      dispatch({ type: "joinFailed", code: "MANUAL_REQUIRED" });
      return;
    }
    let cancelled = false;
    holdingWifi.current = true;
    HelmetWifi.connect(
      HELMET_HOTSPOT.ssid,
      HELMET_HOTSPOT.passphrase,
      JOIN_TIMEOUT_MS,
    ).then(
      () => {
        if (!cancelled) dispatch({ type: "joined" });
      },
      (e: { code?: string }) => {
        devLog("VIDEO", "连接头盔热点失败", e?.code);
        if (!cancelled) dispatch({ type: "joinFailed", code: e?.code });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [state.phase, state.attempt, skipJoin]);

  // 不再需要头盔 Wi-Fi 的阶段（出错 / 暂停 / 手动引导）立即释放
  useEffect(() => {
    if (!holdsHelmetWifi(state.phase)) releaseWifi();
  }, [state.phase, releaseWifi]);

  useEffect(() => releaseWifi, [releaseWifi]);

  // 首帧前约 5 s 无画面：提示检查 Wi-Fi（播放器继续尝试）
  useEffect(() => {
    if (state.phase !== "connecting") return;
    connectStartedAt.current = Date.now();
    const id = setTimeout(
      () => dispatch({ type: "noPictureTimeout" }),
      NO_PICTURE_HINT_MS,
    );
    return () => clearTimeout(id);
  }, [state.phase, state.attempt]);

  // 摔倒 / 求救入队：先让出网络再说（回调在上传发起之前同步执行）
  useEffect(
    () =>
      onSosRelayEvent((eventType) => {
        devLog("VIDEO", `收到 ${eventType}，暂停预览让出网络`);
        releaseWifi();
        dispatch({ type: "suspend", reason: "sos" });
      }),
    [releaseWifi],
  );

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "background") {
        releaseWifi();
        dispatch({ type: "suspend", reason: "background" });
      } else if (next === "active") {
        dispatch({ type: "foreground" });
      }
    });
    return () => sub.remove();
  }, [releaseWifi]);

  useEffect(() => {
    const sub = HelmetWifi.onWifiLost(() => dispatch({ type: "wifiLost" }));
    return () => sub.remove();
  }, []);

  const continueManual = () => {
    if (HelmetWifi.bindToWifi()) {
      holdingWifi.current = true;
      dispatch({ type: "joined" });
    } else {
      dispatch({ type: "manualNoWifi" });
    }
  };

  const takeSnapshot = () => {
    if (snapping || state.phase !== "playing") return;
    setSnapping(true);
    const uri = new File(Paths.cache, `helmet-shot-${Date.now()}.png`).uri;
    pendingShot.current = uri;
    playerRef.current?.snapshot(toFsPath(uri));
    // 原生侧没回调（播放器刚好卸载 / 引用为空）时别让按钮一直转圈
    setTimeout(() => {
      if (pendingShot.current !== uri) return;
      pendingShot.current = null;
      setSnapping(false);
      showToast(t("video.snapshot.failed"));
    }, SNAPSHOT_CALLBACK_TIMEOUT_MS);
  };

  const onSnapshot = async (e: { success: boolean; error?: string }) => {
    const uri = pendingShot.current;
    pendingShot.current = null;
    if (!uri) return;
    try {
      if (!e.success || !(await waitForFile(uri, SNAPSHOT_WAIT_MS))) {
        devLog("VIDEO", "截图失败", e.error);
        showToast(t("video.snapshot.failed"));
        return;
      }
      await HelmetWifi.saveImage(uri);
      showToast(t("video.snapshot.saved"));
    } catch (err) {
      const code = (err as { code?: string })?.code;
      showToast(
        t(
          code === "UNSUPPORTED"
            ? "video.snapshot.unsupported"
            : code === "PERMISSION_DENIED"
              ? "video.snapshot.denied"
              : "video.snapshot.failed",
        ),
      );
    } finally {
      setSnapping(false);
      try {
        new File(uri).delete();
      } catch {
        // 缓存目录，删不掉系统会清
      }
    }
  };

  const ssid = HELMET_HOTSPOT.ssid;
  const overlayText =
    state.phase === "joining"
      ? t("video.joining", { ssid })
      : state.phase === "connecting"
        ? state.stalled
          ? t("video.stalled", { ssid })
          : t("video.connecting")
        : state.phase === "manual"
          ? t("video.manual", { ssid, pass: HELMET_HOTSPOT.passphrase })
          : state.phase === "paused"
            ? state.pauseReason === "sos"
              ? t("video.paused.sos")
              : t("video.connecting")
            : state.phase === "error" && state.errorKey
              ? t(state.errorKey, { ssid })
              : "";
  const busy =
    state.phase === "joining" ||
    (state.phase === "connecting" && !state.stalled) ||
    (state.phase === "paused" && state.pauseReason === "background");
  const canRetry =
    state.phase === "error" ||
    (state.phase === "paused" && state.pauseReason === "sos") ||
    (state.phase === "connecting" && state.stalled);

  return (
    <ThemedView style={styles.page}>
      <View style={[styles.stage, { height: (width * 9) / 16 }]}>
        {showsPlayer(state.phase) && (
          <VLCPlayer
            key={state.attempt}
            ref={playerRef}
            style={StyleSheet.absoluteFill}
            source={{ uri: streamUrl, initOptions: VLC_INIT_OPTIONS }}
            autoplay
            resizeMode="contain"
            onPlaying={() => {
              if (state.phase === "connecting")
                devLog(
                  "VIDEO",
                  `首帧 ${Date.now() - connectStartedAt.current} ms`,
                );
              dispatch({ type: "firstFrame" });
            }}
            onError={() => dispatch({ type: "playerError" })}
            onEnd={() => dispatch({ type: "streamEnded" })}
            onStopped={() => dispatch({ type: "streamEnded" })}
            onSnapshot={(e) => void onSnapshot(e)}
          />
        )}
        {state.phase !== "playing" && (
          <View style={styles.overlay} pointerEvents="none">
            {busy && <ActivityIndicator color="#FFFFFF" />}
            <ThemedText style={styles.overlayText}>{overlayText}</ThemedText>
            {state.phase === "joining" && !skipJoin && (
              <ThemedText type="small" style={styles.overlayHint}>
                {t("video.joiningHint")}
              </ThemedText>
            )}
            {state.phase === "manual" && state.errorKey && (
              <ThemedText type="small" style={styles.overlayHint}>
                {t(state.errorKey, { ssid })}
              </ThemedText>
            )}
          </View>
        )}
      </View>

      <View style={styles.body}>
        {state.phase === "playing" && (
          <SecondaryButton
            title={t("video.snapshot")}
            icon="camera-outline"
            loading={snapping}
            onPress={takeSnapshot}
          />
        )}
        {state.phase === "manual" && (
          <>
            {Platform.OS === "android" && (
              <SecondaryButton
                title={t("video.manual.openSettings")}
                icon="wifi-outline"
                onPress={() => HelmetWifi.openWifiSettings()}
              />
            )}
            <PrimaryButton
              title={t("video.manual.continue")}
              onPress={continueManual}
            />
          </>
        )}
        {canRetry && (
          <PrimaryButton
            title={t("video.retry")}
            onPress={() => dispatch({ type: "retry" })}
          />
        )}

        <View
          style={[
            styles.note,
            {
              backgroundColor: theme.backgroundElement,
              borderColor: theme.border,
            },
          ]}
        >
          <ThemedText type="smallBold">
            {t("video.note.hotspot", { ssid })}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {t("video.note")}
          </ThemedText>
        </View>
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  stage: {
    width: "100%",
    backgroundColor: "#000000",
    overflow: "hidden",
  },
  overlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 24,
  },
  overlayText: { color: "#FFFFFF", textAlign: "center" },
  overlayHint: { color: "rgba(255,255,255,0.7)", textAlign: "center" },
  body: { padding: 16, gap: 12 },
  note: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.card,
    padding: 12,
    gap: 4,
  },
});
