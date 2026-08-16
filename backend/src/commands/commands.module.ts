import { Module } from '@nestjs/common';
import { IngestModule } from '../ingest/ingest.module';
import { CommandsController } from './commands.controller';
import { CommandsSchedulerService } from './commands-scheduler.service';
import { CommandsService } from './commands.service';

@Module({
  // 借 Ingest 模块的 MQTT 连接下发 cmd / 接收 cmd_ack（回调注册，无环依赖）
  imports: [IngestModule],
  controllers: [CommandsController],
  providers: [CommandsService, CommandsSchedulerService],
})
export class CommandsModule {}
