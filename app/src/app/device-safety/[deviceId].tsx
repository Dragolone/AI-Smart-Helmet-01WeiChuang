// 设备设置 ·「安全检测与预警」（设备详情页的分类入口）：跌倒检测、灵敏度、SOS 物理按键，
// 以及后方雷达、预警距离、前方障碍预警。设置项与取值范围取自 @helmet/shared 的清单，下发与回执规则不变。
import { useLocalSearchParams } from "expo-router";

import { DeviceSettingsPage } from "@/components/device-settings-page";

export default function DeviceSafetySettingsScreen() {
  const { deviceId } = useLocalSearchParams<{ deviceId: string }>();
  return (
    <DeviceSettingsPage
      deviceId={deviceId}
      groups={[
        { keys: ["fallDetect", "fallSensitivity", "sosButton"] },
        {
          title: "device.safety.rideGroup",
          keys: ["radar", "radarDistance", "obstacleWarn"],
        },
      ]}
    />
  );
}
