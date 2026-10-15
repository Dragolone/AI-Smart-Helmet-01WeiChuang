import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { CommandsModule } from './commands/commands.module';
import { JsonDepthGuard } from './common/json-depth.guard';
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
  controllers: [HealthController],
  providers: [
    // 文本字段含 NUL 一律 400（PostgreSQL 拒绝 NUL，否则各写接口 500）；设备入口 @AllowNul 自行留档
    { provide: APP_GUARD, useClass: NulGuard },
    // 请求体嵌套过深 400：否则 ValidationPipe 递归栈溢出成 500（公开接口不带令牌也能打）
    { provide: APP_GUARD, useClass: JsonDepthGuard },
  ],
})
export class AppModule {}
