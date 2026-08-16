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
import { VoiceService } from './voice.service';

class CreateChannelDto {
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  name!: string;
}

class JoinChannelDto {
  @Matches(/^\d{6}$/, { message: 'inviteCode 必须是 6 位数字' })
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
