// 安全中心（底部标签「安全」）：进行中 SOS + 紧急联系人（上限 5）+ 事故记录
// 对齐定稿套图的联系人卡片/事件时间线布局；数据全部来自已实现后端（API.md §3/§7）
import { Ionicons } from '@expo/vector-icons';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { AccidentListItem, EmergencyContact } from '@helmet/shared';

import { contactsApi } from '@/api/contacts';
import { devicesApi } from '@/api/devices';
import { toUserMessage } from '@/api/error-messages';
import { sosApi } from '@/api/sos';
import { Badge } from '@/components/badge';
import { PrimaryButton } from '@/components/form';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, Radius } from '@/constants/theme';
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

  return (
    <SafeAreaView style={styles.flex}>
      <ThemedView style={styles.container}>
        <ScrollView
          contentContainerStyle={{ gap: 12, paddingBottom: BottomTabInset + 16 }}
          showsVerticalScrollIndicator={false}>
          <ThemedText type="title" style={styles.pageTitle}>
            安全中心
          </ThemedText>

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

          <View style={styles.sectionHeader}>
            <ThemedText type="subtitle" style={styles.sectionTitle}>
              紧急联系人
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {contactList.length}/{MAX_CONTACTS}
            </ThemedText>
          </View>
          <ThemedText type="small" themeColor="textSecondary">
            SOS 触发且未取消时，将短信通知以下联系人
          </ThemedText>
          {contacts.isError && (
            <ThemedText type="small">{toUserMessage(contacts.error)}</ThemedText>
          )}
          {contactList.map((c) => (
            <ContactRow key={c.id} contact={c} onDelete={() => removeContact(c)} />
          ))}
          {contactList.length === 0 && !contacts.isLoading && (
            <ThemedText type="small" themeColor="textSecondary">
              还没有紧急联系人——强烈建议至少添加一位
            </ThemedText>
          )}
          {contactList.length < MAX_CONTACTS && (
            <PrimaryButton title="＋ 添加联系人" onPress={() => router.push('/add-contact')} />
          )}

          <View style={[styles.sectionHeader, { marginTop: 12 }]}>
            <ThemedText type="subtitle" style={styles.sectionTitle}>
              事故记录
            </ThemedText>
          </View>
          {accidentItems.map((item) => (
            <AccidentRow key={item.sosId} item={item} />
          ))}
          {accidentItems.length === 0 && (
            <ThemedText type="small" themeColor="textSecondary">
              暂无记录——愿一直如此 🙏
            </ThemedText>
          )}
        </ScrollView>
      </ThemedView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
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
});
