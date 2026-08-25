import { Module } from '@nestjs/common';
import { IngestModule } from '../ingest/ingest.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { CommandsController } from './commands.controller';
import { CommandsSchedulerService } from './commands-scheduler.service';
import { CommandsService } from './commands.service';

@Module({
  // 借 Ingest 模块的 MQTT 连接下发 cmd / 接收 cmd_ack（回调注册，无环依赖）
  // Realtime：命令的 WS 下行（决策 #36）——新命令推送 + 连接补推；Realtime 不反向依赖本模块，无环
  imports: [IngestModule, RealtimeModule],
  controllers: [CommandsController],
  providers: [CommandsService, CommandsSchedulerService],
})
export class CommandsModule {}
