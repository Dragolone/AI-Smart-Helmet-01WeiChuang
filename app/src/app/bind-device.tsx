// 绑定设备（模态页，API.md §4 POST /devices/bind；Mock 设备绑定码由 provision:device 生成）
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet } from 'react-native';

import { devicesApi } from '@/api/devices';
import { toUserMessage } from '@/api/error-messages';
import { FormError, FormInput, PrimaryButton } from '@/components/form';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';

export default function BindDeviceScreen() {
  const queryClient = useQueryClient();
  const [deviceId, setDeviceId] = useState('');
  const [bindCode, setBindCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await devicesApi.bind({
        deviceId: deviceId.trim(),
        bindCode: bindCode.trim(),
      });
      await queryClient.invalidateQueries({ queryKey: ['devices'] });
      router.back();
    } catch (e) {
      setError(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ThemedView style={styles.container}>
      <ThemedText type="small">
        设备编号与绑定码在头盔说明卡上（Mock 设备由开通命令生成）
      </ThemedText>
      <FormInput
        label="设备编号"
        icon="hardware-chip-outline"
        value={deviceId}
        onChangeText={setDeviceId}
        autoCapitalize="none"
        placeholder="如 helmet_mock_001"
      />
      <FormInput
        label="绑定码"
        icon="key-outline"
        value={bindCode}
        onChangeText={setBindCode}
        keyboardType="number-pad"
        maxLength={8}
        placeholder="8 位数字"
      />
      <FormError message={error} />
      <PrimaryButton title="绑定" onPress={submit} loading={busy} />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 12 },
});
