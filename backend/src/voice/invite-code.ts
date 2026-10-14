import { randomInt } from 'node:crypto';

/**
 * 邀请码字符集（决策 #57）：2–9 + 去掉 I/L/O 的大写字母，共 31 个。
 * 去掉的几个字符与 0/1 看着像，口头报码、手抄都容易错；31^6 ≈ 8.9 亿，比纯数字的 90 万难猜约 1,000 倍。
 */
export const INVITE_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const INVITE_CODE_LENGTH = 6;

export const generateInviteCode = (): string => {
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    code += INVITE_CODE_ALPHABET[randomInt(INVITE_CODE_ALPHABET.length)];
  }
  return code;
};

/**
 * 入参归一化：大小写不敏感；O→0、I/L→1 只为 2026-10-15 前发出的纯数字旧码兜底——新码里本来没有这几个字符，不会误判。
 * 不做 trim：ValidationPipe 已按 ^[0-9A-Za-z]{6}$ 拦下带空格的输入，这里只处理合法形状。
 */
export const normalizeInviteCode = (raw: string): string =>
  raw.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
