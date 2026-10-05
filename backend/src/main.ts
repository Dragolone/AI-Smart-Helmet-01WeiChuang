import 'dotenv/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { errorMessage } from './common/error-text';
import { UnifiedExceptionFilter } from './common/http-exception.filter';
import { requestIdMiddleware } from './common/request-id.middleware';
import { shutdownState } from './common/shutdown-state';
import { sleep } from './common/sleep';
import { resolveTrustProxy } from './common/trust-proxy';

/** 收到 SIGTERM 后先让 /health 返回 503、再等这么久才关闭：给网关/拨测把流量摘走、在途请求跑完的时间（0 = 立即关） */
const shutdownDrainMs = (): number => {
  const n = Number.parseInt(process.env.SHUTDOWN_DRAIN_MS ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 3000;
};

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);
  // 原生 ws（决策 #25）：App 用平台原生 WebSocket 直连，不用 Socket.IO
  app.useWebSocketAdapter(new WsAdapter(app));
  app.setGlobalPrefix('api/v1');
  // 代理信任由 TRUST_PROXY 决定（审计 AUTH-07）：compose 里 backend 只经 Caddy 一跳，deploy 固定 1；
  // 直连/本地默认不信任任何 X-Forwarded-For，否则伪造该头即可绕过按 IP 的限频
  (app.getHttpAdapter().getInstance() as import('express').Express).set(
    'trust proxy',
    resolveTrustProxy(process.env.TRUST_PROXY),
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

  // 优雅关闭（审计 DBOPS-07）：不用 enableShutdownHooks（它收到信号即刻 close，无排空期）。
  // 信号 → /health 转 503 draining → 等 SHUTDOWN_DRAIN_MS → app.close()（onModuleDestroy 等生命周期钩子
  // 仍由 close() 触发：Prisma/MQTT 连接正常断开）→ 退出。第二次信号不再等待，直接退出。
  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) {
      logger.warn(`再次收到 ${signal}，跳过排空立即退出`);
      process.exit(130);
    }
    closing = true;
    const drainMs = shutdownDrainMs();
    shutdownState.markDraining();
    logger.log(
      `收到 ${signal}：/health 已转 503 draining，${drainMs}ms 后关闭`,
    );
    void (async () => {
      if (drainMs > 0) await sleep(drainMs);
      try {
        await app.close();
        logger.log('已关闭，进程退出');
        process.exit(0);
      } catch (err) {
        logger.error(`关闭过程出错：${errorMessage(err)}`);
        process.exit(1);
      }
    })();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
void bootstrap();
