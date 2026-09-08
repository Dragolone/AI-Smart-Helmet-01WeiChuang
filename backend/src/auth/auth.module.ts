import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ProvidersModule } from '../providers/providers.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { SmsCodeService } from './sms-code.service';

@Module({
  imports: [
    ProvidersModule,
    JwtModule.registerAsync({
      global: true,
      useFactory: () => {
        const secret = process.env.JWT_SECRET;
        if (!secret) {
          throw new Error(
            'JWT_SECRET 未设置：请检查 backend/.env（参照 backend/.env.example）',
          );
        }
        // access 15 分钟（API.md §2 定稿）；refresh 的 30 天在 AuthService 内管理
        return { secret, signOptions: { expiresIn: '15m' } };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    SmsCodeService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
