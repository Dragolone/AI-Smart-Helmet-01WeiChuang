import { Module } from '@nestjs/common';
import { EmqxHookController } from './emqx-hook.controller';
import { EmqxHookService } from './emqx-hook.service';

@Module({
  controllers: [EmqxHookController],
  providers: [EmqxHookService],
})
export class EmqxModule {}
