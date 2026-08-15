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
  // EMQX 认证回调用 keep-alive 连接池（宣称 30s）；Node 默认 5s 就关空闲连接，
  // 会让 EMQX 复用到死连接导致认证超时。放宽到 65s 覆盖对方的复用窗口。
  const server = app.getHttpServer() as import('node:http').Server;
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
}
void bootstrap();
