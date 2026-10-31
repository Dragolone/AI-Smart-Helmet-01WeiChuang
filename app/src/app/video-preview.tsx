// 实时视频预览（决策 #37/#49，DEVICE_PROTOCOL §1.3）：手机连头盔 SoftAP → RTSP over TCP 拉流 → libVLC 硬解。
// 约束（§1.3 App 侧硬要求）：本页不发任何外网请求（此时手机在没有互联网的头盔热点上）；
// Android 进程绑在头盔热点期间连不上云端，所以只在前台持有，离开 / 退后台 / 摔倒求救入队时立即释放。
import { useFocusEffect } from "expo-router";
import { File, Paths } from "expo-file-system";
import type { ComponentType, Ref } from "react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Linking,
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
import { useRouteParams } from "@/hooks/use-route-params";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";
import { flushRelayQueue, onSosRelayEvent } from "@/services/ble-relay-uplink";
import { devLog } from "@/services/dev-log";
import { useKeepAwakeSafe } from "@/hooks/use-keep-awake-safe";
import {
  HELMET_HOTSPOT,
  JOIN_TIMEOUT_MS,
  NO_PICTURE_HINT_MS,
  holdsHelmetWifi,
  initialPreviewState,
  previewReducer,
  showsPlayer,
  suggestsLocalNetwork,
  toFsPath,
  vlcSource,
} from "@/services/video-preview";
import { HelmetWifi } from "helmet-wifi";

export { RouteErrorBoundary as ErrorBoundary } from "@/components/route-error-boundary";

interface VlcHandle {
  snapshot(path: string): void;
}
// 库的 d.ts 声明了 VLCPlayer 类却没有导出，只能 require；类型用库自带的 props 补上。
// 直引 VLCPlayer 子文件：库的 index.js 会连带 require 自带播放器 UI（playerView），把 MaterialCommunityIcons 字体（1.3 MB）也拖进包
// eslint-disable-next-line @typescript-eslint/no-require-imports
const VLCPlayer = require("react-native-vlc-media-player/VLCPlayer")
  .default as ComponentType<VLCPlayerProps & { ref?: Ref<VlcHandle> }>;

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
  useKeepAwakeSafe("video-preview");

  // 开发期无头盔测试（DEVELOPMENT.md「视频预览无硬件测试」）：
  //   ?url=rtsp://<电脑IP>:8554/ch0 换成 tools/rtsp-mock 的测试流；仍会先连名为 X821cam 的热点
  //   （用另一台手机开同名热点、电脑连上去跑测试流，连接 + 绑定整条路径都能测）
  //   ?join=0 再跳过连热点（手机和电脑在同一个普通 Wi-Fi 下，只测播放器）
  //   ?ssid=…&pass=… 换成另一台手机现成的热点名和密码（不用把手机改名成 X821cam）
  //   &wpa3=1（Android 10 对 iPhone 这类 WPA2/WPA3 混合热点要按 WPA3 请求才匹配得上）
  const params = useRouteParams<{
    url?: string;
    join?: string;
    ssid?: string;
    pass?: string;
    wpa3?: string;
  }>();
  const devWpa3 = __DEV__ && params.wpa3 === "1";
  const devSsid =
    __DEV__ && typeof params.ssid === "string" && params.ssid
      ? params.ssid
      : undefined;
  const hotspotSsid = devSsid ?? HELMET_HOTSPOT.ssid;
  const hotspotPass = devSsid
    ? typeof params.pass === "string"
      ? params.pass
      : ""
    : HELMET_HOTSPOT.passphrase;
  const devUrl =
    __DEV__ &&
    typeof params.url === "string" &&
    params.url.startsWith("rtsp://")
      ? params.url
      : undefined;
  const streamUrl = devUrl ?? HELMET_HOTSPOT.streamUrl;
  const skipJoin = !HelmetWifi.available || (__DEV__ && params.join === "0");

  const [state, dispatch] = useReducer(previewReducer, initialPreviewState);
  const phaseRef = useRef(state.phase);
  useEffect(() => {
    phaseRef.current = state.phase;
  }, [state.phase]);
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
    HelmetWifi.connect(hotspotSsid, hotspotPass, JOIN_TIMEOUT_MS, {
      wpa3: devWpa3,
    }).then(
      () => {
        if (cancelled) {
          // 页面在连接途中已离开 / 失焦：此刻才拿到热点，没人再释放它——iOS 会一直挂在没有互联网的头盔热点上
          // （joinOnce 只在退后台时才自动断），Android 则把进程绑死在头盔网络。立即还回去
          if (!holdingWifi.current) HelmetWifi.release();
          return;
        }
        dispatch({ type: "joined" });
        // 连上那一刻系统弹窗多半还没关、AppState 还是 background（华为实测连上 0.5 s 后弹窗才收）；
        // 2 s 后仍在后台才是人按了 HOME：照退后台处理，回前台再重连
        setTimeout(() => {
          if (
            AppState.currentState === "background" &&
            holdsHelmetWifi(phaseRef.current)
          ) {
            releaseWifi();
            dispatch({ type: "suspend", reason: "background" });
          }
        }, 2000);
      },
      (e: { code?: string }) => {
        devLog("VIDEO", "连接头盔热点失败", e?.code);
        if (!cancelled) dispatch({ type: "joinFailed", code: e?.code });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [
    state.phase,
    state.attempt,
    skipJoin,
    releaseWifi,
    hotspotSsid,
    hotspotPass,
    devWpa3,
  ]);

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

  // Android 的「选择 Wi-Fi」系统弹窗是另一个 Activity，一弹出来 AppState 就变 background（华为 P30 实测，
  // 请求发出 68 ms 后就被这里释放，弹窗报「该应用已取消选择设备的请求」，回前台又重发，无限循环）。
  // 正在连热点时不把 background 当成离开：请求本身有 30 s 超时兜底，连上之前也没有绑定任何网络。
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "background") {
        if (phaseRef.current === "joining") return;
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

  // 任何压在本页上面的页面（倒计时页是 fullScreenModal、推送跳转）都让本页失焦但不卸载：此时 Android 进程仍绑在
  // 头盔热点上，倒计时页的取消 / 确认接口没有互联网可走，到期服务端照常通知联系人（10-15 评审 F-1）。
  // 失焦一律视同退后台：释放热点、暂停；回到本页再按「回前台」自动重连。系统的选 Wi-Fi 弹窗不改导航焦点，不受影响
  useFocusEffect(
    useCallback(() => {
      dispatch({ type: "foreground" });
      return () => {
        releaseWifi();
        dispatch({ type: "suspend", reason: "background" });
      };
    }, [releaseWifi]),
  );

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

  const ssid = hotspotSsid;
  const overlayText =
    state.phase === "joining"
      ? t("video.joining", { ssid })
      : state.phase === "connecting"
        ? state.stalled
          ? t("video.stalled", { ssid })
          : t("video.connecting")
        : state.phase === "manual"
          ? t("video.manual", { ssid, pass: hotspotPass })
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
  const localNetworkHint = suggestsLocalNetwork(state, Platform.OS);
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
            source={vlcSource(streamUrl)}
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
            {localNetworkHint && (
              <ThemedText type="small" style={styles.overlayHint}>
                {t("video.err.localNetwork")}
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
        {localNetworkHint && (
          <SecondaryButton
            title={t("video.err.openSettings")}
            icon="settings-outline"
            onPress={() => void Linking.openSettings().catch(() => undefined)}
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
