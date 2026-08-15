import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module';
import { IngestService } from './ingest.service';
import { MqttConsumerService } from './mqtt-consumer.service';

@Module({
  imports: [DevicesModule],
  providers: [IngestService, MqttConsumerService],
  exports: [IngestService],
})
export class IngestModule {}
