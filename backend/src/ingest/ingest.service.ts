import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import {
  buildInvalidRecord,
  validateEnvelope,
  type ValidEnvelope,
} from './envelope';

export type IngestOutcome = 'stored' | 'duplicate' | 'stored_invalid';

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 所有入口（MQTT / 未来的 Webhook / Mock）都汇聚到这里；返回值仅用于日志与测试。 */
  async ingestRaw(raw: string, topicDeviceId: string): Promise<IngestOutcome> {
    const result = validateEnvelope(raw, topicDeviceId);

    if (!result.ok) {
      this.logger.warn(
        `校验失败事件已按原样落库（不进业务流程）：reason=${result.reason} device=${topicDeviceId}`,
      );
      await this.persist(buildInvalidRecord(topicDeviceId, raw, result.reason));
      return 'stored_invalid';
    }

    const stored = await this.persist(result.envelope);
    return stored ? 'stored' : 'duplicate';
  }

  /** eventId 幂等：唯一约束兜底并发，重复上报只存一次（EVENTS.md §2）。 */
  private async persist(e: ValidEnvelope): Promise<boolean> {
    try {
      await this.prisma.rawEvent.create({
        data: {
          eventId: e.eventId,
          deviceId: e.deviceId,
          eventType: e.eventType,
          timestamp: e.timestamp,
          schemaVersion: e.schemaVersion,
          firmwareVersion: e.firmwareVersion,
          payload: e.payload as Prisma.InputJsonValue,
        },
      });
      return true;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.debug(`重复 eventId 已跳过：${e.eventId}`);
        return false;
      }
      throw err;
    }
  }
}
