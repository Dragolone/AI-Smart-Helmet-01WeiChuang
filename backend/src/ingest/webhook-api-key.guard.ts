import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * 云端算法服务 → 后端 Webhook 的来源校验（API.md §12，决策 #7）：
 * X-Api-Key 与环境变量比对；env 未配置时失败关闭（与 EMQX internal-token.guard 同哲学）。
 * ⚠️ 若算法服务方有既定签名方案则从其约定（Contract 标注），届时替换本 Guard。
 */
@Injectable()
export class WebhookApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.INGEST_WEBHOOK_API_KEY;
    const req = context.switchToHttp().getRequest<Request>();
    const got = req.headers['x-api-key'];
    if (!expected || got !== expected) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'API key 无效',
      });
    }
    return true;
  }
}
