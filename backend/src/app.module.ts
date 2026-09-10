import { Module } from '@nestjs/common';
import { AdminModule } from './admin/admin.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { CommandsModule } from './commands/commands.module';
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
  providers: [AppService],
})
export class AppModule {}
