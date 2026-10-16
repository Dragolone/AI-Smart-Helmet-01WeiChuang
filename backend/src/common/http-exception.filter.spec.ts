// 统一错误格式（API.md §1）：{ code, message, requestId }。覆盖 HttpException 各种 response 形态、
// Express 中间件 4xx、未预期异常三条路，以及缺 requestId 的兜底。
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
} from '@nestjs/common';
import { UnifiedExceptionFilter } from './http-exception.filter';

const hostFor = (requestId?: string) => {
  const json = jest.fn<void, [Record<string, unknown>]>();
  const status = jest.fn<{ json: typeof json }, [number]>(() => ({ json }));
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => (requestId ? { requestId } : {}),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
};

describe('UnifiedExceptionFilter', () => {
  const filter = new UnifiedExceptionFilter();
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  const run = (exception: unknown, requestId: string | null = 'req_1') => {
    const h = hostFor(requestId ?? undefined);
    filter.catch(exception, h.host);
    return {
      status: h.status.mock.calls[0][0],
      body: h.json.mock.calls[0][0],
    };
  };

  describe('HttpException', () => {
    it('业务异常自带 code：原样透传 code 与 message', () => {
      expect(
        run(
          new HttpException(
            { code: 'DEVICE_NOT_FOUND', message: '设备不存在' },
            404,
          ),
        ),
      ).toEqual({
        status: 404,
        body: {
          code: 'DEVICE_NOT_FOUND',
          message: '设备不存在',
          requestId: 'req_1',
        },
      });
    });

    it('校验管道的 message 数组：用「; 」拼成一句，code 按状态码兜底为 VALIDATION_FAILED', () => {
      const r = run(
        new BadRequestException({ message: ['phone 不合法', 'password 太短'] }),
      );
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        message: 'phone 不合法; password 太短',
      });
    });

    it('response 是纯字符串：直接当 message', () => {
      const r = run(new HttpException('自定义说明', HttpStatus.CONFLICT));
      expect(r.body).toEqual({
        code: 'CONFLICT',
        message: '自定义说明',
        requestId: 'req_1',
      });
    });

    it('response 对象没有 message：退回异常自身的 message', () => {
      const ex = new HttpException({ detail: 'x' }, HttpStatus.FORBIDDEN);
      const r = run(ex);
      expect(r.body).toMatchObject({ code: 'FORBIDDEN', message: ex.message });
    });

    it('映射表里没有的状态码（418）：code 写成 HTTP_418', () => {
      const r = run(new HttpException({ message: 'teapot' }, 418));
      expect(r).toEqual({
        status: 418,
        body: { code: 'HTTP_418', message: 'teapot', requestId: 'req_1' },
      });
    });

    it('response 既不是字符串也不是对象（数字）：保留默认文案，code 按状态码', () => {
      const r = run(new HttpException(42 as unknown as string, 503));
      expect(r.body).toEqual({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Internal server error',
        requestId: 'req_1',
      });
    });

    it('业务显式带 code=INTERNAL_ERROR 却是 4xx：按状态码改写（INTERNAL_ERROR 视为未指定）', () => {
      const r = run(
        new HttpException({ code: 'INTERNAL_ERROR', message: 'm' }, 429),
      );
      expect(r.body).toMatchObject({ code: 'RATE_LIMITED' });
    });

    it('请求上没有 requestId：回 req_unknown', () => {
      const r = run(new HttpException('x', 400), null);
      expect(r.body.requestId).toBe('req_unknown');
    });
  });

  describe('Express 中间件抛的 4xx HttpError', () => {
    const httpError = (
      status: number,
      message: string,
      extra: Record<string, unknown> = {},
    ) => Object.assign(new Error(message), { status, ...extra });

    it('413 entity.too.large 且 expose：按 4xx 统一格式返回原文案，只记 warn 不打堆栈', () => {
      const r = run(
        httpError(413, 'request entity too large', {
          expose: true,
          type: 'entity.too.large',
        }),
      );
      expect(r).toEqual({
        status: 413,
        body: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'request entity too large',
          requestId: 'req_1',
        },
      });
      expect(warnSpy).toHaveBeenCalledWith(
        '客户端请求错误 [req_1] 413 entity.too.large',
      );
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('expose=false：不回显原文案；映射表外的状态码写成 HTTP_xxx；没有 type 时日志不带 undefined', () => {
      const r = run(httpError(415, 'internal detail'));
      expect(r.body).toEqual({
        code: 'HTTP_415',
        message: '请求无法处理',
        requestId: 'req_1',
      });
      expect(warnSpy).toHaveBeenCalledWith('客户端请求错误 [req_1] 415 ');
    });

    it.each([
      ['status=500 的 Error', () => httpError(500, 'boom')],
      ['status=399', () => httpError(399, 'odd')],
      ['status 是字符串', () => httpError('400' as unknown as number, 'x')],
      ['带 status 的普通对象（不是 Error）', () => ({ status: 400 })],
    ])('%s：不算客户端错误，按 500 处理', (_n, make) => {
      const r = run(make());
      expect(r.status).toBe(500);
      expect(r.body).toMatchObject({
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
    });
  });

  describe('未预期异常', () => {
    it('Error：500 + 不泄露细节，堆栈进 error 日志', () => {
      const err = new Error('db password wrong');
      const r = run(err);
      expect(r.body).toEqual({
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        requestId: 'req_1',
      });
      expect(JSON.stringify(r.body)).not.toContain('password');
      expect(errorSpy).toHaveBeenCalledWith('未处理异常 [req_1]', err.stack);
    });

    it('抛出非 Error 值（字符串）：同样 500，日志里记 String(值)', () => {
      const r = run('weird');
      expect(r.status).toBe(500);
      expect(errorSpy).toHaveBeenCalledWith('未处理异常 [req_1]', 'weird');
    });
  });
});
