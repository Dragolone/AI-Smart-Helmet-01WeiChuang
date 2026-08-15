import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // 不开启此项则 SIGTERM/Ctrl+C 时所有 onModuleDestroy 不会执行（Prisma/MQTT 连接被硬切断）
  app.enableShutdownHooks();
  app.setGlobalPrefix('api/v1');
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
