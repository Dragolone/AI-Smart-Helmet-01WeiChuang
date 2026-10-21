// 本账号还在倒计时的一单（没有就 null）。注销（O15）和退出登录（O21 补充）之前都要看一眼：
// 走了之后这台手机就取消不了它，倒计时结束照样通知紧急联系人。
// 服务端还没有账号级接口（404）就看本机缓存里各顶头盔的进行中单；别的失败照抛，由调用方决定拦不拦
import type { QueryClient } from "@tanstack/react-query";
import type { ActiveSosResponse, Sos } from "@helmet/shared";

import { ApiRequestError } from "@/api/client";
import { sosApi } from "@/api/sos";

export async function firstActiveSos(
  queryClient: QueryClient,
): Promise<Sos | null> {
  try {
    const page = await sosApi.activeForAccount(1, 1);
    return page.items[0] ?? null;
  } catch (e) {
    if (!(e instanceof ApiRequestError && e.status === 404)) throw e;
    for (const [, data] of queryClient.getQueriesData<ActiveSosResponse>({
      queryKey: ["sos-active"],
    })) {
      if (data?.sos?.status === "pending") return data.sos;
    }
    return null;
  }
}
