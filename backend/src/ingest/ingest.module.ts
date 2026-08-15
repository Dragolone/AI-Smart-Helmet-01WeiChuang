import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module';
import { LocationsModule } from '../locations/locations.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { IngestService } from './ingest.service';
import { MqttConsumerService } from './mqtt-consumer.service';

@Module({
  imports: [DevicesModule, LocationsModule, RealtimeModule],
  providers: [IngestService, MqttConsumerService],
  exports: [IngestService],
})
export class IngestModule {}
