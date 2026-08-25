import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module';
import { LocationsModule } from '../locations/locations.module';
import { MediaModule } from '../media/media.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { SosModule } from '../sos/sos.module';
import { AppRelayController } from './app-relay.controller';
import { IngestService } from './ingest.service';
import { MqttConsumerService } from './mqtt-consumer.service';
import { WebhookController } from './webhook.controller';

@Module({
  imports: [
    DevicesModule,
    LocationsModule,
    MediaModule,
    RealtimeModule,
    SosModule,
  ],
  controllers: [AppRelayController, WebhookController],
  providers: [IngestService, MqttConsumerService],
  // MqttConsumerService 亦是后端唯一 MQTT 连接的持有者：命令模块借它下发 cmd/接收 cmd_ack
  exports: [IngestService, MqttConsumerService],
})
export class IngestModule {}
