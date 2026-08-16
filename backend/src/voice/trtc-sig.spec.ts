import { genUserSig, verifyUserSig } from './trtc-sig';

describe('TRTC UserSig（TLS-Sig-API-v2 自实现）', () => {
  const config = {
    sdkAppId: 1400000001,
    secretKey: 'test_secret_key_not_real',
    expireSeconds: 86400,
  };

  it('签发 → 回环解码：字段与 HMAC 全部对得上', () => {
    const now = 1755300000;
    const sig = genUserSig(config, 'user_abc', now);
    // 官方字符映射后不应再出现 base64 保留字符
    expect(sig).not.toMatch(/[+/=]/);

    const decoded = verifyUserSig(config, sig);
    expect(decoded).toEqual({
      identifier: 'user_abc',
      sdkAppId: config.sdkAppId,
      time: now,
      expire: config.expireSeconds,
    });
  });

  it('密钥不对 → HMAC 校验失败', () => {
    const sig = genUserSig(config, 'user_abc');
    expect(() =>
      verifyUserSig({ ...config, secretKey: 'wrong_key' }, sig),
    ).toThrow('HMAC 校验失败');
  });

  it('不同用户/不同时刻的签名互不相同', () => {
    const a = genUserSig(config, 'user_a', 1755300000);
    const b = genUserSig(config, 'user_b', 1755300000);
    const c = genUserSig(config, 'user_a', 1755300001);
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
