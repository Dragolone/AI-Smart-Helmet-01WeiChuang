import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

export const ALLOW_NUL_KEY = 'allowNul';
/**
 * 标记接口跳过 NUL 拦截：设备/算法入口（Ingest、EMQX 回调）自行把脏 envelope 留档为 invalid，
 * 整批 400 会把队列里后面的 possible_fall 一起卡住（上线前加固 P0 口径）。
 */
export const AllowNul = () => SetMetadata(ALLOW_NUL_KEY, true);

const MAX_DEPTH = 64;

function containsNul(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return value.includes('\u0000');
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) {
    return false;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key.includes('\u0000') || containsNul(child, depth + 1)) return true;
  }
  return false;
}

/**
 * PostgreSQL 不接受文本里的 NUL（\u0000），任何自由文本字段（昵称、联系人、设备名、频道名、密码…）
 * 带它都会让 Prisma 抛错变成 500。统一在入口按 400 VALIDATION_FAILED 拒绝，业务 DTO 不必逐个防。
 */
@Injectable()
export class NulGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allow = this.reflector.getAllAndOverride<boolean>(ALLOW_NUL_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allow) return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (
      containsNul(req.body) ||
      containsNul(req.query) ||
      containsNul(req.params)
    ) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: '字段不能包含 NUL 字符',
      });
    }
    return true;
  }
}
