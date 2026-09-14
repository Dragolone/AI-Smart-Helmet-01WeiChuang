// 2026-09-13 全面审计（voice 领域）专用辅助：独立实现的 TLS-Sig-API-v2 解码回环、
// webhook 投递、频道数据清理。不复用 src/voice/trtc-sig 的 verifyUserSig，
// 以免"用被测代码验证被测代码"。注意：这里只是自解码回环，不等于腾讯云服务商兼容验证。
import { createHmac } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import request from 'supertest';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { Http } from './hardening';

export interface DecodedUserSig {
  ver: string;
  identifier: string;
  sdkAppId: number;
  time: number;
  expire: number;
  sig: string;
  hmacMatches: boolean;
}

/**
 * 按腾讯官方 TLSSigAPIv2（tls-sig-api-v2 开源实现）独立解码：
 * 反向字符映射（* → +，- → /，_ → =）→ base64 解码 → zlib inflate → JSON。
 * HMAC-SHA256 明文 = "TLS.identifier:<id>\nTLS.sdkappid:<app>\nTLS.time:<t>\nTLS.expire:<e>\n"，
 * 以 base64 输出。
 */
export const decodeUserSigIndependently = (
  userSig: string,
  secretKey: string,
): DecodedUserSig => {
  const restored = userSig
    .split('*')
    .join('+')
    .split('-')
    .join('/')
    .split('_')
    .join('=');
  const json = inflateSync(Buffer.from(restored, 'base64')).toString('utf8');
  const doc = JSON.parse(json) as Record<string, unknown>;
  const identifier = String(doc['TLS.identifier']);
  const sdkAppId = Number(doc['TLS.sdkappid']);
  const time = Number(doc['TLS.time']);
  const expire = Number(doc['TLS.expire']);
  const sig = String(doc['TLS.sig']);
  const plain =
    `TLS.identifier:${identifier}\n` +
    `TLS.sdkappid:${sdkAppId}\n` +
    `TLS.time:${time}\n` +
    `TLS.expire:${expire}\n`;
  const expected = createHmac('sha256', secretKey)
    .update(plain)
    .digest('base64');
  return {
    ver: String(doc['TLS.ver']),
    identifier,
    sdkAppId,
    time,
    expire,
    sig,
    hmacMatches: sig === expected,
  };
};

export const VOICE_BASE = '/api/v1/voice/channels';

export const postWebhook = (
  http: Http,
  apiKey: string,
  envelope: Record<string, unknown>,
): request.Test =>
  request(http)
    .post('/api/v1/ingest/webhook')
    .set('X-Api-Key', apiKey)
    .send(envelope);

/** 清理指定用户创建/加入的频道（只碰自己造的数据） */
export async function cleanupChannels(
  prisma: PrismaService,
  userIds: string[],
): Promise<void> {
  if (userIds.length === 0) return;
  const swallow = () => undefined;
  const owned = await prisma.voiceChannel
    .findMany({ where: { ownerId: { in: userIds } }, select: { id: true } })
    .catch(() => []);
  const ids = owned.map((c) => c.id);
  await prisma.voiceChannelMember
    .deleteMany({
      where: { OR: [{ userId: { in: userIds } }, { channelId: { in: ids } }] },
    })
    .catch(swallow);
  await prisma.voiceChannel
    .deleteMany({ where: { id: { in: ids } } })
    .catch(swallow);
}
