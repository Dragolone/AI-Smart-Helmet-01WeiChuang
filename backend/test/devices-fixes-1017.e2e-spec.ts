// 10-17 后端评审设备一路的真库复现：R4-2 新主人替头盔回执前主人的命令、R4-3 时钟错乱的心跳不进电量曲线、
// R4-4 按事件号查详情取错了设备那条、R4-8 设备号大写绑不上、观察项 3 查询时间缺时区按进程时区解析。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  bindDevice,
  buildApp,
  cleanupDevices,
  cleanupUsers,
  createUser,
  envelope,
  provisionDevice,
  relay,
  validLocation,
  type Http,
  type TestUser,
} from './helpers/hardening';

jest.setTimeout(60_000);

describe('设备 / 命令 / 轨迹边界（10-17 评审）', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  const users: TestUser[] = [];
  const devices: string[] = [];
  const run = Date.now();
  let seq = 0;

  const newUser = async () => {
    const u = await createUser(app, http);
    users.push(u);
    return u;
  };
  const newDevice = async (u?: TestUser) => {
    seq += 1;
    const id = `devfix_${run}_${seq}`;
    devices.push(id);
    await provisionDevice(prisma, id);
    if (u) await bindDevice(http, u.token, id);
    return id;
  };
  const unbind = (u: TestUser, d: string) =>
    request(http)
      .delete(`/api/v1/devices/${d}/binding`)
      .set(auth(u.token))
      .expect(204);

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
  });
  afterAll(async () => {
    await cleanupDevices(prisma, devices);
    await cleanupUsers(prisma, users);
    await app.close();
  });

  it('R4-2 换绑后新主人替头盔回执前主人下发的命令：404，设置不生效（原来 200 success、设置变成前主人的）', async () => {
    const prev = await newUser();
    const next = await newUser();
    const d = await newDevice(prev);
    const put = await request(http)
      .put(`/api/v1/devices/${d}/settings`)
      .set(auth(prev.token))
      .send({ settings: { light: 3 } })
      .expect(202);
    await unbind(prev, d);
    await bindDevice(http, next.token, d);
    await request(http)
      .post(`/api/v1/devices/${d}/commands/${put.body.commandId}/relay-ack`)
      .set(auth(next.token))
      .send({ stage: 'executed', result: 'success' })
      .expect(404);
    const settings = await request(http)
      .get(`/api/v1/devices/${d}/settings`)
      .set(auth(next.token))
      .expect(200);
    expect(settings.body.settings).not.toHaveProperty('light', 3);
  });

  it('R4-3 头盔时钟错乱（1970 年）的心跳：电量曲线里有这个点（按收到时间），与状态 / 位置同口径', async () => {
    const u = await newUser();
    const d = await newDevice(u);
    await relay(http, u.token, d, [
      envelope(
        d,
        'device_status',
        { battery: 55 },
        { timestamp: '1970-01-01T00:00:10Z' },
      ),
    ]).expect(202);
    const history = await request(http)
      .get(`/api/v1/devices/${d}/battery-history?hours=1`)
      .set(auth(u.token))
      .expect(200);
    expect(
      history.body.points.map((p: { battery: number }) => p.battery),
    ).toEqual([55]);
  });

  it('R4-4 本人两台头盔上各有一条同号事件、其中一条在前主人期间：按事件号查详情返回本人看得到的那条（原来可能 404）', async () => {
    const prev = await newUser();
    const u = await newUser();
    const a = await newDevice(prev);
    const b = await newDevice(u);
    const eventId = randomUUID();
    await relay(http, prev.token, a, [
      envelope(a, 'location_update', validLocation(), { eventId }),
    ]).expect(202);
    await unbind(prev, a);
    await bindDevice(http, u.token, a);
    await relay(http, u.token, b, [
      envelope(b, 'location_update', validLocation(1), { eventId }),
    ]).expect(202);
    for (let i = 0; i < 3; i += 1) {
      const res = await request(http)
        .get(`/api/v1/events/${eventId}`)
        .set(auth(u.token))
        .expect(200);
      expect(res.body.deviceId).toBe(b);
    }
  });

  it('R4-8 照着标签把设备号敲成大写：照样绑得上（出厂编号一律小写）', async () => {
    const u = await newUser();
    const d = await newDevice();
    const res = await request(http)
      .post('/api/v1/devices/bind')
      .set(auth(u.token))
      .send({ deviceId: d.toUpperCase(), bindCode: `bc_${d}` })
      .expect(200);
    expect(res.body.deviceId).toBe(d);
  });

  it('观察项 3 查询时间带时间部分却不带时区：400（原来按服务器进程时区解析）；带 Z 或只到日期照常', async () => {
    const u = await newUser();
    const d = await newDevice(u);
    await request(http)
      .get(`/api/v1/devices/${d}/events?from=2026-10-01T00:00:00`)
      .set(auth(u.token))
      .expect(400);
    await request(http)
      .get(`/api/v1/devices/${d}/events?from=2026-10-01T00:00:00Z`)
      .set(auth(u.token))
      .expect(200);
    await request(http)
      .get(`/api/v1/devices/${d}/events?from=2026-10-01`)
      .set(auth(u.token))
      .expect(200);
  });
});
