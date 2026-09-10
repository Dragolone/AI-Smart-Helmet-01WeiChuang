import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ContactsModule } from '../contacts/contacts.module';
import { DevicesModule } from '../devices/devices.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [AuthModule, DevicesModule, ContactsModule],
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
