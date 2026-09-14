// 审计 §7 —— EMQX 内部认证/授权回调（DEVICE_PROTOCOL §3/§4）的进程内契约回归。
//
// 这里用真实 Nest 应用直接打 /api/v1/internal/emqx/{authenticate,authorize}，
// 与真实 EMQX 每次连接/发布回调后端的裁决路径完全一致（EMQX 侧只是把这两个端点当 HTTP 判定器）。
// 真实 Broker 链路（连接被拒、SUBACK 128、静默丢弃、持久会话补投、clientId 顶替）由
// docs/testing/2026-09-13/evidence/mqtt/ 下的真机脚本覆盖；本文件锁死「后端作为凭证/ACL 权威」的判定逻辑。
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { buildApp, cleanupDevices, type Http } from './helpers/hardening';
import { PrismaService } from '../src/prisma/prisma.service';

const SUF = `mqtthook_${Date.now().toString(36)}`;
const DEV_A = `${SUF}_a`;
const DEV_B = `${SUF}_b`;
const SECRET = 'hardening'; // provisionDevice 写入的明文密钥（哈希在 helper 内）
const WRONG = 'not_the_secret';

const SERVICE_USER = process.env.MQTT_BACKEND_USERNAME ?? 'backend_ingest';
const SERVICE_PASS = process.env.MQTT_BACKEND_PASSWORD;
// 后端 MQTT 消费者的固定 clientId（默认 backend_ingest）——顶替风险的关键身份
const BACKEND_CLIENT_ID =
  process.env.MQTT_BACKEND_CLIENT_ID ?? 'backend_ingest';

// 内部令牌守卫读 process.env.EMQX_INTERNAL_TOKEN（live）；未配置时守卫 fail-closed（401）。
const TOKEN =
  process.env.EMQX_INTERNAL_TOKEN ?? 'audit_internal_token_for_test';

