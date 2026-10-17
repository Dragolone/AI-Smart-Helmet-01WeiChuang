// 紧急联系人（2026-09-10 从安全页拆出的独立页）：列表 + 删除 + 添加入口，上限 5（API.md §3）
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { Alert, ScrollView, Share, StyleSheet, View } from "react-native";
import type { EmergencyContact } from "@helmet/shared";

import { contactsApi } from "@/api/contacts";
import { isSessionEnded, toUserMessage } from "@/api/error-messages";
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
import { showFailure } from "@/services/notice";
import {
  avatarInitial,
  cleanNickname,
  contactNameOf,
} from "@/services/user-name";

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
  const relation = cleanNickname(contact.relation);
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
          {avatarInitial(contact.name)}
        </ThemedText>
      </View>
      <View style={styles.body}>
        <ThemedText type="default" style={{ lineHeight: 22 }} numberOfLines={1}>
          {/* 名字整理后为空（只含零宽字符等）就写号码，别留一片空白 */}
          {contactNameOf(contact)}
          {relation ? (
            <ThemedText type="small" themeColor="textSecondary">
              {"  "}
              {relation}
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
            message: t("contacts.tellMessage", {
              name: contactNameOf(contact),
            }),
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
  // 列表没拿到（还在拉 / 拉失败）≠ 一个都没加：原来拉失败也显示「尚未添加」、添加照样可点，
  // 用户以为丢了又加一遍，联系人重复（10-17 评审）
  const known = contacts.data !== undefined;

  const remove = (c: EmergencyContact) => {
    Alert.alert(
      translate("contacts.deleteTitle"),
      translate("contacts.deleteBody", { name: contactNameOf(c) }),
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
              .catch((e) => showFailure(translate("common.failed"), e)),
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
        {contacts.isError && !isSessionEnded(contacts.error) && (
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
        ) : known ? (
          // 空态只做引导：底部常驻的「添加联系人」才是唯一入口，这里再放一个按钮会出现两个添加
          <EmptyState
            icon="people-outline"
            title={t("empty.contactsTitle")}
            body={t("empty.contactsBody")}
          />
        ) : (
          contacts.isError && (
            <EmptyState
              icon="cloud-offline-outline"
              title={t("contacts.loadFailed")}
              body={t("contacts.loadFailedBody")}
              actionLabel={t("contacts.retry")}
              actionIcon="refresh"
              onAction={() => void contacts.refetch()}
            />
          )
        )}
      </ScrollView>
      <View style={styles.bottom}>
        <PrimaryButton
          title={t("contacts.add")}
          icon="add"
          disabled={!known || list.length >= MAX_CONTACTS}
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
