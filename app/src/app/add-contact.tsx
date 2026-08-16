// 添加紧急联系人（模态页，API.md §3 POST /users/me/emergency-contacts）
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet } from 'react-native';

import { contactsApi } from '@/api/contacts';
import { toUserMessage } from '@/api/error-messages';
import { FormError, FormInput, PrimaryButton } from '@/components/form';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';

export default function AddContactScreen() {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [relation, setRelation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (!name.trim() || !phone.trim()) {
      setError('姓名和手机号必填');
      return;
    }
    setBusy(true);
    try {
      await contactsApi.create({
        name: name.trim(),
        phone: phone.trim(),
        ...(relation.trim() && { relation: relation.trim() }),
      });
      await queryClient.invalidateQueries({ queryKey: ['contacts'] });
      router.back();
    } catch (e) {
      setError(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ThemedView style={styles.container}>
      <ThemedText type="small" themeColor="textSecondary">
        SOS 触发且未取消时，系统将短信通知该联系人并附上事故位置
      </ThemedText>
      <FormInput
        label="姓名"
        icon="person-outline"
        value={name}
        onChangeText={setName}
        maxLength={30}
        placeholder="如：张三"
      />
      <FormInput
        label="手机号"
        icon="phone-portrait-outline"
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
        maxLength={11}
        placeholder="11 位大陆手机号"
      />
      <FormInput
        label="关系（可选）"
        icon="people-outline"
        value={relation}
        onChangeText={setRelation}
        maxLength={10}
        placeholder="如：家人 / 朋友 / 教练"
      />
      <FormError message={error} />
      <PrimaryButton title="保存" onPress={submit} loading={busy} />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 12 },
});
