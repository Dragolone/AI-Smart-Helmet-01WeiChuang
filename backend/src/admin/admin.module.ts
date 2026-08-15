import { Module } from '@nestjs/common';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthGuard } from './admin-auth.guard';
import { AdminAuthService } from './admin-auth.service';
import { AdminController } from './admin.controller';
import { adminJwtSecretProvider } from './admin.constants';
import { AdminService } from './admin.service';

@Module({
  controllers: [AdminAuthController, AdminController],
  providers: [
    adminJwtSecretProvider,
    AdminAuthGuard,
    AdminAuthService,
    AdminService,
  ],
})
export class AdminModule {}
