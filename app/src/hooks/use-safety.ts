// 安全首页 / 安全记录页 / 安全设置页共用的几份数据。都是读取与推导，不发起任何连接或求救动作。
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import type { DevicePublic, Sos } from "@helmet/shared";

import { devicesApi } from "@/api/devices";
import { sosApi } from "@/api/sos";
import { guardActiveResult } from "@/services/sos-sync";
import { readNotifyPermission } from "@/services/notify-permission";
import {
  helmetLinkOf,
  type HelmetLink,
  type NotifyPermission,
} from "@/services/safety-status";
import { useAuthStore } from "@/stores/auth-store";
import { useBleStore, type BleLinkPhase } from "@/stores/ble-store";
import { useDrillStore } from "@/stores/drill-store";
import { useHelmetViewStore, viewedHelmetOf } from "@/stores/helmet-view-store";

/** 绑定的头盔 + 正在查看的那顶（选择存在 helmet-view-store，两页共用） */
export function useHelmets() {
  // 与设备页同一份缓存、同样的 30 秒轮询兜底：WS 断着的时候，这里的「在线」不至于一直停在旧值，
  // 拉取失败时 isError 也会如实翻过来
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: devicesApi.list,
    refetchInterval: 30_000,
  });
  const list = devices.data ?? [];
  const selectedId = useHelmetViewStore((s) => s.selectedId);
  const select = useHelmetViewStore((s) => s.select);
  return {
    list,
    viewed: viewedHelmetOf(list, selectedId),
    select,
    /** 列表拿到过没有：没拿到（还在拉 / 拉失败）≠ 一台都没绑 */
    known: devices.data !== undefined,
    /** 最近一次拉取失败：缓存里的状态可能是旧的 */
    stale: devices.isError,
    error: devices.error,
    refetch: devices.refetch,
  };
}

/**
 * 各头盔的连接结论。BLE store 里整条 link 每来一帧都会变（lastFrameAt / eventsReceived），
 * 这里只订阅各台的 phase 拼成的字符串，帧到达不会让页面重画。
 */
export function useHelmetLinks(
  devices: readonly DevicePublic[],
  serverFresh: boolean,
): Record<string, HelmetLink> {
  const adapter = useBleStore((s) => s.adapter);
  const phases = useBleStore((s) =>
    devices.map((d) => s.links[d.deviceId]?.phase ?? "").join("|"),
  ).split("|");
  const out: Record<string, HelmetLink> = {};
  devices.forEach((d, i) => {
    out[d.deviceId] = helmetLinkOf(
      d,
      { phase: (phases[i] || undefined) as BleLinkPhase | undefined, adapter },
      serverFresh,
    );
  });
  return out;
}

/**
 * 所有头盔上仍在倒计时的求救（不按「正在查看的头盔」筛）：进行中的求救在哪一页都不能被筛掉。
 * WS 推送直写同一份 ["sos-active", id] 缓存；30 秒轮询兜底。
 */
export function usePendingSos(deviceIds: readonly string[]): Sos[] {
  const queryClient = useQueryClient();
  const active = useQueries({
    queries: deviceIds.map((id) => ({
      queryKey: ["sos-active", id],
      // 轮询结果过终态守卫：请求在途时用户已在倒计时页取消，迟到的 pending 不能把卡片顶回来（B 线 F9）
      queryFn: async () =>
        guardActiveResult(queryClient, await sosApi.active(id)),
      refetchInterval: 30_000,
    })),
  });
  return active
    .map((q) => q.data?.sos)
    .filter((s): s is Sos => s != null && s.status === "pending");
}

/** 通知权限；null = 还没查到。回前台再查一次：用户多半是刚从系统设置改完权限回来 */
export function useNotifyPermission(): NotifyPermission | null {
  const [state, setState] = useState<NotifyPermission | null>(null);
  useEffect(() => {
    let alive = true;
    const check = () =>
      void readNotifyPermission().then((p) => {
        if (alive) setState(p);
      });
    check();
    const sub = AppState.addEventListener("change", (st) => {
      if (st === "active") check();
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return state;
}

/**
 * SOS 演练入口（首页那一行和安全设置里的那一项共用）。
 * 首页只在「确定没打开过」时显示入口：还没读到存储时不显示，免得闪一下。
 * 从哪个入口点开都记为打开过。演练页本身（/sos-active?drill=1）没有改动。
 */
export function useSosDrill(): { unseen: boolean; open: () => void } {
  const userId = useAuthStore((s) => s.user?.id);
  const seen = useDrillStore((s) => (userId ? s.seen[userId] : undefined));
  const load = useDrillStore((s) => s.load);
  const markSeen = useDrillStore((s) => s.markSeen);
  useEffect(() => {
    if (userId) void load(userId);
  }, [userId, load]);
  return {
    unseen: seen === false,
    open: () => {
      if (userId) markSeen(userId);
      router.push("/sos-active?drill=1");
    },
  };
}
