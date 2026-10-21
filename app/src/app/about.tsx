// 帮助与关于（「我的」→「帮助与关于」，2026-10-15 负责人要求「我的」首页只留常用项）：帮助与反馈、四份法律文档、版本。
// 两份清单：华为 / 小米隐私检测与 App 备案都要求 App 内可查（LAUNCH_CHECKLIST A-6），入口从「我的」首页挪到这里，仍两步可达。
import Constants from "expo-constants";
import { router } from "expo-router";
import { ScrollView, StyleSheet } from "react-native";

import { Card, ListRow } from "@/components/list";
import { ThemedView } from "@/components/themed-view";
import { translate, useT } from "@/i18n";
import { showNotice } from "@/services/notice";

export { RouteErrorBoundary as ErrorBoundary } from "@/components/route-error-boundary";

export default function AboutScreen() {
  const t = useT();
  const appVersion = Constants.expoConfig?.version ?? "—";
  const about = () =>
    showNotice(
      translate("profile.about"),
      `${translate("profile.version", { v: appVersion })}\n\n${translate("profile.aboutBody")}`,
    );

  return (
    <ThemedView style={styles.flex}>
      <ScrollView
        contentContainerStyle={styles.container}
        showsVerticalScrollIndicator={false}
      >
        <Card>
          <ListRow
            icon="help-circle-outline"
            title={t("profile.help")}
            onPress={() => router.navigate("/help")}
            last
          />
        </Card>
        <Card>
          <ListRow
            icon="shield-checkmark-outline"
            title={t("profile.privacy")}
            onPress={() => router.navigate("/legal/privacy")}
          />
          <ListRow
            icon="document-text-outline"
            title={t("profile.terms")}
            onPress={() => router.navigate("/legal/terms")}
          />
          <ListRow
            icon="list-outline"
            title={t("profile.collection")}
            onPress={() => router.navigate("/legal/collection")}
          />
          <ListRow
            icon="share-social-outline"
            title={t("profile.sharing")}
            onPress={() => router.navigate("/legal/sharing")}
            last
          />
        </Card>
        <Card>
          <ListRow
            icon="information-circle-outline"
            title={t("profile.about")}
            value={appVersion}
            onPress={about}
            last
          />
        </Card>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: 20, gap: 12 },
});
