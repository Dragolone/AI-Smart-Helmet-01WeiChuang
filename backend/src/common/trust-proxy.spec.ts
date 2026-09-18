import { resolveTrustProxy } from './trust-proxy';

describe('resolveTrustProxy（审计 AUTH-07：默认不信任 X-Forwarded-For）', () => {
  it.each([undefined, '', '  ', '0', 'false', 'FALSE'])(
    '%p → false（直连/本地：伪造 XFF 不能改写 req.ip）',
    (raw) => {
      expect(resolveTrustProxy(raw)).toBe(false);
    },
  );

  it('"1" → 1（compose 部署：只信 Caddy 这一跳）', () => {
    expect(resolveTrustProxy('1')).toBe(1);
    expect(resolveTrustProxy(' 2 ')).toBe(2);
  });

  it('"true" → true；其余字符串原样交给 express（如 loopback / 网段）', () => {
    expect(resolveTrustProxy('true')).toBe(true);
    expect(resolveTrustProxy('loopback')).toBe('loopback');
    expect(resolveTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
  });
});
