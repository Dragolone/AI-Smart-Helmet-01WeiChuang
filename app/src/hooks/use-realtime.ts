// 实时推送 → react-query 缓存：登录期间常驻挂载（(tabs) 布局）。
// WS 只负责"更快"；已有的 REST 轮询保持不变作为可靠性兜底（API.md §11）。
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect } from "react";
import { AppState } from "react-native";
import type {
  DevicePublic,
  DeviceStatus,
  WsDeviceCommandData,
  WsDeviceStatusData,
  WsLocationData,
  WsSosData,
} from "@helmet/shared";

import { forceRefreshTokens } from "@/api/client";
import { devicesApi } from "@/api/devices";
import { realtimeClient } from "@/api/realtime";
import { sosApi } from "@/api/sos";
import { setBleTargets, startBleLink, stopBleLink } from "@/services/ble-link";
import {
  checkBatteryAlert,
  resetBatteryAlerts,
} from "@/services/battery-alert";
import { devLog } from "@/services/dev-log";
import { setPushArrivalHandler, startPush, stopPush } from "@/services/push";
import { handleDeviceCommand } from "@/services/ble-relay";
import { startRelayUplink, stopRelayUplink } from "@/services/ble-relay-uplink";
import {
  clearSosAlert,
  ensureSosAlertPermission,
  resetSosAlerts,
  setSosCancelConfirmedListener,
  showSosAlertIfBackground,
} from "@/services/sos-alert";
import {
  alertPendingOnBackground,
  applySosUpdate,
  onReconnect,
  presentedSos,
  resumePendingSos,
  type SosSyncDeps,
} from "@/services/sos-sync";
import { useAuthStore } from "@/stores/auth-store";

