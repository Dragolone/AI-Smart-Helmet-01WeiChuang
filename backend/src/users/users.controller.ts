import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Patch,
  Req,
} from '@nestjs/common';
import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';

class UpdateMeDto {
  @IsOptional()
  @IsString()
  @MaxLength(30)
  nickname?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(500)
  avatarUrl?: string;
}

const SAFE_USER_SELECT = {
  id: true,
  phone: true,
  nickname: true,
  avatarUrl: true,
  createdAt: true,
} as const;

@Controller('users')
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('me')
  async me(@Req() req: AuthenticatedRequest) {
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.userId },
      select: SAFE_USER_SELECT,
    });
    if (!user) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: '用户不存在',
      });
    }
    return user;
  }

  @Patch('me')
  updateMe(@Req() req: AuthenticatedRequest, @Body() dto: UpdateMeDto) {
    return this.prisma.user.update({
      where: { id: req.user.userId },
      data: {
        ...(dto.nickname !== undefined && { nickname: dto.nickname }),
        ...(dto.avatarUrl !== undefined && { avatarUrl: dto.avatarUrl }),
      },
      select: SAFE_USER_SELECT,
    });
  }
}
