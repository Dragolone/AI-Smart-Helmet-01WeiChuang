// 紧急联系人（2026-09-10 从安全页拆出的独立页）：列表 + 删除 + 添加入口，上限 5（API.md §3）
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { Alert, ScrollView, Share, StyleSheet, View } from "react-native";
import type { EmergencyContact } from "@helmet/shared";

import { contactsApi } from "@/api/contacts";
import { toUserMessage } from "@/api/error-messages";
import { PrimaryButton } from "@/components/form";
import { Card } from "@/components/list";
import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { useTheme } from "@/hooks/use-theme";
import { translate, useT } from "@/i18n";
import Animated from "react-native-reanimated";

import { listEntering } from "@/components/motion";
import { EmptyState } from "@/components/empty-state";
import { showNotice } from "@/services/notice";

const MAX_CONTACTS = 5;

function ContactRow({
  contact,
  last,
  onDelete,
}: {
  contact: EmergencyContact;
  last: boolean;
  onDelete: () => void;
}) {
  const theme = useTheme();
  const t = useT();
  return (
    <View
      style={[
        styles.row,
        !last && {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.border,
        },
      ]}
    >
      <View
        style={[styles.avatar, { backgroundColor: theme.backgroundSelected }]}
      >
        <ThemedText type="smallBold" style={{ fontSize: 17 }}>
          {contact.name.slice(0, 1)}
        </ThemedText>
      </View>
      <View style={styles.body}>
        <ThemedText type="default" style={{ lineHeight: 22 }} numberOfLines={1}>
          {contact.name}
          {contact.relation ? (
            <ThemedText type="small" themeColor="textSecondary">
              {"  "}
              {contact.relation}
            </ThemedText>
          ) : null}
        </ThemedText>
        <ThemedText
          type="small"
          themeColor="textSecondary"
          style={{ fontSize: 13 }}
        >
          {contact.phone}
        </ThemedText>
      </View>
      <Tappable
        accessibilityRole="button"
        accessibilityLabel={t("contacts.tell")}
        onPress={() =>
          void Share.share({
            message: t("contacts.tellMessage", { name: contact.name }),
          }).catch(() => undefined)
        }
        hitSlop={8}
        style={styles.trash}
      >
        <Ionicons name="share-outline" size={20} color={theme.textSecondary} />
      </Tappable>
      <Tappable
        accessibilityRole="button"
        accessibilityLabel={t("common.delete")}
        onPress={onDelete}
        hitSlop={8}
        style={styles.trash}
      >
        <Ionicons name="trash-outline" size={20} color={theme.textSecondary} />
      </Tappable>
    </View>
  );
}

export default function ContactsScreen() {
  const t = useT();
  const queryClient = useQueryClient();
  const contacts = useQuery({
    queryKey: ["contacts"],
    queryFn: contactsApi.list,
  });
  const list = contacts.data ?? [];

  const remove = (c: EmergencyContact) => {
    Alert.alert(
      translate("contacts.deleteTitle"),
      translate("contacts.deleteBody", { name: c.name }),
      [
        { text: translate("common.cancel"), style: "cancel" },
        {
          text: translate("common.delete"),
          style: "destructive",
          onPress: () =>
            contactsApi
              .remove(c.id)
              .then(() =>
                queryClient.invalidateQueries({ queryKey: ["contacts"] }),
              )
              .catch((e) =>
                showNotice(translate("common.failed"), toUserMessage(e)),
              ),
        },
      ],
    );
  };

  return (
    <ThemedView style={styles.flex}>
      <ScrollView contentContainerStyle={styles.container}>
        <ThemedText type="small" themeColor="textSecondary" style={styles.lead}>
          {t("contacts.lead", { max: MAX_CONTACTS })}
        </ThemedText>
        {contacts.isError && (
          <ThemedText type="small" themeColor="danger">
            {toUserMessage(contacts.error)}
          </ThemedText>
        )}
        {list.length > 0 ? (
          <Card>
            {list.map((c, i) => (
              <Animated.View key={c.id} entering={listEntering(i)}>
                <ContactRow
                  contact={c}
                  last={i === list.length - 1}
                  onDelete={() => remove(c)}
                />
              </Animated.View>
            ))}
          </Card>
        ) : (
          !contacts.isLoading && (
            // 空态只做引导：底部常驻的「添加联系人」才是唯一入口，这里再放一个按钮会出现两个添加
            <EmptyState
              icon="people-outline"
              title={t("empty.contactsTitle")}
              body={t("empty.contactsBody")}
            />
          )
        )}
      </ScrollView>
      <View style={styles.bottom}>
        <PrimaryButton
          title={t("contacts.add")}
          icon="add"
          disabled={list.length >= MAX_CONTACTS}
          onPress={() => router.navigate("/add-contact")}
        />
        {list.length >= MAX_CONTACTS && (
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.center}
          >
            {t("contacts.full", { max: MAX_CONTACTS })}
          </ThemedText>
        )}
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: 20, gap: 14 },
  lead: { fontSize: 13, lineHeight: 18, paddingHorizontal: 4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  body: { flex: 1, minWidth: 0, gap: 2 },
  trash: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    marginRight: -12,
  },
  empty: { alignItems: "center", paddingVertical: 40 },
  bottom: { paddingHorizontal: 20, paddingTop: 6, paddingBottom: 24, gap: 8 },
  center: { textAlign: "center" },
});
