// 紧急联系人集成测试：CRUD、上限边界、软删除语义、归属隔离、入参校验（API.md §3）。
import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { UnifiedExceptionFilter } from '../src/common/http-exception.filter';
import { requestIdMiddleware } from '../src/common/request-id.middleware';
import { PrismaService } from '../src/prisma/prisma.service';
import { registerUser } from './helpers/register';

const randomPhone = (): string =>
  `19${Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, '0')}`;

const BASE = '/api/v1/users/me/emergency-contacts';

describe('紧急联系人 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let ownerToken: string;
  let otherToken: string;
  const userIds: string[] = [];

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
    prisma = app.get(PrismaService);

    const register = async (): Promise<string> => {
      const res = await registerUser(app, http, {
        phone: randomPhone(),
        password: 'e2e_password_1',
      });
      userIds.push(res.body.user.id as string);
      return res.body.accessToken as string;
    };
    ownerToken = await register();
    otherToken = await register();
  });

  afterAll(async () => {
    await prisma.emergencyContact
      .deleteMany({ where: { userId: { in: userIds } } })
      .catch(() => undefined);
    await app.close();
  });

  const create = (token: string, body: Record<string, unknown>): request.Test =>
    request(http).post(BASE).set('Authorization', `Bearer ${token}`).send(body);

  it('未登录 → 401 UNAUTHORIZED', async () => {
    const res = await request(http).get(BASE).expect(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('入参校验：缺 name / 空 name / 手机号非法 / 超长字段 → 400 VALIDATION_FAILED', async () => {
    const cases = [
      { phone: '13800001111' }, // 缺 name
      { name: '', phone: '13800001111' }, // 空 name
      { name: '妈妈', phone: '12345' }, // 手机号非法
      { name: '妈妈', phone: '23800001111' }, // 号段非法
      { name: 'x'.repeat(31), phone: '13800001111' }, // name 超长
      { name: '妈妈', phone: '13800001111', relation: 'x'.repeat(21) }, // relation 超长
    ];
    for (const body of cases) {
      const res = await create(ownerToken, body).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
  });

  it('创建 → 201 返回联系人对象；列表按创建先后排序', async () => {
    const res = await create(ownerToken, {
      name: '妈妈',
      phone: '13800001111',
      relation: '母亲',
    }).expect(201);
    expect(res.body).toMatchObject({
      name: '妈妈',
      phone: '13800001111',
      relation: '母亲',
    });
    expect(typeof res.body.id).toBe('string');
    expect(typeof res.body.createdAt).toBe('string');

    await create(ownerToken, { name: '爸爸', phone: '13800002222' }).expect(
      201,
    );
    const list = await request(http)
      .get(BASE)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(list.body).toHaveLength(2);
    expect(list.body.map((c: { name: string }) => c.name)).toEqual([
      '妈妈',
      '爸爸',
    ]);
    // relation 缺省为 null（不是 undefined 丢字段）
    expect(list.body[1].relation).toBeNull();
  });

  it('上限边界：第 5 个成功，第 6 个 → 409 EMERGENCY_CONTACT_LIMIT_REACHED', async () => {
    for (let i = 3; i <= 5; i++) {
      await create(ownerToken, {
        name: `联系人${i}`,
        phone: `1380000${i.toString().padStart(4, '0')}`,
      }).expect(201);
    }
    const res = await create(ownerToken, {
      name: '第六个',
      phone: '13800006666',
    }).expect(409);
    expect(res.body.code).toBe('EMERGENCY_CONTACT_LIMIT_REACHED');
  });

  it('软删除释放名额：删 1 个后可再建；列表不含已删', async () => {
    const list = await request(http)
      .get(BASE)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const victim = list.body[0] as { id: string; name: string };

    await request(http)
      .delete(`${BASE}/${victim.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(204);

    const after = await request(http)
      .get(BASE)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(after.body).toHaveLength(4);
    expect(
      after.body.find((c: { id: string }) => c.id === victim.id),
    ).toBeUndefined();

    // 库里记录仍在（软删留档），仅 deletedAt 置位
    const row = await prisma.emergencyContact.findUnique({
      where: { id: victim.id },
    });
    expect(row?.deletedAt).not.toBeNull();

    await create(ownerToken, { name: '补位', phone: '13800007777' }).expect(
      201,
    );
  });

  it('PATCH 更新字段；对已删/他人联系人操作 → 404', async () => {
    const list = await request(http)
      .get(BASE)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const target = list.body[0] as { id: string };

    const updated = await request(http)
      .patch(`${BASE}/${target.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '改名', relation: '兄弟' })
      .expect(200);
    expect(updated.body.name).toBe('改名');
    expect(updated.body.relation).toBe('兄弟');

    // 他人联系人：改/删都是 404（不泄露存在性）
    await request(http)
      .patch(`${BASE}/${target.id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ name: '越权' })
      .expect(404);
    await request(http)
      .delete(`${BASE}/${target.id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);

    // 已删联系人：再改/再删 → 404
    await request(http)
      .delete(`${BASE}/${target.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(204);
    await request(http)
      .patch(`${BASE}/${target.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '亡者归来' })
      .expect(404);
    await request(http)
      .delete(`${BASE}/${target.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(404);
  });

  it('PATCH 校验：非法手机号 → 400；未知字段被剥除不入库', async () => {
    const list = await request(http)
      .get(BASE)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const target = list.body[0] as { id: string; name: string };

    await request(http)
      .patch(`${BASE}/${target.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ phone: 'not-a-phone' })
      .expect(400);

    // whitelist：未知字段静默剥除，其余字段照常生效
    const res = await request(http)
      .patch(`${BASE}/${target.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '白名单', userId: 'hack', deletedAt: '2020-01-01' })
      .expect(200);
    expect(res.body.name).toBe('白名单');
    const row = await prisma.emergencyContact.findUnique({
      where: { id: target.id },
    });
    expect(row?.deletedAt).toBeNull();
    expect(userIds).toContain(row?.userId);
  });

  it('用户隔离：另一用户列表为空，看不到他人联系人', async () => {
    const res = await request(http)
      .get(BASE)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(200);
    expect(res.body).toEqual([]);
  });
});
