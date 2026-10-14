// 安全设置（安全首页右上角「设置」，2026-10-06）：把原先散在安全首页的几样集中到一处——
// 紧急联系人入口、通知权限、后台运行说明、SOS 演练入口。
// 入口和状态显示为主：联系人管理仍在 /contacts，演练仍是 /sos-active?drill=1。
// 唯一的设置项是「更换头盔提醒」的开关（2026-10-07），绑了两顶以上头盔才显示。
// 紧急联系人是账号级的（emergency_contacts.user_id，API.md §3），所有头盔共用。
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import {
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from "react-native";

import { contactsApi } from "@/api/contacts";
import { devicesApi } from "@/api/devices";
import { useBleOnboardingSteps } from "@/components/ble-onboarding";
import { Card, GroupTitle, ListRow } from "@/components/list";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { useNotifyPermission, useSosDrill } from "@/hooks/use-safety";
import { useSwitchReminderSetting } from "@/hooks/use-switch-reminder";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";

const MAX_CONTACTS = 5; // API.md §3 定稿

export default function SafetySettingsScreen() {
  const theme = useTheme();
  const t = useT();
  // 与设备页同一份缓存：只用来知道绑了几顶头盔
  const devices = useQuery({ queryKey: ["devices"], queryFn: devicesApi.list });
  const severalHelmets = (devices.data?.length ?? 0) > 1;
  const reminder = useSwitchReminderSetting();
  const contacts = useQuery({
    queryKey: ["contacts"],
    queryFn: contactsApi.list,
    // 还没拿到列表时每 30 秒再拉一次：否则失败一次后会一直停在「待确认」。拿到后不轮询
    refetchInterval: (q) => (q.state.data === undefined ? 30_000 : false),
  });
  // 没拿到列表（加载中 / 失败）≠ 没有联系人
  const contactCount = contacts.data ? contacts.data.length : null;
  const notify = useNotifyPermission();
  const drill = useSosDrill();
  // Android 省电白名单（决策 #41）：与首次连接引导、设备详情页读的是同一个状态
  const whitelist = useBleOnboardingSteps().find((s) => s.key === "whitelist");

  return (
    <ThemedView style={styles.flex}>
      <ScrollView
        contentContainerStyle={styles.container}
        showsVerticalScrollIndicator={false}
      >
        <GroupTitle title={t("safetySettings.groupContacts")} />
        <Card>
          <ListRow
            icon="call-outline"
            title={t("nav.contacts")}
            subtitle={
              contactCount === null
                ? t("safetySettings.contactsUnknown")
                : contactCount === 0
                  ? t("safety.contactsNone")
                  : t("safety.contactsCaption", {
                      n: contactCount,
                      max: MAX_CONTACTS,
                    })
            }
            onPress={() => router.navigate("/contacts")}
            last
          />
        </Card>
        <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
          {t("safety.helmet.sharedContacts")}
        </ThemedText>

        <GroupTitle title={t("safetySettings.groupPhone")} />
        <Card>
          <ListRow
            icon={
              notify === "denied"
                ? "notifications-off-outline"
                : "notifications-outline"
            }
            title={t("safetySettings.notify")}
            // 还没查到、系统没问过、查询失败，都如实写出来，不显示成已开启
            subtitle={t(`safetySettings.notify.${notify ?? "unknown"}`)}
            onPress={() => void Linking.openSettings()}
            last={!whitelist}
          />
          {whitelist && (
            <ListRow
              icon={
                whitelist.done
                  ? "battery-charging-outline"
                  : "battery-dead-outline"
              }
              title={t("device.batteryOpt")}
              subtitle={t(
                whitelist.done
                  ? "device.batteryOpt.ok"
                  : "device.batteryOpt.limited",
              )}
              onPress={whitelist.done ? undefined : whitelist.action}
              last
            />
          )}
        </Card>
        <Card style={styles.explain}>
          <ThemedText type="smallBold" style={styles.explainTitle}>
            {t("safetySettings.background")}
          </ThemedText>
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.explainBody}
          >
            {t("keepalive.body")}
          </ThemedText>
          {Platform.OS === "android" && (
            <ThemedText
              type="small"
              themeColor="textSecondary"
              style={styles.explainBody}
            >
              {t("keepalive.androidTip")}
            </ThemedText>
          )}
        </Card>

        {/* 只有一顶头盔时没有可换的对象，这个开关不出现 */}
        {severalHelmets && (
          <>
            <Card>
              <ListRow
                icon="swap-horizontal-outline"
                title={t("safetySettings.switchReminder")}
                right={
                  <Switch
                    accessibilityLabel={t("safetySettings.switchReminder")}
                    // 还没读到存储时先按开着显示（默认就是开），读到之前不让拨
                    value={reminder.enabled ?? true}
                    disabled={reminder.enabled === null}
                    onValueChange={reminder.setEnabled}
                    trackColor={{
                      true: theme.brand,
                      false: theme.borderStrong,
                    }}
                    thumbColor={
                      (reminder.enabled ?? true) ? theme.onBrand : "#FFFFFF"
                    }
                  />
                }
                last
              />
            </Card>
            <ThemedText
              type="small"
              themeColor="textSecondary"
              style={styles.note}
            >
              {t("safetySettings.switchReminderHint")}
            </ThemedText>
          </>
        )}

        <Card>
          <ListRow
            icon="school-outline"
            title={t("safetySettings.drill")}
            subtitle={t("safetySettings.drillHint")}
            onPress={drill.open}
            last
          />
        </Card>
        <View style={styles.tail} />
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: 20, gap: 12 },
  note: { fontSize: 12, lineHeight: 18, paddingHorizontal: 4, marginTop: -4 },
  explain: { padding: 16, gap: 8 },
  explainTitle: { fontSize: 15 },
  explainBody: { fontSize: 13, lineHeight: 20 },
  tail: { height: 12 },
});
