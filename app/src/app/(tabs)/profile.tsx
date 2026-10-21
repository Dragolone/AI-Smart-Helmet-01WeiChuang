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
import { firstActiveSos } from "@/services/active-sos";
import { drainRelayQueue } from "@/services/ble-relay-uplink";
import { sosActiveHref } from "@/services/sos-routes";
import { devLog } from "@/services/dev-log";
import { showNotice } from "@/services/notice";
import { profilePatch } from "@/services/profile-patch";
import {
  avatarInitial,
  cleanNickname,
  personNameOf,
} from "@/services/user-name";

export { RouteErrorBoundary as ErrorBoundary } from "@/components/route-error-boundary";

/** 退出前最多花这么久把积压的头盔事件送出去（O21） */
const SIGN_OUT_UPLOAD_MS = 5_000;

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
    setNickDraft(cleanNickname(user?.nickname));
    setAvatarDraft(user?.avatarUrl ?? null);
    // 上次画勾还没画完就关了弹层（点遮罩 / 返回键）：按钮卸掉，onSuccessShown 不会再来，这里复位，
    // 否则再打开时按钮直接是「已保存」、点不了，还会自己把弹层关掉
    setSaved(false);
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
      // 原生层的报错是给开发看的英文（权限、解码失败），不直接给用户看；原文留在日志里
      devLog("profile", "选择头像失败", e);
      showNotice(
        translate("profile.pickFailed"),
        translate("profile.pickFailedBody"),
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

  // 退出前先尽力把手机里还没传上去的头盔事件送完：退出后它们要等这个账号下次在这台手机上登录才补传，
  // 换个账号登录不会替它传——断网时摔的那一下就一直卡在手机里（负责人 10-21 定，O21）
  const [signingOut, setSigningOut] = useState(false);
  const signOutAfterUpload = async () => {
    setSigningOut(true);
    try {
      const left = await drainRelayQueue(SIGN_OUT_UPLOAD_MS);
      // 有一单在倒计时（刚补传上去的那条摔倒建出的单，或本来就在倒数的）：走了这台手机就取消不了，
      // 到点照样通知紧急联系人——先说清楚，让他去处理或确认再走（10-21 第二轮审查）。查不了（断网）不拦：
      // 退出本身不需要网，补传那一步已经单独提醒过
      const active = await firstActiveSos(queryClient).catch(() => null);
      if (active) {
        Alert.alert(
          translate("profile.signOutActiveSosTitle"),
          translate("profile.signOutActiveSosBody"),
          [
            { text: translate("common.cancel"), style: "cancel" },
            {
              text: translate("profile.signOutActiveSosOpen"),
              onPress: () =>
                router.navigate(sosActiveHref(active.sosId, active.deviceId)),
            },
            {
              text: translate("profile.signOutAnyway"),
              style: "destructive",
              onPress: () => void signOut(),
            },
          ],
        );
        return;
      }
      if (left.total === 0) {
        await signOut();
        return;
      }
      Alert.alert(
        translate("profile.signOutPendingTitle", { n: left.total }),
        left.sos > 0
          ? translate("profile.signOutPendingBodySos", { n: left.sos })
          : translate("profile.signOutPendingBody"),
        [
          { text: translate("common.cancel"), style: "cancel" },
          {
            text: translate("profile.signOutAnyway"),
            style: "destructive",
            onPress: () => void signOut(),
          },
        ],
      );
    } finally {
      setSigningOut(false);
    }
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
          onPress: () => void signOutAfterUpload(),
        },
      ],
    );
  };

  const initial = avatarInitial(personNameOf(user, "?"));
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
                  {cleanNickname(user?.nickname) || t("profile.setNickname")}
                </ThemedText>
                {/* 手机号和设备数分两段：放不下时设备数整段换到下一行，不在「2 台设 / 备」中间断开（10-19 华为 1.3 倍字体实测） */}
                <View style={styles.accountMeta}>
                  <ThemedText
                    type="small"
                    themeColor="textSecondary"
                    style={{ fontSize: 13 }}
                  >
                    {`${user?.phone ?? "—"} · `}
                  </ThemedText>
                  <ThemedText
                    type="small"
                    themeColor="textSecondary"
                    style={{ fontSize: 13 }}
                  >
                    {t("profile.devicesCount", { n: deviceCount })}
                  </ThemedText>
                </View>
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
              // 没拿到列表时写一横：写「0 人」会让人以为联系人被清掉了，回头又重复添加
              value={
                contacts.data
                  ? t("profile.contactsValue", { n: contacts.data.length })
                  : "—"
              }
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

          <Tappable
            onPress={signingOut ? undefined : confirmSignOut}
            style={styles.signOut}
          >
            <ThemedText
              type="small"
              themeColor="textSecondary"
              style={{ fontSize: 15 }}
            >
              {t(signingOut ? "profile.signOutUploading" : "profile.signOut")}
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
                    // 与注册页、服务端（UpdateMeDto ≤ 30）一致。原来这里是 20：注册时起的 21–30 字昵称预填进来，
                    // Android 的长度过滤会把显示截到 20 字，改一个字再保存就把后面几个字丢了
                    maxLength={30}
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
  accountMeta: { flexDirection: "row", flexWrap: "wrap" },
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
