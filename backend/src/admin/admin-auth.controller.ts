import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Public } from '../common/public.decorator';
import { AdminAuthService } from './admin-auth.service';
import { AdminLoginDto } from './admin.dto';

@Public()
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly adminAuth: AdminAuthService) {}

  @HttpCode(200)
  @Post('login')
  login(@Body() dto: AdminLoginDto) {
    return this.adminAuth.login(dto.username, dto.password);
  }
}
