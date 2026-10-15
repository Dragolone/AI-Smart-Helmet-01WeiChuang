// WS 实时通道网关：鉴权分支、到期断开、连接钩子失败隔离、定向 / 广播推送跳过非 OPEN 连接与发送失败、注销断开。
// JwtService / Prisma mock，WebSocket 用只带 readyState / send / close 的假对象。
import { Logger } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import type { PrismaService } from '../prisma/prisma.service';
import { CLOSE_UNAUTHORIZED, RealtimeGateway } from './realtime.gateway';

type SendCb = (err?: Error) => void;
interface FakeWs {
  readyState: number;
  close: jest.Mock;
  send: jest.Mock<void, [string, SendCb]>;
}
const fakeWs = (readyState: number = WebSocket.OPEN): FakeWs => ({
  readyState,
  close: jest.fn(),
  send: jest.fn<void, [string, SendCb]>((_raw, cb) => cb()),
});
const asWs = (w: FakeWs) => w as unknown as WebSocket;
const req = (url?: string) => ({ url }) as IncomingMessage;
const msg = { type: 'device_status', data: { deviceId: 'h1' } } as never;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('RealtimeGateway', () => {
  const verifyAsync = jest.fn();
  const findUnique = jest.fn();
  let gw: RealtimeGateway;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    verifyAsync.mockReset().mockResolvedValue({ sub: 'u1' });
    findUnique.mockReset().mockResolvedValue({ deletedAt: null });
    gw = new RealtimeGateway(
      { verifyAsync } as unknown as JwtService,
      { user: { findUnique } } as unknown as PrismaService,
    );
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const connect = async (ws: FakeWs, url = '/ws?token=t') => {
    await gw.handleConnection(asWs(ws), req(url));
  };

  describe('handleConnection 鉴权', () => {
    it.each([
      ['没有 token 参数', '/ws'],
      ['token 为空串', '/ws?token='],
    ])('%s：4401 关闭，不验签', async (_n, url) => {
      const ws = fakeWs();
      await connect(ws, url);
      expect(ws.close).toHaveBeenCalledWith(CLOSE_UNAUTHORIZED, '缺少访问令牌');
      expect(verifyAsync).not.toHaveBeenCalled();
    });

    it('请求上没有 url：按缺 token 处理', async () => {
      const ws = fakeWs();
      await gw.handleConnection(asWs(ws), req(undefined));
      expect(ws.close).toHaveBeenCalledWith(CLOSE_UNAUTHORIZED, '缺少访问令牌');
    });

    it('验签失败：4401「访问令牌无效或已过期」', async () => {
      verifyAsync.mockRejectedValue(new Error('jwt expired'));
      const ws = fakeWs();
      await connect(ws);
      expect(ws.close).toHaveBeenCalledWith(
        CLOSE_UNAUTHORIZED,
        '访问令牌无效或已过期',
      );
    });

    it('账号已注销：4401「账号已注销」，不登记', async () => {
      findUnique.mockResolvedValue({ deletedAt: new Date() });
      const ws = fakeWs();
      await connect(ws);
      expect(ws.close).toHaveBeenCalledWith(CLOSE_UNAUTHORIZED, '账号已注销');
      gw.pushToUser('u1', msg);
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('用户行查不到（null）：不算注销，正常登记', async () => {
      findUnique.mockResolvedValue(null);
      const ws = fakeWs();
      await connect(ws);
      gw.pushToUser('u1', msg);
      expect(ws.send).toHaveBeenCalledTimes(1);
    });

    it('查库期间客户端已断开：不登记（避免死连接与定时器泄漏）', async () => {
      const ws = fakeWs(WebSocket.CLOSED);
      await connect(ws);
      gw.pushToUser('u1', msg);
      expect(ws.send).not.toHaveBeenCalled();
      expect(ws.close).not.toHaveBeenCalled();
    });
  });

  describe('token 到期断开', () => {
    it('带 exp：到期时 4401「访问令牌已过期」', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-16T00:00:00Z') });
      verifyAsync.mockResolvedValue({
        sub: 'u1',
        exp: Date.parse('2026-10-16T00:15:00Z') / 1000,
      });
      const ws = fakeWs();
      await connect(ws);
      jest.advanceTimersByTime(15 * 60_000 - 1);
      expect(ws.close).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(ws.close).toHaveBeenCalledWith(
        CLOSE_UNAUTHORIZED,
        '访问令牌已过期',
      );
    });

    it('exp 已经过去：立即（0ms）断开', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-16T00:00:00Z') });
      verifyAsync.mockResolvedValue({ sub: 'u1', exp: 1 });
      const ws = fakeWs();
      await connect(ws);
      jest.advanceTimersByTime(0);
      expect(ws.close).toHaveBeenCalledWith(
        CLOSE_UNAUTHORIZED,
        '访问令牌已过期',
      );
    });

    it('没有 exp：不挂到期定时器', async () => {
      jest.useFakeTimers();
      const ws = fakeWs();
      await connect(ws);
      jest.advanceTimersByTime(365 * 24 * 3_600_000);
      expect(ws.close).not.toHaveBeenCalled();
    });

    it('断开时清掉到期定时器：之后不会再对已断开的连接 close', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-16T00:00:00Z') });
      verifyAsync.mockResolvedValue({
        sub: 'u1',
        exp: Date.parse('2026-10-16T00:01:00Z') / 1000,
      });
      const ws = fakeWs();
      await connect(ws);
      gw.handleDisconnect(asWs(ws));
      jest.advanceTimersByTime(120_000);
      expect(ws.close).not.toHaveBeenCalled();
    });
  });

  describe('连接建立钩子', () => {
    it('没注册钩子：连接照常登记', async () => {
      const ws = fakeWs();
      await connect(ws);
      gw.pushToUser('u1', msg);
      expect(ws.send).toHaveBeenCalledTimes(1);
    });

    it('钩子带 userId 与连接调用；钩子失败只记 warn，连接不受影响', async () => {
      const hook = jest.fn(() => Promise.reject(new Error('补推失败')));
      gw.setUserConnectedHandler(hook);
      const ws = fakeWs();
      await connect(ws);
      await flush();
      expect(hook).toHaveBeenCalledWith('u1', ws);
      expect(warnSpy).toHaveBeenCalledWith(
        '连接建立钩子失败（不影响连接）：补推失败',
      );
      expect(ws.close).not.toHaveBeenCalled();
      gw.pushToUser('u1', msg);
      expect(ws.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('sendToClient（定向）', () => {
    it('OPEN：发送 JSON 文本', () => {
      const ws = fakeWs();
      gw.sendToClient(asWs(ws), msg);
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify(msg),
        expect.any(Function),
      );
    });

    it('非 OPEN：不发', () => {
      const ws = fakeWs(WebSocket.CLOSING);
      gw.sendToClient(asWs(ws), msg);
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('发送回调报错：只记 warn', () => {
      const ws = fakeWs();
      ws.send.mockImplementation((_r, cb) => cb(new Error('EPIPE')));
      gw.sendToClient(asWs(ws), msg);
      expect(warnSpy).toHaveBeenCalledWith('WS 定向推送失败：EPIPE');
    });
  });

  describe('pushToUser（广播给该用户所有连接）', () => {
    it('没有连接：什么都不做', () => {
      expect(() => gw.pushToUser('nobody', msg)).not.toThrow();
    });

    it('多连接：只发 OPEN 的；单条发送失败不影响其他连接', async () => {
      const a = fakeWs();
      const b = fakeWs();
      const c = fakeWs();
      await connect(a);
      await connect(b);
      await connect(c);
      b.readyState = WebSocket.CLOSING;
      a.send.mockImplementation((_r, cb) => cb(new Error('socket hang up')));
      gw.pushToUser('u1', msg);
      expect(a.send).toHaveBeenCalledTimes(1);
      expect(b.send).not.toHaveBeenCalled();
      expect(c.send).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith('WS 推送失败：socket hang up');
    });

    it('断开一个连接后：剩下的照收；全部断开后用户条目被清掉', async () => {
      const a = fakeWs();
      const b = fakeWs();
      await connect(a);
      await connect(b);
      gw.handleDisconnect(asWs(a));
      gw.pushToUser('u1', msg);
      expect(a.send).not.toHaveBeenCalled();
      expect(b.send).toHaveBeenCalledTimes(1);
      gw.handleDisconnect(asWs(b));
      expect(gw.closeUser('u1', 4000, 'x')).toBe(0);
    });

    it('未登记的连接断开：无事可做', () => {
      expect(() => gw.handleDisconnect(asWs(fakeWs()))).not.toThrow();
    });
  });

  describe('closeUser（注销账号断开全部连接）', () => {
    it('只关 OPEN / CONNECTING 的连接，返回实际关闭数', async () => {
      const open = fakeWs();
      const connecting = fakeWs();
      const closing = fakeWs();
      await connect(open);
      await connect(connecting);
      await connect(closing);
      connecting.readyState = WebSocket.CONNECTING;
      closing.readyState = WebSocket.CLOSED;
      expect(gw.closeUser('u1', CLOSE_UNAUTHORIZED, '账号已注销')).toBe(2);
      expect(open.close).toHaveBeenCalledWith(CLOSE_UNAUTHORIZED, '账号已注销');
      expect(connecting.close).toHaveBeenCalledTimes(1);
      expect(closing.close).not.toHaveBeenCalled();
    });

    it('用户没有连接：返回 0', () => {
      expect(gw.closeUser('u404', CLOSE_UNAUTHORIZED, 'x')).toBe(0);
    });
  });
});
