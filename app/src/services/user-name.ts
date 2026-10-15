// 人的显示名：昵称按头盔名同样的规则整理（去掉看不见的字符、压空白），整理完为空就回退。
// 接口接受空串 / 全空白 / 零宽 / 换行的昵称（2026-10-16 华为实测：资料卡没名字、对讲格子只剩「（我）」）。
import { cleanHelmetName } from "./safety-status";

type Person =
  { nickname?: string | null; phone?: string | null } | null | undefined;

/** 整理后的昵称；没有可显示的昵称时是空串 */
export const cleanNickname = (nickname: string | null | undefined): string =>
  cleanHelmetName(nickname);

/** 昵称 → 手机号（别人的手机号服务端已脱敏）→ fallback */
export function personNameOf(person: Person, fallback: string): string {
  return cleanNickname(person?.nickname) || person?.phone || fallback;
}

/**
 * 头像圆里写的那一个字：先按同样规则整理（去掉看不见的字符），按码点取第一个字——
 * 原来 slice(0, 1) 按 UTF-16 切，表情开头的名字只切到半个代理对，显示成「?」方块；
 * 零宽开头的名字头像是空白圆（2026-10-16 模拟器联系人页）。大写后变成多个字（ß → SS）时保留原字。
 */
export function avatarInitial(
  name: string | null | undefined,
  fallback = "?",
): string {
  const first = Array.from(cleanNickname(name))[0];
  if (!first) return fallback;
  const upper = first.toUpperCase();
  return Array.from(upper).length === 1 ? upper : first;
}
