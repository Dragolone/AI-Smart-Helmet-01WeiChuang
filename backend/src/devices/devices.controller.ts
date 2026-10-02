import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { RateLimit } from '../common/rate-limit.guard';
import { DevicesService } from './devices.service';

class BindDeviceDto {
  // deviceId 由硬件团队分配，限定安全字符集防注入类脏数据
  @Matches(/^[A-Za-z0-9_-]{1,64}$/, { message: 'deviceId 格式不正确' })
  deviceId!: string;

  @IsString()
  @MinLength(4)
  @MaxLength(64)
  bindCode!: string;
}

class UpdateDeviceDto {
  // 自定义设备名:1-20 字符(trim 后空串视为清除);仅此一个可改字段
  @IsOptional()
  @IsString()
  @MaxLength(20)
  name?: string;
}

class BatteryHistoryQueryDto {
  // 回看小时数：默认 24，最长 7 天（API.md §4）
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(168)
  hours: number = 24;
}

@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  // 绑定码是 8 位数字、deviceId 可枚举，且「码错 403 / 已被绑 409」能区分猜没猜中：
  // 不限频时单个账号几小时就能穷举出一台库存头盔的绑定码并抢先绑走
  @RateLimit({ name: 'device_bind', limit: 10, windowMs: 60_000 })
  @Post('bind')
  @HttpCode(200)
  bind(@Req() req: AuthenticatedRequest, @Body() dto: BindDeviceDto) {
    return this.devices.bind(req.user.userId, dto.deviceId, dto.bindCode);
  }

  @Get()
  list(@Req() req: AuthenticatedRequest) {
    return this.devices.listMine(req.user.userId);
  }

  @Get(':deviceId')
  detail(
    @Req() req: AuthenticatedRequest,
    @Param('deviceId') deviceId: string,
  ) {
    return this.devices.getOwned(req.user.userId, deviceId);
  }

  @Patch(':deviceId')
  rename(
    @Req() req: AuthenticatedRequest,
    @Param('deviceId') deviceId: string,
    @Body() dto: UpdateDeviceDto,
  ) {
    return this.devices.rename(req.user.userId, deviceId, dto.name ?? null);
  }

  @Get(':deviceId/status')
  status(
    @Req() req: AuthenticatedRequest,
    @Param('deviceId') deviceId: string,
  ) {
    return this.devices.status(req.user.userId, deviceId);
  }

  @Get(':deviceId/battery-history')
  batteryHistory(
    @Req() req: AuthenticatedRequest,
    @Param('deviceId') deviceId: string,
    @Query() q: BatteryHistoryQueryDto,
  ) {
    return this.devices.batteryHistory(req.user.userId, deviceId, q.hours);
  }

  @Delete(':deviceId/binding')
  @HttpCode(204)
  async unbind(
    @Req() req: AuthenticatedRequest,
    @Param('deviceId') deviceId: string,
  ): Promise<void> {
    await this.devices.unbind(req.user.userId, deviceId);
  }
}
