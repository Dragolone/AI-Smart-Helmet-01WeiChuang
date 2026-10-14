// 「更换头盔提醒」的接线：看着各台在线头盔的最新定位点（WS 直写的 ["device-location", id] 缓存），
// 条件满足就把要问的那一对放进 store，由设备页 / 安全页上的面板问用户。
// 这里只读缓存，不发请求、不碰蓝牙；提醒本身不是保命链路，挂在标签页布局里即可。
import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { devicesApi } from "@/api/devices";
import { useCurrentHelmetChoice } from "@/hooks/use-safety";
import { currentHelmetOf } from "@/services/safety-status";
import {
  nextMotion,
  switchCandidateOf,
  type Motion,
} from "@/services/switch-reminder";
import { useAuthStore } from "@/stores/auth-store";
import { useSwitchReminderStore } from "@/stores/switch-reminder-store";

/** 安全设置里的开关。enabled 为 null = 还没读到 */
export function useSwitchReminderSetting(): {
  enabled: boolean | null;
  setEnabled: (on: boolean) => void;
} {
  const userId = useAuthStore((s) => s.user?.id);
  const enabled = useSwitchReminderStore((s) =>
    userId ? s.enabled[userId] : undefined,
  );
  const load = useSwitchReminderStore((s) => s.load);
  const set = useSwitchReminderStore((s) => s.setEnabled);
  useEffect(() => {
    if (userId) void load(userId);
  }, [userId, load]);
  return {
    enabled: enabled ?? null,
    setEnabled: (on) => {
      if (userId) set(userId, on);
    },
  };
}

export function useSwitchHelmetWatcher(): void {
  const userId = useAuthStore((s) => s.user?.id);
  const { enabled } = useSwitchReminderSetting();
  const { chosenId, ready } = useCurrentHelmetChoice();
  // 只读缓存：设备页已经按 30 秒轮询这份列表，这里不再发请求
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: devicesApi.list,
    enabled: false,
  });
  const list = devices.data ?? [];
  const currentId = currentHelmetOf(list, chosenId)?.deviceId;
  const online = list.filter((d) => d.online).map((d) => d.deviceId);
  // 在线不到两台时没有可换的对象，不用看定位
  const watchKey = online.length > 1 ? online.join("|") : "";
  const locations = useQueries({
    queries: (watchKey ? watchKey.split("|") : []).map((id) => ({
      queryKey: ["device-location", id],
      queryFn: async () => (await devicesApi.latestLocation(id)).location,
      enabled: false,
    })),
  });
  // 每来一个新的定位点变一次：effect 靠它知道该重算了
  const stamp = locations.map((q) => q.dataUpdatedAt).join("|");
  const speeds = locations.map((q) => q.data?.speed ?? "").join("|");

  const motions = useRef<Record<string, Motion>>({});
  const seen = useRef<Record<string, string>>({});
  const watching = useRef<{ id: string | undefined; since: number }>({
    id: undefined,
    since: 0,
  });

  useEffect(() => {
    if (!userId || !ready) return;
    const now = Date.now();
    if (watching.current.id !== currentId)
      watching.current = { id: currentId, since: now };
    const ids = watchKey ? watchKey.split("|") : [];
    const stamps = stamp.split("|");
    const speedOf = speeds.split("|");
    ids.forEach((id, i) => {
      // 只在这顶头盔真的来了新点时记一次；别的头盔来点引起的重算不重复记
      if (speedOf[i] === "" || seen.current[id] === stamps[i]) return;
      seen.current[id] = stamps[i];
      motions.current[id] = nextMotion(
        motions.current[id],
        Number(speedOf[i]),
        now,
      );
    });
    const store = useSwitchReminderStore.getState();
    const candidate =
      enabled === true && currentId
        ? switchCandidateOf({
            currentId,
            onlineIds: ids,
            motions: motions.current,
            watchingSince: watching.current.since,
            now,
          })
        : null;
    if (candidate && currentId) {
      store.offer(userId, { currentId, otherId: candidate });
      return;
    }
    // 已经在问的那一条：只在问题本身不成立了才收起（当前头盔已换、那台掉线、开关被关）。
    // 那台只是停了一下不收——面板在用户眼前自己消失更让人摸不着头脑
    const p = store.prompt;
    if (
      p &&
      (p.currentId !== currentId ||
        !ids.includes(p.otherId) ||
        enabled !== true)
    )
      store.withdraw();
  }, [userId, ready, enabled, currentId, watchKey, stamp, speeds]);
}
