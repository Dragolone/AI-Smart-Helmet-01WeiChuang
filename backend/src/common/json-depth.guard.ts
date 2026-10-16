import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * 请求体 JSON 的最大嵌套层数。ValidationPipe 里的 class-transformer 逐层递归处理请求体（连 DTO 没声明、
 * 之后会被 whitelist 丢掉的字段也会先递归一遍），约 4000 层（20KB 出头）就栈溢出成 500——公开的登录 / 发码接口
 * 不带令牌也能打（边界测试 B9）。正常请求不超过十层；设备入口的既有口径是「payload 嵌套 1000 层也照收」
 * （audit-ingest-entries 坏输入矩阵），所以取 2000：比既有口径宽一倍、比栈溢出点低一半。
 */
export const MAX_JSON_DEPTH = 2000;

/** 迭代遍历（不递归，免得检查本身也栈溢出）：任一分支超过 limit 层即返回 true */
export function jsonDepthExceeds(value: unknown, limit: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (node === null || typeof node !== 'object') continue;
    if (depth > limit) return true;
    for (const child of Object.values(node as Record<string, unknown>)) {
      if (child !== null && typeof child === 'object') {
        stack.push([child, depth + 1]);
      }
    }
  }
  return false;
}

/** 全局守卫：在 ValidationPipe 之前拦下嵌套过深的请求体，统一 400 VALIDATION_FAILED（设备入口同样适用——深到会让 Pipe 崩的批次本来就整批 500） */
@Injectable()
export class JsonDepthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (jsonDepthExceeds(req.body, MAX_JSON_DEPTH)) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: `请求体嵌套超过 ${MAX_JSON_DEPTH} 层`,
      });
    }
    return true;
  }
}
