// NUL 拦截（PostgreSQL 文本不收 \u0000）：body / query / params 里任何字符串值或键带 NUL → 400；@AllowNul 的入口放行。
import { BadRequestException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { NulGuard } from './nul.guard';

const ctxFor = (req: Record<string, unknown>) =>
  ({
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;

describe('NulGuard', () => {
  let allow: boolean | undefined;
  const guard = new NulGuard({
    getAllAndOverride: () => allow,
  } as unknown as Reflector);
  beforeEach(() => {
    allow = undefined;
  });

  const check = (req: Record<string, unknown>) => () =>
    guard.canActivate(ctxFor(req));

  it('干净的请求放行（含数字 / 布尔 / null / 数组）', () => {
    expect(
      check({
        body: { a: 'x', n: 1, b: true, z: null, arr: ['y', { k: 'v' }] },
        query: { page: '1' },
        params: { id: 'abc' },
      })(),
    ).toBe(true);
    expect(check({})()).toBe(true);
  });

  it.each([
    ['body 顶层字符串', { body: { nickname: 'a\u0000b' } }],
    ['body 嵌套数组里', { body: { list: [{ name: 'x\u0000' }] } }],
    ['body 的键', { body: { 'k\u0000': 'v' } }],
    ['query', { query: { q: '\u0000' } }],
    ['params', { params: { id: 'x\u0000' } }],
    ['body 本身就是字符串', { body: 'raw\u0000text' }],
  ])('%s 带 NUL：400 VALIDATION_FAILED', (_n, req) => {
    let err: unknown;
    try {
      check(req)();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toEqual({
      code: 'VALIDATION_FAILED',
      message: '字段不能包含 NUL 字符',
    });
  });

  it('@AllowNul 的入口（Ingest / EMQX 回调）：带 NUL 也放行，由入口自己留档', () => {
    allow = true;
    expect(check({ body: { raw: '\u0000' } })()).toBe(true);
  });

  it('嵌套超过 64 层后不再往下找（防栈溢出）：更深处的 NUL 现状放行', () => {
    let deep: Record<string, unknown> = { v: '\u0000' };
    for (let i = 0; i < 70; i += 1) deep = { c: deep };
    expect(check({ body: deep })()).toBe(true);
    let shallow: Record<string, unknown> = { v: '\u0000' };
    for (let i = 0; i < 10; i += 1) shallow = { c: shallow };
    expect(check({ body: shallow })).toThrow(BadRequestException);
  });
});
