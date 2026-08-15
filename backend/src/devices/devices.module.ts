import { Module } from '@nestjs/common';
import { DeviceSnapshotService } from './device-snapshot.service';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';

@Module({
  controllers: [DevicesController],
  providers: [DevicesService, DeviceSnapshotService],
  exports: [DeviceSnapshotService, DevicesService],
})
export class DevicesModule {}
