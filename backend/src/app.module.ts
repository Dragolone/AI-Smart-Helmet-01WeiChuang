import { Module } from '@nestjs/common';
import { AdminModule } from './admin/admin.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { ContactsModule } from './contacts/contacts.module';
import { DevicesModule } from './devices/devices.module';
import { EmqxModule } from './emqx/emqx.module';
import { HealthController } from './health/health.controller';
import { IngestModule } from './ingest/ingest.module';
import { PrismaModule } from './prisma/prisma.module';
import { UsersController } from './users/users.controller';

@Module({
  imports: [
    PrismaModule,
    IngestModule,
    AuthModule,
    ContactsModule,
    DevicesModule,
    EmqxModule,
    AdminModule,
  ],
  controllers: [AppController, HealthController, UsersController],
  providers: [AppService],
})
export class AppModule {}
