import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { WsMessage } from '@helmet/shared';
import type { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { errorMessage } from '../common/error-text';
import { PrismaService } from '../prisma/prisma.service';

/** 应用自定义关闭码（4000–4999 区间）：鉴权失败。账号注销时 users.service 也用它断开连接，App 据此走重新登录 */
export const CLOSE_UNAUTHORIZED = 4401;

/**
 * App 实时通道（API.md §11，原生 ws，决策 #25）：
 * - 连接 `/ws?token=<accessToken>`，JWT 验证失败立即关闭（4401）；
 * - 连接挂到 userId，服务端按「当前用户绑定的设备」推送，无客户端订阅指令；
 * - 加速通道不是可靠通道：不做补发，App 重连后用 REST 拉取兜底。
 */
@WebSocketGateway({ path: '/ws' })
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly byUser = new Map<string, Set<WebSocket>>();
  private readonly clientUser = new Map<WebSocket, string>();
  /** access token 到期即断开（App 用新 token 重连）：连接不能比凭证活得久 */
  private readonly expiryTimers = new Map<WebSocket, NodeJS.Timeout>();

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * 握手已由适配器完成（客户端此时已 open），这里再校验 token 与注销状态后才登记进推送表——
   * 中间有一次 DB 查询的窗口，窗口内的推送不会送达该连接。这是加速通道的既定口径（不补发，REST 兜底），
   * 但写 e2e 时不能把客户端 open 当作"已订阅"（2026-09-18 CI 诊断）。
   */
  async handleConnection(
    client: WebSocket,
    req: IncomingMessage,
  ): Promise<void> {
    // 查询参数带 token（RN/浏览器原生 WebSocket 无法可靠设置 header）
    const token = new URL(req.url ?? '', 'ws://placeholder').searchParams.get(
      'token',
    );
    if (!token) {
      client.close(CLOSE_UNAUTHORIZED, '缺少访问令牌');
      return;
    }
    try {
      // 默认密钥 = 用户 JWT；admin token（独立密钥）天然验签失败
      const payload = await this.jwt.verifyAsync<{ sub: string; exp?: number }>(
        token,
      );
      const userId = payload.sub;
      // 与 HTTP 守卫同口径：注销后的残留 token 不得再收推送
      const found = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { deletedAt: true },
      });
      if (found?.deletedAt) {
        client.close(CLOSE_UNAUTHORIZED, '账号已注销');
        return;
      }
      // 上面两次 await 期间客户端可能已经断开：handleDisconnect 早已跑过（当时还没登记、无事可做），
      // 此时再登记就是一条永远不会被清理的死连接（连同到期定时器一起泄漏）
      if (client.readyState !== WebSocket.OPEN) return;
      if (typeof payload.exp === 'number') {
        const ttl = Math.max(payload.exp * 1000 - Date.now(), 0);
        const timer = setTimeout(
          () => client.close(CLOSE_UNAUTHORIZED, '访问令牌已过期'),
          ttl,
        );
        timer.unref();
        this.expiryTimers.set(client, timer);
      }
      let conns = this.byUser.get(userId);
      if (!conns) {
        conns = new Set();
        this.byUser.set(userId, conns);
      }
      conns.add(client);
      this.clientUser.set(client, userId);
      // 连接建立钩子（决策 #36）：补推 pending/delivered 命令等"连接时状态同步"挂在这里；
      // 钩子失败不影响连接本身（加速通道哲学：推不到还有 REST 兜底）
      if (this.onUserConnected) {
        this.onUserConnected(userId, client).catch((err: unknown) =>
          this.logger.warn(
            `连接建立钩子失败（不影响连接）：${errorMessage(err)}`,
          ),
        );
      }
    } catch {
      client.close(CLOSE_UNAUTHORIZED, '访问令牌无效或已过期');
    }
  }

  /** 回调注入（与 MqttConsumer.setCmdAckHandler 同模式）：Realtime 不反向依赖业务模块 */
  private onUserConnected?: (
    userId: string,
    client: WebSocket,
  ) => Promise<void>;

  setUserConnectedHandler(
    handler: (userId: string, client: WebSocket) => Promise<void>,
  ): void {
    this.onUserConnected = handler;
  }

  /** 定向发给单个连接（连接补推用；广播仍走 pushToUser） */
  sendToClient(client: WebSocket, message: WsMessage): void {
    if (client.readyState === WebSocket.OPEN) {
      const raw = JSON.stringify(message);
      client.send(raw, (err) => {
        if (err) this.logger.warn(`WS 定向推送失败：${err.message}`);
      });
    }
  }

  handleDisconnect(client: WebSocket): void {
    const timer = this.expiryTimers.get(client);
    if (timer) {
      clearTimeout(timer);
      this.expiryTimers.delete(client);
    }
    const userId = this.clientUser.get(client);
    if (!userId) return;
    this.clientUser.delete(client);
    const conns = this.byUser.get(userId);
    if (conns) {
      conns.delete(client);
      if (conns.size === 0) this.byUser.delete(userId);
    }
  }

  /** 主动断开某用户的全部连接（注销账号）：连接不能比账号活得久（API.md §2 / 审计 AUTH-05、INGEST-04） */
  closeUser(userId: string, code: number, reason: string): number {
    const conns = this.byUser.get(userId);
    if (!conns || conns.size === 0) return 0;
    let closed = 0;
    for (const ws of [...conns]) {
      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.close(code, reason);
        closed += 1;
      }
    }
    return closed;
  }

  /** 单条推送失败只跳过该连接，不影响其他连接与主流程 */
  pushToUser(userId: string, message: WsMessage): void {
    const conns = this.byUser.get(userId);
    if (!conns || conns.size === 0) return;
    const raw = JSON.stringify(message);
    for (const ws of conns) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(raw, (err) => {
          if (err) this.logger.warn(`WS 推送失败：${err.message}`);
        });
      }
    }
  }
}
