import { Module } from '@nestjs/common';
import { BindingScopeService } from './binding-scope.service';
import { DeviceSnapshotService } from './device-snapshot.service';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';

@Module({
  controllers: [DevicesController],
  providers: [DevicesService, DeviceSnapshotService, BindingScopeService],
  exports: [DeviceSnapshotService, DevicesService, BindingScopeService],
})
export class DevicesModule {}
