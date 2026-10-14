import { createHmac } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/**
 * 腾讯 TRTC UserSig（TLS-Sig-API-v2）签发——官方公开算法自实现（决策 #27⑥）：
 * HMAC-SHA256 签名 → JSON 文档 → zlib deflate → base64 → 字符映射（+→* /→- =→_）。
 * 约 60 行换掉一个 SDK 依赖；verifyUserSig 仅测试用（回环校验算法正确性）。
 *
 * PrivateMapKey（决策 #56，2026-10-14）：同一套算法多签一段 userbuf（账号 + sdkAppId + 房间号 + 绝对到期时间 +
 * 权限位），TRTC 控制台开启「高级权限控制」后进房必须带它——UserSig 只证明「是这个用户」，不绑房间，
 * 任何人建个频道拿到 UserSig 就能挨个房间偷听。
 */

export interface TrtcSigConfig {
  sdkAppId: number;
  secretKey: string;
  expireSeconds: number;
}

function hmac(
  secretKey: string,
  identifier: string,
  sdkAppId: number,
  time: number,
  expire: number,
  userBuf?: string,
): string {
  const content =
    `TLS.identifier:${identifier}\n` +
    `TLS.sdkappid:${sdkAppId}\n` +
    `TLS.time:${time}\n` +
    `TLS.expire:${expire}\n` +
    (userBuf ? `TLS.userbuf:${userBuf}\n` : '');
  return createHmac('sha256', secretKey).update(content).digest('base64');
}

/** 官方 TLS-Sig-API-v2 的字符映射：base64 的 + / = 换成 URL 安全字符 */
function encodeDoc(doc: Record<string, unknown>): string {
  return deflateSync(Buffer.from(JSON.stringify(doc)))
    .toString('base64')
    .replace(/\+/g, '*')
    .replace(/\//g, '-')
    .replace(/=/g, '_');
}

/** TRTC 权限位：255 = 全部（创建 / 加入房间、收发音视频）。对讲频道成员就是全权限 */
export const TRTC_ALL_PRIVILEGES = 255;

/**
 * userbuf（官方 genUserBuf 的二进制布局，数字房间号版本 0）：
 * [版本 1B][账号长度 2B][账号][sdkAppId 4B][房间号 4B][到期时间 4B（绝对秒）][权限位 4B][账号类型 4B]
 */
function buildUserBuf(
  identifier: string,
  sdkAppId: number,
  roomId: number,
  expireAt: number,
  privilegeMap: number,
): Buffer {
  const account = Buffer.from(identifier, 'utf-8');
  const buf = Buffer.alloc(1 + 2 + account.length + 20);
  let offset = 0;
  buf[offset++] = 0;
  buf.writeUInt16BE(account.length, offset);
  offset += 2;
  account.copy(buf, offset);
  offset += account.length;
  for (const n of [sdkAppId, roomId, expireAt, privilegeMap, 0]) {
    buf.writeUInt32BE(n >>> 0, offset);
    offset += 4;
  }
  return buf;
}

export interface TrtcRoomPermission {
  roomId: number;
  expireAt: number;
  privilegeMap: number;
}

function parseUserBuf(base64: string): TrtcRoomPermission & {
  identifier: string;
  sdkAppId: number;
} {
  const buf = Buffer.from(base64, 'base64');
  const accountLength = buf.readUInt16BE(1);
  let offset = 3;
  const identifier = buf.subarray(offset, offset + accountLength).toString();
  offset += accountLength;
  const sdkAppId = buf.readUInt32BE(offset);
  const roomId = buf.readUInt32BE(offset + 4);
  const expireAt = buf.readUInt32BE(offset + 8);
  const privilegeMap = buf.readUInt32BE(offset + 12);
  return { identifier, sdkAppId, roomId, expireAt, privilegeMap };
}

export function genUserSig(
  config: TrtcSigConfig,
  identifier: string,
  now = Math.floor(Date.now() / 1000),
): string {
  const doc = {
    'TLS.ver': '2.0',
    'TLS.identifier': identifier,
    'TLS.sdkappid': config.sdkAppId,
    'TLS.expire': config.expireSeconds,
    'TLS.time': now,
    'TLS.sig': hmac(
      config.secretKey,
      identifier,
      config.sdkAppId,
      now,
      config.expireSeconds,
    ),
  };
  return encodeDoc(doc);
}

/**
 * 房间权限钥匙（PrivateMapKey）：绑定 roomId，config.expireSeconds 是它自己的有效期（默认 10 分钟，
 * App 进房前现取 /token，与 UserSig 的 24 h 无关）。
 */
export function genPrivateMapKey(
  config: TrtcSigConfig,
  identifier: string,
  roomId: number,
  now = Math.floor(Date.now() / 1000),
): string {
  const userBuf = buildUserBuf(
    identifier,
    config.sdkAppId,
    roomId,
    now + config.expireSeconds,
    TRTC_ALL_PRIVILEGES,
  ).toString('base64');
  const doc = {
    'TLS.ver': '2.0',
    'TLS.identifier': identifier,
    'TLS.sdkappid': config.sdkAppId,
    'TLS.expire': config.expireSeconds,
    'TLS.time': now,
    'TLS.userbuf': userBuf,
    'TLS.sig': hmac(
      config.secretKey,
      identifier,
      config.sdkAppId,
      now,
      config.expireSeconds,
      userBuf,
    ),
  };
  return encodeDoc(doc);
}

/**
 * 回环校验（测试用）：解开 userSig / privateMapKey 重算 HMAC 比对，证明签发实现与规范一致；
 * 带 userbuf 的（PrivateMapKey）顺带解出房间号 / 到期时间 / 权限位
 */
export function verifyUserSig(
  config: TrtcSigConfig,
  userSig: string,
): {
  identifier: string;
  sdkAppId: number;
  time: number;
  expire: number;
  room?: TrtcRoomPermission;
} {
  const base64 = userSig
    .replace(/\*/g, '+')
    .replace(/-/g, '/')
    .replace(/_/g, '=');
  const doc = JSON.parse(
    inflateSync(Buffer.from(base64, 'base64')).toString(),
  ) as Record<string, unknown>;
  const identifier = String(doc['TLS.identifier']);
  const sdkAppId = Number(doc['TLS.sdkappid']);
  const time = Number(doc['TLS.time']);
  const expire = Number(doc['TLS.expire']);
  const userBuf =
    typeof doc['TLS.userbuf'] === 'string' ? doc['TLS.userbuf'] : undefined;
  const expected = hmac(
    config.secretKey,
    identifier,
    sdkAppId,
    time,
    expire,
    userBuf,
  );
  if (doc['TLS.sig'] !== expected) {
    throw new Error('UserSig HMAC 校验失败');
  }
  if (!userBuf) return { identifier, sdkAppId, time, expire };
  const parsed = parseUserBuf(userBuf);
  if (parsed.identifier !== identifier || parsed.sdkAppId !== sdkAppId) {
    throw new Error('PrivateMapKey userbuf 与签名头不一致');
  }
  const { roomId, expireAt, privilegeMap } = parsed;
  return {
    identifier,
    sdkAppId,
    time,
    expire,
    room: { roomId, expireAt, privilegeMap },
  };
}
