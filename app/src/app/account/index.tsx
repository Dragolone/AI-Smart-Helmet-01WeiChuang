// 账号与安全（「我的」→「账号与安全」，2026-10-15 负责人要求：改密 / 换号 / 注销这类用得少的从「我的」首页挪进子页）。
// 注销单独一组放最下面，与两项日常设置隔开，不会顺手点到。
import { router } from "expo-router";
import { ScrollView, StyleSheet } from "react-native";

import { maskPhone } from "@/api/auth";
import { Card, ListRow } from "@/components/list";
import { ThemedView } from "@/components/themed-view";
import { useT } from "@/i18n";
import { useAuthStore } from "@/stores/auth-store";

export default function AccountScreen() {
  const t = useT();
  const user = useAuthStore((s) => s.user);

  return (
    <ThemedView style={styles.flex}>
      <ScrollView
        contentContainerStyle={styles.container}
        showsVerticalScrollIndicator={false}
      >
        <Card>
          <ListRow
            icon="key-outline"
            title={t("profile.changePassword")}
            onPress={() => router.navigate("/account/change-password")}
          />
          <ListRow
            icon="phone-portrait-outline"
            title={t("profile.changePhone")}
            value={maskPhone(user?.phone)}
            onPress={() => router.navigate("/account/change-phone")}
            last
          />
        </Card>
        <Card>
          <ListRow
            icon="person-remove-outline"
            title={t("profile.deleteAccount")}
            onPress={() => router.navigate("/account/delete")}
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
