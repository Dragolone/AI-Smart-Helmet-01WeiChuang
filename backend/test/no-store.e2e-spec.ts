// 接口应答一律 Cache-Control: no-store（API.md §1，上线清单 B 线 22）：正常应答、守卫拒绝的 401、
// 没有这个路由的 404、入参校验的 400 都要带——这些应答分别由控制器、守卫、Nest 路由、异常过滤器写出，走的路径不同。
import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { UnifiedExceptionFilter } from '../src/common/http-exception.filter';
import { requestIdMiddleware } from '../src/common/request-id.middleware';
import { registerUser } from './helpers/register';

jest.setTimeout(30000);

const randomPhone = (): string =>
  `19${Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, '0')}`;

describe('接口应答 Cache-Control: no-store (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(requestIdMiddleware);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new UnifiedExceptionFilter());
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();
    http = app.getHttpServer();
    const res = await registerUser(app, http, {
      phone: randomPhone(),
      password: 'e2e_password_1',
    });
    token = res.body.accessToken as string;
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['健康检查 200', () => request(http).get('/api/v1/health'), 200],
    [
      '带令牌的列表 200',
      () =>
        request(http)
          .get('/api/v1/devices')
          .set('Authorization', `Bearer ${token}`),
      200,
    ],
    ['守卫拒绝的 401', () => request(http).get('/api/v1/devices'), 401],
    [
      '没有这个路由的 404',
      () => request(http).get('/api/v1/no-such-route'),
      404,
    ],
    [
      '入参校验的 400',
      () => request(http).post('/api/v1/auth/login').send({}),
      400,
    ],
  ])('%s：应答带 Cache-Control: no-store', async (_name, send, status) => {
    const res = await send().expect(status);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
