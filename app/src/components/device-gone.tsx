// 这顶头盔已不在本账号下（别的手机解绑了、点了旧推送 / 深链 / 乱链接）：服务端 404 DEVICE_NOT_FOUND。
// 详情首页和各分类页（安全检测 / 提醒方式 / 关于头盔）共用：原来分类页照样画整张表单，点了全都报错（优化清单 10）
import { router } from "expo-router";
import { StyleSheet } from "react-native";

import { ApiRequestError } from "@/api/client";
import { EmptyState } from "@/components/empty-state";
import { ThemedView } from "@/components/themed-view";
import { useT } from "@/i18n";
import { shortDeviceId } from "@/services/device-view";

/** 这几个请求里有一个回了「头盔不存在」 */
export const isDeviceGone = (...errors: unknown[]): boolean =>
  errors.some(
    (e) => e instanceof ApiRequestError && e.code === "DEVICE_NOT_FOUND",
  );

export function DeviceGone({ deviceId }: { deviceId: string }) {
  const t = useT();
  return (
    <ThemedView style={styles.wrap}>
      <EmptyState
        icon="help-circle-outline"
        title={t("device.goneTitle")}
        // 链接里的编号可以是任意长的一串（华为真机：600 个 x 铺满整屏），正文里只留前 32 个字
        body={t("device.goneBody", { id: shortDeviceId(deviceId) })}
        actionLabel={t("device.goneBack")}
        onAction={() => router.navigate("/")}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: "center", paddingHorizontal: 24 },
});
