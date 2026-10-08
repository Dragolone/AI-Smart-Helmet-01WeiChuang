import AppTabs from "@/components/app-tabs";
import { KeepAliveTip } from "@/components/keepalive-tip";
import { useSwitchHelmetWatcher } from "@/hooks/use-switch-reminder";

// 实时通道 / BLE 中转 / 推送不挂在这里：它们与登录态同生命周期，在根布局的 RealtimeBridge 里
// （这个布局可能被重复压栈或随页面崩溃卸载，见 hooks/use-realtime.ts 顶部说明）
export default function TabsLayout() {
  // 「更换头盔提醒」只是个提醒，不是保命链路：跟着标签页走就够了
  useSwitchHelmetWatcher();
  return (
    <>
      <AppTabs />
      <KeepAliveTip />
    </>
  );
}
