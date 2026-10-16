// 设备设置的读取与下发（API.md §8 命令 + 回执状态机）。原先写在设备详情页里，分类页面拆出去之后
// 详情首页和各分类页共用这一份，逻辑原样搬过来，没有改动：
// - 当前值与最近一条命令来自同一个查询（["device-settings", deviceId]），几个页面共享缓存，
//   所以从分类页返回、或进另一个分类页，等待中的命令和失败结果都还在；
// - 有未终态命令时 2 秒快轮询直到回执 / 超时，平时 30 秒；
// - 下发只是把命令交给服务端，界面上的「当前值」始终是头盔确认过的值，不是用户刚点的值。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { CommandPublic } from "@helmet/shared";

import { devicesApi } from "@/api/devices";
import { toUserMessage } from "@/api/error-messages";
import { useT } from "@/i18n";
import { showNotice } from "@/services/notice";

export function useDeviceSettings(deviceId: string): {
  /** 当前生效设置（只含头盔确认过的值）；还没拿到时为 undefined */
  values: Record<string, unknown> | undefined;
  lastCommand: CommandPublic | null;
  /** 下发请求还在路上（只覆盖这一次 HTTP 请求，不是等头盔回执） */
  sending: boolean;
  /** 交给服务端；成功给回新建的命令（调用方按 commandId 认自己那条的回执），没发出去给 null（已弹窗说明） */
  send: (
    key: string,
    value: string | number | boolean,
  ) => Promise<CommandPublic | null>;
  isError: boolean;
  error: unknown;
} {
  const t = useT();
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ["device-settings", deviceId],
    queryFn: () => devicesApi.settings(deviceId),
    refetchInterval: (q) => {
      const st = q.state.data?.lastCommand?.status;
      return st === "pending" || st === "delivered" ? 2_000 : 30_000;
    },
  });
  const [sending, setSending] = useState(false);
  const send = (key: string, value: string | number | boolean) => {
    setSending(true);
    const put = devicesApi.putSettings(deviceId, {
      settings: { [key]: value },
    });
    put
      .then(() =>
        queryClient.invalidateQueries({
          queryKey: ["device-settings", deviceId],
        }),
      )
      .catch((e) => showNotice(t("device.sendFailed"), toUserMessage(e)))
      .finally(() => setSending(false));
    // 命令号一回来就交出去，不等重新拉设置：拉回来时调用方已经认得出哪条是自己的
    return put.then(
      (cmd) => cmd ?? null,
      () => null,
    );
  };
  return {
    values: settings.data?.settings,
    lastCommand: settings.data?.lastCommand ?? null,
    sending,
    send,
    isError: settings.isError,
    error: settings.error,
  };
}
