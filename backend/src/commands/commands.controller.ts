import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsObject, IsOptional, Max, Min } from 'class-validator';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { CommandsService } from './commands.service';

class PutSettingsDto {
  // 扁平键值结构与标量约束在服务层校验（validateSettingsParams）
  @IsObject()
  settings!: Record<string, unknown>;
}

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

/** API.md §8：设置/命令挂设备资源下，命令详情按 commandId 查 */
@Controller()
export class CommandsController {
  constructor(private readonly commands: CommandsService) {}

  @Put('devices/:deviceId/settings')
  @HttpCode(202)
  putSettings(
    @Req() req: AuthenticatedRequest,
    @Param('deviceId') deviceId: string,
    @Body() dto: PutSettingsDto,
  ) {
    return this.commands.putSettings(req.user.userId, deviceId, dto.settings);
  }

  @Get('devices/:deviceId/settings')
  getSettings(
    @Req() req: AuthenticatedRequest,
    @Param('deviceId') deviceId: string,
  ) {
    return this.commands.getSettings(req.user.userId, deviceId);
  }

  @Get('devices/:deviceId/commands')
  list(
    @Req() req: AuthenticatedRequest,
    @Param('deviceId') deviceId: string,
    @Query() query: PageQueryDto,
  ) {
    return this.commands.listCommands(
      req.user.userId,
      deviceId,
      query.page,
      query.pageSize,
    );
  }

  @Get('commands/:commandId')
  detail(
    @Req() req: AuthenticatedRequest,
    @Param('commandId') commandId: string,
  ) {
    return this.commands.getCommand(req.user.userId, commandId);
  }
}
