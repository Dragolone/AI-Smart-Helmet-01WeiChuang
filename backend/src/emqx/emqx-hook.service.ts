import { Injectable, Logger } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

/** EMQX HTTP 认证/授权的应答格式 */
export type EmqxResult = { result: 'allow' | 'deny' };

const ALLOW: EmqxResult = { result: 'allow' };
const DENY: EmqxResult = { result: 'deny' };

/** 设备可发布的 Topic 叶子（DEVICE_PROTOCOL §4） */
const DEVICE_PUBLISH_LEAVES = new Set([
  'status',
  'location',
  'event',
  'cmd_ack',
]);
const TOPIC_PATTERN = /^helmet\/([^/]+)\/([^/]+)$/;

const sha256 = (s: string): string =>
  createHash('sha256').update(s).digest('hex');

/** 哈希比较用常数时间，防时序侧信道 */
function hashEquals(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

@Injectable()
export class EmqxHookService {
  private readonly logger = new Logger(EmqxHookService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * MQTT 连接认证：后端服务账号走环境变量；设备走 devices 表密钥哈希。
   * clientId 也参与判定（审计 MQTT-01）：MQTT 同 clientId 互踢，若不校验，任何持有一台设备密钥的人
   * 都能用后端消费者的固定 clientId 把消费者顶下线。后端保留的 clientId 只允许服务账号使用；
   * 设备 clientId 不做与 deviceId 相等的强约束（DEVICE_PROTOCOL §3 未约定，等硬件确认后再收紧）。
   */
  async authenticate(
    username: string | undefined,
    password: string | undefined,
    clientid?: string,
  ): Promise<EmqxResult> {
    if (!username || !password) return DENY;

    const serviceUser = process.env.MQTT_BACKEND_USERNAME ?? 'backend_ingest';
    const servicePass = process.env.MQTT_BACKEND_PASSWORD;
    const backendClientId =
      process.env.MQTT_BACKEND_CLIENT_ID ?? 'backend_ingest';
    if (username === serviceUser) {
      if (clientid !== undefined && clientid !== backendClientId) {
        this.logger.warn(
          `MQTT 认证拒绝：服务账号使用了非保留 clientId（${clientid}）`,
        );
        return DENY;
      }
      return servicePass && password === servicePass ? ALLOW : DENY;
    }
    if (clientid === backendClientId) {
      this.logger.warn(
        `MQTT 认证拒绝：设备 ${username} 试图使用后端保留的 clientId`,
      );
      return DENY;
    }

    const device = await this.prisma.device.findUnique({
      where: { deviceId: username },
      select: { deviceSecretHash: true },
    });
    if (!device || !hashEquals(sha256(password), device.deviceSecretHash)) {
      this.logger.warn(`MQTT 认证拒绝：${username}`);
      return DENY;
    }
    return ALLOW;
  }

  /** Topic 授权：设备只准操作自己的 helmet/{deviceId}/*；服务账号放行。 */
  authorize(
    username: string | undefined,
    topic: string | undefined,
    action: string | undefined,
  ): EmqxResult {
    if (!username || !topic || !action) return DENY;

    const serviceUser = process.env.MQTT_BACKEND_USERNAME ?? 'backend_ingest';
    if (username === serviceUser) return ALLOW;

    const match = TOPIC_PATTERN.exec(topic);
    if (!match || match[1] !== username) {
      this.logger.warn(`MQTT 越权拒绝：${username} → ${action} ${topic}`);
      return DENY;
    }
    const leaf = match[2];
    if (action === 'publish' && DEVICE_PUBLISH_LEAVES.has(leaf)) return ALLOW;
    if (action === 'subscribe' && leaf === 'cmd') return ALLOW;
    this.logger.warn(`MQTT 越权拒绝：${username} → ${action} ${topic}`);
    return DENY;
  }
}
