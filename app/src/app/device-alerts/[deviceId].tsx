// 设备设置 ·「提醒方式」（设备详情页的分类入口）：振动提醒及强度、蜂鸣提醒开关、断连蜂鸣提醒。
// 蜂鸣音量的滑杆在详情首页，这里不放第二个。
import { useLocalSearchParams } from "expo-router";

import { DeviceSettingsPage } from "@/components/device-settings-page";

export { RouteErrorBoundary as ErrorBoundary } from "@/components/route-error-boundary";

export default function DeviceAlertSettingsScreen() {
  const { deviceId } = useLocalSearchParams<{ deviceId: string }>();
  return (
    <DeviceSettingsPage
      deviceId={deviceId}
      groups={[{ keys: ["vibration", "buzzer", "disconnectBeep"] }]}
      note="device.alerts.volumeNote"
    />
  );
}
