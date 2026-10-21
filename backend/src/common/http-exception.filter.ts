import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/** HTTP 状态码到统一错误码的兜底映射；业务代码可在异常 response 里带 code 覆盖。 */
const STATUS_CODE_MAP: Record<number, string> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  503: 'SERVICE_UNAVAILABLE',
};

interface ClientHttpError extends Error {
  status: number;
  expose?: boolean;
  type?: string;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Express 中间件层（body-parser 等）抛出的 4xx HttpError */
function isClientHttpError(err: unknown): err is ClientHttpError {
  if (!(err instanceof Error)) return false;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

/** 统一错误格式（API.md §1）：{ code, message, requestId }；客户端只依赖 code。 */
@Catch()
export class UnifiedExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(UnifiedExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { requestId?: string }>();
    const requestId = req.requestId ?? 'req_unknown';

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Internal server error';
    let details: Record<string, unknown> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (typeof body === 'object' && body !== null) {
        const b = body as {
          code?: string;
          message?: string | string[];
          details?: unknown;
        };
        message = Array.isArray(b.message)
          ? b.message.join('; ')
          : (b.message ?? exception.message);
        if (b.code) code = b.code;
        // 业务异常可带结构化补充（如上限值 limit），客户端按 code 决定读哪些键；只认普通对象（API.md §1）
        if (isPlainObject(b.details)) details = b.details;
      }
      if (code === 'INTERNAL_ERROR') {
        code = STATUS_CODE_MAP[status] ?? `HTTP_${status}`;
      }
    } else if (isClientHttpError(exception)) {
      // Express/body-parser 抛的 HttpError（413 entity.too.large、400 entity.parse.failed 等）：
      // 是客户端问题，按 4xx 统一格式返回；不打堆栈，避免被用来刷 ERROR 日志
      status = exception.status;
      code = STATUS_CODE_MAP[status] ?? `HTTP_${status}`;
      message = exception.expose ? exception.message : '请求无法处理';
      this.logger.warn(
        `客户端请求错误 [${requestId}] ${status} ${exception.type ?? ''}`,
      );
    } else {
      // 未预期异常：完整堆栈进日志，响应体不泄露内部细节
      this.logger.error(
        `未处理异常 [${requestId}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    res
      .status(status)
      .json({ code, message, requestId, ...(details && { details }) });
  }
}
