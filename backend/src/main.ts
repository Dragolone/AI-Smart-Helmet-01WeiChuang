import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { UnifiedExceptionFilter } from './common/http-exception.filter';
import { requestIdMiddleware } from './common/request-id.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // 不开启此项则 SIGTERM/Ctrl+C 时所有 onModuleDestroy 不会执行（Prisma/MQTT 连接被硬切断）
  app.enableShutdownHooks();
  // 原生 ws（决策 #25）：App 用平台原生 WebSocket 直连，不用 Socket.IO
  app.useWebSocketAdapter(new WsAdapter(app));
  app.setGlobalPrefix('api/v1');
  // 生产在 Caddy 之后：信任第一跳代理，req.ip 才是真实客户端（限频按 IP 计）
  (app.getHttpAdapter().getInstance() as import('express').Express).set(
    'trust proxy',
    1,
  );
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
