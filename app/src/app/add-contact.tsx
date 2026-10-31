// 添加 / 编辑紧急联系人（模态页，API.md §3 POST / PATCH /users/me/emergency-contacts）
// 带 ?contactId= 进来就是编辑：从列表缓存里预填，保存走 PATCH（输错号码不用删了重加——那段时间这位联系人是不在的）。
import { useQueryClient } from "@tanstack/react-query";
import { Stack, router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet } from "react-native";
import type {
  EmergencyContact,
  UpdateEmergencyContactRequest,
} from "@helmet/shared";

import { contactsApi } from "@/api/contacts";
import { isSessionEnded, toUserMessage } from "@/api/error-messages";
import { FormError, FormInput, PrimaryButton } from "@/components/form";
import { KeyboardAvoid } from "@/components/keyboard-avoid";
import { ThemedView } from "@/components/themed-view";
import { useEnterChain } from "@/hooks/use-enter-chain";
import { useFormErrors } from "@/hooks/use-form-errors";
import { useRouteParams } from "@/hooks/use-route-params";
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
  const { contactId } = useRouteParams<{ contactId?: string }>();
  // 编辑的是哪一位：进页面那一刻从列表缓存里取一次并固定下来（保存后列表重拉，缓存里的会变，比对的基准不能跟着变）。
  // 缓存里没有这个 id（链接是旧的 / 乱写的）：不显示一张空表单让人以为是在添加，直接回列表
  const [original] = useState<EmergencyContact | null>(() => {
    if (contactId === undefined) return null;
    const cached = queryClient.getQueryData<EmergencyContact[]>(["contacts"]);
    return (
      (Array.isArray(cached) ? cached.find((c) => c.id === contactId) : null) ??
      null
    );
  });
  const gone = contactId !== undefined && original === null;
  useEffect(() => {
    if (!gone) return;
    if (router.canGoBack()) router.back();
    else router.navigate("/contacts");
  }, [gone]);
  const [name, setName] = useState(original?.name ?? "");
  const [phone, setPhone] = useState(original?.phone ?? "");
  const [relation, setRelation] = useState(cleanNickname(original?.relation));
  const [busy, setBusy] = useState(false);
  // 保存成功：按钮先画勾（收成短药丸），画完再回列表
  const [done, setDone] = useState(false);

  // 名字 / 关系提交前和显示时同一套整理：只含零宽字符、换行的名字原来照提交，列表里是一片空白
  const cleanName = cleanNickname(name);
  const cleanRelation = cleanNickname(relation);
  const cleanPhone = normalizePhone(phone);
  // 重复的号码求救时收两条短信还占名额；本人号码等于没人收到
  const phoneProblem = () => {
    // 编辑时号码没动就不查：留着的旧数据（早期没有这两条拦截时存下的）只改名字也要能保存
    if (original && cleanPhone === normalizePhone(original.phone)) return null;
    const cached = queryClient.getQueryData<EmergencyContact[]>(["contacts"]);
    return contactPhoneProblem(
      cleanPhone,
      // 编辑时不拿自己这条比：改回原号不算重复
      (Array.isArray(cached) ? cached : []).filter(
        (c) => c.id !== original?.id,
      ),
      selfPhone,
    );
  };
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
    // 回车键也能走到这里，按钮的加载 / 成功态拦不住它
    if (busy || done) return;
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

  /** 编辑：只发改过的项。关系删空要发空串才清得掉（后端只在没传时跳过） */
  const changes = (): UpdateEmergencyContactRequest => ({
    ...(cleanName !== original?.name && { name: cleanName }),
    ...(cleanPhone !== normalizePhone(original?.phone ?? "") && {
      phone: cleanPhone,
    }),
    ...(cleanRelation !== cleanNickname(original?.relation) && {
      relation: cleanRelation,
    }),
  });

  const save = async (contact: {
    name: string;
    phone: string;
    relation?: string;
  }) => {
    setBusy(true);
    try {
      // 编辑时什么都没改：不发请求，照样画勾返回
      const patch = original ? changes() : null;
      const sends = !patch || Object.keys(patch).length > 0;
      if (!original) await contactsApi.create(contact);
      else if (sends) await contactsApi.update(original.id, patch!);
      if (sends)
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

  const enter = useEnterChain(3, () => void submit(), "done");

  // 和别的表单页一样让开键盘、内容可滚（10-21 夜测）：手机竖屏时保存按钮在键盘上方，但横着拿的展开折叠屏 / 平板、
  // 小屏手机和大字号下会被键盘盖住，原来这页不能滚、按钮够不着；键盘开着时点保存也要一次就生效
  if (gone) return null;

  return (
    <ThemedView style={styles.flex}>
      {original && <Stack.Screen options={{ title: t("nav.editContact") }} />}
      <KeyboardAvoid>
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <FormInput
            {...enter.field(0)}
            label={t("contacts.name")}
            icon="person-outline"
            value={name}
            onChangeText={setName}
            maxLength={30}
            placeholder={t("contacts.namePlaceholder")}
          />
          <FormInput
            {...enter.field(1)}
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
            {...enter.field(2)}
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
