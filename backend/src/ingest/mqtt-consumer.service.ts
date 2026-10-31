import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { connect, type MqttClient } from 'mqtt';
import type { Packet } from 'mqtt-packet';
import { mqttBackendClientId, mqttBackendUsername } from '../common/env';
import { errorMessage } from '../common/error-text';
import { retrying } from '../common/retry';
import { sleep } from '../common/sleep';
import { IngestService } from './ingest.service';

/** 设备侧 Topic（DEVICE_PROTOCOL §4）：helmet/{deviceId}/{status|location|event|cmd_ack} */
const SUBSCRIBE_TOPICS = [
  'helmet/+/status',
  'helmet/+/location',
  'helmet/+/event',
  'helmet/+/cmd_ack',
];
const TOPIC_PATTERN = /^helmet\/([^/]+)\/(status|location|event|cmd_ack)$/;

/** cmd_ack 处理器：命令模块启动时注册（回调注入，避免 Ingest ↔ Commands 模块环依赖） */
export type CmdAckHandler = (deviceId: string, raw: string) => Promise<void>;

/** 数据库瞬时故障时的入库重试（次数 × 间隔）；重试耗尽才放弃并告警。 */
const PERSIST_RETRIES = 2;
const PERSIST_RETRY_DELAY_MS = 300;

/** 订阅失败后多久断线重连再订：订阅失败 = 连着 Broker 却收不到任何消息，只告警不重试会静默失聪 */
const SUBSCRIBE_RETRY_DELAY_MS = 5_000;

/** 防日志伪造：外部输入进日志前去掉换行符 */
const sanitize = (s: string): string => s.replace(/[\r\n]+/g, ' ');

/** 关闭时最多等在飞的 QoS1 消息拿到 PUBACK 多久，之后强制断开（要小于 SHUTDOWN 的宽限期） */
const MQTT_END_WAIT_MS = 3_000;

/** 断线期间汇总日志的间隔：mqtt.js 每秒重连一次，逐次记日志会刷屏（O23） */
const OUTAGE_LOG_INTERVAL_MS = 60_000;

/**
 * 日志里的 MQTT 错误：错误码一定写出来。连接失败时 Node 对一个主机名的多个地址（IPv4 / IPv6）都试过，
 * 抛的是 AggregateError，message 为空，原因只在 code 和里面每一条上——原来只记 message，日志只剩「MQTT 错误：」（O23）
 */
export function describeMqttError(err: unknown): string {
  // 按字段取，不用 instanceof：mqtt.js 传来的是 Node 核心建的错误对象，在别的 realm（如 jest 的沙箱）里 instanceof Error 不成立
  if (typeof err !== 'object' || err === null) return sanitize(String(err));
  const e = err as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    errors?: unknown;
  };
  const parts: string[] = [];
  // net 错误是字符串（ECONNREFUSED），CONNACK 拒绝是数字原因码（5 = 未授权）
  if (typeof e.code === 'string' || typeof e.code === 'number') {
    parts.push(`code=${e.code}`);
  }
  if (typeof e.message === 'string' && e.message) parts.push(e.message);
  if (Array.isArray(e.errors) && e.errors.length > 0) {
    const inner = (e.errors as unknown[]).map((one) => {
      const x = (one ?? {}) as {
        message?: unknown;
        code?: unknown;
        address?: unknown;
        port?: unknown;
      };
      if (typeof x.message === 'string' && x.message) return x.message;
      return [
        typeof x.code === 'string' ? x.code : '',
        typeof x.address === 'string'
          ? `${x.address}:${typeof x.port === 'number' ? x.port : ''}`
          : '',
      ]
        .filter(Boolean)
        .join(' ');
    });
    parts.push(`[${inner.join('; ')}]`);
  }
  if (parts.length > 0) return sanitize(parts.join(' '));
  return typeof e.name === 'string' && e.name ? e.name : 'unknown error';
}

