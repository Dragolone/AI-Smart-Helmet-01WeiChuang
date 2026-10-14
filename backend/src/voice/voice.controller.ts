import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { RateLimit } from '../common/rate-limit.guard';
import { VoiceService } from './voice.service';

class CreateChannelDto {
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  name!: string;
}

class JoinChannelDto {
  @Matches(/^[0-9A-Za-z]{6}$/, { message: 'inviteCode 必须是 6 位字母或数字' })
  inviteCode!: string;
}

@Controller('voice/channels')
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  @Post()
  create(@Req() req: AuthenticatedRequest, @Body() dto: CreateChannelDto) {
    return this.voice.create(req.user.userId, dto.name);
  }

  @Get()
  list(@Req() req: AuthenticatedRequest) {
    return this.voice.listMine(req.user.userId);
  }

  // 邀请码 6 位字母 / 数字（决策 #57）、长期有效，且「码错 404 / 码对 200」能区分猜没猜中：不限频时一个脚本就能
  // 枚举出陌生人的频道并自动入群（看到成员昵称头像、拿进房凭证）。与绑定码同口径（决策 #53）
  @RateLimit({ name: 'voice_join', limit: 10, windowMs: 60_000 })
  @Post('join')
  @HttpCode(200)
  join(@Req() req: AuthenticatedRequest, @Body() dto: JoinChannelDto) {
    return this.voice.join(req.user.userId, dto.inviteCode);
  }

  @Delete(':channelId/membership')
  @HttpCode(204)
  async leave(
    @Req() req: AuthenticatedRequest,
    @Param('channelId') channelId: string,
  ): Promise<void> {
    await this.voice.leave(req.user.userId, channelId);
  }

  @Get(':channelId/members')
  members(
    @Req() req: AuthenticatedRequest,
    @Param('channelId') channelId: string,
  ) {
    return this.voice.members(req.user.userId, channelId);
  }

  @Post(':channelId/token')
  @HttpCode(200)
  token(
    @Req() req: AuthenticatedRequest,
    @Param('channelId') channelId: string,
  ) {
    return this.voice.token(req.user.userId, channelId);
  }
}
