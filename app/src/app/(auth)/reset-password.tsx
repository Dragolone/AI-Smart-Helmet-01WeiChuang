// 找回密码页（API.md §2：sms-code purpose=reset_password → POST /auth/reset-password）
// 成功后服务端撤销该用户全部会话,所有设备需重新登录——页面提示后回登录页。
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { authApi } from '@/api/auth';
import { toUserMessage } from '@/api/error-messages';
import { FormError, FormInput, PrimaryButton } from '@/components/form';
import { showToast } from '@/components/toast';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** 与后端 SMS_CODE_RESEND_INTERVAL_SECONDS 默认一致；超前点击由服务端 429 兜底 */
const RESEND_SECONDS = 60;
const PHONE_PATTERN = /^1[3-9]\d{9}$/;

export default function ResetPasswordScreen() {
  const theme = useTheme();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  /** 重发限频用截止时间戳 + 墙钟计算剩余——递减 state 在 App 退后台时定时器
   *  被 iOS 暂停,回前台倒计时冻在原地(2026-09-10 真机实证);按墙钟算则
   *  回前台首个 tick 即校准。同 sos-active 倒计时的口径。 */
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const cooldown = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

  useEffect(() => {
    if (cooldownUntil <= now) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [cooldownUntil, now]);

  const sendCode = async () => {
    setError(null);
    if (!PHONE_PATTERN.test(phone.trim())) {
      setError('请先输入正确的 11 位手机号');
      return;
    }
    setSending(true);
    try {
      await authApi.sendSmsCode({ phone: phone.trim(), purpose: 'reset_password' });
      const t = Date.now();
      setNow(t);
      setCooldownUntil(t + RESEND_SECONDS * 1000);
    } catch (e) {
      setError(toUserMessage(e));
    } finally {
      setSending(false);
    }
  };

  const submit = async () => {
    setError(null);
    if (!/^\d{6}$/.test(code)) {
      setError('请输入 6 位短信验证码');
      return;
    }
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
      await authApi.resetPassword({ phone: phone.trim(), code, newPassword: password });
      // 成功即全端会话作废(API.md §2),回登录页用新密码登录
      showToast('密码已重置，请重新登录');
      router.back();
    } catch (e) {
      setError(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const codeButtonDisabled = sending || cooldown > 0;

  return (
    <SafeAreaView style={styles.flex}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ThemedView style={styles.container}>
          <ThemedText type="title">找回密码</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            验证手机号后设置新密码；重置成功后所有已登录设备需重新登录。
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
          <View style={styles.codeRow}>
            <View style={styles.flex}>
              <FormInput
                label="短信验证码"
                icon="chatbox-ellipses-outline"
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
                maxLength={6}
                placeholder="6 位数字"
              />
            </View>
            <Pressable
              disabled={codeButtonDisabled}
              onPress={sendCode}
              style={({ pressed }) => [
                styles.codeButton,
                {
                  borderColor: codeButtonDisabled ? theme.border : theme.brand,
                  opacity: pressed ? 0.7 : 1,
                },
              ]}>
              <ThemedText
                type="smallBold"
                style={{
                  color: codeButtonDisabled ? theme.textSecondary : theme.brand,
                }}>
                {sending
                  ? '发送中…'
                  : cooldown > 0
                    ? `${cooldown}s 后重发`
                    : '获取验证码'}
              </ThemedText>
            </Pressable>
          </View>
          <FormInput
            label="新密码"
            icon="lock-closed-outline"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="8–72 位"
          />
          <FormInput
            label="确认新密码"
            icon="lock-closed-outline"
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry
            placeholder="再输一遍"
          />

          <FormError message={error} />
          <PrimaryButton title="重置密码" onPress={submit} loading={busy} />

          <Pressable style={styles.link} onPress={() => router.back()}>
            <ThemedText type="link">返回登录</ThemedText>
          </Pressable>
        </ThemedView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, justifyContent: 'center', padding: 24, gap: 12 },
  codeRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  codeButton: {
    borderWidth: 1,
    borderRadius: Radius.control,
    paddingHorizontal: 14,
    paddingVertical: 14,
    minWidth: 112,
    alignItems: 'center',
  },
  link: { alignSelf: 'center', marginTop: 8 },
});
