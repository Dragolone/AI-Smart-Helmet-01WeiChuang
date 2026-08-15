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

/** 应用自定义关闭码（4000–4999 区间）：鉴权失败 */
const CLOSE_UNAUTHORIZED = 4401;

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

  constructor(private readonly jwt: JwtService) {}

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
      const payload = await this.jwt.verifyAsync<{ sub: string }>(token);
      const userId = payload.sub;
      let conns = this.byUser.get(userId);
      if (!conns) {
        conns = new Set();
        this.byUser.set(userId, conns);
      }
      conns.add(client);
      this.clientUser.set(client, userId);
    } catch {
      client.close(CLOSE_UNAUTHORIZED, '访问令牌无效或已过期');
    }
  }

  handleDisconnect(client: WebSocket): void {
    const userId = this.clientUser.get(client);
    if (!userId) return;
    this.clientUser.delete(client);
    const conns = this.byUser.get(userId);
    if (conns) {
      conns.delete(client);
      if (conns.size === 0) this.byUser.delete(userId);
    }
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
