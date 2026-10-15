// 地图页「在地图上看哪台头盔」的底部面板（有两顶以上才会打开）。
// 只换地图上显示的头盔：不更换当前头盔，求救关联也不变——当前头盔只在设备页更换，
// 这一点写在面板上，免得用户以为在这里点了就换了求救的对象。
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { DevicePublic } from "@helmet/shared";

import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { helmetImageFor } from "@/constants/helmet-images";
import { Radius } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import { useLocale, useT } from "@/i18n";
import { relativeTime } from "@/i18n/format";
import { linkPillOf } from "@/services/device-home";
import { helmetNameOf, type HelmetLink } from "@/services/safety-status";

interface Props {
  visible: boolean;
  devices: readonly DevicePublic[];
  links: Record<string, HelmetLink>;
  /** 地图上正在看的那顶 */
  viewedId: string | undefined;
  /** 当前头盔（设备页设的那顶） */
  currentId: string | undefined;
  onPick: (deviceId: string) => void;
  onClose: () => void;
}

export function HelmetPicker({
  visible,
  devices,
  links,
  viewedId,
  currentId,
  onPick,
  onClose,
}: Props) {
  const theme = useTheme();
  const t = useT();
  const locale = useLocale();
  const insets = useSafeAreaInsets();
  // 顶数多时列表在面板里滚，面板本身不能长过屏幕：9 顶就把标题顶出状态栏（2026-10-15 边界测试）
  const { height: windowHeight } = useWindowDimensions();
  const listMaxHeight = Math.max(200, windowHeight * 0.55);
  return (
    <Modal
      visible={visible}
      transparent
      statusBarTranslucent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.mask}>
        <Pressable
          accessibilityLabel={t("common.close")}
          style={StyleSheet.absoluteFill}
          onPress={onClose}
        />
        <Animated.View
          entering={FadeInDown.duration(220)}
          accessibilityViewIsModal
          style={[
            styles.sheet,
            {
              backgroundColor: theme.backgroundElement,
              borderColor: theme.border,
              paddingBottom: Math.max(insets.bottom, 12) + 10,
            },
          ]}
        >
          <View style={styles.head}>
            <ThemedText
              type="smallBold"
              accessibilityRole="header"
              style={styles.title}
            >
              {t("map.picker.title")}
            </ThemedText>
            <Tappable
              feedback="opacity"
              accessibilityRole="button"
              accessibilityLabel={t("common.close")}
              onPress={onClose}
              style={[
                styles.close,
                { backgroundColor: theme.backgroundSelected },
              ]}
            >
              <Ionicons name="close" size={20} color={theme.text} />
            </Tappable>
          </View>
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.lead}
          >
            {t("map.picker.lead")}
          </ThemedText>

          <ScrollView
            style={{ maxHeight: listMaxHeight }}
            bounces={false}
            showsVerticalScrollIndicator
          >
            {devices.map((d) => {
              const on = d.deviceId === viewedId;
              const pill = linkPillOf(links[d.deviceId] ?? "unknown");
              // 多久前断开的写在状态那一行（和设备页「其他设备」同一个写法），这一行不会被长编号挤掉
              const battery =
                d.battery === null
                  ? null
                  : t("map.picker.battery", { n: d.battery });
              return (
                <Tappable
                  key={d.deviceId}
                  feedback="scale"
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  onPress={() => onPick(d.deviceId)}
                  style={[
                    styles.row,
                    {
                      borderColor: on ? theme.borderStrong : theme.border,
                      backgroundColor: on
                        ? theme.backgroundSelected
                        : "transparent",
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.thumb,
                      {
                        backgroundColor: on
                          ? theme.backgroundElement
                          : theme.backgroundSelected,
                      },
                    ]}
                  >
                    <Image
                      source={helmetImageFor(d.deviceId)}
                      contentFit="contain"
                      style={styles.thumbImage}
                    />
                  </View>
                  <View style={styles.body}>
                    <View style={styles.nameRow}>
                      <ThemedText numberOfLines={1} style={styles.name}>
                        {helmetNameOf(d)}
                      </ThemedText>
                      {d.deviceId === currentId && (
                        <View
                          style={[styles.tag, { backgroundColor: theme.brand }]}
                        >
                          <ThemedText
                            style={[styles.tagText, { color: theme.onBrand }]}
                          >
                            {t("map.picker.currentTag")}
                          </ThemedText>
                        </View>
                      )}
                    </View>
                    <ThemedText
                      themeColor="textSecondary"
                      numberOfLines={1}
                      style={styles.sub}
                    >
                      {battery ? `${d.deviceId} · ${battery}` : d.deviceId}
                    </ThemedText>
                    <View style={styles.linkRow}>
                      <View
                        style={[
                          styles.dot,
                          {
                            backgroundColor: pill.linked
                              ? theme.success
                              : theme.textSecondary,
                          },
                        ]}
                      />
                      <ThemedText numberOfLines={1} style={styles.link}>
                        {pill.linked
                          ? t(pill.text)
                          : `${t("common.offline")} · ${relativeTime(d.lastSeenAt, locale)}`}
                      </ThemedText>
                    </View>
                  </View>
                  <Ionicons
                    name="checkmark"
                    size={22}
                    color={theme.text}
                    style={{ opacity: on ? 1 : 0 }}
                  />
                </Tappable>
              );
            })}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  mask: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
    padding: 10,
  },
  sheet: {
    borderRadius: 24,
    borderWidth: 1,
    paddingHorizontal: 20,
    paddingTop: 18,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  title: { fontSize: 20, lineHeight: 26, flexShrink: 1 },
  close: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  lead: { fontSize: 13, lineHeight: 19, marginTop: 6, marginBottom: 14 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 76,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 10,
    borderRadius: 12,
    borderWidth: 1,
  },
  thumb: {
    width: 44,
    height: 44,
    borderRadius: Radius.control,
    alignItems: "center",
    justifyContent: "center",
  },
  thumbImage: { width: 38, height: 38 },
  body: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { fontSize: 15, lineHeight: 20, fontWeight: 700, flexShrink: 1 },
  tag: {
    height: 20,
    paddingHorizontal: 7,
    borderRadius: 10,
    justifyContent: "center",
  },
  tagText: { fontSize: 11, lineHeight: 14, fontWeight: 700 },
  sub: { fontSize: 13, lineHeight: 18 },
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  link: { fontSize: 13, lineHeight: 18, flexShrink: 1 },
});
