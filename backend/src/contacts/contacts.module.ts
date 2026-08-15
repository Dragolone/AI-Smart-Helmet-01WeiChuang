import { Module } from '@nestjs/common';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';

@Module({
  controllers: [ContactsController],
  providers: [ContactsService],
  // SOS 通知流程（Week 7-8）从这里取联系人列表
  exports: [ContactsService],
})
export class ContactsModule {}
