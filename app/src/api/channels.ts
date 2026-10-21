// 对讲频道接口（docs/API.md §13；backend/src/voice 已实现并验收）
import type {
  CreateChannelRequest,
  JoinChannelRequest,
  VoiceChannel,
  VoiceChannelMemberPublic,
  VoiceTokenResponse,
} from "@helmet/shared";
import { api, apiList } from "./client";

export const channelsApi = {
  /** 我加入的频道列表 */
  list: () => apiList<VoiceChannel>("/voice/channels"),

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

  /** 进房凭证：UserSig 服务端签发（决策 #27⑥），App 不再本地算签名 */
  token: (channelId: string) =>
    api<VoiceTokenResponse>(
      `/voice/channels/${encodeURIComponent(channelId)}/token`,
      { method: "POST" },
    ),
};