export function useRealtimeUpdates(): void {
  const queryClient = useQueryClient();
  const authed = useAuthStore((s) => s.tokens !== null);
  // 防止同一单的多次 pending 推送（重连补拉等）重复弹全屏页；进程内共用一份，
  // 点通知进倒计时页的两条路径（sos-alert / push）也往里登记
  const presentedSosId = presentedSos;

  useEffect(() => {
    devLog("realtime", "effect authed=", authed);
    if (!authed) return;

    realtimeClient.start({
      getAccessToken: () => useAuthStore.getState().tokens?.accessToken ?? null,
      // 4401（token 过期）后必须真的换一把新 token 再重连，否则会拿着同一个过期 token 死循环
      triggerTokenRefresh: () => forceRefreshTokens(),
    });
    // BLE 上行中转队列与登录态同生命周期(决策 #35:BLE 是唯一真机数据链路)；按账号分区，换账号不混用
    startRelayUplink(useAuthStore.getState().user?.id ?? undefined);
    void ensureSosAlertPermission();
    // 远程推送（极光）：alias = 用户 ID；内部会等隐私政策同意后才初始化 SDK。
    // 钥匙串里只有 token、档案没落上盘时，user 要等 /users/me 回来才有——那时再补，不能整个会话都不设别名
    let pushStarted = false;
    const ensurePush = () => {
      const uid = useAuthStore.getState().user?.id;
      if (!uid || pushStarted) return;
      pushStarted = true;
      startPush(uid);
    };
    ensurePush();
    const unsubscribeUser = useAuthStore.subscribe(ensurePush);
    // BLE 近场链路：目标 = 已绑定设备；绑定/解绑后随 ['devices'] 缓存变化同步目标
    const bleTargetsOf = () =>
      (queryClient.getQueryData<DevicePublic[]>(["devices"]) ?? []).map(
        (d) => d.deviceId,
      );
    // SOS 同步的判断逻辑在 services/sos-sync.ts（纯函数 + 注入副作用，有单测）；这里只接线
    const sosDeps: SosSyncDeps = {
      fetchActive: (id) => sosApi.active(id),
      openCountdown: (sosId, deviceId) =>
        router.push(`/sos-active?sosId=${sosId}&deviceId=${deviceId}`),
      showLockScreenAlert: (sosId, deviceId, deadline) =>
        void showSosAlertIfBackground(sosId, deviceId, deadline),
      clearLockScreenAlert: (sosId) => void clearSosAlert(sosId),
      log: (m) => devLog("SOS", m),
    };
    // 冷启动补拉：App 被杀/重开期间若有 SOS 仍在倒计时，WS 不会重推创建消息；
    // WS 每次重连后同样补拉一次（SOS-12）
    const unsubscribeState = realtimeClient.subscribeState(
      onReconnect(
        () =>
          void resumePendingSos(
            queryClient,
            bleTargetsOf(),
            presentedSosId,
            sosDeps,
            "重连补拉",
          ),
      ),
    );
    void queryClient
      .fetchQuery({
        queryKey: ["devices"],
        queryFn: devicesApi.list,
        staleTime: 10_000,
      })
      .catch(() => undefined)
      .then(() => {
        startBleLink(bleTargetsOf());
        void resumePendingSos(
          queryClient,
          bleTargetsOf(),
          presentedSosId,
          sosDeps,
        );
      });
    // 远程 SOS 推送到达 → 以 REST 为准补拉一次（前台 + WS 没连上时唯一能把倒计时页拉起来的路径）
    setPushArrivalHandler((extras) => {
      void resumePendingSos(
        queryClient,
        extras.deviceId ? [extras.deviceId] : bleTargetsOf(),
        presentedSosId,
        sosDeps,
        "远程推送到达，补拉",
      );
    });
    // 锁屏通知「取消」被服务端确认（含重试成功）→ 倒计时页与安全页立刻拉权威状态，不等 WS / 10 s 轮询
    setSosCancelConfirmedListener((sosId) => {
      void queryClient.invalidateQueries({ queryKey: ["sos", sosId] });
      void queryClient.invalidateQueries({ queryKey: ["sos-active"] });
    });
    const unsubscribeCache = queryClient.getQueryCache().subscribe((event) => {
      if (event.query.queryKey[0] === "devices" && event.type === "updated") {
        setBleTargets(bleTargetsOf());
      }
    });

    const unsubscribe = realtimeClient.subscribe((message) => {
      switch (message.type) {
        case "device_status": {
          const { deviceId, ...status } = message.data as WsDeviceStatusData;
          // 详情页缓存：整体替换
          queryClient.setQueryData<DeviceStatus>(
            ["device-status", deviceId],
            status,
          );
          // 列表缓存：合并进对应设备行
          queryClient.setQueryData<DevicePublic[]>(["devices"], (prev) =>
            prev?.map((d) =>
              d.deviceId === deviceId ? { ...d, ...status } : d,
            ),
          );
          const dev = queryClient
            .getQueryData<DevicePublic[]>(["devices"])
            ?.find((d) => d.deviceId === deviceId);
          checkBatteryAlert(deviceId, dev?.name ?? deviceId, status);
          break;
        }
        case "risk_event":
        case "device_event": {
          // 危险/设备事件推送 → 事件页缓存失效即时刷新(§6)
          void queryClient.invalidateQueries({ queryKey: ["events"] });
          break;
        }
        case "location_update": {
          // 地图页（等高德 Key 接 SDK）消费；先落缓存供实时数据卡使用
          const data = message.data as WsLocationData;
          queryClient.setQueryData(["device-location", data.deviceId], data);
          break;
        }
        case "sos_update": {
          // 服务端权威：创建/取消/确认/超时通知四个时机都推（shared WsSosData）
          const sos = message.data as WsSosData;
          devLog(
            "SOS",
            `推送 ${sos.status} ${sos.sosId} appState=${AppState.currentState}`,
          );
          applySosUpdate(queryClient, sos, presentedSosId, sosDeps);
          void queryClient.invalidateQueries({ queryKey: ["accidents"] });
          break;
        }
        case "device_command": {
          // BLE 下行通道(决策 #36):写头盔+回执由 ble-relay 处理,完成后刷新设置页状态
          const cmd = message.data as WsDeviceCommandData;
          void handleDeviceCommand(cmd).then((acked) => {
            if (acked) {
              void queryClient.invalidateQueries({
                queryKey: ["device-settings", cmd.deviceId],
              });
            }
          });
          break;
        }
        default:
          break;
      }
    });

    // 回前台立即触发一次兜底刷新（WS 断线期间可能漏消息）
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        // 断线中回前台：不等退避，立刻重连（关飞行模式/切回 Wi-Fi 后提示条秒消失）
        realtimeClient.kick();
        void queryClient.invalidateQueries({ queryKey: ["devices"] });
        return;
      }
      // SOS-13：离开前台时按缓存补弹锁屏通知（只认 background，规则见 sos-sync）
      alertPendingOnBackground(queryClient, state, bleTargetsOf(), sosDeps);
    });

    return () => {
      unsubscribe();
      unsubscribeState();
      unsubscribeUser();
      appState.remove();
      realtimeClient.stop();
      stopRelayUplink();
      unsubscribeCache();
      stopBleLink();
      resetBatteryAlerts();
      setPushArrivalHandler(null);
      setSosCancelConfirmedListener(null);
      void resetSosAlerts();
      presentedSosId.current.clear();
      stopPush();
    };
  }, [authed, queryClient]);
}
