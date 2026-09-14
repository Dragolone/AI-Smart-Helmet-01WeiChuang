import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Public } from '../common/public.decorator';
import { AdminAuthGuard } from './admin-auth.guard';
import {
  AdminAccidentsQueryDto,
  AdminDevicesQueryDto,
  AdminEventsQueryDto,
  AdminUsersQueryDto,
} from './admin.dto';
import { AdminService } from './admin.service';

// @Public() 只是跳过全局用户守卫；实际访问控制由 AdminAuthGuard 承担（独立密钥）
@Public()
@UseGuards(AdminAuthGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('users')
  users(@Query() query: AdminUsersQueryDto) {
    return this.admin.listUsers(
      query.page,
      query.pageSize,
      query.keyword,
      query.includeDeleted === 'true',
    );
  }

  @Get('devices')
  devices(@Query() query: AdminDevicesQueryDto) {
    return this.admin.listDevices(
      query.page,
      query.pageSize,
      query.keyword,
      query.online === undefined ? undefined : query.online === 'true',
    );
  }

  @Get('accidents')
  accidents(@Query() query: AdminAccidentsQueryDto) {
    return this.admin.listAccidents(
      query.page,
      query.pageSize,
      query.status,
      query.deviceId,
    );
  }

  @Get('devices/:deviceId')
  deviceDetail(@Param('deviceId') deviceId: string) {
    return this.admin.getDeviceDetail(deviceId);
  }

  @Get('stats/overview')
  statsOverview() {
    return this.admin.statsOverview();
  }

  @Get('events')
  events(@Query() query: AdminEventsQueryDto) {
    return this.admin.listEvents(query.page, query.pageSize, {
      type: query.type,
      deviceId: query.deviceId,
      from: query.from,
      to: query.to,
      invalid: query.invalid === 'true',
    });
  }
}
