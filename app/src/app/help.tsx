// 帮助与反馈（2026-09-11）：常见问题（点行展开答案）+ 联系我们（反馈邮件 / 官网）。
// 问题与答案全部来自 messages/help.ts，页面只维护问答条数与排版。
import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import { Stack } from "expo-router";
import { useState } from "react";
import { Linking, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Card, GroupTitle, ListRow } from "@/components/list";
import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { useTheme } from "@/hooks/use-theme";
import { translate, useT, type MessageKey } from "@/i18n";
import { showNotice } from "@/services/notice";

const FEEDBACK_EMAIL = "zhongqilong@01weichuang.com";
const WEBSITE = "https://www.01weichuang.com";

// 显式列出而不用模板字符串拼 key：让 tsc 在字典缺条时直接报错
const FAQ: { q: MessageKey; a: MessageKey }[] = [
  { q: "help.q1", a: "help.a1" },
  { q: "help.q2", a: "help.a2" },
  { q: "help.q3", a: "help.a3" },
  { q: "help.q4", a: "help.a4" },
  { q: "help.q5", a: "help.a5" },
  { q: "help.q6", a: "help.a6" },
  { q: "help.q7", a: "help.a7" },
  { q: "help.q8", a: "help.a8" },
];

function FaqRow({
  question,
  answer,
  open,
  last,
  onToggle,
}: {
  question: string;
  answer: string;
  open: boolean;
  last: boolean;
  onToggle: () => void;
}) {
  const theme = useTheme();
  return (
    <View
      style={
        !last && {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.border,
        }
      }
    >
      <Tappable
        feedback="fill"
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={styles.faqRow}
      >
        <ThemedText type="default" style={styles.question}>
          {question}
        </ThemedText>
        <Ionicons
          name={open ? "chevron-up" : "chevron-down"}
          size={18}
          color={theme.textSecondary}
        />
      </Tappable>
      {open && (
        <ThemedText
          type="small"
          themeColor="textSecondary"
          style={styles.answer}
        >
          {answer}
        </ThemedText>
      )}
    </View>
  );
}

export default function HelpScreen() {
  const t = useT();
  const insets = useSafeAreaInsets();
  const [openIds, setOpenIds] = useState<MessageKey[]>([]);

  const toggle = (id: MessageKey) =>
    setOpenIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const open = (url: string) =>
    Linking.openURL(url).catch(() => showNotice(translate("help.openFailed")));

  const appVersion = Constants.expoConfig?.version ?? "—";
  const sendFeedback = () => {
    const subject = encodeURIComponent(
      translate("help.emailSubject", { v: appVersion }),
    );
    open(`mailto:${FEEDBACK_EMAIL}?subject=${subject}`);
  };

  return (
    <ThemedView style={styles.flex}>
      <Stack.Screen options={{ title: t("help.title") }} />
      <ScrollView
        contentContainerStyle={[
          styles.container,
          { paddingBottom: 28 + insets.bottom },
        ]}
      >
        <GroupTitle title={t("help.faqGroup")} />
        <Card>
          {FAQ.map((item, i) => (
            <FaqRow
              key={item.q}
              question={t(item.q)}
              answer={t(item.a)}
              open={openIds.includes(item.q)}
              last={i === FAQ.length - 1}
              onToggle={() => toggle(item.q)}
            />
          ))}
        </Card>

        <GroupTitle title={t("help.contactGroup")} />
        <Card>
          <ListRow
            icon="mail-outline"
            title={t("help.email")}
            subtitle={FEEDBACK_EMAIL}
            onPress={sendFeedback}
          />
          <ListRow
            icon="globe-outline"
            title={t("help.site")}
            subtitle={WEBSITE.replace(/^https?:\/\//, "")}
            onPress={() => open(WEBSITE)}
            last
          />
        </Card>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { paddingHorizontal: 20, paddingTop: 16, gap: 10 },
  faqRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 13,
    minHeight: 52,
  },
  question: { flex: 1, fontSize: 15, lineHeight: 21 },
  answer: {
    fontSize: 14,
    lineHeight: 21,
    paddingHorizontal: 16,
    paddingBottom: 14,
    marginTop: -2,
  },
});
