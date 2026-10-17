// 10-17 第二轮评审 r4：admin 守卫查库失败不能回 401；查询时间空格写法也要显式时区。
import 'dotenv/config';
import type { INestApplication } from '@nestjs/common';
import { isParsableIsoDateTime } from '../src/common/iso-date';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  bindDevice,
  buildApp,
  cleanupDevices,
  cleanupUsers,
  createUser,
  envelope,
  provisionDevice,
  relay,
  type Http,
  type TestUser,
} from './helpers/hardening';
import {
  adminGet,
  cleanupAdmins,
  createAdmin,
  type TestAdmin,
} from './helpers/audit-admin';

jest.setTimeout(60_000);

const run = Date.now();

describe('admin 守卫 / 查询时间校验 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let admin: TestAdmin;
  let owner: TestUser;
  const users: TestUser[] = [];
  const dev = `admguard1017_${run}`;
  const adminUsernames: string[] = [];

  beforeAll(async () => {
    process.env.SOS_COUNTDOWN_SECONDS = '600';
    process.env.SOS_SCAN_INTERVAL_MS = '600000';
    ({ app, http, prisma } = await buildApp());
    admin = await createAdmin(prisma, http, `admguard1017_${run}`);
    adminUsernames.push(admin.username);
    owner = await createUser(app, http);
    users.push(owner);
    await provisionDevice(prisma, dev);
    await bindDevice(http, owner.token, dev);
    await relay(http, owner.token, dev, [
      envelope(dev, 'device_status', { battery: 50, charging: false }),
      envelope(dev, 'collision_risk', { riskLevel: 'high', direction: 'rear' }),
    ]).expect(202);
  });

  afterAll(async () => {
    await cleanupDevices(prisma, [dev]);
    await cleanupUsers(prisma, users);
    await cleanupAdmins(prisma, adminUsernames);
    await app.close();
  });

  it('管理员守卫查库失败（数据库瞬断）：不回 401（后台前端见 401 会清会话踢回登录页），按服务端错误处理', async () => {
    const spy = jest
      .spyOn(prisma.adminUser, 'findUnique')
      .mockRejectedValueOnce(new Error('injected db failure'));
    try {
      const res = await adminGet(http, admin.token, '/stats/overview');
      // 令牌本身是好的：按服务端异常处理（统一过滤器 500）
      expect(res.status).toBe(500);
      expect(res.body.code).not.toBe('UNAUTHORIZED');
    } finally {
      spy.mockRestore();
    }
  });

  it('查询时间用空格代替 T 且不带时区（2026-10-01 10:00:00）：400，带时区照收', async () => {
    const res = await adminGet(http, admin.token, '/events', {
      from: '2026-10-01 10:00:00',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    const zoned = await adminGet(http, admin.token, '/events', {
      from: '2026-10-01 10:00:00Z',
    });
    expect(zoned.status).toBe(200);
  });

  it('同一校验器（common/iso-date）：空格分隔、无时区的时间不放行（原来按服务器时区解析，TZ=Asia/Shanghai 时差 8 小时）', () => {
    const prev = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    try {
      const v = '2026-10-01 10:00:00';
      expect(isParsableIsoDateTime(v)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });
});
