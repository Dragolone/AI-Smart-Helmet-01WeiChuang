import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Patch,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';

class UpdateMeDto {
  @IsOptional()
  @IsString()
  @MaxLength(30)
  nickname?: string;

  // http(s) URL(未来 OSS)或 data:image base64(MVP 本地闭环,App 侧压到 256px≈20KB;
  // 上限 90KB 以留在 Nest 默认 100KB JSON body 限制之内)
  @IsOptional()
  @IsString()
  @MaxLength(90_000)
  @Matches(
    /^(https?:\/\/\S{1,490}|data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+)$/,
    {
      message: 'avatarUrl 格式不正确',
    },
  )
  avatarUrl?: string;
}

class DeleteAccountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(72)
  password!: string;
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
  ) {}

  @Get('me')
  async me(@Req() req: AuthenticatedRequest) {
    const found = await this.prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { ...SAFE_USER_SELECT, deletedAt: true },
    });
    if (!found) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: '用户不存在',
      });
    }
    const { deletedAt, ...user } = found;
    // JWT 守卫无状态：注销后 access token 最多再活 15 分钟，这里把残留会话按未登录处理
    if (deletedAt) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: '账号已注销',
      });
    }
    return user;
  }

  /** 注销账号（软删除）：密码错误 400 PASSWORD_INCORRECT；成功 204，之后原手机号可重新注册 */
  @Delete('me')
  @HttpCode(204)
  async deleteMe(
    @Req() req: AuthenticatedRequest,
    @Body() dto: DeleteAccountDto,
  ): Promise<void> {
    await this.users.deleteAccount(req.user.userId, dto.password);
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
