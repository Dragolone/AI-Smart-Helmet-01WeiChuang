// 我的（底部标签，2026-09-10 重设计；09-11 重分组；10-15 分层）：账号卡 → 「安全」「通用」两组常用项 →
// 「账号与安全」「帮助与关于」两个子页入口（改密 / 换号 / 注销、法律文档这类用得少的挪进子页，负责人要求）→ 底部文字「退出登录」。
// 图标统一单色描边（此前多彩方块与其他页不一致）；语言切换（简/繁/英）在这里落地。
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, Modal, ScrollView, StyleSheet, View } from "react-native";
import ReAnimated, { FadeInDown } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";

import { authApi } from "@/api/auth";
import { contactsApi } from "@/api/contacts";
import { devicesApi } from "@/api/devices";
import { toUserMessage } from "@/api/error-messages";
import { FormInput, PrimaryButton } from "@/components/form";
import { IntercomMiniBar } from "@/components/intercom-mini-bar";
import { Card, GroupTitle, ListRow } from "@/components/list";
import { Tappable } from "@/components/tappable";
import { KeyboardAvoid } from "@/components/keyboard-avoid";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { showToast } from "@/components/toast";
import { Radius } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import { LOCALES, LOCALE_NAMES, translate, useLocaleStore, useT } from "@/i18n";
import { useAuthStore } from "@/stores/auth-store";
import {
  THEME_MODES,
  useThemeStore,
  type ThemeMode,
} from "@/stores/theme-store";
import { showNotice } from "@/services/notice";
import { profilePatch } from "@/services/profile-patch";

