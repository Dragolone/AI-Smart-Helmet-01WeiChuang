import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
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

@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

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

  @Delete(':deviceId/binding')
  @HttpCode(204)
  async unbind(
    @Req() req: AuthenticatedRequest,
    @Param('deviceId') deviceId: string,
  ): Promise<void> {
    await this.devices.unbind(req.user.userId, deviceId);
  }
}
