import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { UnifiedExceptionFilter } from './common/http-exception.filter';
import { requestIdMiddleware } from './common/request-id.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // 不开启此项则 SIGTERM/Ctrl+C 时所有 onModuleDestroy 不会执行（Prisma/MQTT 连接被硬切断）
  app.enableShutdownHooks();
  app.setGlobalPrefix('api/v1');
  app.use(requestIdMiddleware);
  // whitelist：丢弃 DTO 未声明的字段，防参数污染
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new UnifiedExceptionFilter());
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
