// 添加紧急联系人（模态页，API.md §3 POST /users/me/emergency-contacts）
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet } from "react-native";
import type { EmergencyContact } from "@helmet/shared";

import { contactsApi } from "@/api/contacts";
import { isSessionEnded, toUserMessage } from "@/api/error-messages";
import { FormError, FormInput, PrimaryButton } from "@/components/form";
import { KeyboardAvoid } from "@/components/keyboard-avoid";
import { ThemedView } from "@/components/themed-view";
import { useFormErrors } from "@/hooks/use-form-errors";
import {
  PHONE_INPUT_MAX,
  isValidPhone,
  normalizePhone,
} from "@/hooks/use-sms-code";
import { useT } from "@/i18n";
import { contactPhoneProblem } from "@/services/contact-phone";
import { cleanNickname } from "@/services/user-name";
import { useAuthStore } from "@/stores/auth-store";

export { RouteErrorBoundary as ErrorBoundary } from "@/components/route-error-boundary";

export default function AddContactScreen() {
  const queryClient = useQueryClient();
  const t = useT();
  const selfPhone = useAuthStore((s) => s.user?.phone);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [relation, setRelation] = useState("");
  const [busy, setBusy] = useState(false);
  // 保存成功：按钮先画勾（收成短药丸），画完再回列表
  const [done, setDone] = useState(false);

  // 名字 / 关系提交前和显示时同一套整理：只含零宽字符、换行的名字原来照提交，列表里是一片空白
  const cleanName = cleanNickname(name);
  const cleanRelation = cleanNickname(relation);
  const cleanPhone = normalizePhone(phone);
  // 服务端不查重复、不拦本人号码：重复的号码求救时收两条短信还占名额；本人号码等于没人收到
  const phoneProblem = () =>
    contactPhoneProblem(
      cleanPhone,
      queryClient.getQueryData<EmergencyContact[]>(["contacts"]) ?? [],
      selfPhone,
    );
  const form = useFormErrors([name, phone, relation], () => {
    if (!cleanName || !phone.trim())
      return { key: "required", message: t("contacts.required") };
    // 先在本地规整、校验：以前原样提交，带空格的正确号码也被后端拒，只回一句「输入格式不正确」（2026-10-15 边界测试）
    if (!isValidPhone(cleanPhone))
      return { key: "phone", message: t("contacts.invalidPhone") };
    if (phoneProblem() === "duplicate")
      return { key: "duplicate", message: t("contacts.duplicatePhone") };
    return null;
  });

  const submit = async () => {
    if (!form.check()) return;
    const problem = phoneProblem();
    const contact = {
      name: cleanName,
      phone: cleanPhone,
      ...(cleanRelation && { relation: cleanRelation }),
    };
    if (problem === "self") {
      Alert.alert(t("contacts.selfPhoneTitle"), t("contacts.selfPhoneBody"), [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("contacts.selfPhoneConfirm"),
          onPress: () => void save(contact),
        },
      ]);
      return;
    }
    await save(contact);
  };

  const save = async (contact: {
    name: string;
    phone: string;
    relation?: string;
  }) => {
    setBusy(true);
    try {
      await contactsApi.create(contact);
      await queryClient.invalidateQueries({ queryKey: ["contacts"] });
      setDone(true);
    } catch (e) {
      // 会话已失效：正被送回登录页，登录页自有说明
      if (isSessionEnded(e)) return;
      form.fail(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // 和别的表单页一样让开键盘、内容可滚（10-21 夜测）：手机竖屏时保存按钮在键盘上方，但横着拿的展开折叠屏 / 平板、
  // 小屏手机和大字号下会被键盘盖住，原来这页不能滚、按钮够不着；键盘开着时点保存也要一次就生效
  return (
    <ThemedView style={styles.flex}>
      <KeyboardAvoid>
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <FormInput
            label={t("contacts.name")}
            icon="person-outline"
            value={name}
            onChangeText={setName}
            maxLength={30}
            placeholder={t("contacts.namePlaceholder")}
          />
          <FormInput
            label={t("contacts.phone")}
            icon="phone-portrait-outline"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            // 留出空格 / 横线 / +86 的位置（「+86 138 0000 0000」17 位），提交前再规整成 11 位
            maxLength={PHONE_INPUT_MAX}
            placeholder={t("contacts.phonePlaceholder")}
          />
          <FormInput
            label={t("contacts.relation")}
            icon="people-outline"
            value={relation}
            onChangeText={setRelation}
            maxLength={10}
            placeholder={t("contacts.relationPlaceholder")}
          />
          <FormError message={form.pageError} />
          <PrimaryButton
            title={t("common.save")}
            onPress={submit}
            loading={busy}
            success={done}
            onSuccessShown={() => router.back()}
          />
        </ScrollView>
      </KeyboardAvoid>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: 20, gap: 12 },
});