export default function ProfileScreen() {
  const theme = useTheme();
  const t = useT();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const refreshUser = useAuthStore((s) => s.refreshUser);
  // 每次进「我的」重拉一次档案：别的手机改过的昵称 / 头像要能看到
  useFocusEffect(
    useCallback(() => {
      void refreshUser();
    }, [refreshUser]),
  );
  const signOut = useAuthStore((s) => s.signOut);
  const locale = useLocaleStore((s) => s.locale);
  const setLocale = useLocaleStore((s) => s.setLocale);
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);
  const [themeOpen, setThemeOpen] = useState(false);
  const themeLabel = (m: ThemeMode) =>
    m === "system"
      ? t("profile.appearance.system")
      : m === "dark"
        ? t("profile.appearance.dark")
        : t("profile.appearance.light");

  const devices = useQuery({ queryKey: ["devices"], queryFn: devicesApi.list });
  const contacts = useQuery({
    queryKey: ["contacts"],
    queryFn: contactsApi.list,
  });

  const [editOpen, setEditOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [nickDraft, setNickDraft] = useState("");
  const [avatarDraft, setAvatarDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 保存成功：按钮先画勾，画完再关弹层（弹层一关内容就卸掉，下次打开从头来）
  const [saved, setSaved] = useState(false);

  const openEdit = () => {
    setNickDraft(user?.nickname ?? "");
    setAvatarDraft(user?.avatarUrl ?? null);
    setEditOpen(true);
  };

  // 选图 → 方形裁剪 → 压到 256px JPEG → data-URI（OSS 就绪后换真 URL，契约不变）
  const pickAvatar = async () => {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.9,
      });
      const asset = res.assets?.[0];
      if (!asset) return;
      const ctx = ImageManipulator.manipulate(asset.uri);
      ctx.resize({ width: 256 });
      const rendered = await ctx.renderAsync();
      const out = await rendered.saveAsync({
        compress: 0.6,
        format: SaveFormat.JPEG,
        base64: true,
      });
      if (out.base64) setAvatarDraft(`data:image/jpeg;base64,${out.base64}`);
    } catch (e) {
      showNotice(
        translate("profile.pickFailed"),
        e instanceof Error ? e.message : String(e),
      );
    }
  };

  const saveProfile = async () => {
    // 只发改过的字段：user 是本机存着的会话，可能是旧的（别的手机改过昵称）。
    // 原来只换头像也会把旧昵称一起写回去，把别处的修改覆盖掉（2026-10-16 华为实测）
    const patch = profilePatch(user, nickDraft, avatarDraft);
    if (!patch) {
      setSaved(true);
      return;
    }
    setSaving(true);
    try {
      const updated = await authApi.updateMe(patch);
      await setUser(updated);
      setSaved(true);
    } catch (e) {
      showNotice(translate("profile.saveFailed"), toUserMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const clearCache = () => {
    Alert.alert(
      translate("profile.clearCache"),
      translate("profile.clearCacheBody"),
      [
        { text: translate("common.cancel"), style: "cancel" },
        {
          text: translate("common.confirm"),
          onPress: () => {
            queryClient.clear();
            void Image.clearDiskCache();
            void Image.clearMemoryCache();
            showToast(translate("profile.clearCacheDone"));
          },
        },
      ],
    );
  };

  const confirmSignOut = () => {
    Alert.alert(
      translate("profile.signOut"),
      translate("profile.signOutBody"),
      [
        { text: translate("common.cancel"), style: "cancel" },
        {
          text: translate("profile.signOutConfirm"),
          style: "destructive",
          onPress: () => void signOut(),
        },
      ],
    );
  };

  const initial = (user?.nickname ?? user?.phone ?? "?")
    .slice(0, 1)
    .toUpperCase();
  const deviceCount = devices.data?.length ?? 0;

  return (
    <ThemedView style={styles.flex}>
      <SafeAreaView style={styles.flex}>
        <ScrollView
          contentContainerStyle={styles.container}
          showsVerticalScrollIndicator={false}
        >
          <ThemedText type="title" style={styles.pageTitle}>
            {t("profile.title")}
          </ThemedText>

          {/* 账号卡：整卡可点进编辑；相机角标只是提示 */}
          <Tappable feedback="scale" onPress={openEdit}>
            <Card style={styles.accountCard}>
              <View style={styles.avatarWrap}>
                {user?.avatarUrl ? (
                  <Image
                    source={{ uri: user.avatarUrl }}
                    style={styles.avatar}
                  />
                ) : (
                  <View
                    style={[
                      styles.avatar,
                      { backgroundColor: theme.backgroundSelected },
                    ]}
                  >
                    <ThemedText
                      type="display"
                      style={{ fontSize: 24, lineHeight: 30 }}
                    >
                      {initial}
                    </ThemedText>
                  </View>
                )}
                <View
                  style={[
                    styles.avatarBadge,
                    {
                      backgroundColor: theme.brand,
                      borderColor: theme.backgroundElement,
                    },
                  ]}
                >
                  <Ionicons name="camera" size={12} color={theme.onBrand} />
                </View>
              </View>
              <View style={styles.accountBody}>
                <ThemedText
                  type="smallBold"
                  style={{ fontSize: 18, lineHeight: 24 }}
                  numberOfLines={1}
                >
                  {user?.nickname ?? t("profile.setNickname")}
                </ThemedText>
                <ThemedText
                  type="small"
                  themeColor="textSecondary"
                  style={{ fontSize: 13 }}
                >
                  {user?.phone ?? "—"} ·{" "}
                  {t("profile.devicesCount", { n: deviceCount })}
                </ThemedText>
              </View>
              <Ionicons
                name="chevron-forward"
                size={18}
                color={theme.textSecondary}
              />
            </Card>
          </Tappable>

          <GroupTitle title={t("profile.groupSafety")} />
          <Card>
            <ListRow
              compact
              icon="call-outline"
              title={t("profile.contacts")}
              value={t("profile.contactsValue", {
                n: contacts.data?.length ?? 0,
              })}
              onPress={() => router.navigate("/contacts")}
            />
            <ListRow
              compact
              icon="time-outline"
              title={t("profile.records")}
              onPress={() => router.navigate("/safety-records")}
              last
            />
          </Card>

          <GroupTitle title={t("profile.groupGeneral")} />
          <Card>
            <ListRow
              compact
              icon="globe-outline"
              title={t("profile.language")}
              value={LOCALE_NAMES[locale]}
              onPress={() => setLangOpen(true)}
            />
            <ListRow
              compact
              icon="moon-outline"
              title={t("profile.appearance")}
              value={themeLabel(themeMode)}
              onPress={() => setThemeOpen(true)}
            />
            <ListRow
              compact
              icon="notifications-outline"
              title={t("profile.notifications")}
              value={t("profile.notificationsValue")}
            />
            <ListRow
              compact
              icon="trash-outline"
              title={t("profile.clearCache")}
              onPress={clearCache}
              last
            />
          </Card>

          {/* 用得少的收进子页：账号与安全（改密 / 换号 / 注销）、帮助与关于（帮助、四份法律文档、版本） */}
          <Card>
            <ListRow
              compact
              icon="person-circle-outline"
              title={t("profile.groupAccount")}
              onPress={() => router.navigate("/account")}
            />
            <ListRow
              compact
              icon="help-circle-outline"
              title={t("profile.groupHelp")}
              onPress={() => router.navigate("/about")}
              last
            />
          </Card>

          <Tappable onPress={confirmSignOut} style={styles.signOut}>
            <ThemedText
              type="small"
              themeColor="textSecondary"
              style={{ fontSize: 15 }}
            >
              {t("profile.signOut")}
            </ThemedText>
          </Tappable>
        </ScrollView>

        {/* 人在对讲房间里时占一行，不在时不占位置 */}
        <IntercomMiniBar style={styles.miniBar} />

        {/* 个人资料编辑 */}
        <Modal
          visible={editOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setEditOpen(false)}
        >
          <KeyboardAvoid>
            <Tappable
              feedback={[]}
              // 遮罩只负责「点空白处关闭」，不能自成一个读屏焦点（会把整张卡片合成一块）
              accessible={false}
              style={styles.modalMask}
              onPress={() => setEditOpen(false)}
            >
              <ReAnimated.View entering={FadeInDown.duration(200)}>
                <Tappable
                  feedback={[]}
                  style={[
                    styles.modalCard,
                    {
                      backgroundColor: theme.backgroundElement,
                      borderColor: theme.border,
                    },
                  ]}
                  // 只用来挡住「点卡片关弹层」；不能自成一个读屏焦点，否则里面的选项 / 输入框被合成一块、读屏选不中
                  accessible={false}
                  onPress={() => undefined}
                >
                  <ThemedText
                    type="smallBold"
                    style={{ fontSize: 20, lineHeight: 26 }}
                  >
                    {t("profile.edit")}
                  </ThemedText>
                  <Tappable
                    style={styles.avatarPick}
                    onPress={() => void pickAvatar()}
                  >
                    {avatarDraft ? (
                      <Image
                        source={{ uri: avatarDraft }}
                        style={styles.avatarBig}
                      />
                    ) : (
                      <View
                        style={[
                          styles.avatarBig,
                          styles.center,
                          { backgroundColor: theme.backgroundSelected },
                        ]}
                      >
                        <ThemedText
                          type="display"
                          style={{ fontSize: 26, lineHeight: 32 }}
                        >
                          {initial}
                        </ThemedText>
                      </View>
                    )}
                    <ThemedText type="small" themeColor="textSecondary">
                      {t("profile.changeAvatar")}
                    </ThemedText>
                  </Tappable>
                  <FormInput
                    label={t("profile.nickname")}
                    value={nickDraft}
                    onChangeText={setNickDraft}
                    placeholder={t("profile.nicknamePlaceholder")}
                    maxLength={20}
                  />
                  <PrimaryButton
                    title={t("common.save")}
                    onPress={() => void saveProfile()}
                    loading={saving}
                    success={saved}
                    onSuccessShown={() => {
                      setEditOpen(false);
                      setSaved(false);
                    }}
                  />
                </Tappable>
              </ReAnimated.View>
            </Tappable>
          </KeyboardAvoid>
        </Modal>

        {/* 外观选择 */}
        <Modal
          visible={themeOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setThemeOpen(false)}
        >
          <Tappable
            feedback={[]}
            // 遮罩只负责「点空白处关闭」，不能自成一个读屏焦点（会把整张卡片合成一块）
            accessible={false}
            style={styles.modalMask}
            onPress={() => setThemeOpen(false)}
          >
            <ReAnimated.View entering={FadeInDown.duration(200)}>
              <Tappable
                feedback={[]}
                style={[
                  styles.modalCard,
                  {
                    backgroundColor: theme.backgroundElement,
                    borderColor: theme.border,
                  },
                ]}
                // 只用来挡住「点卡片关弹层」；不能自成一个读屏焦点，否则里面的选项 / 输入框被合成一块、读屏选不中
                accessible={false}
                onPress={() => undefined}
              >
                <ThemedText
                  type="smallBold"
                  style={{ fontSize: 20, lineHeight: 26 }}
                >
                  {t("profile.chooseAppearance")}
                </ThemedText>
                <View>
                  {THEME_MODES.map((m, i) => (
                    <Tappable
                      key={m}
                      feedback="fill"
                      accessibilityRole="button"
                      accessibilityState={{ selected: m === themeMode }}
                      onPress={() => {
                        void setThemeMode(m);
                        setThemeOpen(false);
                      }}
                      style={[
                        styles.langRow,
                        i < THEME_MODES.length - 1 && {
                          borderBottomWidth: StyleSheet.hairlineWidth,
                          borderBottomColor: theme.border,
                        },
                      ]}
                    >
                      <ThemedText type="default" style={{ flex: 1 }}>
                        {themeLabel(m)}
                      </ThemedText>
                      {m === themeMode && (
                        <Ionicons
                          name="checkmark"
                          size={20}
                          color={theme.brand}
                        />
                      )}
                    </Tappable>
                  ))}
                </View>
              </Tappable>
            </ReAnimated.View>
          </Tappable>
        </Modal>

        {/* 语言选择 */}
        <Modal
          visible={langOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setLangOpen(false)}
        >
          <Tappable
            feedback={[]}
            // 遮罩只负责「点空白处关闭」，不能自成一个读屏焦点（会把整张卡片合成一块）
            accessible={false}
            style={styles.modalMask}
            onPress={() => setLangOpen(false)}
          >
            <ReAnimated.View entering={FadeInDown.duration(200)}>
              <Tappable
                feedback={[]}
                style={[
                  styles.modalCard,
                  {
                    backgroundColor: theme.backgroundElement,
                    borderColor: theme.border,
                  },
                ]}
                // 只用来挡住「点卡片关弹层」；不能自成一个读屏焦点，否则里面的选项 / 输入框被合成一块、读屏选不中
                accessible={false}
                onPress={() => undefined}
              >
                <ThemedText
                  type="smallBold"
                  style={{ fontSize: 20, lineHeight: 26 }}
                >
                  {t("profile.chooseLanguage")}
                </ThemedText>
                <View>
                  {LOCALES.map((loc, i) => (
                    <Tappable
                      key={loc}
                      feedback="fill"
                      accessibilityRole="button"
                      accessibilityState={{ selected: loc === locale }}
                      onPress={() => {
                        void setLocale(loc);
                        setLangOpen(false);
                      }}
                      style={[
                        styles.langRow,
                        i < LOCALES.length - 1 && {
                          borderBottomWidth: StyleSheet.hairlineWidth,
                          borderBottomColor: theme.border,
                        },
                      ]}
                    >
                      <ThemedText type="default" style={{ flex: 1 }}>
                        {LOCALE_NAMES[loc]}
                      </ThemedText>
                      {loc === locale && (
                        <Ionicons
                          name="checkmark"
                          size={20}
                          color={theme.brand}
                        />
                      )}
                    </Tappable>
                  ))}
                </View>
              </Tappable>
            </ReAnimated.View>
          </Tappable>
        </Modal>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  miniBar: { paddingHorizontal: 12, paddingBottom: 12 },
  container: { paddingHorizontal: 20, paddingBottom: 28, gap: 14 },
  pageTitle: { fontSize: 32, lineHeight: 40, marginBottom: -2 },
  accountCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    padding: 16,
  },
  avatarWrap: { width: 56, height: 56 },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarBadge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  accountBody: { flex: 1, minWidth: 0, gap: 3 },
  signOut: {
    alignSelf: "center",
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 16,
    marginTop: 4,
  },
  modalMask: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    padding: 28,
  },
  modalCard: {
    borderRadius: Radius.card,
    borderWidth: 1,
    padding: 18,
    gap: 14,
  },
  avatarPick: { alignItems: "center", gap: 8 },
  avatarBig: { width: 84, height: 84, borderRadius: 42 },
  center: { alignItems: "center", justifyContent: "center" },
  langRow: {
    flexDirection: "row",
    alignItems: "center",
    height: 52,
    paddingHorizontal: 4,
  },
});
