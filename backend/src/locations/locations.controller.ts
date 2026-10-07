import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsISO8601, IsInt, IsOptional, Max, Min } from 'class-validator';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { PageQueryDto } from '../common/page-query.dto';
import { DevicesService } from '../devices/devices.service';
import { LocationsService } from './locations.service';

class RangeQueryDto {
  @IsISO8601({ strict: true })
  from!: string;

  @IsISO8601({ strict: true })
  to!: string;
}

class TrackQueryDto extends RangeQueryDto {
  // 抽稀后最多返回多少个点（API.md §5）
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(2000)
  maxPoints: number = 1000;
}

class LocationsQueryDto extends PageQueryDto {
  // 时间范围必填（API.md §5）；范围上限与先后关系在服务层校验
  @IsISO8601({ strict: true })
  from!: string;

  @IsISO8601({ strict: true })
  to!: string;
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

  /** 区间统计（里程/移动时长/最高速） */
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

  /** 抽稀轨迹 + 全量统计（单趟行程的画线与回放） */
  @Get('track')
  async track(
    @Req() req: AuthenticatedRequest,
    @Param('deviceId') deviceId: string,
    @Query() query: TrackQueryDto,
  ) {
    await this.devices.getOwned(req.user.userId, deviceId);
    return this.locations.track(
      req.user.userId,
      deviceId,
      query.from,
      query.to,
      query.maxPoints,
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

/** 行程列表：按「一趟」组织的历史（API.md §5），数据仍来自 location_points */
@Controller('devices/:deviceId/rides')
export class RidesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly locations: LocationsService,
  ) {}

  @Get()
  async list(
    @Req() req: AuthenticatedRequest,
    @Param('deviceId') deviceId: string,
    @Query() query: RangeQueryDto,
  ) {
    await this.devices.getOwned(req.user.userId, deviceId);
    return this.locations.rides(
      req.user.userId,
      deviceId,
      query.from,
      query.to,
    );
  }
}