@Injectable()
export class MqttConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttConsumerService.name);
  private client: MqttClient | null = null;
  private subscribeTimer: NodeJS.Timeout | null = null;
  private subscribeFailures = 0;
  private shuttingDown = false;
  private cmdAckHandler: CmdAckHandler | null = null;
  /** 连上过没有：断线日志写「连接断开」还是「连不上 Broker」 */
  private everConnected = false;
  /** 上次连上以来最近一个错误（断线日志写原因用） */
  private lastError: string | null = null;
  /** 正在断线：开始时间、重连次数、上次记日志的时间 */
  private outage: {
    since: number;
    reconnects: number;
    loggedAt: number;
  } | null = null;

  constructor(private readonly ingest: IngestService) {}

  /** 命令模块注册回执处理器（onModuleInit 时机，见 CommandsService） */
  setCmdAckHandler(handler: CmdAckHandler): void {
    this.cmdAckHandler = handler;
  }

  /**
   * 命令下发（DEVICE_PROTOCOL §7）：QoS1，resolve = Broker PUBACK（送达 Broker，
   * 非送达设备——设备侧送达以 cmd_ack 为准）。未连接/发布失败 reject，由调用方留 pending。
   */
  publishCommand(deviceId: string, payload: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client || !this.client.connected) {
        reject(new Error('MQTT 未连接'));
        return;
      }
      this.client.publish(
        `helmet/${deviceId}/cmd`,
        payload,
        { qos: 1 },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  onModuleInit(): void {
    const url = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
    // 固定 clientId + 持久会话（clean:false）：后端离线/重启期间，EMQX 会为该会话
    // 暂存 QoS1 消息并在重连后补投（重复交付由 Ingest 的 eventId 幂等消化）。
    // 注意：持久会话有 Broker 侧过期时间（EMQX 默认 2h），超长停机仍依赖设备补传兜底
    //（设备离线缓存能力见 DEVICE_PROTOCOL §6，⚠️ 待硬件确认）。单体单实例架构下 clientId 固定是安全的。
    this.client = connect(url, {
      clientId: mqttBackendClientId(),
      clean: false,
      // 服务账号凭证：EMQX 开启认证后后端消费者也必须带证（emqx-hook 校验）
      username: mqttBackendUsername(),
      password: process.env.MQTT_BACKEND_PASSWORD,
      // 关掉 mqtt.js 的自动重订阅（审计 MQTT-02）：开着时它会把已订阅过的主题记在内存里，
      // 之后再调 subscribe() 会被去重、直接回调成功而不真发 SUBSCRIBE——会话被 Broker 清掉
      // （同 clientId 顶替、会话过期）后就变成「日志已订阅、Broker 零订阅」的静默失聪。
      // 我们自己在每次 'connect' 上显式订阅并检查 SUBACK，才是可核实的订阅状态。
      resubscribe: false,
    });

    // 覆写 handleMessage：mqtt.js 只有在本回调完成后才回 PUBACK——
    // 即"入库成功才签收"。默认行为是收到即签收，数据库故障窗口内消息会被永久丢弃。
    this.client.handleMessage = (
      packet: Packet,
      done: (err?: Error) => void,
    ) => {
      if (packet.cmd !== 'publish') {
        done();
        return;
      }
      void this.processPublish(packet.topic, packet.payload.toString('utf-8'))
        .catch((err: unknown) => {
          // 重试耗尽：只告警不 done(err)——done(err) 会断开连接，反而丢更多消息
          this.logger.error(
            `Ingest 最终失败，该消息放弃 [${sanitize(packet.topic)}]：${errorMessage(err)}`,
          );
        })
        .finally(() => done());
    };

    this.client.on('connect', (connack) => {
      if (this.outage) {
        this.logger.log(
          `MQTT 已恢复：断线 ${this.outageSeconds()} 秒，重连 ${this.outage.reconnects} 次`,
        );
        this.outage = null;
      }
      this.everConnected = true;
      this.lastError = null;
      // sessionPresent=false 表示 Broker 没有保留我们的持久会话（首连、过期或被顶替），订阅必须重建
      this.logger.log(
        `已连接 MQTT Broker：${url}（sessionPresent=${String(connack.sessionPresent)}）`,
      );
      this.subscribe();
    });

    // 断线日志节流（O23）：原来每次重连记一行「重连中」、每次失败记一行错误，EMQX 停机期间每秒两行。
    // 现在断线时记一行（带原因），断线期间每分钟汇总一行，恢复时记一行；连着的时候出的错照常立刻记
    this.client.on('close', () => this.beginOutage());
    this.client.on('offline', () => this.beginOutage());
    this.client.on('reconnect', () => {
      if (!this.outage) return;
      this.outage.reconnects += 1;
      this.summarizeOutage();
    });
    this.client.on('error', (err) => {
      this.lastError = describeMqttError(err);
      if (this.outage) {
        this.summarizeOutage();
      } else if (this.client?.connected) {
        this.logger.error(`MQTT 错误：${this.lastError}`);
      } else {
        // 还没连上就失败（启动时 Broker 不在）：错误先于 close 到，直接从这里开始算断线
        this.beginOutage();
      }
    });
  }

  private beginOutage(): void {
    if (this.outage || this.shuttingDown) return;
    const now = Date.now();
    this.outage = { since: now, reconnects: 0, loggedAt: now };
    const what = this.everConnected ? 'MQTT 连接断开' : 'MQTT 连不上 Broker';
    this.logger.error(
      `${what}：${this.lastError ?? '没有错误信息（Broker 主动断开或网络中断）'}；每秒自动重连，断线期间每分钟汇总一行`,
    );
  }

  private summarizeOutage(): void {
    const outage = this.outage;
    if (!outage || Date.now() - outage.loggedAt < OUTAGE_LOG_INTERVAL_MS)
      return;
    outage.loggedAt = Date.now();
    this.logger.error(
      `MQTT 仍未连上：已断 ${this.outageSeconds()} 秒，重连 ${outage.reconnects} 次，最近错误：${this.lastError ?? '无'}`,
    );
  }

  private outageSeconds(): number {
    return this.outage
      ? Math.round((Date.now() - this.outage.since) / 1000)
      : 0;
  }

  /**
   * 订阅失败必须重试直到成功，否则就是「连着却永远收不到消息」。重试走断线重连而不是在原连接上重订：
   * 服务账号是超级用户、不经授权，订阅被拒只可能是这条连接没过认证——EMQX 刚启动那一下连上的连接
   * 认证链还没就绪，直接被放进来（2026-10-17 云端 EMQX 重建后实测）。它在 EMQX 眼里不是超级用户，
   * 在上面重订多少次都被拒；重连会重新走认证。断线重连后 'connect' 再进入本方法，先清掉待执行的计时器。
   */
  private subscribe(): void {
    if (this.subscribeTimer) {
      clearTimeout(this.subscribeTimer);
      this.subscribeTimer = null;
    }
    this.client?.subscribe(SUBSCRIBE_TOPICS, { qos: 1 }, (err, granted) => {
      // SUBACK 里 qos=128 是 Broker 逐主题拒绝（ACL 未放行），mqtt.js 不把它当 err，必须自己看
      const rejected = (granted ?? []).filter((g) => g.qos === 128);
      if (!err && rejected.length === 0) {
        this.subscribeFailures = 0;
        this.logger.log(`已订阅：${SUBSCRIBE_TOPICS.join(', ')}`);
        return;
      }
      if (this.shuttingDown) return;
      this.subscribeFailures += 1;
      const reason = err
        ? err.message
        : `Broker 拒绝：${rejected.map((g) => g.topic).join(', ')}`;
      this.logger.error(
        `订阅失败（第 ${this.subscribeFailures} 次）：${reason}；${SUBSCRIBE_RETRY_DELAY_MS}ms 后断线重连再订`,
      );
      this.subscribeTimer = setTimeout(() => {
        this.subscribeTimer = null;
        if (this.shuttingDown) return;
        // 掐掉底层连接 = 模拟断网，mqtt.js 按 reconnectPeriod 自动重连并重新认证
        this.lastError = `订阅失败后主动断开重连（${reason}）`;
        this.client?.stream.destroy();
      }, SUBSCRIBE_RETRY_DELAY_MS);
    });
  }

  private async processPublish(topic: string, raw: string): Promise<void> {
    const match = TOPIC_PATTERN.exec(topic);
    if (!match) {
      this.logger.warn(`收到未识别 Topic 的消息，忽略：${sanitize(topic)}`);
      return;
    }
    const topicDeviceId = match[1];

    // cmd_ack 不是事件 envelope（EVENTS.md §6 独立格式），走命令模块，不进 Ingest
    if (match[2] === 'cmd_ack') {
      if (!this.cmdAckHandler) {
        this.logger.warn(`cmd_ack 处理器未注册，消息忽略：${sanitize(topic)}`);
        return;
      }
      // 与事件入库同一套重试：回执的事务（咨询锁 + 5 s 事务超时）比普通 insert 更容易瞬时失败，
      // 失败即签收会让已执行的命令 30 s 后显示 offline（10-06 并发评审 #9）
      const handler = this.cmdAckHandler;
      await retrying(
        () => handler(topicDeviceId, raw),
        PERSIST_RETRIES,
        PERSIST_RETRY_DELAY_MS,
        (err, attempt) =>
          this.logger.warn(
            `cmd_ack 处理失败（第 ${attempt} 次），${PERSIST_RETRY_DELAY_MS}ms 后重试：${errorMessage(err)}`,
          ),
      );
      this.logger.log(`[${sanitize(topic)}] → ack_processed`);
      return;
    }

    const outcome = await retrying(
      () => this.ingest.ingestRaw(raw, topicDeviceId, 'mqtt'),
      PERSIST_RETRIES,
      PERSIST_RETRY_DELAY_MS,
      (err, attempt) =>
        this.logger.warn(
          `入库失败（第 ${attempt} 次），${PERSIST_RETRY_DELAY_MS}ms 后重试：${errorMessage(err)}`,
        ),
    );
    // 正常入库（stored）每条一行会撑爆容器日志轮转：6 台 Mock 约 16 MB/天，5×20MB 只够留 6 天，
    // 真机量更大时不到一小时就滚没了。只留非常规结果（重复 / 校验失败留档等），排查异常时日志才不被刷掉
    if (outcome !== 'stored') {
      this.logger.log(`[${sanitize(topic)}] → ${outcome}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    if (this.subscribeTimer) {
      clearTimeout(this.subscribeTimer);
      this.subscribeTimer = null;
    }
    const client = this.client;
    if (!client) return;
    // 优雅断开会等在飞的 QoS1 拿到 PUBACK：Broker 半开 / 不可达时永远等不到，关闭流程挂到被 SIGKILL（10-17 评审 R4-9）。
    // 最多等 MQTT_END_WAIT_MS，之后强制断开（在飞的命令留 pending，由扫描按超时判 offline）
    await Promise.race([
      client.endAsync(),
      sleep(MQTT_END_WAIT_MS).then(() => client.endAsync(true)),
    ]).catch((err: unknown) =>
      this.logger.warn(`MQTT 断开失败：${errorMessage(err)}`),
    );
  }
}
