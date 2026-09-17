import AppTabs from "@/components/app-tabs";
import { KeepAliveTip } from "@/components/keepalive-tip";
import { useRealtimeUpdates } from "@/hooks/use-realtime";

export default function TabsLayout() {
  // 登录后常驻的实时通道：设备状态/位置推送直写 react-query 缓存
  useRealtimeUpdates();
  return (
    <>
      <AppTabs />
      <KeepAliveTip />
    </>
  );
}
