import { genPrivateMapKey, genUserSig, verifyUserSig } from './trtc-sig';

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

  it('PrivateMapKey：绑定房间号、到期 = 签发时刻 + 有效期、全权限；换密钥校验失败（决策 #56）', () => {
    const now = 1760400000;
    const roomConfig = { ...config, expireSeconds: 600 };
    const key = genPrivateMapKey(roomConfig, 'user_abc', 1234567890, now);
    expect(key).not.toMatch(/[+/=]/);
    const decoded = verifyUserSig(roomConfig, key);
    expect(decoded).toEqual({
      identifier: 'user_abc',
      sdkAppId: config.sdkAppId,
      time: now,
      expire: 600,
      room: { roomId: 1234567890, expireAt: now + 600, privilegeMap: 255 },
    });
    expect(() =>
      verifyUserSig({ ...roomConfig, secretKey: 'wrong_key' }, key),
    ).toThrow('HMAC 校验失败');
    // 另一个房间的钥匙是另一串
    expect(genPrivateMapKey(roomConfig, 'user_abc', 1234567891, now)).not.toBe(
      key,
    );
  });

  it('不同用户/不同时刻的签名互不相同', () => {
    const a = genUserSig(config, 'user_a', 1755300000);
    const b = genUserSig(config, 'user_b', 1755300000);
    const c = genUserSig(config, 'user_a', 1755300001);
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
