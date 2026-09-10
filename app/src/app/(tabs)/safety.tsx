// 安全中心（底部标签「安全」）：进行中 SOS + 紧急联系人（上限 5）+ 事故记录
// 对齐定稿套图的联系人卡片/事件时间线布局；数据全部来自已实现后端（API.md §3/§7）
import { Ionicons } from '@expo/vector-icons';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { router } from 'expo-router';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
  Easing,
  FadeInDown,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import type { AccidentListItem, EmergencyContact } from '@helmet/shared';

import { contactsApi } from '@/api/contacts';
import { devicesApi } from '@/api/devices';
import { toUserMessage } from '@/api/error-messages';
import { relayApi } from '@/api/relay';
import { sosApi } from '@/api/sos';
import { Badge } from '@/components/badge';
import { PrimaryButton } from '@/components/form';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

const MAX_CONTACTS = 5; // API.md §3 定稿

function ContactRow({ contact, onDelete }: { contact: EmergencyContact; onDelete: () => void }) {
  const theme = useTheme();
  return (
    <View
      style={[styles.card, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
      <View style={[styles.avatar, { backgroundColor: theme.backgroundSelected }]}>
        <ThemedText type="smallBold" style={{ fontSize: 18 }}>
          {contact.name.slice(0, 1)}
        </ThemedText>
      </View>
      <View style={styles.contactBody}>
        <ThemedText type="smallBold" style={{ fontSize: 16 }}>
          {contact.name}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {contact.phone}
        </ThemedText>
        {contact.relation && <Badge variant="neutral" label={contact.relation} />}
      </View>
      <Pressable hitSlop={8} onPress={onDelete}>
        <Ionicons name="trash-outline" size={20} color={theme.textSecondary} />
      </Pressable>
    </View>
  );
}

function AccidentRow({ item }: { item: AccidentListItem & { _device: string } }) {
  const theme = useTheme();
  const statusBadge =
    item.status === 'pending'
      ? { variant: 'danger' as const, label: '进行中' }
      : item.status === 'notified'
        ? { variant: 'warning' as const, label: '已通知' }
        : { variant: 'neutral' as const, label: '已取消' };
  return (
    <Pressable onPress={() => router.push(`/accident/${item.sosId}`)}>
      <View
        style={[styles.card, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
        <View style={[styles.avatar, { backgroundColor: theme.dangerBg }]}>
          <Ionicons
            name={item.triggerType === 'manual_sos' ? 'hand-left-outline' : 'body-outline'}
            size={20}
            color={theme.danger}
          />
        </View>
        <View style={styles.contactBody}>
          <View style={styles.rowBetween}>
            <ThemedText type="smallBold" style={{ fontSize: 15 }}>
              {item.triggerType === 'manual_sos' ? '手动求救' : '跌倒检测'}
            </ThemedText>
            <Badge variant={statusBadge.variant} label={statusBadge.label} />
          </View>
          <ThemedText type="small" themeColor="textSecondary">
            {item._device} · {new Date(item.createdAt).toLocaleString()}
          </ThemedText>
        </View>
        <Ionicons name="chevron-forward" size={16} color={theme.textSecondary} />
      </View>
    </Pressable>
  );
}

export default function SafetyScreen() {
  const theme = useTheme();
  const queryClient = useQueryClient();

  const devices = useQuery({ queryKey: ['devices'], queryFn: devicesApi.list });
  const deviceIds = (devices.data ?? []).map((d) => d.deviceId);

  // 每台设备的进行中 SOS（WS 推送也会直写同 key 缓存）
  const activeSos = useQueries({
    queries: deviceIds.map((id) => ({
      queryKey: ['sos-active', id],
      queryFn: () => sosApi.active(id),
      refetchInterval: 30_000,
    })),
  });
  const pendingSos = activeSos
    .map((q) => q.data?.sos)
    .find((s) => s && s.status === 'pending');

  const contacts = useQuery({ queryKey: ['contacts'], queryFn: contactsApi.list });

  const accidents = useQueries({
    queries: deviceIds.map((id) => ({
      queryKey: ['accidents', id],
      queryFn: () => sosApi.accidents(id),
    })),
  });
  const accidentItems = accidents
    .flatMap((q, i) =>
      (q.data?.items ?? []).map((item) => ({ ...item, _device: deviceIds[i] })),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 20);

  const removeContact = (contact: EmergencyContact) => {
    Alert.alert('删除联系人', `SOS 时将不再通知 ${contact.name}，确定删除？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          contactsApi
            .remove(contact.id)
            .then(() => queryClient.invalidateQueries({ queryKey: ['contacts'] }))
            .catch((e) => Alert.alert('删除失败', toUserMessage(e)));
        },
      },
    ]);
  };

  const contactList = contacts.data ?? [];
  const [devOpen, setDevOpen] = useState(false);

  /** 紧急求助:长按 2 秒触发(防误触),经 app-relay 注入 manual_sos——
   *  与头盔按钮走完全相同的服务端状态机,倒计时页由 WS 推送自动弹出 */
  const sosP = useSharedValue(0);
  const sosFillStyle = useAnimatedStyle(() => ({
    width: `${sosP.get() * 100}%`,
  }));
  const sosTextStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(sosP.get(), [0, 1], [1, 1.04]) }],
  }));
  const sosTarget = (devices.data ?? []).find((d) => d.online)?.deviceId ?? deviceIds[0];
  const fireSos = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    relayApi
      .pushEvent(sosTarget, 'manual_sos', {})
      .catch((e) => Alert.alert('求救发送失败', toUserMessage(e)));
  };

  return (
    <SafeAreaView style={styles.flex}>
      <ThemedView style={styles.container}>
        <ScrollView
          contentContainerStyle={{ gap: 12, paddingBottom: 16 }}
          showsVerticalScrollIndicator={false}>
          <View style={styles.titleRow}>
            <ThemedText type="title" style={styles.pageTitle}>
              安全中心
            </ThemedText>
            {(() => {
              const online = (devices.data ?? []).filter((d) => d.online).length;
              const ok = contactList.length > 0 && online > 0;
              const color = ok ? theme.success : theme.danger;
              return (
                <View style={[styles.statusPill, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
                  <View style={[styles.statusDot, { backgroundColor: color }]} />
                  <ThemedText type="label" style={{ color }}>
                    {ok ? '防护中' : '防护未完成'}
                  </ThemedText>
                </View>
              );
            })()}
          </View>

          {pendingSos && (
            <Pressable
              onPress={() =>
                router.push(`/sos-active?sosId=${pendingSos.sosId}&deviceId=${pendingSos.deviceId}`)
              }>
              <View style={[styles.sosBanner, { backgroundColor: theme.dangerBg, borderColor: theme.danger }]}>
                <Ionicons name="warning" size={22} color={theme.danger} />
                <ThemedText type="smallBold" style={{ color: theme.danger, flex: 1 }}>
                  有一条进行中的 SOS，点击处理
                </ThemedText>
                <Ionicons name="chevron-forward" size={18} color={theme.danger} />
              </View>
            </Pressable>
          )}

          {/* 紧急求助:长按 2 秒发出 manual_sos(与头盔按钮同链路,倒计时内可取消) */}
          {sosTarget && !pendingSos && (
            <Pressable
              delayLongPress={2000}
              onPressIn={() => {
                sosP.set(withTiming(1, { duration: 2000, easing: Easing.linear }));
              }}
              onPressOut={() => {
                sosP.set(withTiming(0, { duration: 180 }));
              }}
              onLongPress={fireSos}>
              <View style={[styles.sosBtn, { borderColor: theme.danger, backgroundColor: theme.dangerBg }]}>
                <Animated.View
                  style={[styles.sosFill, { backgroundColor: theme.danger }, sosFillStyle]}
                />
                <Animated.View style={[styles.sosBtnRow, sosTextStyle]}>
                  <Ionicons name="alert-circle" size={22} color={theme.danger} />
                  <View>
                    <ThemedText type="smallBold" style={{ color: theme.danger, fontSize: 16 }}>
                      紧急求助
                    </ThemedText>
                    <ThemedText type="label" themeColor="textSecondary">
                      长按 2 秒,60 秒倒计时后通知紧急联系人
                    </ThemedText>
                  </View>
                </Animated.View>
              </View>
            </Pressable>
          )}

          <View style={styles.sectionHeader}>
            <ThemedText type="subtitle" style={styles.sectionTitle}>
              紧急联系人
            </ThemedText>
            <View style={styles.sectionHeaderRight}>
              <ThemedText type="small" themeColor="textSecondary">
                {contactList.length}/{MAX_CONTACTS}
              </ThemedText>
              {contactList.length < MAX_CONTACTS && (
                <Pressable
                  hitSlop={8}
                  onPress={() => router.push('/add-contact')}
                  style={[styles.addBtn, { backgroundColor: theme.backgroundSelected }]}>
                  <Ionicons name="add" size={18} color={theme.brand} />
                </Pressable>
              )}
            </View>
          </View>
          {contacts.isError && (
            <ThemedText type="small">{toUserMessage(contacts.error)}</ThemedText>
          )}
          {contactList.map((c) => (
            <ContactRow key={c.id} contact={c} onDelete={() => removeContact(c)} />
          ))}
          {contactList.length === 0 && !contacts.isLoading && (
            <ThemedText type="small" themeColor="textSecondary">
              点右上「+」添加,SOS 时将短信通知他们
            </ThemedText>
          )}

          <View style={[styles.sectionHeader, { marginTop: 12 }]}>
            <ThemedText type="subtitle" style={styles.sectionTitle}>
              安全记录
            </ThemedText>
          </View>
          {accidentItems.map((item) => (
            <AccidentRow key={item.sosId} item={item} />
          ))}
          {accidentItems.length === 0 && (
            <ThemedText type="small" themeColor="textSecondary">
              暂无事故记录——愿一直如此 🙏
            </ThemedText>
          )}

          {/* 次级入口:普通危险事件历史(§6),权重低于事故 */}
          <Pressable onPress={() => router.push('/events')}>
            {({ pressed }) => (
              <View style={[styles.eventsLink, { opacity: pressed ? 0.6 : 1 }]}>
                <Ionicons name="pulse-outline" size={16} color={theme.textSecondary} />
                <ThemedText type="small" themeColor="textSecondary" style={{ flex: 1 }}>
                  危险事件历史(碰撞 / 障碍物 / 摔倒)
                </ThemedText>
                <Ionicons name="chevron-forward" size={14} color={theme.textSecondary} />
              </View>
            )}
          </Pressable>

          {/* 开发测试:经 app-relay(§12.1 真实契约)替绑定设备注入事件,快速触发 SOS/危险事件
              全链路(Ingest→状态机→WS→倒计时页)。仅开发构建可见。 */}
          {__DEV__ && deviceIds[0] && (
            <View style={[styles.devBox, { borderColor: theme.border }]}>
              <Pressable onPress={() => setDevOpen((v) => !v)} style={styles.devHeader}>
                <ThemedText type="label" themeColor="textSecondary">
                  开发测试(仅 DEV 构建可见,走 app-relay 真实链路)
                </ThemedText>
                <Ionicons
                  name={devOpen ? 'chevron-up' : 'chevron-down'}
                  size={14}
                  color={theme.textSecondary}
                />
              </Pressable>
              {devOpen && (
              <View style={styles.devRow}>
                <Pressable
                  style={[styles.devBtn, { backgroundColor: theme.dangerBg }]}
                  onPress={() =>
                    relayApi
                      .pushEvent(deviceIds[0], 'possible_fall', { confidence: 0.95 })
                      .catch((e) => Alert.alert('注入失败', toUserMessage(e)))
                  }>
                  <ThemedText type="smallBold" style={{ color: theme.danger, fontSize: 13 }}>
                    模拟摔倒
                  </ThemedText>
                </Pressable>
                <Pressable
                  style={[styles.devBtn, { backgroundColor: theme.warningBg }]}
                  onPress={() =>
                    relayApi
                      .pushEvent(deviceIds[0], 'collision_risk', {
                        riskLevel: 'high',
                        direction: 'rear',
                      })
                      .catch((e) => Alert.alert('注入失败', toUserMessage(e)))
                  }>
                  <ThemedText type="smallBold" style={{ color: theme.warning, fontSize: 13 }}>
                    模拟碰撞风险
                  </ThemedText>
                </Pressable>
              </View>
              )}
            </View>
          )}
        </ScrollView>

      </ThemedView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  sectionHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  addBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sosBtn: {
    borderRadius: 18,
    borderWidth: 1,
    overflow: 'hidden',
  },
  sosFill: {
    ...StyleSheet.absoluteFill,
    opacity: 0.28,
  },
  sosBtnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  eventsLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  devHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
    borderRadius: 22,
    borderWidth: 1,
    padding: 18,
  },
  heroShieldWrap: { alignItems: 'center', justifyContent: 'center' },
  heroShield: {
    width: 68,
    height: 68,
    borderRadius: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroBody: { flex: 1, gap: 4 },
  flex: { flex: 1 },
  container: { flex: 1, paddingHorizontal: 20 },
  pageTitle: { fontSize: 32, lineHeight: 38, marginTop: 8 },
  sosBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: Radius.card,
    borderWidth: 1,
    padding: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  sectionTitle: { fontSize: 20, lineHeight: 26 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: Radius.card,
    borderWidth: 1,
    padding: 14,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contactBody: { flex: 1, gap: 4 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  bottomCta: { paddingTop: 4, paddingBottom: 10 },
  devBox: {
    marginTop: 16,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: Radius.card,
    padding: 12,
    gap: 10,
  },
  devRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  devBtn: {
    borderRadius: Radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
});
