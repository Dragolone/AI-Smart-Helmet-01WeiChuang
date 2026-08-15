import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { connect, type MqttClient } from 'mqtt';
import type { Packet } from 'mqtt-packet';
import { IngestService } from './ingest.service';

/** 设备侧 Topic（DEVICE_PROTOCOL §4）：helmet/{deviceId}/{status|location|event} */
const SUBSCRIBE_TOPICS = [
  'helmet/+/status',
  'helmet/+/location',
  'helmet/+/event',
];
const TOPIC_PATTERN = /^helmet\/([^/]+)\/(status|location|event)$/;

/** 数据库瞬时故障时的入库重试（次数 × 间隔）；重试耗尽才放弃并告警。 */
const PERSIST_RETRIES = 2;
const PERSIST_RETRY_DELAY_MS = 300;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 防日志伪造：外部输入进日志前去掉换行符 */
const sanitize = (s: string): string => s.replace(/[\r\n]+/g, ' ');

@Injectable()
export class MqttConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttConsumerService.name);
  private client: MqttClient | null = null;

  constructor(private readonly ingest: IngestService) {}

  onModuleInit(): void {
    const url = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
    // 固定 clientId + 持久会话（clean:false）：后端离线/重启期间，EMQX 会为该会话
    // 暂存 QoS1 消息并在重连后补投（重复交付由 Ingest 的 eventId 幂等消化）。
    // 注意：持久会话有 Broker 侧过期时间（EMQX 默认 2h），超长停机仍依赖设备补传兜底
    //（设备离线缓存能力见 DEVICE_PROTOCOL §6，⚠️ 待硬件确认）。单体单实例架构下 clientId 固定是安全的。
    this.client = connect(url, {
      clientId: process.env.MQTT_BACKEND_CLIENT_ID ?? 'backend_ingest',
      clean: false,
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
            `Ingest 最终失败，该消息放弃 [${sanitize(packet.topic)}]：${err instanceof Error ? err.message : String(err)}`,
          );
        })
        .finally(() => done());
    };

    this.client.on('connect', () => {
      this.logger.log(`已连接 MQTT Broker：${url}`);
      this.client?.subscribe(SUBSCRIBE_TOPICS, { qos: 1 }, (err) => {
        if (err) {
          this.logger.error(`订阅失败：${err.message}`);
        } else {
          this.logger.log(`已订阅：${SUBSCRIBE_TOPICS.join(', ')}`);
        }
      });
    });

    this.client.on('reconnect', () => this.logger.warn('MQTT 重连中…'));
    this.client.on('error', (err) =>
      this.logger.error(`MQTT 错误：${err.message}`),
    );
  }

  private async processPublish(topic: string, raw: string): Promise<void> {
    const match = TOPIC_PATTERN.exec(topic);
    if (!match) {
      this.logger.warn(`收到未识别 Topic 的消息，忽略：${sanitize(topic)}`);
      return;
    }
    const topicDeviceId = match[1];

    let lastError: unknown;
    for (let attempt = 0; attempt <= PERSIST_RETRIES; attempt++) {
      try {
        const outcome = await this.ingest.ingestRaw(raw, topicDeviceId);
        this.logger.log(`[${sanitize(topic)}] → ${outcome}`);
        return;
      } catch (err) {
        lastError = err;
        if (attempt < PERSIST_RETRIES) {
          this.logger.warn(
            `入库失败（第 ${attempt + 1} 次），${PERSIST_RETRY_DELAY_MS}ms 后重试：${err instanceof Error ? err.message : String(err)}`,
          );
          await sleep(PERSIST_RETRY_DELAY_MS);
        }
      }
    }
    throw lastError;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.endAsync();
  }
}
