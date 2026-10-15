// 对讲邀请码的输入整理（2026-10-16）。频道页「分享邀请码」发出去的是一整句话
//（「加入我的骑行对讲频道「周末骑行队」，在零一智行 App 输入邀请码：K7RM3X」）；微信里长按复制默认复制整条消息，
// 原来粘进只收 6 个字的输入框会被截成「加入我的骑行」，再提示「邀请码是 6 位字母或数字」，加不进去。
// 这里从粘进来的文字里把邀请码认出来；大小写、0/O、1/I/L 的归一交给服务端（normalizeInviteCode）。

const CODE = /^[0-9A-Za-z]{6}$/;
/** 分享文案里邀请码前面那几个字（三种语言的 intercom.shareMessage） */
const AFTER_MARKER =
  /(?:邀请码|邀請碼|invite\s*code)\s*[：:]?\s*([0-9A-Za-z]{6})(?![0-9A-Za-z])/i;
/** 复制时夹带的看不见的字符 */
const INVISIBLE = /[​-‏‪-‮⁠⁦-⁩﻿]/g;

/**
 * 从输入框里的文字认出邀请码；认不出返回 null。
 * 认：正好 6 位字母数字（中间夹空格 / 横线也认，如「K7R M3X」）、全角字母数字、整句分享文案。
 */
export function inviteCodeFrom(text: string): string | null {
  const t = text
    .replace(INVISIBLE, "")
    // 全角字母数字（中文输入法全角状态下打的）换成半角
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0),
    )
    .trim();
  const compact = t.replace(/[\s\-－]/g, "");
  if (CODE.test(compact)) return compact;
  return AFTER_MARKER.exec(t)?.[1] ?? null;
}
