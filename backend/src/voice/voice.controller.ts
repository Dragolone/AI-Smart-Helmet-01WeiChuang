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
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { cleanName } from '../common/display-name';
import { RateLimit } from '../common/rate-limit.guard';
import { VoiceService } from './voice.service';

class CreateChannelDto {
  // 与联系人名同口径：先整理再验 1–30，全空白 / 只含零宽字符的频道名 400（10-16 BC3 / N 系列）
  @Transform(cleanName)
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  name!: string;
}

class JoinChannelDto {
  @Matches(/^[0-9A-Za-z]{6}$/, { message: 'inviteCode 必须是 6 位字母或数字' })
  inviteCode!: string;
}

/** 整个可省略（旧包不带，行为同从前）；带了 purpose 就必须带 clientId（决策 #62） */
class TokenDto {
  @ValidateIf(
    (o: TokenDto) => o.clientId !== undefined || o.purpose !== undefined,
  )
  @Matches(/^[0-9A-Za-z_-]{8,64}$/, {
    message: 'clientId 必须是 8–64 位字母、数字、_ 或 -',
  })
  clientId?: string;

  @IsOptional()
  @IsIn(['enter', 'renew'])
  purpose?: 'enter' | 'renew';
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
  // 枚举出陌生人的频道并自动入群（看到成员昵称头像、拿进房凭证）。
  // 按账号计（决策 #57「每账号每分钟 10 次」）：原来按 IP，集合点大家连同一个热点 / 运营商 NAT 出口，
  // 第 11 个人凭正确的码入群就 429（10-17 第二轮评审 r1）。另留一条宽松的按 IP 上限，挡同一出口批量注册小号枚举
  @RateLimit(
    { name: 'voice_join', limit: 10, windowMs: 60_000, keyBy: 'user' },
    { name: 'voice_join_ip', limit: 60, windowMs: 60_000 },
  )
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
    @Body() dto: TokenDto,
  ) {
    return this.voice.token(req.user.userId, channelId, dto);
  }
}
