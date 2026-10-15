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
