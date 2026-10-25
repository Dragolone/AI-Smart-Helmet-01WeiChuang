// 对讲频道接口（docs/API.md §13；backend/src/voice 已实现并验收）
import type {
  CreateChannelRequest,
  JoinChannelRequest,
  VoiceChannel,
  VoiceChannelMemberPublic,
  VoiceTokenRequest,
  VoiceTokenResponse,
} from "@helmet/shared";
import { api, apiList } from "./client";
import { isShapedObject, normalizeChannel } from "./device-shape";

export const channelsApi = {
  /** 我加入的频道列表 */
  list: () =>
    apiList<unknown>("/voice/channels").then((cs) =>
      cs
        .filter(
          (c): c is VoiceChannel =>
            isShapedObject(c) && typeof c.channelId === "string",
        )
        .map(normalizeChannel),
    ),

  create: (body: CreateChannelRequest) =>
    api<VoiceChannel>("/voice/channels", { method: "POST", body }),

  join: (body: JoinChannelRequest) =>
    api<VoiceChannel>("/voice/channels/join", { method: "POST", body }),

  leave: (channelId: string) =>
    api<void>(`/voice/channels/${encodeURIComponent(channelId)}/membership`, {
      method: "DELETE",
    }),

  members: (channelId: string) =>
    api<VoiceChannelMemberPublic[]>(
      `/voice/channels/${encodeURIComponent(channelId)}/members`,
    ),

  /**
   * 进房凭证：UserSig 服务端签发（决策 #27⑥），App 不再本地算签名。
   * body 带本机标识与用途（决策 #62）：enter 让同账号别的手机退房，renew 遇已被接管 409 VOICE_TAKEN_OVER
   */
  token: (channelId: string, body: VoiceTokenRequest) =>
    api<VoiceTokenResponse>(
      `/voice/channels/${encodeURIComponent(channelId)}/token`,
      { method: "POST", body },
    ),
};
