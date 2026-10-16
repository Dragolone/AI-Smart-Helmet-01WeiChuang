// 零散小工具：requestId 中间件、关停排空标记、withTimeout。
import type { NextFunction, Request, Response } from 'express';
import { requestIdMiddleware } from './request-id.middleware';
import { shutdownState } from './shutdown-state';
import { TimeoutError, withTimeout } from './with-timeout';

describe('requestIdMiddleware', () => {
  it('每个请求一个 req_<uuid>，然后交给下一个中间件', () => {
    const next = jest.fn() as unknown as NextFunction;
    const a = {} as Request & { requestId?: string };
    const b = {} as Request & { requestId?: string };
    requestIdMiddleware(a, {} as Response, next);
    requestIdMiddleware(b, {} as Response, next);
    expect(a.requestId).toMatch(/^req_[0-9a-f-]{36}$/);
    expect(a.requestId).not.toBe(b.requestId);
    expect(next).toHaveBeenCalledTimes(2);
  });
});

describe('shutdownState', () => {
  afterEach(() => shutdownState.reset());
  it('默认不在排空；mark 之后排空；reset 复位', () => {
    expect(shutdownState.isDraining()).toBe(false);
    shutdownState.markDraining();
    expect(shutdownState.isDraining()).toBe(true);
    shutdownState.reset();
    expect(shutdownState.isDraining()).toBe(false);
  });
});

describe('withTimeout', () => {
  afterEach(() => jest.useRealTimers());

  it('按时完成：原样返回结果', async () => {
    await expect(withTimeout(Promise.resolve(7), 1_000, 'x')).resolves.toBe(7);
  });

  it('原 Promise 先失败：原样抛原错误', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 1_000, 'x'),
    ).rejects.toThrow('boom');
  });

  it('超时：TimeoutError，message 带标签与毫秒数', async () => {
    jest.useFakeTimers();
    const p = withTimeout(new Promise(() => {}), 250, 'sms.send');
    const assertion = expect(p).rejects.toEqual(
      expect.objectContaining({
        name: 'TimeoutError',
        message: 'sms.send timeout after 250ms',
      }),
    );
    await jest.advanceTimersByTimeAsync(250);
    await assertion;
    expect(new TimeoutError('a', 1)).toBeInstanceOf(Error);
  });
});