describe('审计 §7 EMQX 内部回调：认证 / 授权 / 内部令牌 (e2e in-process)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;

  beforeAll(async () => {
    if (!process.env.EMQX_INTERNAL_TOKEN) {
      process.env.EMQX_INTERNAL_TOKEN = TOKEN;
    }
    ({ app, http, prisma } = await buildApp());
    // 直接建两台设备（provisionDevice 用固定密钥 'hardening'）
    const hash = createHash('sha256').update(SECRET).digest('hex');
    for (const id of [DEV_A, DEV_B]) {
      await prisma.device.create({
        data: { deviceId: id, deviceSecretHash: hash, bindCode: `bc_${id}` },
      });
    }
  });

  afterAll(async () => {
    await cleanupDevices(prisma, [DEV_A, DEV_B]);
    await app.close();
  });

  const authn = (body: Record<string, unknown>, token = TOKEN) =>
    request(http)
      .post('/api/v1/internal/emqx/authenticate')
      .set('X-Internal-Token', token)
      .send(body);

  const authz = (body: Record<string, unknown>, token = TOKEN) =>
    request(http)
      .post('/api/v1/internal/emqx/authorize')
      .set('X-Internal-Token', token)
      .send(body);

  // ————— 内部令牌守卫（§3.1：令牌不匹配或未配置一律 401，fail-closed）—————
  it('AUTHN-TOKEN 无令牌 → 401', async () => {
    await request(http)
      .post('/api/v1/internal/emqx/authenticate')
      .send({ clientid: DEV_A, username: DEV_A, password: SECRET })
      .expect(401);
  });

  it('AUTHN-TOKEN 错误令牌 → 401', async () => {
    await authn(
      { clientid: DEV_A, username: DEV_A, password: SECRET },
      'wrong_token',
    ).expect(401);
  });

  // ————— 设备认证（§3：username=deviceId，password=deviceSecret，后端为唯一权威）—————
  it('AUTHN-OK 正确设备密钥 → allow', async () => {
    const res = await authn({
      clientid: DEV_A,
      username: DEV_A,
      password: SECRET,
    }).expect(200);
    expect(res.body).toEqual({ result: 'allow' });
  });

  it('AUTHN-WRONG 错误密钥 → deny', async () => {
    const res = await authn({
      clientid: DEV_A,
      username: DEV_A,
      password: WRONG,
    }).expect(200);
    expect(res.body).toEqual({ result: 'deny' });
  });

  it('AUTHN-UNKNOWN 不存在的 deviceId → deny', async () => {
    const res = await authn({
      clientid: 'ghost',
      username: 'ghost_device_xyz',
      password: SECRET,
    }).expect(200);
    expect(res.body).toEqual({ result: 'deny' });
  });

  it('AUTHN-EMPTY 缺用户名/密码 → deny', async () => {
    expect((await authn({ clientid: 'x' }).expect(200)).body).toEqual({
      result: 'deny',
    });
    expect(
      (await authn({ username: DEV_A, password: '' }).expect(200)).body,
    ).toEqual({ result: 'deny' });
  });

  it('AUTHN-SVC 后端服务账号：正确口令 allow / 错误口令 deny', async () => {
    if (!SERVICE_PASS) {
      // 未配置 MQTT_BACKEND_PASSWORD 时服务账号任何口令都 deny（服务端逻辑）
      expect(
        (await authn({ username: SERVICE_USER, password: 'x' }).expect(200))
          .body,
      ).toEqual({ result: 'deny' });
      return;
    }
    expect(
      (
        await authn({
          clientid: BACKEND_CLIENT_ID,
          username: SERVICE_USER,
          password: SERVICE_PASS,
        }).expect(200)
      ).body,
    ).toEqual({ result: 'allow' });
    expect(
      (await authn({ username: SERVICE_USER, password: 'wrong' }).expect(200))
        .body,
    ).toEqual({ result: 'deny' });
  });

  // ————— Topic 授权（§4：按 deviceId 隔离，越权一律拒绝）—————
  it('AUTHZ-PUB-OWN 设备 publish 自己的 status/location/event/cmd_ack → allow', async () => {
    for (const leaf of ['status', 'location', 'event', 'cmd_ack']) {
      const res = await authz({
        username: DEV_A,
        topic: `helmet/${DEV_A}/${leaf}`,
        action: 'publish',
      }).expect(200);
      expect(res.body).toEqual({ result: 'allow' });
    }
  });

  it('AUTHZ-SUB-CMD 设备 subscribe 自己的 cmd → allow；subscribe status → deny', async () => {
    expect(
      (
        await authz({
          username: DEV_A,
          topic: `helmet/${DEV_A}/cmd`,
          action: 'subscribe',
        }).expect(200)
      ).body,
    ).toEqual({ result: 'allow' });
    // 设备只准订阅 cmd 叶，不准订阅 status（那是上行）
    expect(
      (
        await authz({
          username: DEV_A,
          topic: `helmet/${DEV_A}/status`,
          action: 'subscribe',
        }).expect(200)
      ).body,
    ).toEqual({ result: 'deny' });
  });

  it('AUTHZ-PUB-CMD 设备 publish 自己的 cmd（下行叶）→ deny', async () => {
    expect(
      (
        await authz({
          username: DEV_A,
          topic: `helmet/${DEV_A}/cmd`,
          action: 'publish',
        }).expect(200)
      ).body,
    ).toEqual({ result: 'deny' });
  });

  it('AUTHZ-OTHER 设备操作他人 topic → deny（publish 与 subscribe）', async () => {
    expect(
      (
        await authz({
          username: DEV_A,
          topic: `helmet/${DEV_B}/event`,
          action: 'publish',
        }).expect(200)
      ).body,
    ).toEqual({ result: 'deny' });
    expect(
      (
        await authz({
          username: DEV_A,
          topic: `helmet/${DEV_B}/cmd`,
          action: 'subscribe',
        }).expect(200)
      ).body,
    ).toEqual({ result: 'deny' });
  });

  it('AUTHZ-WILDCARD 通配 helmet/# 与 helmet/+/cmd 与 $SYS/# → deny', async () => {
    for (const topic of ['helmet/#', 'helmet/+/cmd', '$SYS/#']) {
      const res = await authz({
        username: DEV_A,
        topic,
        action: 'subscribe',
      }).expect(200);
      expect(res.body).toEqual({ result: 'deny' });
    }
  });

  it('AUTHZ-NONPROTO 非协议 topic 与四段 topic → deny', async () => {
    for (const topic of [
      'foo/bar',
      `helmet/${DEV_A}/unknown_leaf`,
      `helmet/${DEV_A}/event/extra`,
    ]) {
      const res = await authz({
        username: DEV_A,
        topic,
        action: 'publish',
      }).expect(200);
      expect(res.body).toEqual({ result: 'deny' });
    }
  });

  it('AUTHZ-SVC 服务账号可操作任意 topic → allow', async () => {
    const res = await authz({
      username: SERVICE_USER,
      topic: `helmet/${DEV_B}/cmd`,
      action: 'subscribe',
    }).expect(200);
    expect(res.body).toEqual({ result: 'allow' });
  });

  it('AUTHZ-EMPTY 缺字段 → deny', async () => {
    expect(
      (await authz({ username: DEV_A, action: 'publish' }).expect(200)).body,
    ).toEqual({ result: 'deny' });
  });

  // ————— 【MQTT-01 缺陷断言】clientId 未与 username 绑定 —————
  // DEVICE_PROTOCOL §3 规定 username=deviceId、password=deviceSecret，§4 按 deviceId 隔离。
  // authenticate 回调只收 { clientid, username, password }，但服务端只校验 username/password，
  // 完全忽略 clientid。后果：任何持有【任一】合法设备密钥者，都能带上后端消费者的固定
  // clientId 连接 Broker（MQTT clientId 唯一性）把后端消费者顶下线——真机脚本已复现
  // （auth-acl-matrix.log AUTH-9：顶替成功、消费者被踢线；且顶替后消费者「已订阅」假成功、
  // 实际 0 订阅、全链路静默失聪，见报告 MQTT-02）。
  // 安全期望：设备连接必须校验 clientId == username（deviceId），
  // 因此「合法设备密钥 + clientId=后端消费者 id」应当被拒。当前实现不校验 → 本用例失败即缺陷证据。
  it('【MQTT-01 缺陷断言】合法设备密钥 + clientId=后端消费者 id 应被拒（当前不校验 clientId，会失败）', async () => {
    const res = await authn({
      clientid: BACKEND_CLIENT_ID, // 顶替后端消费者
      username: DEV_A, // 合法设备名
      password: SECRET, // 合法设备密钥
    }).expect(200);
    // 期望安全行为：deny（clientId 与设备名不符，且撞上后端保留 id）
    expect(res.body).toEqual({ result: 'deny' });
  });
});
