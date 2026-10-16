// 内存滑动窗口限频守卫：多规则叠加、按 ip / ip+手机号 / 用户分桶、被拒请求不记账、Retry-After、
// 没有 req.ip 时共用 unknown 桶、定期清理过期桶。Reflector 与 ExecutionContext 用假对象，时钟用 fake timers。
import { HttpException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import {
  RateLimitGuard,
  rateLimitIpKey,
  type RateLimitRule,
} from './rate-limit.guard';

const ctx = (req: Record<string, unknown>) => {
  const setHeader = jest.fn();
  const context = {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({ setHeader }),
    }),
  } as unknown as ExecutionContext;
  return { context, setHeader };
};

describe('RateLimitGuard', () => {
  let rules: RateLimitRule[] | undefined;
  let guard: RateLimitGuard;
  const saved = process.env.RATE_LIMIT_DISABLED;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-16T00:00:00Z') });
    delete process.env.RATE_LIMIT_DISABLED;
    rules = [{ name: 'r', limit: 2, windowMs: 60_000 }];
    guard = new RateLimitGuard({
      getAllAndOverride: () => rules,
    } as unknown as Reflector);
  });
  afterEach(() => {
    jest.useRealTimers();
    if (saved === undefined) delete process.env.RATE_LIMIT_DISABLED;
    else process.env.RATE_LIMIT_DISABLED = saved;
  });

  const hit = (req: Record<string, unknown>) =>
    guard.canActivate(ctx(req).context);
  const rejected = (req: Record<string, unknown>) => {
    const c = ctx(req);
    let err: unknown;
    try {
      guard.canActivate(c.context);
    } catch (e) {
      err = e;
    }
    return { err, setHeader: c.setHeader };
  };

  it('路由没标 @RateLimit：直接放行', () => {
    rules = undefined;
    for (let i = 0; i < 10; i += 1) expect(hit({ ip: '1.1.1.1' })).toBe(true);
    rules = [];
    expect(hit({ ip: '1.1.1.1' })).toBe(true);
  });

  it('RATE_LIMIT_DISABLED=1：放行（压测 / 联调用）', () => {
    process.env.RATE_LIMIT_DISABLED = '1';
    for (let i = 0; i < 10; i += 1) expect(hit({ ip: '1.1.1.1' })).toBe(true);
  });

  it('超限 429 RATE_LIMITED，Retry-After 按最早一次命中算（秒，向上取整）', () => {
    hit({ ip: '1.1.1.1' });
    jest.advanceTimersByTime(20_500);
    hit({ ip: '1.1.1.1' });
    const { err, setHeader } = rejected({ ip: '1.1.1.1' });
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).getResponse()).toEqual({
      code: 'RATE_LIMITED',
      message: '请求过于频繁，请稍后再试',
    });
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '40');
    // 别的 IP 不受影响
    expect(hit({ ip: '2.2.2.2' })).toBe(true);
  });

  it('窗口滑过去就恢复额度', () => {
    hit({ ip: '1.1.1.1' });
    hit({ ip: '1.1.1.1' });
    expect(rejected({ ip: '1.1.1.1' }).err).toBeDefined();
    jest.advanceTimersByTime(60_000);
    expect(hit({ ip: '1.1.1.1' })).toBe(true);
  });

  it('被拒的请求不记账：拒绝期间狂刷不会延长封禁', () => {
    hit({ ip: '1.1.1.1' });
    jest.advanceTimersByTime(30_000);
    hit({ ip: '1.1.1.1' });
    for (let i = 0; i < 20; i += 1) rejected({ ip: '1.1.1.1' });
    jest.advanceTimersByTime(30_000); // 第一次命中出窗
    expect(hit({ ip: '1.1.1.1' })).toBe(true);
  });

  it('多条规则：任一超限即拒，且被拒时其他规则也不记账', () => {
    rules = [
      { name: 'wide', limit: 3, windowMs: 60_000 },
      { name: 'narrow', limit: 1, windowMs: 60_000, keyBy: 'ip+phone' },
    ];
    expect(hit({ ip: '1.1.1.1', body: { phone: '13800001111' } })).toBe(true);
    expect(
      rejected({ ip: '1.1.1.1', body: { phone: '13800001111' } }).err,
    ).toBeDefined();
    // narrow 拒了那次没占 wide 的额度：换号还能再来两次
    expect(hit({ ip: '1.1.1.1', body: { phone: '13800002222' } })).toBe(true);
    expect(hit({ ip: '1.1.1.1', body: { phone: '13800003333' } })).toBe(true);
    expect(
      rejected({ ip: '1.1.1.1', body: { phone: '13800004444' } }).err,
    ).toBeDefined();
  });

  it('ip+phone：手机号格式不合法时退化为按 ip（任意字符串不能造新桶）', () => {
    rules = [{ name: 'p', limit: 1, windowMs: 60_000, keyBy: 'ip+phone' }];
    expect(hit({ ip: '1.1.1.1', body: { phone: 'aaa' } })).toBe(true);
    expect(
      rejected({ ip: '1.1.1.1', body: { phone: 'bbb' } }).err,
    ).toBeDefined();
    expect(rejected({ ip: '1.1.1.1', body: { phone: 123 } }).err).toBeDefined();
    expect(rejected({ ip: '1.1.1.1' }).err).toBeDefined();
  });

  it('keyBy=user：按登录用户分桶，换 IP 也算同一人；未登录退化为 ip', () => {
    rules = [{ name: 'u', limit: 1, windowMs: 60_000, keyBy: 'user' }];
    expect(hit({ ip: '1.1.1.1', user: { userId: 'u1' } })).toBe(true);
    expect(
      rejected({ ip: '9.9.9.9', user: { userId: 'u1' } }).err,
    ).toBeDefined();
    expect(hit({ ip: '9.9.9.9', user: { userId: 'u2' } })).toBe(true);
    expect(hit({ ip: '5.5.5.5' })).toBe(true);
    expect(rejected({ ip: '5.5.5.5', user: { userId: '' } }).err).toBeDefined();
  });

  it('请求上没有 ip：都记在 unknown 桶里（共用额度）', () => {
    expect(hit({})).toBe(true);
    expect(hit({ ip: undefined })).toBe(true);
    expect(rejected({}).err).toBeDefined();
  });

  it('超过清理间隔后：24 小时前的旧桶被清掉，仍在窗口内的桶保留', () => {
    rules = [{ name: 'day', limit: 1, windowMs: 24 * 3_600_000 }];
    const buckets = (guard as unknown as { buckets: Map<string, number[]> })
      .buckets;
    hit({ ip: '1.1.1.1' });
    jest.advanceTimersByTime(23 * 3_600_000);
    hit({ ip: '2.2.2.2' });
    expect([...buckets.keys()].sort()).toEqual(['day:1.1.1.1', 'day:2.2.2.2']);
    jest.advanceTimersByTime(3_600_000 + 1);
    // 第三个 IP 的请求触发清理：1.1.1.1 的命中已满 24h → 整桶删除；2.2.2.2 还在窗口内 → 保留且仍拒
    hit({ ip: '3.3.3.3' });
    expect([...buckets.keys()].sort()).toEqual(['day:2.2.2.2', 'day:3.3.3.3']);
    expect(rejected({ ip: '2.2.2.2' }).err).toBeDefined();
  });

  it('不到清理间隔：不清理（过期的桶还留在表里，只是判定时被窗口过滤掉）', () => {
    rules = [{ name: 'short', limit: 1, windowMs: 1_000 }];
    const buckets = (guard as unknown as { buckets: Map<string, number[]> })
      .buckets;
    hit({ ip: '1.1.1.1' });
    jest.advanceTimersByTime(30_000);
    hit({ ip: '2.2.2.2' });
    expect(buckets.has('short:1.1.1.1')).toBe(true);
    expect(hit({ ip: '1.1.1.1' })).toBe(true);
  });

  describe('桶数量上限（5 万）淘汰', () => {
    const fill = (rule: string, n: number) => {
      for (let i = 0; i < n; i += 1) hit({ ip: `${rule}-${i}` });
    };
    const bucketsOf = () =>
      (guard as unknown as { buckets: Map<string, number[]> }).buckets;

    it('超过上限时先删已出各自窗口的桶：1 分钟规则的过期桶清掉，24 小时规则（发码日限）的桶保留', () => {
      rules = [{ name: 'sms_day', limit: 1, windowMs: 24 * 3_600_000 }];
      hit({ ip: 'victim' }); // 日限桶：被拒的人今天已发过一次
      rules = [{ name: 'min', limit: 5, windowMs: 60_000 }];
      jest.advanceTimersByTime(1); // 与日限桶错开，避免同一毫秒
      fill('flood', 50_000);
      expect(bucketsOf().size).toBe(50_001);
      jest.advanceTimersByTime(61_000); // 1 分钟桶全部过期
      hit({ ip: 'trigger' }); // 触发容量淘汰
      expect(bucketsOf().has('sms_day:victim')).toBe(true);
      expect(bucketsOf().size).toBe(2); // 日限桶 + 本次新建的桶
      rules = [{ name: 'sms_day', limit: 1, windowMs: 24 * 3_600_000 }];
      expect(rejected({ ip: 'victim' }).err).toBeDefined();
    });

    it('都还在窗口内仍超限：淘汰最先到期的 10%，最新的桶留下', () => {
      rules = [{ name: 'min', limit: 5, windowMs: 60_000 }];
      hit({ ip: 'oldest' });
      jest.advanceTimersByTime(10);
      fill('mid', 49_999);
      jest.advanceTimersByTime(10);
      hit({ ip: 'newest' });
      expect(bucketsOf().size).toBe(50_001);
      hit({ ip: 'trigger' });
      // 50001 个里淘汰 ceil(50001 × 0.1) = 5001 个，再加上触发请求新建的 1 个
      expect(bucketsOf().size).toBe(50_001 - 5_001 + 1);
      expect(bucketsOf().has('min:oldest')).toBe(false);
      expect(bucketsOf().has('min:newest')).toBe(true);
      expect(bucketsOf().has('min:trigger')).toBe(true);
    });
  });
  describe('IPv6 按 /64 聚合（2026-10-16）', () => {
    it.each([
      ['2408:8456:1:2:aaaa:bbbb:cccc:dddd', '2408:8456:1:2::/64'],
      ['2408:8456:0001:0002::1', '2408:8456:1:2::/64'],
      ['2408:8456::1', '2408:8456:0:0::/64'],
      ['::1', '0:0:0:0::/64'],
      ['fe80::1%eth0', 'fe80:0:0:0::/64'],
      ['64:ff9b::1.2.3.4', '64:ff9b:0:0::/64'],
      ['::ffff:1.2.3.4', '1.2.3.4'],
      ['1.2.3.4', '1.2.3.4'],
      ['not-an-ip', 'not-an-ip'],
    ])('%s → %s', (ip, key) => {
      expect(rateLimitIpKey(ip)).toBe(key);
    });

    it('同一 /64 换地址共用一个桶；别的 /64 不受影响', () => {
      expect(hit({ ip: '2408:8456:1:2::a' })).toBe(true);
      expect(hit({ ip: '2408:8456:1:2::b' })).toBe(true);
      expect(rejected({ ip: '2408:8456:1:2:ffff::c' }).err).toBeInstanceOf(
        HttpException,
      );
      expect(hit({ ip: '2408:8456:1:3::a' })).toBe(true);
    });

    it('IPv4 映射地址与纯 IPv4 是同一个桶', () => {
      expect(hit({ ip: '::ffff:5.6.7.8' })).toBe(true);
      expect(hit({ ip: '5.6.7.8' })).toBe(true);
      expect(rejected({ ip: '::ffff:5.6.7.8' }).err).toBeInstanceOf(
        HttpException,
      );
    });
  });
});
