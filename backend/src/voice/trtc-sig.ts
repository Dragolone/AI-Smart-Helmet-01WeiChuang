import { createHmac } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/**
 * 腾讯 TRTC UserSig（TLS-Sig-API-v2）签发——官方公开算法自实现（决策 #27⑥）：
 * HMAC-SHA256 签名 → JSON 文档 → zlib deflate → base64 → 字符映射（+→* /→- =→_）。
 * 约 60 行换掉一个 SDK 依赖；verifyUserSig 仅测试用（回环校验算法正确性）。
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
): string {
  const content =
    `TLS.identifier:${identifier}\n` +
    `TLS.sdkappid:${sdkAppId}\n` +
    `TLS.time:${time}\n` +
    `TLS.expire:${expire}\n`;
  return createHmac('sha256', secretKey).update(content).digest('base64');
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
  const compressed = deflateSync(Buffer.from(JSON.stringify(doc)));
  return compressed
    .toString('base64')
    .replace(/\+/g, '*')
    .replace(/\//g, '-')
    .replace(/=/g, '_');
}

/** 回环校验（测试用）：解开 userSig 重算 HMAC 比对，证明签发实现与规范一致 */
export function verifyUserSig(
  config: TrtcSigConfig,
  userSig: string,
): { identifier: string; sdkAppId: number; time: number; expire: number } {
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
  const expected = hmac(config.secretKey, identifier, sdkAppId, time, expire);
  if (doc['TLS.sig'] !== expected) {
    throw new Error('UserSig HMAC 校验失败');
  }
  return { identifier, sdkAppId, time, expire };
}
