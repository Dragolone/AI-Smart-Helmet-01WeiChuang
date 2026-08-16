import {
  Body,
  Controller,
  HttpCode,
  NotFoundException,
  Post,
  Req,
} from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, Matches } from 'class-validator';
import { BLE_RELAY_EVENT_TYPES } from '@helmet/shared';
import type { AppRelayResponse } from '@helmet/shared';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { IngestService } from './ingest.service';

const RELAY_ALLOWED = new Set<string>(BLE_RELAY_EVENT_TYPES);

class AppRelayDto {
  @Matches(/^[A-Za-z0-9_-]{1,64}$/, { message: 'deviceId 格式不正确' })
  deviceId!: string;

  // envelope 内容不在 DTO 层校验：统一交给 Ingest 层（同 MQTT 入口口径），坏的留档不报错
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  envelopes!: unknown[];
}

/**
 * 蓝牙版 App 中转入口（API.md §12.1，决策 #31）：手机 App 把 BLE 收到的事件批量转交云端。
 * 与 MQTT 入口在统一 Ingest 层汇合——同校验、同幂等、同业务分发；重复/失败只计数不报错，
 * App 断线补传无需关心哪些已传过。
 */
@Controller('ingest')
export class AppRelayController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ingest: IngestService,
  ) {}

  @Post('app-relay')
  @HttpCode(202)
  async relay(
    @Req() req: AuthenticatedRequest,
    @Body() dto: AppRelayDto,
  ): Promise<AppRelayResponse> {
    // 归属校验与 §4 同口径：只有设备当前绑定用户的 App 有资格替它中转
    const device = await this.prisma.device.findUnique({
      where: { deviceId: dto.deviceId },
      select: { bindUserId: true },
    });
    if (!device || device.bindUserId !== req.user.userId) {
      throw new NotFoundException({
        code: 'DEVICE_NOT_FOUND',
        message: '设备不存在或未绑定到当前用户',
      });
    }

    const counts: AppRelayResponse = { accepted: 0, duplicate: 0, invalid: 0 };
    // 逐条顺序入库：保持事件时序（位置轨迹/SOS 依赖先后关系），批量上限 100 控制时延
    for (const envelope of dto.envelopes) {
      const outcome = await this.ingest.ingestRaw(
        JSON.stringify(envelope),
        dto.deviceId,
        'app_relay',
        { allowedEventTypes: RELAY_ALLOWED },
      );
      if (outcome === 'stored') counts.accepted += 1;
      else if (outcome === 'duplicate') counts.duplicate += 1;
      else counts.invalid += 1;
    }
    return counts;
  }
}
