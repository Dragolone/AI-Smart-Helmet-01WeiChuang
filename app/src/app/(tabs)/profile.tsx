// 我的（底部标签，2026-09-10 重设计；09-11 重分组）：账号卡 → 「安全」「账号与安全」「通用」「帮助与关于」四组紧凑设置行 → 底部文字「退出登录」。
// 图标统一单色描边（此前多彩方块与其他页不一致）；语言切换（简/繁/英）在这里落地。
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Constants from "expo-constants";
import { Image } from "expo-image";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, Modal, ScrollView, StyleSheet, View } from "react-native";
import ReAnimated, { FadeInDown } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";

import { authApi, maskPhone } from "@/api/auth";
import { contactsApi } from "@/api/contacts";
import { devicesApi } from "@/api/devices";
import { toUserMessage } from "@/api/error-messages";
import { FormInput, PrimaryButton } from "@/components/form";
import { Card, GroupTitle, ListRow } from "@/components/list";
import { Tappable } from "@/components/tappable";
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

export default function ProfileScreen() {
  const theme = useTheme();
  const t = useT();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
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
      Alert.alert(
        translate("profile.pickFailed"),
        e instanceof Error ? e.message : String(e),
      );
    }
  };

  const saveProfile = async () => {
    setSaving(true);
    try {
      const updated = await authApi.updateMe({
        nickname: nickDraft.trim(),
        ...(avatarDraft && avatarDraft !== user?.avatarUrl
          ? { avatarUrl: avatarDraft }
          : {}),
      });
      await setUser(updated);
      setEditOpen(false);
      showToast(translate("common.saved"));
    } catch (e) {
      Alert.alert(translate("profile.saveFailed"), toUserMessage(e));
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

  const appVersion = Constants.expoConfig?.version ?? "—";
  const about = () =>
    Alert.alert(
      translate("profile.about"),
      `${translate("profile.version", { v: appVersion })}\n\n${translate("profile.aboutBody")}`,
    );

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
              onPress={() => router.push("/contacts")}
            />
            <ListRow
              compact
              icon="medkit-outline"
              title={t("profile.accidents")}
              onPress={() => router.push("/accidents")}
            />
            <ListRow
              compact
              icon="warning-outline"
              title={t("profile.events")}
              onPress={() => router.push("/events")}
              last
            />
          </Card>

          <GroupTitle title={t("profile.groupAccount")} />
          <Card>
            <ListRow
              compact
              icon="key-outline"
              title={t("profile.changePassword")}
              onPress={() => router.push("/account/change-password")}
            />
            <ListRow
              compact
              icon="phone-portrait-outline"
              title={t("profile.changePhone")}
              value={maskPhone(user?.phone)}
              onPress={() => router.push("/account/change-phone")}
            />
            <ListRow
              compact
              icon="person-remove-outline"
              title={t("profile.deleteAccount")}
              onPress={() => router.push("/account/delete")}
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

          <GroupTitle title={t("profile.groupHelp")} />
          <Card>
            <ListRow
              compact
              icon="help-circle-outline"
              title={t("profile.help")}
              onPress={() => router.push("/help")}
            />
            <ListRow
              compact
              icon="shield-checkmark-outline"
              title={t("profile.privacy")}
              onPress={() => router.push("/legal/privacy")}
            />
            <ListRow
              compact
              icon="document-text-outline"
              title={t("profile.terms")}
              onPress={() => router.push("/legal/terms")}
            />
            <ListRow
              compact
              icon="information-circle-outline"
              title={t("profile.about")}
              value={appVersion}
              onPress={about}
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

        {/* 个人资料编辑 */}
        <Modal
          visible={editOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setEditOpen(false)}
        >
          <Tappable
            feedback={[]}
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
              onPress={() => undefined}
            >
              <ThemedText type="smallBold" style={{ fontSize: 20 }}>
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
              />
            </Tappable>
          </ReAnimated.View>
          </Tappable>
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
              onPress={() => undefined}
            >
              <ThemedText type="smallBold" style={{ fontSize: 20 }}>
                {t("profile.chooseAppearance")}
              </ThemedText>
              <View>
                {THEME_MODES.map((m, i) => (
                  <Tappable
                    key={m}
                    feedback="fill"
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
              onPress={() => undefined}
            >
              <ThemedText type="smallBold" style={{ fontSize: 20 }}>
                {t("profile.chooseLanguage")}
              </ThemedText>
              <View>
                {LOCALES.map((loc, i) => (
                  <Tappable
                    key={loc}
                    feedback="fill"
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
