import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { VoiceController } from './voice.controller';
import { VoiceService } from './voice.service';

@Module({
  imports: [RealtimeModule],
  controllers: [VoiceController],
  providers: [VoiceService],
})
export class VoiceModule {}
