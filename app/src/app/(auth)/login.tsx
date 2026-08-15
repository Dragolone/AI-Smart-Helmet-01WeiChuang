// 登录页（API.md §2 POST /auth/login）
import { Link } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';
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

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const auth = await authApi.login({ phone: phone.trim(), password });
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
          <ThemedText type="small">登录后管理你的头盔与骑行安全</ThemedText>

          <FormInput
            label="手机号"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            maxLength={11}
            placeholder="11 位大陆手机号"
            autoComplete="tel"
          />
          <FormInput
            label="密码"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="8 位以上"
            autoComplete="password"
          />

          <FormError message={error} />
          <PrimaryButton title="登录" onPress={submit} loading={busy} />

          <Link href="/register" style={styles.link}>
            <ThemedText type="link">没有账号？注册</ThemedText>
          </Link>
        </ThemedView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, justifyContent: 'center', padding: 24, gap: 14 },
  link: { alignSelf: 'center', marginTop: 8 },
});
