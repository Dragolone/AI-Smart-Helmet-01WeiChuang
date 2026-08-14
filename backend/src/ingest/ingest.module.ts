import { Module } from '@nestjs/common';
import { IngestService } from './ingest.service';
import { MqttConsumerService } from './mqtt-consumer.service';

@Module({
  providers: [IngestService, MqttConsumerService],
  exports: [IngestService],
})
export class IngestModule {}
