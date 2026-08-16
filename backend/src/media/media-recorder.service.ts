import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { ValidEnvelope } from '../ingest/envelope';
import { PrismaService } from '../prisma/prisma.service';

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;

const isNonNegativeInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0;

export interface MediaPayload {
  videoId: string;
  relatedEventId: string | null;
  duration: number | null;
  sizeBytes: number | null;
  storageKey: string | null;
}

/** video_ready payload 校验（EVENTS.md 4.9）：videoId 必填，其余选填；非法字段按缺失处理 */
export function extractMediaPayload(
  payload: Record<string, unknown>,
): MediaPayload | null {
  const p = payload;
  if (!isNonEmptyString(p.videoId)) return null;
  return {
    videoId: p.videoId,
    relatedEventId: isNonEmptyString(p.relatedEventId)
      ? p.relatedEventId
      : null,
    duration: isNonNegativeInt(p.duration) ? p.duration : null,
    sizeBytes: isNonNegativeInt(p.sizeBytes) ? p.sizeBytes : null,
    storageKey: isNonEmptyString(p.storageKey) ? p.storageKey : null,
  };
}

@Injectable()
export class MediaRecorderService {
  private readonly logger = new Logger(MediaRecorderService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * video_ready → 媒体元数据入库（Ingest 分发调用）。
   * 与位置表同哲学：失败只告警不抛出（raw 已留档可回填）；eventId 与 (deviceId, videoId)
   * 双唯一约束兜底幂等——重复上报、同 videoId 重复宣告都只建一条。
   */
  async record(e: ValidEnvelope): Promise<void> {
    const media = extractMediaPayload(e.payload);
    if (!media) {
      this.logger.warn(
        `video_ready payload 不合法（缺 videoId），不入媒体表（raw 已留档）：${e.eventId}`,
      );
      return;
    }
    try {
      await this.prisma.media.create({
        data: {
          eventId: e.eventId,
          deviceId: e.deviceId,
          videoId: media.videoId,
          relatedEventId: media.relatedEventId,
          duration: media.duration,
          sizeBytes: media.sizeBytes,
          storageKey: media.storageKey,
          // 上传方式待硬件定稿（EVENTS.md 4.9 ⚠️）：暂无 storageKey 的先登记、不可换 URL
          status: media.storageKey ? 'ready' : 'pending_upload',
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.debug(`重复媒体宣告已跳过：${e.eventId}`);
        return;
      }
      this.logger.warn(
        `媒体元数据入库失败（raw 已留档）${e.eventId}：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
