import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { isIPv6 } from 'node:net';
import { PHONE_PATTERN } from './phone';

/**
 * 限频规则：同一路由可叠多条（如「每 IP 每分钟」+「每 IP+手机号每分钟」），任一超限即 429。
 * keyBy=ip+phone 时从请求体取 phone（登录/发码按号维度限）；体里没有 phone 则退化为 ip。
 * keyBy=user 按登录用户限（JwtAuthGuard 先于本 guard 注册，req.user 已就位）；未登录退化为 ip。
 */
export interface RateLimitRule {
  name: string;
  limit: number;
  windowMs: number;
  keyBy?: 'ip' | 'ip+phone' | 'user';
}

/**
 * 改密 / 换号 / 注销三处都要当前密码（#153 的威胁模型：别人借用解锁的手机两分钟）；错了 400 且不消费验证码，
 * 没有限频就是一个无代价的密码 oracle——持会话者脚本猜密码，猜中即换号夺号。三处共用同一额度，
 * 限的是尝试次数不分对错：同用户 5 次/分 + 同 IP 20 次/分
 */
export const PASSWORD_CHECK_LIMITS: readonly RateLimitRule[] = [
  { name: 'password_user', limit: 5, windowMs: 60_000, keyBy: 'user' },
  { name: 'password_ip', limit: 20, windowMs: 60_000 },
];

/**
 * 限频用的 IP 键（2026-10-16）：IPv6 按 /64 网段聚合——运营商给一台终端分的就是一整个 /64，
 * 按单个地址计，换地址就能无限绕过同 IP 限频。IPv4 映射地址（::ffff:a.b.c.d）还原成 IPv4，
 * 同一来源不因监听方式不同落进两个桶
 */
export function rateLimitIpKey(ip: string): string {
  const addr = ip.split('%')[0];
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (mapped) return mapped[1];
  if (!isIPv6(addr)) return ip;
  const groups = (part: string): string[] =>
    part
      ? part.split(':').flatMap((g) => (g.includes('.') ? ['0', '0'] : [g]))
      : [];
  const gap = addr.indexOf('::');
  const head = groups(gap < 0 ? addr : addr.slice(0, gap));
  const tail = gap < 0 ? [] : groups(addr.slice(gap + 2));
  const full = [
    ...head,
    ...Array<string>(8 - head.length - tail.length).fill('0'),
    ...tail,
  ];
  return `${full
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`;
}

export const RATE_LIMIT_KEY = 'rate_limit_rules';
export const RateLimit = (...rules: RateLimitRule[]) =>
  SetMetadata(RATE_LIMIT_KEY, rules);

/**
 * 桶数量上限：超过时淘汰最久没命中的桶，而不是整表清空——清空会让单个 IP 用海量不同手机号的
 * 被拒请求把全站限频归零（审计 AUTH-08）。被拒的请求不建桶、不计数，防止靠制造 key 撑爆表。
 */
const MAX_BUCKETS = 50_000;
const PRUNE_INTERVAL_MS = 60_000;
/** 淘汰时先清已出各自窗口的桶，仍超限再按「最先到期」淘汰这一比例 */
const EVICT_RATIO = 0.1;

/**
 * 单实例内存滑动窗口限频（模块化单体 + 单实例部署，不引入 Redis）。
 * 只挂在 @RateLimit() 标注的公开接口上（登录撞库、短信轰炸面）；业务接口本身有 JWT 归属校验。
 * 部署在 Caddy 后面时 main.ts 已开 trust proxy，req.ip 是真实客户端地址。
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, number[]>();
  /** 规则名 → 窗口长度：淘汰时按桶所属规则的窗口判断，而不是一刀切 */
  private readonly windowByRule = new Map<string, number>();
  private lastPrune = Date.now();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const rules = this.reflector.getAllAndOverride<RateLimitRule[] | undefined>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!rules?.length) return true;
    // 压力/联调可临时关闭（.env.example 有键）；生产禁止设置
    if (process.env.RATE_LIMIT_DISABLED === '1') return true;

    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const now = Date.now();
    this.maybePrune(now);

    const ip = req.ip ? rateLimitIpKey(req.ip) : 'unknown';
    const phone = (req.body as { phone?: unknown } | undefined)?.phone;
    // 手机号只接受合法格式做 key，否则退化为 ip：任意字符串都能造键会把桶表撑爆
    const phoneKey =
      typeof phone === 'string' && PHONE_PATTERN.test(phone) ? phone : null;
    const userId = (req as { user?: { userId?: unknown } }).user?.userId;
    const userKey = typeof userId === 'string' && userId ? userId : null;
    // 先把所有规则判完，全部通过才记账：被拒请求不留痕（既不建桶也不占额度）
    const passed: Array<{ key: string; hits: number[] }> = [];
    for (const rule of rules) {
      this.windowByRule.set(rule.name, rule.windowMs);
      const subject =
        rule.keyBy === 'user' && userKey
          ? `u|${userKey}`
          : rule.keyBy === 'ip+phone' && phoneKey
            ? `${ip}|${phoneKey}`
            : ip;
      const key = `${rule.name}:${subject}`;
      const hits = (this.buckets.get(key) ?? []).filter(
        (t) => now - t < rule.windowMs,
      );
      if (hits.length >= rule.limit) {
        const retryAfterSec = Math.ceil((hits[0] + rule.windowMs - now) / 1000);
        res.setHeader('Retry-After', String(Math.max(retryAfterSec, 1)));
        throw new HttpException(
          { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      passed.push({ key, hits });
    }
    for (const { key, hits } of passed) {
      hits.push(now);
      this.buckets.set(key, hits);
    }
    return true;
  }

  private maybePrune(now: number): void {
    if (this.buckets.size > MAX_BUCKETS) {
      this.evict(now);
      this.lastPrune = now;
      return;
    }
    if (now - this.lastPrune < PRUNE_INTERVAL_MS) return;
    this.lastPrune = now;
    for (const [key, hits] of this.buckets) {
      // 最长窗口是 24h（发码日限）；更早的记录任何规则都用不到
      const alive = hits.filter((t) => now - t < 24 * 60 * 60_000);
      if (alive.length === 0) this.buckets.delete(key);
      else this.buckets.set(key, alive);
    }
  }

  /** 桶失效时刻：最近一次命中 + 所属规则窗口；过了这一刻桶对任何判定都没有影响 */
  private expiresAt(key: string, hits: number[]): number {
    const window =
      this.windowByRule.get(key.slice(0, key.indexOf(':'))) ??
      PRUNE_INTERVAL_MS;
    return hits[hits.length - 1] + window;
  }

  /**
   * 容量淘汰：先删已失效的桶（无损）；仍超限时淘汰最先失效的一批。
   * 原先按「1 分钟无命中」一刀切，24h 的 sms_day 桶也被清掉——单个 IP 用 5 万个随机号码的
   * 找回密码请求把表撑满，就能把自己的每日发码上限归零（2026-10-14 排查）
   */
  private evict(now: number): void {
    for (const [key, hits] of this.buckets) {
      if (this.expiresAt(key, hits) <= now) this.buckets.delete(key);
    }
    if (this.buckets.size <= MAX_BUCKETS) return;
    const byExpiry = [...this.buckets.entries()].sort(
      (a, b) => this.expiresAt(a[0], a[1]) - this.expiresAt(b[0], b[1]),
    );
    for (const [key] of byExpiry.slice(
      0,
      Math.ceil(byExpiry.length * EVICT_RATIO),
    )) {
      this.buckets.delete(key);
    }
  }
}
