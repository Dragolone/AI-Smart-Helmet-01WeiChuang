// 「对讲中」小条：人在对讲房间里、但正看着别的标签页时，提醒通话还开着，并能一步回去。
// 一直开麦时尤其要紧——用户切到别的页面后容易忘了麦克风还开着。
// 各标签页自己决定放在哪（不浮在内容上面：安全页底部是 SOS，不能被挡住）；不在房间里时不占位置。
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { FadeInDown, FadeOutDown } from "react-native-reanimated";

import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";
import { useIntercomStore } from "@/stores/intercom-store";

export function IntercomMiniBar({ style }: { style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  const t = useT();
  const session = useIntercomStore((s) => s.session);
  if (!session) return null;
  const sub = session.reconnecting
    ? t("intercom.reconnecting")
    : t(session.micOpen ? "intercom.mini.micOn" : "intercom.mini.micOff");
  return (
    <Animated.View
      entering={FadeInDown.duration(220)}
      exiting={FadeOutDown.duration(160)}
      style={style}
    >
      <Tappable
        feedback="scale"
        accessibilityRole="button"
        accessibilityLabel={`${t("intercom.mini.title", { name: session.channelName })}，${sub}，${t("intercom.mini.back")}`}
        onPress={() => router.navigate("/intercom")}
        style={[
          styles.bar,
          {
            backgroundColor: theme.backgroundElement,
            borderColor: theme.borderStrong,
          },
        ]}
      >
        <View
          style={[
            styles.icon,
            {
              backgroundColor: session.micOpen
                ? theme.brand
                : theme.backgroundSelected,
            },
          ]}
        >
          <Ionicons
            name={session.micOpen ? "mic" : "mic-outline"}
            size={18}
            color={session.micOpen ? theme.onBrand : theme.textSecondary}
          />
        </View>
        <View style={styles.body}>
          <ThemedText numberOfLines={1} style={styles.title}>
            {t("intercom.mini.title", { name: session.channelName })}
          </ThemedText>
          <ThemedText
            numberOfLines={1}
            style={[
              styles.sub,
              {
                color:
                  session.micOpen && !session.reconnecting
                    ? theme.brand
                    : theme.textSecondary,
              },
            ]}
          >
            {sub}
          </ThemedText>
        </View>
        <View style={[styles.back, { borderColor: theme.borderStrong }]}>
          <ThemedText style={styles.backText}>
            {t("intercom.mini.back")}
          </ThemedText>
        </View>
      </Tappable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    height: 60,
    paddingLeft: 14,
    paddingRight: 8,
    borderRadius: 18,
    borderWidth: 1,
  },
  icon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, lineHeight: 20, fontWeight: 700 },
  sub: { fontSize: 12, lineHeight: 16, fontWeight: 500 },
  back: {
    height: 44,
    paddingHorizontal: 16,
    borderRadius: 22,
    borderWidth: 1,
    justifyContent: "center",
  },
  backText: { fontSize: 14, lineHeight: 20, fontWeight: 700 },
});
