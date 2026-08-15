import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { SosService } from './sos.service';

class PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}

/** API.md §7：active/accidents 挂设备资源下，cancel/confirm/事故详情按 id 操作 */
@Controller()
export class SosController {
  constructor(private readonly sos: SosService) {}

  @Get('devices/:deviceId/sos/active')
  active(
    @Req() req: AuthenticatedRequest,
    @Param('deviceId') deviceId: string,
  ) {
    return this.sos.active(req.user.userId, deviceId);
  }

  @Get('devices/:deviceId/accidents')
  accidents(
    @Req() req: AuthenticatedRequest,
    @Param('deviceId') deviceId: string,
    @Query() query: PageQueryDto,
  ) {
    return this.sos.accidents(
      req.user.userId,
      deviceId,
      query.page,
      query.pageSize,
    );
  }

  @Get('accidents/:accidentId')
  accidentDetail(
    @Req() req: AuthenticatedRequest,
    @Param('accidentId') accidentId: string,
  ) {
    return this.sos.accidentDetail(req.user.userId, accidentId);
  }

  @Post('sos/:sosId/cancel')
  @HttpCode(200)
  cancel(@Req() req: AuthenticatedRequest, @Param('sosId') sosId: string) {
    return this.sos.cancel(req.user.userId, sosId);
  }

  @Post('sos/:sosId/confirm')
  @HttpCode(200)
  confirm(@Req() req: AuthenticatedRequest, @Param('sosId') sosId: string) {
    return this.sos.confirm(req.user.userId, sosId);
  }
}
