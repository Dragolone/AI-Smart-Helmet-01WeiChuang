// 服务器对服务器入口的共享密钥守卫：环境变量没配时失败关闭；不匹配一律 401。
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { InternalTokenGuard } from '../emqx/internal-token.guard';
import { WebhookApiKeyGuard } from '../ingest/webhook-api-key.guard';

const ctxFor = (req: Record<string, unknown>) =>
  ({
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;

describe('WebhookApiKeyGuard（算法服务 Webhook）', () => {
  const saved = process.env.INGEST_WEBHOOK_API_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.INGEST_WEBHOOK_API_KEY;
    else process.env.INGEST_WEBHOOK_API_KEY = saved;
  });
  const guard = new WebhookApiKeyGuard();

  it('匹配：放行', () => {
    process.env.INGEST_WEBHOOK_API_KEY = 'k1';
    expect(guard.canActivate(ctxFor({ headers: { 'x-api-key': 'k1' } }))).toBe(
      true,
    );
  });

  it.each([
    ['不匹配', 'k1', { 'x-api-key': 'k2' }],
    ['没带', 'k1', {}],
    ['服务端没配（失败关闭，空 key 也进不来）', undefined, { 'x-api-key': '' }],
    ['服务端配成空串', '', { 'x-api-key': '' }],
  ])('%s：401', (_n, expected, headers) => {
    if (expected === undefined) delete process.env.INGEST_WEBHOOK_API_KEY;
    else process.env.INGEST_WEBHOOK_API_KEY = expected;
    expect(() => guard.canActivate(ctxFor({ headers }))).toThrow(
      UnauthorizedException,
    );
  });
});

describe('InternalTokenGuard（EMQX → 后端）', () => {
  const saved = process.env.EMQX_INTERNAL_TOKEN;
  afterEach(() => {
    if (saved === undefined) delete process.env.EMQX_INTERNAL_TOKEN;
    else process.env.EMQX_INTERNAL_TOKEN = saved;
  });
  const guard = new InternalTokenGuard();

  it('header 或 query 带对了都放行；header 优先', () => {
    process.env.EMQX_INTERNAL_TOKEN = 't1';
    expect(
      guard.canActivate(
        ctxFor({ headers: { 'x-internal-token': 't1' }, query: {} }),
      ),
    ).toBe(true);
    expect(
      guard.canActivate(ctxFor({ headers: {}, query: { token: 't1' } })),
    ).toBe(true);
    expect(() =>
      guard.canActivate(
        ctxFor({
          headers: { 'x-internal-token': 'wrong' },
          query: { token: 't1' },
        }),
      ),
    ).toThrow(UnauthorizedException);
  });

  it('服务端没配：失败关闭', () => {
    delete process.env.EMQX_INTERNAL_TOKEN;
    expect(() => guard.canActivate(ctxFor({ headers: {}, query: {} }))).toThrow(
      UnauthorizedException,
    );
  });
});
