import { Module } from '@nestjs/common';
import { ProvidersModule } from '../providers/providers.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { SosController } from './sos.controller';
import { SosNotifierService } from './sos-notifier.service';
import { SosSchedulerService } from './sos-scheduler.service';
import { SosService } from './sos.service';
import { SosTriggerService } from './sos-trigger.service';

@Module({
  imports: [ProvidersModule, RealtimeModule],
  controllers: [SosController],
  providers: [
    SosService,
    SosTriggerService,
    SosNotifierService,
    SosSchedulerService,
  ],
  // Ingest 分发 possible_fall / manual_sos 用
  exports: [SosTriggerService],
})
export class SosModule {}
