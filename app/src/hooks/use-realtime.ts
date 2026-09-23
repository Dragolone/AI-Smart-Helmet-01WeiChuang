// 实时推送 → react-query 缓存：登录期间常驻挂载（(tabs) 布局）。
// WS 只负责"更快"；已有的 REST 轮询保持不变作为可靠性兜底（API.md §11）。
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import type {
  ActiveSosResponse,
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
import { handleDeviceCommand } from "@/services/ble-relay";
import { startRelayUplink, stopRelayUplink } from "@/services/ble-relay-uplink";
import {
  clearSosAlert,
  ensureSosAlertPermission,
  showSosAlertIfBackground,
} from "@/services/sos-alert";
import { useAuthStore } from "@/stores/auth-store";

export function useRealtimeUpdates(): void {
  const queryClient = useQueryClient();
  const authed = useAuthStore((s) => s.tokens !== null);
  // 防止同一单的多次 pending 推送（重连补拉等）重复弹全屏页
  const presentedSosId = useRef<string | null>(null);

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
    // BLE 近场链路：目标 = 已绑定设备；绑定/解绑后随 ['devices'] 缓存变化同步目标
    const bleTargetsOf = () =>
      (queryClient.getQueryData<DevicePublic[]>(["devices"]) ?? []).map(
        (d) => d.deviceId,
      );
    // 冷启动补拉：App 被杀/重开期间若有 SOS 仍在倒计时（例如点了锁屏通知才打开 App），
    // WS 不会重推创建消息，主动查一次 active 并拉起倒计时页；服务端仍是权威
    const resumePendingSos = async (ids: string[]) => {
      for (const id of ids) {
        try {
          const { sos } = await sosApi.active(id);
          if (!sos || sos.status !== "pending") continue;
          queryClient.setQueryData<ActiveSosResponse>(["sos-active", id], {
            sos,
          });
          if (presentedSosId.current === sos.sosId) continue;
          presentedSosId.current = sos.sosId;
          devLog("SOS", `冷启动发现进行中 SOS ${sos.sosId}`);
          router.push(`/sos-active?sosId=${sos.sosId}&deviceId=${id}`);
        } catch {
          // 网络失败不阻塞；安全页仍会按常规查询展示
        }
      }
    };
    void queryClient
      .fetchQuery({
        queryKey: ["devices"],
        queryFn: devicesApi.list,
        staleTime: 10_000,
      })
      .catch(() => undefined)
      .then(() => {
        startBleLink(bleTargetsOf());
        void resumePendingSos(bleTargetsOf());
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
          queryClient.setQueryData<ActiveSosResponse>(
            ["sos-active", sos.deviceId],
            {
              sos: sos.status === "pending" ? sos : null,
            },
          );
          queryClient.setQueryData(["sos", sos.sosId], sos);
          void queryClient.invalidateQueries({ queryKey: ["accidents"] });
          devLog(
            "SOS",
            `推送 ${sos.status} ${sos.sosId} appState=${AppState.currentState}`,
          );
          if (
            sos.status === "pending" &&
            presentedSosId.current !== sos.sosId
          ) {
            presentedSosId.current = sos.sosId;
            router.push(
              `/sos-active?sosId=${sos.sosId}&deviceId=${sos.deviceId}`,
            );
            void showSosAlertIfBackground(
              sos.sosId,
              sos.deviceId,
              sos.deadline,
            );
          }
          if (sos.status !== "pending") void clearSosAlert(sos.sosId);
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
        void queryClient.invalidateQueries({ queryKey: ["devices"] });
      }
    });

    return () => {
      unsubscribe();
      appState.remove();
      realtimeClient.stop();
      stopRelayUplink();
      unsubscribeCache();
      stopBleLink();
      resetBatteryAlerts();
    };
  }, [authed, queryClient]);
}
