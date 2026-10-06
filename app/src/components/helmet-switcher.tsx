// 头盔选择器（安全首页 / 安全记录页共用）：一行显示正在查看的头盔；绑了多顶时点开底部面板切换。
// 切换只改「正在查看哪顶」（stores/helmet-view-store）——不连接、不断开、不解绑任何头盔。
// 只有一顶头盔时没有可切换的对象，不显示「切换」；有进行中的 SOS 时同样不给切换入口。
import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { DevicePublic } from "@helmet/shared";

import { IconCircle } from "@/components/list";
import { StatusChip } from "@/components/status-chip";
import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { Radius } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import { useLocale, useT, type Locale, type MessageKey } from "@/i18n";
import { relativeTime } from "@/i18n/format";
import {
  linkCheckLevelOf,
  linkLevelOf,
  type HelmetLink,
} from "@/services/safety-status";

export const helmetNameOf = (d: Pick<DevicePublic, "name" | "deviceId">) =>
  d.name ?? d.deviceId;

export const linkLabelKey = (link: HelmetLink): MessageKey =>
  `safety.link.${link}`;

type Translate = ReturnType<typeof useT>;

/**
 * 名称下面那行：设备号（起了名字才显示，否则名称本身就是设备号）+ 电量（服务端有值才显示）。
 * 没连着的时候，电量是上次收到的旧值，必须带上「上次」和时间。
 */
function sublineOf(
  d: DevicePublic,
  link: HelmetLink,
  t: Translate,
  locale: Locale,
): string {
  const parts: string[] = [];
  if (d.name) parts.push(d.deviceId);
  if (d.battery !== null) {
    if (linkLevelOf(link) === "ok")
      parts.push(t("safety.helmet.battery", { n: d.battery }));
    else if (d.lastSeenAt)
      parts.push(
        t("safety.helmet.batteryLast", {
          n: d.battery,
          ago: relativeTime(d.lastSeenAt, locale),
        }),
      );
  }
  return parts.join(" · ");
}

