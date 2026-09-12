import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AllowNul } from '../common/nul.guard';
import { Public } from '../common/public.decorator';
import { IngestService } from './ingest.service';
import { WebhookApiKeyGuard } from './webhook-api-key.guard';

/**
 * 云端算法服务 → 后端的 HTTP 入口（API.md §12，决策 #7：服务器对服务器，不经 EMQX）。
 * 请求体 = EVENTS.md §1 envelope 单条；与 MQTT / app-relay 在统一 Ingest 层汇合，
 * 同校验、同 eventId 幂等、同业务分发——业务模块不感知来源（source=webhook 仅排查可见）。
 */
@Public()
@AllowNul()
@UseGuards(WebhookApiKeyGuard)
@Controller('ingest')
export class WebhookController {
  constructor(private readonly ingest: IngestService) {}

  @Post('webhook')
  @HttpCode(202)
  async webhook(
    @Body() body: unknown,
  ): Promise<{ eventId: string | null; duplicate: boolean; invalid: boolean }> {
    // deviceId 一致性校验的"外层来源"在 MQTT 是 topic、app-relay 是请求外层字段；
    // webhook 请求体就是 envelope 本身，故从 body 浅取（非法结构走 invalid 留档路径）
    const o = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    const deviceId = typeof o.deviceId === 'string' ? o.deviceId : 'unknown';
    const eventId = typeof o.eventId === 'string' ? o.eventId : null;

    const outcome = await this.ingest.ingestRaw(
      JSON.stringify(body),
      deviceId,
      'webhook',
    );
    // 与 Ingest 层规则一致：校验失败留档不丢弃、也不报错（algorithm 侧无需重试逻辑）
    return {
      eventId,
      duplicate: outcome === 'duplicate',
      invalid: outcome === 'stored_invalid',
    };
  }
}
