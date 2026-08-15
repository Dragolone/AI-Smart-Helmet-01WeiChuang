import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

/** EMQX → 后端内部接口的来源校验：共享令牌不匹配一律拒绝（env 未配置时失败关闭）。 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.EMQX_INTERNAL_TOKEN;
    const req = context.switchToHttp().getRequest<Request>();
    // 支持 header 或 query 两种携带方式（EMQX 环境变量配置里 query 形式最省事）
    const got = req.headers['x-internal-token'] ?? req.query.token;
    if (!expected || got !== expected) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'internal token 无效',
      });
    }
    return true;
  }
}
