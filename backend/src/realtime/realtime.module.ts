import { Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimePushService } from './realtime-push.service';

@Module({
  providers: [RealtimeGateway, RealtimePushService],
  exports: [RealtimePushService],
})
export class RealtimeModule {}
