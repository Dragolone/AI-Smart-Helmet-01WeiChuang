import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module';
import { LocationRecorderService } from './location-recorder.service';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';

@Module({
  imports: [DevicesModule],
  controllers: [LocationsController],
  providers: [LocationRecorderService, LocationsService],
  exports: [LocationRecorderService],
})
export class LocationsModule {}
