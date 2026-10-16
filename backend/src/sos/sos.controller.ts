import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { PageQueryDto } from '../common/page-query.dto';
import { SosService } from './sos.service';

/** API.md §7：active/accidents 挂设备资源下，cancel/confirm/事故详情按 id 操作；账号级进行中列表挂 users/me 下 */
@Controller()
export class SosController {
  constructor(private readonly sos: SosService) {}

  @Get('users/me/sos/active')
  activeForUser(
    @Req() req: AuthenticatedRequest,
    @Query() query: PageQueryDto,
  ) {
    return this.sos.activeForUser(req.user.userId, query.page, query.pageSize);
  }

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
