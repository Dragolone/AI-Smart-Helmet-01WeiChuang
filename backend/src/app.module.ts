import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AdminModule } from './admin/admin.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { CommandsModule } from './commands/commands.module';
import { NulGuard } from './common/nul.guard';
import { ContactsModule } from './contacts/contacts.module';
import { DevicesModule } from './devices/devices.module';
import { EmqxModule } from './emqx/emqx.module';
import { EventsModule } from './events/events.module';
import { HealthController } from './health/health.controller';
import { IngestModule } from './ingest/ingest.module';
import { MediaModule } from './media/media.module';
import { PrismaModule } from './prisma/prisma.module';
import { SosModule } from './sos/sos.module';
import { UsersModule } from './users/users.module';
import { VoiceModule } from './voice/voice.module';

@Module({
  imports: [
    PrismaModule,
    IngestModule,
    AuthModule,
    CommandsModule,
    ContactsModule,
    DevicesModule,
    EmqxModule,
    EventsModule,
    MediaModule,
    AdminModule,
    SosModule,
    UsersModule,
    VoiceModule,
  ],
  controllers: [AppController, HealthController],
  providers: [
    AppService,
    // 文本字段含 NUL 一律 400（PostgreSQL 拒绝 NUL，否则各写接口 500）；设备入口 @AllowNul 自行留档
    { provide: APP_GUARD, useClass: NulGuard },
  ],
})
export class AppModule {}
