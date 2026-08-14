import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { connect, type MqttClient } from 'mqtt';
import { IngestService } from './ingest.service';

/** 设备侧 Topic（DEVICE_PROTOCOL §4）：helmet/{deviceId}/{status|location|event} */
const SUBSCRIBE_TOPICS = [
  'helmet/+/status',
  'helmet/+/location',
  'helmet/+/event',
];
const TOPIC_PATTERN = /^helmet\/([^/]+)\/(status|location|event)$/;

@Injectable()
export class MqttConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttConsumerService.name);
  private client: MqttClient | null = null;

  constructor(private readonly ingest: IngestService) {}

  onModuleInit(): void {
    const url = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
    // mqtt.js 默认自动重连（reconnectPeriod 1s），断线期间设备消息由 QoS/补传机制兜底
    this.client = connect(url, { clientId: `backend_${process.pid}` });

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

    this.client.on('message', (topic, payload) => {
      void this.handleMessage(topic, payload.toString('utf-8'));
    });
  }

  private async handleMessage(topic: string, raw: string): Promise<void> {
    const match = TOPIC_PATTERN.exec(topic);
    if (!match) {
      this.logger.warn(`收到未识别 Topic 的消息，忽略：${topic}`);
      return;
    }
    const topicDeviceId = match[1];
    try {
      const outcome = await this.ingest.ingestRaw(raw, topicDeviceId);
      this.logger.log(`[${topic}] → ${outcome}`);
    } catch (err) {
      // 数据库异常等不可恢复错误：只记日志不崩进程；消息丢失由设备侧 QoS1 重发兜底
      this.logger.error(
        `Ingest 处理失败 [${topic}]：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.endAsync();
  }
}
