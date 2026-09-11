// 隐私政策 / 用户协议阅读页（2026-09-11）：路由参数 doc = privacy | terms，
// 正文全部来自 messages/legal.ts，章节数固定（privacy 9、terms 10），页面只负责排版。
// 文案仍是草案（公司法务未审），头部固定标出，法务定稿后只改字典不改页面。
import { Stack, useLocalSearchParams } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { useTheme } from "@/hooks/use-theme";
import { useT, type MessageKey } from "@/i18n";

const UPDATED_AT = "2026-09-11";

type Doc = "privacy" | "terms";
type Section = { h: MessageKey; p: MessageKey };

// 显式列出而不用模板字符串拼 key：让 tsc 在字典缺节时直接报错
const DOCS: Record<
  Doc,
  { title: MessageKey; intro: MessageKey; sections: Section[] }
> = {
  privacy: {
    title: "legal.privacy.title",
    intro: "legal.privacy.intro",
    sections: [
      { h: "legal.privacy.s1.h", p: "legal.privacy.s1.p" },
      { h: "legal.privacy.s2.h", p: "legal.privacy.s2.p" },
      { h: "legal.privacy.s3.h", p: "legal.privacy.s3.p" },
      { h: "legal.privacy.s4.h", p: "legal.privacy.s4.p" },
      { h: "legal.privacy.s5.h", p: "legal.privacy.s5.p" },
      { h: "legal.privacy.s6.h", p: "legal.privacy.s6.p" },
      { h: "legal.privacy.s7.h", p: "legal.privacy.s7.p" },
      { h: "legal.privacy.s8.h", p: "legal.privacy.s8.p" },
      { h: "legal.privacy.s9.h", p: "legal.privacy.s9.p" },
    ],
  },
  terms: {
    title: "legal.terms.title",
    intro: "legal.terms.intro",
    sections: [
      { h: "legal.terms.s1.h", p: "legal.terms.s1.p" },
      { h: "legal.terms.s2.h", p: "legal.terms.s2.p" },
      { h: "legal.terms.s3.h", p: "legal.terms.s3.p" },
      { h: "legal.terms.s4.h", p: "legal.terms.s4.p" },
      { h: "legal.terms.s5.h", p: "legal.terms.s5.p" },
      { h: "legal.terms.s6.h", p: "legal.terms.s6.p" },
      { h: "legal.terms.s7.h", p: "legal.terms.s7.p" },
      { h: "legal.terms.s8.h", p: "legal.terms.s8.p" },
      { h: "legal.terms.s9.h", p: "legal.terms.s9.p" },
      { h: "legal.terms.s10.h", p: "legal.terms.s10.p" },
    ],
  },
};

export default function LegalDocScreen() {
  const t = useT();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ doc?: string }>();
  const doc: Doc = params.doc === "terms" ? "terms" : "privacy";
  const { title, intro, sections } = DOCS[doc];

  return (
    <ThemedView style={styles.flex}>
      <Stack.Screen options={{ title: t(title) }} />
      <ScrollView
        contentContainerStyle={[
          styles.container,
          { paddingBottom: 32 + insets.bottom },
        ]}
      >
        <View style={styles.header}>
          <ThemedText type="smallBold" style={styles.title}>
            {t(title)}
          </ThemedText>
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.meta}
          >
            {t("legal.updated", { date: UPDATED_AT })}
          </ThemedText>
          <View
            style={[
              styles.draft,
              { backgroundColor: theme.warningBg, borderColor: theme.warning },
            ]}
          >
            <ThemedText
              type="small"
              style={[styles.draftText, { color: theme.warning }]}
            >
              {t("legal.draftNote")}
            </ThemedText>
          </View>
        </View>

        <ThemedText type="default" style={styles.paragraph}>
          {t(intro)}
        </ThemedText>

        {sections.map((s, i) => (
          <View key={s.h} style={styles.section}>
            <ThemedText type="smallBold" style={styles.heading}>
              {i + 1}. {t(s.h)}
            </ThemedText>
            {t(s.p)
              .split("\n")
              .map((line, j) => (
                <ThemedText key={j} type="default" style={styles.paragraph}>
                  {line}
                </ThemedText>
              ))}
          </View>
        ))}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { paddingHorizontal: 20, paddingTop: 16, gap: 18 },
  header: { gap: 6, alignItems: "flex-start" },
  title: { fontSize: 24, lineHeight: 30 },
  meta: { fontSize: 13 },
  draft: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
    marginTop: 2,
  },
  draftText: { fontSize: 12, lineHeight: 16 },
  section: { gap: 6 },
  heading: { fontSize: 17, lineHeight: 24, marginBottom: 2 },
  paragraph: { fontSize: 15, lineHeight: 23 },
});
