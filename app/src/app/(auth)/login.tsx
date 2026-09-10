// 登录页（API.md §2 POST /auth/login）
import { Link } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { authApi } from '@/api/auth';
import { toUserMessage } from '@/api/error-messages';
import { FormError, FormInput, PrimaryButton } from '@/components/form';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useAuthStore } from '@/stores/auth-store';

export default function LoginScreen() {
  const signIn = useAuthStore((s) => s.signIn);
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 记住上次登录的手机号(只存号码不存密码);读取失败静默忽略
  useEffect(() => {
    SecureStore.getItemAsync('last_login_phone')
      .then((v) => {
        if (v) setPhone((cur) => cur || v);
      })
      .catch(() => {});
  }, []);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const auth = await authApi.login({ phone: phone.trim(), password });
      SecureStore.setItemAsync('last_login_phone', phone.trim()).catch(() => {});
      await signIn(auth); // AuthGate 检测到会话后自动跳转主页
    } catch (e) {
      setError(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.flex}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ThemedView style={styles.container}>
          <ThemedText type="title">AI 智能头盔</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            AI 赋能，智能守护每一次骑行安全
          </ThemedText>

          <FormInput
            label="手机号"
            icon="phone-portrait-outline"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            maxLength={11}
            placeholder="11 位大陆手机号"
            autoComplete="tel"
          />
          <FormInput
            label="密码"
            icon="lock-closed-outline"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="8 位以上"
            autoComplete="password"
          />

          <FormError message={error} />
          <PrimaryButton title="登录" onPress={submit} loading={busy} />

          <View style={styles.linkRow}>
            <Link href="/register">
              <ThemedText type="link">没有账号？注册</ThemedText>
            </Link>
            <Link href="/reset-password">
              <ThemedText type="link" themeColor="textSecondary">
                忘记密码
              </ThemedText>
            </Link>
          </View>
        </ThemedView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, justifyContent: 'center', padding: 24, gap: 14 },
  linkRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
    paddingHorizontal: 4,
  },
});
