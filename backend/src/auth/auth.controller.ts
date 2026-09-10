import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { Public } from '../common/public.decorator';
import {
  ChangePasswordDto,
  ChangePhoneDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  ResetPasswordDto,
  SmsCodeDto,
} from './auth.dto';
import { AuthService } from './auth.service';
import type { AuthenticatedRequest } from './jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @HttpCode(204)
  @Post('sms-code')
  async smsCode(@Body() dto: SmsCodeDto): Promise<void> {
    await this.auth.sendSmsCode(dto.phone, dto.purpose);
  }

  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto.phone, dto.code, dto.password, dto.nickname);
  }

  @Public()
  @HttpCode(200)
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.phone, dto.password);
  }

  @Public()
  @HttpCode(204)
  @Post('reset-password')
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.auth.resetPassword(dto.phone, dto.code, dto.newPassword);
  }

  /** 需登录（非 @Public）：改密后其他会话全部撤销，本设备凭 refreshToken 保留 */
  @HttpCode(204)
  @Post('change-password')
  async changePassword(
    @Req() req: AuthenticatedRequest,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.auth.changePassword(
      req.user.userId,
      dto.oldPassword,
      dto.newPassword,
      dto.refreshToken,
    );
  }

  @HttpCode(200)
  @Post('change-phone')
  changePhone(@Req() req: AuthenticatedRequest, @Body() dto: ChangePhoneDto) {
    return this.auth.changePhone(req.user.userId, dto.newPhone, dto.code);
  }

  @Public()
  @HttpCode(200)
  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @HttpCode(204)
  @Post('logout')
  async logout(@Body() dto: RefreshDto): Promise<void> {
    await this.auth.logout(dto.refreshToken);
  }
}
