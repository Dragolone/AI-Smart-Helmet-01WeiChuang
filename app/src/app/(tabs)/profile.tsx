// 我的（底部标签）：账号信息 + 昵称修改（PATCH /users/me）+ 退出登录
import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { authApi } from '@/api/auth';
import { toUserMessage } from '@/api/error-messages';
import { FormInput, PrimaryButton } from '@/components/form';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuthStore } from '@/stores/auth-store';

export default function ProfileScreen() {
  const theme = useTheme();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const signOut = useAuthStore((s) => s.signOut);
  const [nickname, setNickname] = useState(user?.nickname ?? '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const updated = await authApi.updateMe({ nickname: nickname.trim() });
      await setUser(updated);
      Alert.alert('已保存');
    } catch (e) {
      Alert.alert('保存失败', toUserMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.flex}>
      <ThemedView style={styles.container}>
        <ThemedText type="title" style={styles.pageTitle}>
          我的
        </ThemedText>

        <View
          style={[styles.userCard, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
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
          <Ionicons name="shield-checkmark-outline" size={22} color={theme.brand} />
        </View>

        <FormInput
          label="昵称"
          icon="person-outline"
          value={nickname}
          onChangeText={setNickname}
          maxLength={30}
          placeholder="怎么称呼你"
        />
        <PrimaryButton title="保存昵称" onPress={save} loading={saving} />

        <View style={styles.footer}>
          <PrimaryButton title="退出登录" onPress={() => void signOut()} danger />
        </View>
      </ThemedView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, padding: 20, gap: 14 },
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
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  userBody: { flex: 1, gap: 2 },
  footer: { marginTop: 'auto', paddingBottom: 90 },
});
