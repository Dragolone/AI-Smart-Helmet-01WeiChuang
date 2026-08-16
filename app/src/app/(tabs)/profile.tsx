// 我的（底部标签）：分组设置列表（账号 / 设备 / 通用），参考定稿套图的分区卡片风格。
// 未落地能力（消息通知/多语言/外观切换）以「即将推出」占位；剪贴板类需求用系统分享面板
// 实现（面板自带"拷贝"，避免为 expo-clipboard 新增原生依赖迫使双端重建 dev client）。
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { authApi } from '@/api/auth';
import { toUserMessage } from '@/api/error-messages';
import { FormInput, PrimaryButton } from '@/components/form';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuthStore } from '@/stores/auth-store';

/** 图标圆片的色板（参考图的多彩浅底图标；深色主题用低饱和半透明底） */
const TINTS = {
  purple: { bg: 'rgba(142, 122, 255, 0.16)', fg: '#A99BFF' },
  green: { bg: 'rgba(74, 222, 128, 0.14)', fg: '#4ADE80' },
  orange: { bg: 'rgba(245, 184, 74, 0.15)', fg: '#F5B84A' },
  blue: { bg: 'rgba(96, 165, 250, 0.15)', fg: '#60A5FA' },
  red: { bg: 'rgba(242, 109, 95, 0.15)', fg: '#F26D5F' },
  neutral: { bg: 'rgba(255, 255, 255, 0.08)', fg: '#9BA1AA' },
} as const;

function Row({
  icon,
  tint,
  title,
  subtitle,
  right,
  onPress,
  last = false,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  tint: keyof typeof TINTS;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  last?: boolean;
}) {
  const theme = useTheme();
  const t = TINTS[tint];
  const body = (
    <>
      <View style={[styles.rowIcon, { backgroundColor: t.bg }]}>
        <Ionicons name={icon} size={19} color={t.fg} />
      </View>
      <View style={styles.rowBody}>
        <ThemedText type="smallBold" style={styles.rowTitle}>
          {title}
        </ThemedText>
        {subtitle && (
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
            {subtitle}
          </ThemedText>
        )}
      </View>
      {right ?? (
        onPress ? (
          <Ionicons name="chevron-forward" size={16} color={theme.textSecondary} />
        ) : null
      )}
    </>
  );
  return onPress ? (
    <Pressable
      style={({ pressed }) => [
        styles.row,
        !last && [styles.rowDivider, { borderBottomColor: theme.border }],
        pressed && { backgroundColor: theme.backgroundSelected },
      ]}
      onPress={onPress}>
      {body}
    </Pressable>
  ) : (
    <View
      style={[styles.row, !last && [styles.rowDivider, { borderBottomColor: theme.border }]]}>
      {body}
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View style={styles.section}>
      <ThemedText type="label" themeColor="textSecondary" style={styles.sectionTitle}>
        {title}
      </ThemedText>
      <View
        style={[
          styles.sectionCard,
          { backgroundColor: theme.backgroundElement, borderColor: theme.border },
        ]}>
        {children}
      </View>
    </View>
  );
}

function SoonBadge() {
  const theme = useTheme();
  return (
    <View style={[styles.soon, { backgroundColor: theme.backgroundSelected }]}>
      <ThemedText type="label" themeColor="textSecondary">
        即将推出
      </ThemedText>
    </View>
  );
}

