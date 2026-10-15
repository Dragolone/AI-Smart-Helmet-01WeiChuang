// 「编辑资料」要发给服务端的改动。只发改过的字段：弹层里的初值来自本机存着的会话，可能是旧的，
// 没动过的字段原样写回去会覆盖别的手机上刚做的修改（2026-10-16 华为实测：只换头像，旧昵称被一起写回）。
import type { UpdateMeRequest, UserProfile } from "@helmet/shared";

import { cleanNickname } from "./user-name";

/** 什么都没改时返回 null（调用方直接关弹层，不发请求） */
export function profilePatch(
  user: Pick<UserProfile, "nickname" | "avatarUrl"> | null | undefined,
  nickDraft: string,
  avatarDraft: string | null,
): UpdateMeRequest | null {
  const patch: UpdateMeRequest = {};
  // 昵称按显示时的规则整理后再比、再发：只含零宽字符 / 换行的昵称原来照发（资料卡没名字），
  // 弹层预填的是整理后的样子，和本机存的原文比会把「没动过」当成改动
  const nickname = cleanNickname(nickDraft);
  if (nickname !== cleanNickname(user?.nickname)) patch.nickname = nickname;
  if (avatarDraft && avatarDraft !== user?.avatarUrl) {
    patch.avatarUrl = avatarDraft;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
