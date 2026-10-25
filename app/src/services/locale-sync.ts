// 切语言后，已经交给系统的文字也跟着换：求救通知上的两个按钮、几个通知通道名、蓝牙常驻通知。
// 这些在交给系统那一刻按当时的语言写死，App 里切语言不会自己变——10-25 安卓模拟器：切成简体后
// 求救通知标题是中文、按钮还是「I'm OK, cancel」，常驻通知一直是英文，要重开 App 才换
import { useLocaleStore } from "@/i18n";
import { refreshBatteryChannelName } from "@/services/battery-alert";
import { refreshServiceNotification } from "@/services/ble-link";
import { refreshSosAlertTexts } from "@/services/sos-alert";

export function installLocaleSync(): () => void {
  return useLocaleStore.subscribe((state, prev) => {
    if (state.locale === prev.locale) return;
    void refreshSosAlertTexts();
    void refreshBatteryChannelName();
    refreshServiceNotification();
  });
}
