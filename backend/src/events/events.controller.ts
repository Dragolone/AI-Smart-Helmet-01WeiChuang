import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { IsIsoDateTime } from '../common/iso-date';
import { PageQueryDto } from '../common/page-query.dto';
import { EventsService } from './events.service';

class EventsQueryDto extends PageQueryDto {
  /** 逗号分隔多值；取值 = EVENTS.md §3 eventType（服务层校验白名单） */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  type?: string;

  @IsOptional()
  @IsIsoDateTime()
  from?: string;

  @IsOptional()
  @IsIsoDateTime()
  to?: string;
}

/** API.md §6：事件历史挂设备资源下，详情按 eventId 查 */
@Controller()
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get('devices/:deviceId/events')
  list(
    @Req() req: AuthenticatedRequest,
    @Param('deviceId') deviceId: string,
    @Query() query: EventsQueryDto,
  ) {
    return this.events.list(req.user.userId, deviceId, query);
  }

  @Get('events/:eventId')
  detail(@Req() req: AuthenticatedRequest, @Param('eventId') eventId: string) {
    return this.events.detail(req.user.userId, eventId);
  }
}
