import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** 每个请求分配 requestId：统一错误格式（API.md §1）与日志排查的关联键。 */
export function requestIdMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  (req as Request & { requestId: string }).requestId = `req_${randomUUID()}`;
  next();
}
