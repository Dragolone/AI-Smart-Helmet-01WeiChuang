import { Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { SosService } from './sos.service';

/** API.md §7：active 挂设备资源下，cancel/confirm 按 sosId 操作 */
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
