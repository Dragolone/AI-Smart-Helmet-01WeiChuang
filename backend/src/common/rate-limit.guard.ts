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

/**
 * 限频规则：同一路由可叠多条（如「每 IP 每分钟」+「每 IP+手机号每分钟」），任一超限即 429。
 * keyBy=ip+phone 时从请求体取 phone（登录/发码按号维度限）；体里没有 phone 则退化为 ip。
 */
export interface RateLimitRule {
  name: string;
  limit: number;
  windowMs: number;
  keyBy?: 'ip' | 'ip+phone';
}

export const RATE_LIMIT_KEY = 'rate_limit_rules';
export const RateLimit = (...rules: RateLimitRule[]) =>
  SetMetadata(RATE_LIMIT_KEY, rules);

/** 桶数量上限：超过即整表清空重来（宁可放行一小段，不可无限占内存） */
const MAX_BUCKETS = 50_000;
const PRUNE_INTERVAL_MS = 60_000;

/**
 * 单实例内存滑动窗口限频（模块化单体 + 单实例部署，不引入 Redis）。
 * 只挂在 @RateLimit() 标注的公开接口上（登录撞库、短信轰炸面）；业务接口本身有 JWT 归属校验。
 * 部署在 Caddy 后面时 main.ts 已开 trust proxy，req.ip 是真实客户端地址。
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, number[]>();
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

    const ip = req.ip ?? 'unknown';
    const phone = (req.body as { phone?: unknown } | undefined)?.phone;
    for (const rule of rules) {
      const subject =
        rule.keyBy === 'ip+phone' && typeof phone === 'string'
          ? `${ip}|${phone}`
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
      hits.push(now);
      this.buckets.set(key, hits);
    }
    return true;
  }

  private maybePrune(now: number): void {
    if (this.buckets.size > MAX_BUCKETS) {
      this.buckets.clear();
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
}