export function HelmetSwitcher({
  devices,
  viewed,
  links,
  locked,
  onSelect,
}: {
  devices: readonly DevicePublic[];
  viewed: DevicePublic;
  links: Record<string, HelmetLink>;
  /** 有进行中的 SOS：不提供切换入口 */
  locked: boolean;
  onSelect: (deviceId: string) => void;
}) {
  const theme = useTheme();
  const t = useT();
  const locale = useLocale();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const several = devices.length > 1;
  const canSwitch = several && !locked;
  const name = helmetNameOf(viewed);

  const pillStyle = [
    styles.pill,
    { backgroundColor: theme.backgroundSelected },
  ];
  const pillBody = (
    <>
      <Ionicons
        name="shield-half-outline"
        size={18}
        color={theme.textSecondary}
      />
      <ThemedText type="small" numberOfLines={1} style={styles.pillName}>
        {name}
      </ThemedText>
      {canSwitch && (
        <>
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.pillAction}
          >
            {t("safety.helmet.switch")}
          </ThemedText>
          <Ionicons name="chevron-down" size={16} color={theme.textSecondary} />
        </>
      )}
    </>
  );

  return (
    <View style={styles.wrap}>
      {canSwitch ? (
        <Tappable
          feedback="opacity"
          accessibilityRole="button"
          accessibilityLabel={t("safety.helmet.switchA11y", { name })}
          onPress={() => setOpen(true)}
          style={pillStyle}
        >
          {pillBody}
        </Tappable>
      ) : (
        <View
          accessible
          accessibilityLabel={t("safety.helmet.currentA11y", { name })}
          style={pillStyle}
        >
          {pillBody}
        </View>
      )}
      {several && locked && (
        <ThemedText
          type="small"
          themeColor="textSecondary"
          style={styles.lockedNote}
        >
          {t("safety.helmet.lockedBySos")}
        </ThemedText>
      )}

      <Modal
        // 面板开着的时候来了 SOS：入口收起，面板也跟着关
        visible={open && canSwitch}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <View style={styles.mask}>
          <Pressable
            style={StyleSheet.absoluteFill}
            accessibilityRole="button"
            accessibilityLabel={t("common.close")}
            onPress={() => setOpen(false)}
          />
          <Animated.View
            entering={FadeInDown.duration(200)}
            accessibilityViewIsModal
            style={[
              styles.sheet,
              {
                backgroundColor: theme.backgroundElement,
                borderColor: theme.border,
                paddingBottom: Math.max(insets.bottom, 12) + 8,
              },
            ]}
          >
            <View style={styles.sheetHead}>
              <ThemedText type="smallBold" style={styles.sheetTitle}>
                {t("safety.helmet.sheetTitle")}
              </ThemedText>
              <Tappable
                accessibilityRole="button"
                accessibilityLabel={t("common.close")}
                onPress={() => setOpen(false)}
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
              {t("safety.helmet.sheetLead")}
            </ThemedText>
            <ScrollView
              style={styles.choices}
              contentContainerStyle={styles.choicesContent}
              showsVerticalScrollIndicator={false}
            >
              {devices.map((d) => {
                const selected = d.deviceId === viewed.deviceId;
                const link = links[d.deviceId] ?? "unknown";
                const subline = sublineOf(d, link, t, locale);
                return (
                  <Tappable
                    key={d.deviceId}
                    feedback="fill"
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => {
                      onSelect(d.deviceId);
                      setOpen(false);
                    }}
                    style={[
                      styles.choice,
                      {
                        borderColor: selected
                          ? theme.borderStrong
                          : theme.border,
                      },
                      selected && { backgroundColor: theme.backgroundSelected },
                    ]}
                  >
                    <IconCircle icon="shield-half-outline" size={36} />
                    <View style={styles.choiceBody}>
                      <ThemedText
                        type="smallBold"
                        numberOfLines={1}
                        style={styles.choiceName}
                      >
                        {helmetNameOf(d)}
                      </ThemedText>
                      {subline !== "" && (
                        <ThemedText
                          type="small"
                          themeColor="textSecondary"
                          style={styles.choiceSub}
                        >
                          {subline}
                        </ThemedText>
                      )}
                      <StatusChip
                        level={linkCheckLevelOf(link)}
                        label={
                          selected
                            ? `${t(linkLabelKey(link))} · ${t("safety.helmet.viewing")}`
                            : t(linkLabelKey(link))
                        }
                      />
                    </View>
                    {selected && (
                      <Ionicons name="checkmark" size={22} color={theme.text} />
                    )}
                  </Tappable>
                );
              })}
            </ScrollView>
            <ThemedText
              type="small"
              themeColor="textSecondary"
              style={styles.sheetNote}
            >
              {t("safety.helmet.sharedContacts")}
            </ThemedText>
          </Animated.View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 12,
  },
  pillName: { flex: 1, minWidth: 0 },
  pillAction: { fontSize: 13 },
  lockedNote: { fontSize: 12, lineHeight: 16, paddingHorizontal: 4 },
  mask: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
    padding: 10,
  },
  sheet: {
    borderRadius: 24,
    borderWidth: 1,
    padding: 20,
    maxHeight: "80%",
  },
  sheetHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  sheetTitle: { fontSize: 20, lineHeight: 26, flexShrink: 1 },
  close: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  lead: { lineHeight: 20, marginTop: 8 },
  choices: { marginTop: 14, flexGrow: 0 },
  choicesContent: { gap: 10 },
  choice: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 76,
    padding: 14,
    borderWidth: 1,
    borderRadius: Radius.control,
  },
  choiceBody: { flex: 1, minWidth: 0, gap: 4 },
  choiceName: { fontSize: 15 },
  choiceSub: { fontSize: 13, lineHeight: 18 },
  sheetNote: { fontSize: 12, lineHeight: 18, marginTop: 14 },
});
