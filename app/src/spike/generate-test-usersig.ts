// Week 2 RTC Spike 专用：本地生成 TRTC 调试 UserSig（腾讯官方 TLS-Sig-API-v2 算法）
// ⚠️ 仅限开发调试：正式环境 UserSig 必须由后端签发，SecretKey 绝不进客户端（见 docs/DECISIONS.md 安全规则）
import { sha256 } from 'js-sha256';
import { deflate } from 'pako';

const BASE64_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    out += BASE64_CHARS[a >> 2];
    out += BASE64_CHARS[((a & 3) << 4) | (b === undefined ? 0 : b >> 4)];
    out += b === undefined ? '=' : BASE64_CHARS[((b & 15) << 2) | (c === undefined ? 0 : c >> 6)];
    out += c === undefined ? '=' : BASE64_CHARS[c & 63];
  }
  return out;
}

/** 腾讯的 base64url 变体：+ → *，/ → -，= → _ */
function base64UrlEscape(b64: string): string {
  return b64.replace(/\+/g, '*').replace(/\//g, '-').replace(/=/g, '_');
}

export function generateTestUserSig(
  sdkAppId: number,
  secretKey: string,
  userId: string,
  expireSeconds = 7 * 24 * 60 * 60,
): string {
  const currTime = Math.floor(Date.now() / 1000);
  // 签名内容拼接顺序是算法规定的，不可调整
  const contentToSign =
    `TLS.identifier:${userId}\n` +
    `TLS.sdkappid:${sdkAppId}\n` +
    `TLS.time:${currTime}\n` +
    `TLS.expire:${expireSeconds}\n`;
  const sig = bytesToBase64(
    new Uint8Array(sha256.hmac.arrayBuffer(secretKey, contentToSign)),
  );
  const doc = JSON.stringify({
    'TLS.ver': '2.0',
    'TLS.identifier': userId,
    'TLS.sdkappid': sdkAppId,
    'TLS.expire': expireSeconds,
    'TLS.time': currTime,
    'TLS.sig': sig,
  });
  return base64UrlEscape(bytesToBase64(deflate(doc)));
}
