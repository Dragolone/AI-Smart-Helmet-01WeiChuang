import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import type { RelayAckRequest } from '@helmet/shared';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { CommandsService } from './commands.service';

class PutSettingsDto {
  // 扁平键值结构与标量约束在服务层校验（validateSettingsParams）
  @IsObject()
  settings!: Record<string, unknown>;
}

/** 头盔实际设置上报（决策 #45）：键值合法性在服务层逐键校验 */
class ReportSettingsDto {
  @IsObject()
  settings!: Record<string, unknown>;
}

/** relay-ack 请求体（决策 #36）：stage 联合的字段依赖（executed 必带 result）在 controller 收口 */
class RelayAckDto {
  @IsIn(['delivered', 'executed'])
  stage!: 'delivered' | 'executed';

  @IsOptional()
  @IsIn(['success', 'failed'])
  result?: 'success' | 'failed';

  @IsOptional()
  @IsString()
  errorCode?: string;

  @IsOptional()
  @IsString()
  executedAt?: string;
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

  @Post('devices/:deviceId/settings/reported')
  @HttpCode(200)
  reportSettings(
    @Req() req: AuthenticatedRequest,
    @Param('deviceId') deviceId: string,
    @Body() dto: ReportSettingsDto,
  ) {
    return this.commands.reportSettings(
      req.user.userId,
      deviceId,
      dto.settings,
    );
  }

  @Post('devices/:deviceId/commands/:commandId/relay-ack')
  @HttpCode(200)
  relayAck(
    @Req() req: AuthenticatedRequest,
    @Param('deviceId') deviceId: string,
    @Param('commandId') commandId: string,
    @Body() dto: RelayAckDto,
  ) {
    if (dto.stage === 'executed' && dto.result === undefined) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'stage=executed 时 result 必填',
      });
    }
    return this.commands.relayAck(
      req.user.userId,
      deviceId,
      commandId,
      dto as RelayAckRequest,
    );
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
