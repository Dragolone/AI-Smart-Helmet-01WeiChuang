import { Injectable, Logger } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mqttBackendClientId, mqttBackendUsername } from '../common/env';
import { PrismaService } from '../prisma/prisma.service';

/** 随认证应答下发的一条 ACL（EMQX HTTP 认证的 acl 字段） */
export type EmqxAclRule = {
  permission: 'allow';
  action: 'publish' | 'subscribe';
  topic: string;
};

/** EMQX HTTP 认证/授权的应答格式；is_superuser / acl 只在认证应答里出现 */
export type EmqxResult = {
  result: 'allow' | 'deny';
  is_superuser?: boolean;
  acl?: EmqxAclRule[];
};

const ALLOW: EmqxResult = { result: 'allow' };
const DENY: EmqxResult = { result: 'deny' };
/** 服务账号标超级用户，EMQX 对它跳过授权（授权里它本来就全部放行，见 authorize） */
const SERVICE_ALLOW: EmqxResult = { result: 'allow', is_superuser: true };

/** 设备可发布的 Topic 叶子（DEVICE_PROTOCOL §4） */
export const DEVICE_PUBLISH_LEAVES = new Set([
  'status',
  'location',
  'event',
  'cmd_ack',
]);
const TOPIC_PATTERN = /^helmet\/([^/]+)\/([^/]+)$/;
/** 要拼进 ACL topic 的 deviceId 不能带 MQTT 通配符 / 层级分隔符，否则一条规则就放行了别的设备 */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 设备的全部权限，随认证应答交给 EMQX（DEVICE_PROTOCOL §3.1 / §4）：只能发布自己的
 * helmet/{deviceId}/{status,location,event,cmd_ack}，只能订阅自己的 helmet/{deviceId}/cmd。
 */
export function deviceAcl(deviceId: string): EmqxAclRule[] {
  return [
    ...[...DEVICE_PUBLISH_LEAVES].map((leaf): EmqxAclRule => ({
      permission: 'allow',
      action: 'publish',
      topic: `helmet/${deviceId}/${leaf}`,
    })),
    {
      permission: 'allow',
      action: 'subscribe',
      topic: `helmet/${deviceId}/cmd`,
    },
  ];
}

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

    const serviceUser = mqttBackendUsername();
    const servicePass = process.env.MQTT_BACKEND_PASSWORD;
    const backendClientId = mqttBackendClientId();
    if (username === serviceUser) {
      if (clientid !== undefined && clientid !== backendClientId) {
        this.logger.warn(
          `MQTT 认证拒绝：服务账号使用了非保留 clientId（${clientid}）`,
        );
        return DENY;
      }
      return servicePass && password === servicePass ? SERVICE_ALLOW : DENY;
    }
    if (clientid === backendClientId) {
      this.logger.warn(
        `MQTT 认证拒绝：设备 ${username} 试图使用后端保留的 clientId`,
      );
      return DENY;
    }

    if (!DEVICE_ID_PATTERN.test(username)) {
      this.logger.warn(`MQTT 认证拒绝：设备号格式不合法（${username}）`);
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
    // 权限跟着这次认证走，而不是事后按 username 回调 authorize：EMQX 刚启动那一下（约 0.1 s）
    // 认证链还没就绪，连接不经认证就被放进来，错密码也行（2026-10-17 本机 5.8.8 复现）。
    // 那种连接没有这份 ACL，什么都发不了；按 username 判的 authorize 却会放行它冒充任意头盔。
    return { result: 'allow', acl: deviceAcl(username) };
  }

  /**
   * Topic 授权：设备只准操作自己的 helmet/{deviceId}/*；服务账号放行。
   * EMQX 已不再配置这个回调（权限随认证下发，见 authenticate）——它只看 username 与 topic，
   * 分不出没过认证的连接，不要再把它加回 authorization.sources。保留一版供旧配置过渡。
   */
  authorize(
    username: string | undefined,
    topic: string | undefined,
    action: string | undefined,
  ): EmqxResult {
    if (!username || !topic || !action) return DENY;

    const serviceUser = mqttBackendUsername();
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
