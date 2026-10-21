// 标签页一直挂着：切回来时把这份缓存重新拉一遍，不等下一次轮询。
// 不按「过期」判断：别的页面刚拉过、还在新鲜期里的那份可能正是改动之前的；只跳过「正在拉」和「2 秒内刚拉过」
// （来回切标签时别连发）。App 回到前台的刷新在根布局（focusManager 接 AppState），这里补的是「只切标签、App 没离开
// 前台」的那一下——10-19 iPhone 实测：接口清空再加回联系人，安全页一直写「尚无联系人」，退后台再回来才对。
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback } from "react";

export const FOCUS_REFETCH_GAP_MS = 2_000;

export function useRefetchOnFocus(queryKey: QueryKey): void {
  const queryClient = useQueryClient();
  // 调用方多半传字面量数组，每次渲染都是新引用：按内容比较，别让聚焦回调每次渲染都换、反复触发
  const keyJson = JSON.stringify(queryKey);
  useFocusEffect(
    useCallback(() => {
      const queryKey = JSON.parse(keyJson) as QueryKey;
      const q = queryClient.getQueryCache().find({ queryKey });
      if (
        q &&
        (q.state.fetchStatus === "fetching" ||
          Date.now() - q.state.dataUpdatedAt < FOCUS_REFETCH_GAP_MS)
      )
        return;
      void queryClient.refetchQueries(
        { queryKey, type: "active" },
        { cancelRefetch: false },
      );
    }, [queryClient, keyJson]),
  );
}
