// RTSP 播放器 Spike（决策 #37）——只为回答一个问题：这套技术栈能不能双端播出画面。
// 约定见 DEVICE_PROTOCOL §1.3：H.264 1280x720 无音频，强制 RTSP over TCP，无鉴权。
// 无硬件时用 tools/rtsp-mock 起的同约定测试流；真机只改主机为 192.168.176.1。
import { useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { VLCPlayer } = require("react-native-vlc-media-player");

import { FormInput, PrimaryButton } from "@/components/form";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { devLog } from "@/services/dev-log";

const DEFAULT_URL = "rtsp://192.168.1.111:8554/ch0";

export default function SpikeRtspScreen() {
  // 真机（尤其 iPhone）没法用命令行点按钮：带 ?auto=1&host=… 进来就自动开播，结果发到 devLog
  const params = useLocalSearchParams<{ auto?: string; host?: string }>();
  const [url, setUrl] = useState(
    params.host ? `rtsp://${params.host}:8554/ch0` : DEFAULT_URL,
  );
  // ?auto=1 从初值就开播，避免在渲染期做副作用（React Compiler 规则）
  const [playing, setPlaying] = useState(params.auto === "1");
  const [log, setLog] = useState<string[]>([]);
  const [firstFrameMs, setFirstFrameMs] = useState<number | null>(null);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const push = (s: string) => {
    devLog("RTSP", s);
    setLog((l) =>
      [`${Date.now()}|${new Date().toLocaleTimeString()} ${s}`, ...l].slice(
        0,
        12,
      ),
    );
  };

  return (
    <ThemedView style={styles.wrap}>
      <FormInput
        label="RTSP 地址"
        icon="videocam-outline"
        value={url}
        onChangeText={setUrl}
        autoCapitalize="none"
      />
      <PrimaryButton
        title={playing ? "停止" : "播放"}
        onPress={() => {
          if (!playing) {
            setFirstFrameMs(null);
            setStartedAt(Date.now());
            push(`开始连接 ${url}`);
          } else {
            push("已停止（TEARDOWN）");
          }
          setPlaying((p) => !p);
        }}
      />
      <View style={styles.stage}>
        {playing ? (
          <VLCPlayer
            style={StyleSheet.absoluteFill}
            source={{
              uri: url,
              // §1.3 硬要求：必须强制 TCP，否则弱网/热点下容易黑屏
              initOptions: [
                "--rtsp-tcp",
                "--network-caching=150",
                "--no-audio",
                "--drop-late-frames",
                "--skip-frames",
              ],
            }}
            autoplay
            onPlaying={() => {
              if (firstFrameMs === null) {
                const ms = Date.now() - startedAt;
                setFirstFrameMs(ms);
                push(`首帧 ${ms} ms`);
              }
            }}
            onError={(e: unknown) =>
              push(`错误 ${JSON.stringify(e).slice(0, 120)}`)
            }
            onStopped={() => push("stopped")}
            onBuffering={() => push("缓冲中")}
          />
        ) : (
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.hint}
          >
            未播放
          </ThemedText>
        )}
      </View>
      <ThemedText type="small">
        平台 {Platform.OS} · 首帧{" "}
        {firstFrameMs === null ? "—" : `${firstFrameMs} ms`}
      </ThemedText>
      <View style={styles.log}>
        {log.map((l) => (
          <ThemedText key={l} type="label" themeColor="textSecondary">
            {l.slice(l.indexOf("|") + 1)}
          </ThemedText>
        ))}
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, padding: 16, gap: 10 },
  stage: {
    aspectRatio: 16 / 9,
    backgroundColor: "#000",
    borderRadius: 12,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  hint: { opacity: 0.6 },
  log: { gap: 2 },
});
