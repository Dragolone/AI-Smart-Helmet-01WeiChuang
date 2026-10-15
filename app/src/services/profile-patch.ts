// 「编辑资料」要发给服务端的改动。只发改过的字段：弹层里的初值来自本机存着的会话，可能是旧的，
// 没动过的字段原样写回去会覆盖别的手机上刚做的修改（2026-10-16 华为实测：只换头像，旧昵称被一起写回）。
import type { UpdateMeRequest, UserProfile } from "@helmet/shared";

/** 什么都没改时返回 null（调用方直接关弹层，不发请求） */
export function profilePatch(
  user: Pick<UserProfile, "nickname" | "avatarUrl"> | null | undefined,
  nickDraft: string,
  avatarDraft: string | null,
): UpdateMeRequest | null {
  const patch: UpdateMeRequest = {};
  const nickname = nickDraft.trim();
  if (nickname !== (user?.nickname ?? "").trim()) patch.nickname = nickname;
  if (avatarDraft && avatarDraft !== user?.avatarUrl) {
    patch.avatarUrl = avatarDraft;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
