import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { DevicesService } from '../devices/devices.service';
import { LocationsService } from './locations.service';

class RangeQueryDto {
  @IsISO8601({ strict: true })
  from!: string;

  @IsISO8601({ strict: true })
  to!: string;
}

class LocationsQueryDto {
  // 时间范围必填（API.md §5）；范围上限与先后关系在服务层校验
  @IsISO8601({ strict: true })
  from!: string;

  @IsISO8601({ strict: true })
  to!: string;

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

@Controller('devices/:deviceId/locations')
export class LocationsController {
  constructor(
    private readonly devices: DevicesService,
    private readonly locations: LocationsService,
  ) {}

  @Get('latest')
  async latest(
    @Req() req: AuthenticatedRequest,
    @Param('deviceId') deviceId: string,
  ) {
    // 归属校验与 devices 同口径：非本人设备 404，不泄露存在性
    await this.devices.getOwned(req.user.userId, deviceId);
    return this.locations.latest(req.user.userId, deviceId);
  }

  /** 区间统计（里程/移动时长/最高速）；路由声明在 :page 之类通配前，避免被当成参数 */
  @Get('summary')
  async summary(
    @Req() req: AuthenticatedRequest,
    @Param('deviceId') deviceId: string,
    @Query() query: RangeQueryDto,
  ) {
    await this.devices.getOwned(req.user.userId, deviceId);
    return this.locations.summaryRange(
      req.user.userId,
      deviceId,
      query.from,
      query.to,
    );
  }

  @Get()
  async list(
    @Req() req: AuthenticatedRequest,
    @Param('deviceId') deviceId: string,
    @Query() query: LocationsQueryDto,
  ) {
    await this.devices.getOwned(req.user.userId, deviceId);
    return this.locations.listRange(
      req.user.userId,
      deviceId,
      query.from,
      query.to,
      query.page,
      query.pageSize,
    );
  }
}
