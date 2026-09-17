// 头盔低电量提醒：电量跌破 20% / 10% 各提醒一次（前台 Toast，后台本地通知），充电或回升到 25% 以上后重置。
// 骑行中看不到 App，头盔没电 = 保命链路断掉，所以这条值得打扰一次；不做判断，只看服务端推来的 battery。
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import type { DeviceStatus } from "@helmet/shared";

import { showToast } from "@/components/toast";
import { translate } from "@/i18n";
import { devLog } from "@/services/dev-log";

/** 升序：取「已跌破的最低档」 */
const THRESHOLDS = [10, 20] as const;
const RESET_ABOVE = 25;
const CHANNEL_ID = "device";

/** deviceId → 已提醒过的最低阈值 */
const notified = new Map<string, number>();
let channelReady = false;

async function ensureChannel(): Promise<void> {
  if (channelReady || Platform.OS !== "android") return;
  channelReady = true;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: translate("battery.channel"),
    importance: Notifications.AndroidImportance.DEFAULT,
  }).catch(() => undefined);
}

export function checkBatteryAlert(
  deviceId: string,
  name: string,
  status: Pick<DeviceStatus, "battery" | "charging">,
): void {
  const { battery, charging } = status;
  if (battery === null) return;
  if (charging || battery > RESET_ABOVE) {
    notified.delete(deviceId);
    return;
  }
  const crossed = THRESHOLDS.find((t) => battery <= t);
  if (crossed === undefined) return;
  const last = notified.get(deviceId);
  if (last !== undefined && last <= crossed) return;
  notified.set(deviceId, crossed);
  const body = translate("battery.lowBody", { name, battery });
  if (AppState.currentState === "active") {
    showToast(body);
    return;
  }
  void ensureChannel().then(() =>
    Notifications.scheduleNotificationAsync({
      content: {
        title: translate("battery.lowTitle"),
        body,
        data: { deviceId },
        ...(Platform.OS === "android" ? { channelId: CHANNEL_ID } : {}),
      },
      trigger: null,
    }).catch((e: Error) => devLog("BATTERY", "低电量通知失败", e)),
  );
}

/** 登出/换账号：清掉「已提醒过」记录，新会话下同一台设备该提醒还要再提醒 */
export function resetBatteryAlerts(): void {
  notified.clear();
  channelReady = false;
}
