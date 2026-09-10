import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module';
import { ProvidersModule } from '../providers/providers.module';
import { MediaController } from './media.controller';
import { MediaRecorderService } from './media-recorder.service';
import { MediaService } from './media.service';

@Module({
  imports: [ProvidersModule, DevicesModule],
  controllers: [MediaController],
  providers: [MediaService, MediaRecorderService],
  // Ingest 分发 video_ready 用
  exports: [MediaRecorderService],
})
export class MediaModule {}
