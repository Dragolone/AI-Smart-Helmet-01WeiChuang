// 注册页（API.md §2 POST /auth/register；短信验证码待 SmsProvider 接入后补）
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

export default function RegisterScreen() {
  const signIn = useAuthStore((s) => s.signIn);
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    if (password.length < 8) {
      setError('密码至少 8 位');
      return;
    }
    setBusy(true);
    try {
      const auth = await authApi.register({
        phone: phone.trim(),
        password,
        ...(nickname.trim() && { nickname: nickname.trim() }),
      });
      await signIn(auth); // 注册即登录（后端直接发 token）
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
          <ThemedText type="title">注册</ThemedText>

          <FormInput
            label="手机号"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            maxLength={11}
            placeholder="11 位大陆手机号"
          />
          <FormInput
            label="密码"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="8–72 位"
          />
          <FormInput
            label="确认密码"
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry
            placeholder="再输一遍"
          />
          <FormInput
            label="昵称（可选）"
            value={nickname}
            onChangeText={setNickname}
            maxLength={30}
            placeholder="怎么称呼你"
          />

          <FormError message={error} />
          <PrimaryButton title="注册并登录" onPress={submit} loading={busy} />

          <Link href="/login" style={styles.link}>
            <ThemedText type="link">已有账号？登录</ThemedText>
          </Link>
        </ThemedView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, justifyContent: 'center', padding: 24, gap: 12 },
  link: { alignSelf: 'center', marginTop: 8 },
});