export default function ProfileScreen() {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const signOut = useAuthStore((s) => s.signOut);

  const [nickOpen, setNickOpen] = useState(false);
  const [nickDraft, setNickDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const openNick = () => {
    setNickDraft(user?.nickname ?? '');
    setNickOpen(true);
  };

  const saveNick = async () => {
    setSaving(true);
    try {
      const updated = await authApi.updateMe({ nickname: nickDraft.trim() });
      await setUser(updated);
      setNickOpen(false);
    } catch (e) {
      Alert.alert('保存失败', toUserMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const clearCache = () => {
    Alert.alert('清除本地缓存', '清理本地数据与图片缓存，不影响云端数据。', [
      { text: '取消', style: 'cancel' },
      {
        text: '清除',
        onPress: () => {
          queryClient.clear();
          void Image.clearDiskCache();
          void Image.clearMemoryCache();
          Alert.alert('已清除');
        },
      },
    ]);
  };

  const appVersion = Constants.expoConfig?.version ?? '—';

  const about = () => {
    Alert.alert(
      'AI 智能头盔',
      `版本 ${appVersion}\n\nAI 赋能，智能守护每一次骑行安全。\n深圳零一唯创科技有限公司`,
    );
  };

  const deviceInfoText = `${Platform.OS} / ${Device.osName ?? Platform.OS} ${Device.osVersion ?? ''} / ${Device.modelName ?? '未知机型'} / App v${appVersion}`;

  const shareDeviceInfo = () => {
    // 系统分享面板自带"拷贝"动作,兼顾复制与转发两种用途
    void Share.share({ message: deviceInfoText });
  };

  const confirmSignOut = () => {
    Alert.alert('退出登录', '清理登录态并返回登录页。', [
      { text: '取消', style: 'cancel' },
      { text: '退出', style: 'destructive', onPress: () => void signOut() },
    ]);
  };

  return (
    <SafeAreaView style={styles.flex}>
      <ThemedView style={styles.flex}>
        <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
          <ThemedText type="title" style={styles.pageTitle}>
            我的
          </ThemedText>

          {/* 用户卡（点击改昵称） */}
          <Pressable onPress={openNick}>
            {({ pressed }) => (
              <View
                style={[
                  styles.userCard,
                  {
                    backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement,
                    borderColor: theme.border,
                  },
                ]}>
                <View style={[styles.avatar, { backgroundColor: theme.backgroundSelected }]}>
                  <ThemedText type="display" style={{ fontSize: 24, lineHeight: 30 }}>
                    {(user?.nickname ?? user?.phone ?? '?').slice(0, 1)}
                  </ThemedText>
                </View>
                <View style={styles.userBody}>
                  <ThemedText type="smallBold" style={{ fontSize: 17 }}>
                    {user?.nickname ?? '未设置昵称'}
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    {user?.phone}
                  </ThemedText>
                </View>
                <Ionicons name="pencil-outline" size={18} color={theme.textSecondary} />
              </View>
            )}
          </Pressable>

          <Section title="账号">
            <Row
              icon="person-outline"
              tint="purple"
              title="个人资料"
              subtitle="修改昵称等信息"
              onPress={openNick}
            />
            <Row
              icon="id-card-outline"
              tint="purple"
              title="账号信息"
              subtitle="当前登录账号"
              right={
                <ThemedText type="small" themeColor="textSecondary">
                  {user?.phone ?? '—'}
                </ThemedText>
              }
              last
            />
          </Section>

          <Section title="设备">
            <Row
              icon="albums-outline"
              tint="blue"
              title="我的头盔"
              subtitle="查看头盔列表与设备状态"
              onPress={() => router.push('/')}
            />
            <Row
              icon="add-circle-outline"
              tint="green"
              title="绑定新头盔"
              subtitle="输入设备编号与绑定码"
              onPress={() => router.push('/bind-device')}
            />
            <Row
              icon="call-outline"
              tint="orange"
              title="紧急联系人"
              subtitle="SOS 通知对象管理"
              onPress={() => router.push('/safety')}
              last
            />
          </Section>

          <Section title="通用">
            <Row
              icon="notifications-outline"
              tint="orange"
              title="消息通知"
              subtitle="提醒偏好与通知管理"
              right={<SoonBadge />}
            />
            <Row
              icon="language-outline"
              tint="blue"
              title="语言 / Language"
              subtitle="中文 · English"
              right={<SoonBadge />}
            />
            <Row
              icon="moon-outline"
              tint="purple"
              title="外观模式"
              subtitle="深色 · 浅色"
              right={<SoonBadge />}
            />
            <Row
              icon="trash-outline"
              tint="neutral"
              title="清除本地缓存"
              subtitle="清理本地存储，不影响云端数据"
              onPress={clearCache}
            />
            <Row
              icon="information-circle-outline"
              tint="blue"
              title="关于我们"
              subtitle={`产品信息与版本说明 · v${appVersion}`}
              onPress={about}
            />
            <Row
              icon="phone-portrait-outline"
              tint="neutral"
              title="设备信息"
              subtitle={deviceInfoText}
              right={
                <ThemedText type="smallBold" themeColor="brand">
                  分享
                </ThemedText>
              }
              onPress={shareDeviceInfo}
              last
            />
          </Section>

          {/* 退出登录（独立红色卡） */}
          <Pressable onPress={confirmSignOut}>
            {({ pressed }) => (
              <View
                style={[
                  styles.sectionCard,
                  styles.signOutCard,
                  {
                    backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement,
                    borderColor: theme.border,
                  },
                ]}>
                <View style={[styles.rowIcon, { backgroundColor: TINTS.red.bg }]}>
                  <Ionicons name="log-out-outline" size={19} color={theme.danger} />
                </View>
                <View style={styles.rowBody}>
                  <ThemedText type="smallBold" style={{ color: theme.danger, fontSize: 15 }}>
                    退出登录
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    清理登录态并返回登录页
                  </ThemedText>
                </View>
              </View>
            )}
          </Pressable>
        </ScrollView>

        {/* 昵称修改弹层 */}
        <Modal visible={nickOpen} transparent animationType="fade" onRequestClose={() => setNickOpen(false)}>
          <Pressable style={styles.modalMask} onPress={() => setNickOpen(false)}>
            <Pressable
              style={[
                styles.modalCard,
                { backgroundColor: theme.backgroundElement, borderColor: theme.border },
              ]}
              onPress={() => undefined}>
              <ThemedText type="subtitle">修改昵称</ThemedText>
              <FormInput
                label="昵称"
                value={nickDraft}
                onChangeText={setNickDraft}
                placeholder="1-20 字符"
                maxLength={20}
                autoFocus
              />
              <PrimaryButton title="保存" onPress={() => void saveNick()} loading={saving} />
            </Pressable>
          </Pressable>
        </Modal>
      </ThemedView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: 20, gap: 16, paddingBottom: 28 },
  pageTitle: { fontSize: 32, lineHeight: 38 },
  userCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderRadius: Radius.card,
    borderWidth: 1,
    padding: 16,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  userBody: { flex: 1, gap: 2 },
  section: { gap: 8 },
  sectionTitle: { marginLeft: 4 },
  sectionCard: {
    borderRadius: Radius.card,
    borderWidth: 1,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth },
  rowIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: { flex: 1, gap: 2, marginRight: 8 },
  rowTitle: { fontSize: 15 },
  soon: {
    borderRadius: Radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  signOutCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
  },
  modalMask: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    padding: 28,
  },
  modalCard: {
    borderRadius: Radius.card,
    borderWidth: 1,
    padding: 18,
    gap: 14,
  },
});
