// 全局「连接中断」细条：WS 加速通道断开超过 4 s 才出现（启动/短暂重连不闪），恢复即收。
// 只在标签根页显示：这些页顶部是大标题，药丸落在状态栏下不挡任何东西；二级页（设备详情、
// 事件、SOS 等）有 44pt 导航条，同一位置会盖住标题——它们是过路页面，回到标签页就会看到。
// 地图页有自己的横幅（贴在设备药丸下），跳过避免叠两条。对讲页在房间里时也跳过：房间有自己的黄色重连条，
// 全局这条会压在频道名上（10-16 iPhone / 10-15 华为）。挂在根布局：NativeTabs 宿主对兄弟节点的绝对定位不可靠。
import { Ionicons } from "@expo/vector-icons";
import { usePathname } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { FadeInUp, FadeOutUp } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { realtimeClient } from "@/api/realtime";
import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";
import { useAuthStore } from "@/stores/auth-store";
import { useIntercomStore } from "@/stores/intercom-store";

const GRACE_MS = 4000;
/** 标签根页（/map 有自己的横幅，不在此列） */
const TAB_ROOTS = new Set(["/", "/intercom", "/safety", "/profile"]);

export function ConnectionBanner() {
  const theme = useTheme();
  const t = useT();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const authed = useAuthStore((s) => s.tokens !== null);
  const inRoom = useIntercomStore((s) => s.session !== null);
  // 断开时刻 + 「宽限期到点时对应的断开时刻」：两者相等才显示（不在 effect 里直接 setState）
  const [downSince, setDownSince] = useState<number | null>(null);
  const [elapsedFor, setElapsedFor] = useState<number | null>(null);
  // 只在登录期间计时：没登录时通道本来就断着，原来宽限期在登录页上就耗完了，一登录就闪「连接中断」。
  // 每次登录重新订阅，订阅时回放的那一次「断开」从此刻起算
  useEffect(() => {
    if (!authed) return;
    let replay = true;
    return realtimeClient.subscribeState((connected) => {
      const fresh = replay;
      replay = false;
      setDownSince((prev) =>
        connected ? null : fresh || prev === null ? Date.now() : prev,
      );
    });
  }, [authed]);
  useEffect(() => {
    if (downSince === null) return;
    const id = setTimeout(() => setElapsedFor(downSince), GRACE_MS);
    return () => clearTimeout(id);
  }, [downSince]);
  const show = downSince !== null && elapsedFor === downSince;

  if (!authed || !show || !TAB_ROOTS.has(pathname)) return null;
  if (pathname === "/intercom" && inRoom) return null;
  return (
    <View pointerEvents="none" style={[styles.wrap, { top: insets.top + 6 }]}>
      <Animated.View
        entering={FadeInUp.duration(220)}
        exiting={FadeOutUp.duration(180)}
        style={[styles.strip, { backgroundColor: theme.warningBg }]}
      >
        <Ionicons
          name="cloud-offline-outline"
          size={14}
          color={theme.warning}
        />
        <ThemedText
          type="small"
          style={[styles.text, { color: theme.warning }]}
        >
          {t("map.reconnecting")}
        </ThemedText>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 50,
  },
  strip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  text: { fontSize: 12, lineHeight: 16 },
});
