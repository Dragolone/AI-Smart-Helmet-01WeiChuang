// 添加紧急联系人（模态页，API.md §3 POST /users/me/emergency-contacts）
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet } from "react-native";

import { contactsApi } from "@/api/contacts";
import { toUserMessage } from "@/api/error-messages";
import { FormError, FormInput, PrimaryButton } from "@/components/form";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { useT } from "@/i18n";

export default function AddContactScreen() {
  const queryClient = useQueryClient();
  const t = useT();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [relation, setRelation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (!name.trim() || !phone.trim()) {
      setError(t("contacts.required"));
      return;
    }
    setBusy(true);
    try {
      await contactsApi.create({
        name: name.trim(),
        phone: phone.trim(),
        ...(relation.trim() && { relation: relation.trim() }),
      });
      await queryClient.invalidateQueries({ queryKey: ["contacts"] });
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
        {t("contacts.addLead")}
      </ThemedText>
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
        maxLength={11}
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
      <FormError message={error} />
      <PrimaryButton title={t("common.save")} onPress={submit} loading={busy} />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 12 },
});
