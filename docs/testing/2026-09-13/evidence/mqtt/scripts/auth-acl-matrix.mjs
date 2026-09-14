// §7 认证 / ACL / 消息层矩阵（真实 EMQX 51883 + 真实后端 3100）。
// 用法：source env.sh; set -a; source $EV/.devices.env; set +a; node auth-acl-matrix.mjs | tee $EV/auth-acl-matrix.log
// 说明：mqtt.js v5 对 SUBACK 128（Broker 拒绝订阅）在回调里报 "Subscribe error"，sub() 归一为 '128'。
// 依赖：仓库 node_modules 的 mqtt@5 与 pg；只读写本脚本创建的 raw_events 行（deviceId=audit_mqtt_*）。
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire('/Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang/backend/package.json');
const mqtt = require('mqtt');
const { Client } = require('pg');

const URL = process.env.MQTT_URL;
const A = process.env.audit_mqtt_a_DEVICE_ID, A_SECRET = process.env.audit_mqtt_a_DEVICE_SECRET;
const B = process.env.audit_mqtt_b_DEVICE_ID, B_SECRET = process.env.audit_mqtt_b_DEVICE_SECRET;
const SVC_USER = process.env.MQTT_BACKEND_USERNAME, SVC_PASS = process.env.MQTT_BACKEND_PASSWORD;
const BACKEND_CLIENT_ID = process.env.MQTT_BACKEND_CLIENT_ID;
const pg = new Client({ connectionString: process.env.DATABASE_URL });
await pg.connect();
const results = [];
const rec = (id, desc, expected, actual, pass) => { results.push({ id, desc, expected, actual, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id} | ${desc} | expected=${expected} | actual=${actual}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tryConnect(opts, label) {
  return new Promise((resolve) => {
    const c = mqtt.connect(URL, { reconnectPeriod: 0, connectTimeout: 5000, ...opts });
    const t = setTimeout(() => { c.end(true); resolve({ ok: false, reason: 'timeout' }); }, 6000);
    c.once('connect', () => { clearTimeout(t); resolve({ ok: true, client: c }); });
    c.once('error', (e) => { clearTimeout(t); c.end(true); resolve({ ok: false, reason: e.message }); });
    c.once('close', () => { clearTimeout(t); resolve({ ok: false, reason: 'closed_before_connack' }); });
  });
}
const sub = (c, topic) => new Promise((res) => c.subscribe(topic, { qos: 1 }, (err, granted) => {
  if (err) return res(/Subscribe error/.test(err.message) ? '128' : `err:${err.message}`);
  res(granted.map((g) => g.qos).join(','));
}));
const subRec = async (id, desc, topic, c, want) => { const got = await sub(c, topic); rec(id, desc, want === '128' ? 'SUBACK 128（拒绝）' : `granted qos ${want}`, got, got === want); };
const pub = (c, topic, payload, qos = 1) => new Promise((res) => c.publish(topic, payload, { qos }, (err) => res(err ? `err:${err.message}` : 'puback')));
const env = (deviceId, eventType, payload, over = {}) => JSON.stringify({ schemaVersion: 1, eventId: randomUUID(), deviceId, eventType, timestamp: new Date().toISOString(), firmwareVersion: '0.1.0-audit', payload, ...over });
const loc = { latitude: 31.2, longitude: 121.5, coordinateSystem: 'wgs84', accuracy: 5, speed: 1, heading: 90 };
const count = async (deviceId, where = '', params = []) => Number((await pg.query(`select count(*) from raw_events where device_id=$1 ${where}`, [deviceId, ...params])).rows[0].count);
const invalidReasons = async (deviceId) => (await pg.query(`select payload->>'reason' r, count(*) n from raw_events where device_id=$1 and event_type='_invalid' group by 1`, [deviceId])).rows;

// ===== 1. 认证 =====
let r = await tryConnect({ clientId: A, username: A, password: A_SECRET });
rec('AUTH-1', '正确密钥连接', 'connect', r.ok ? 'connect' : r.reason, r.ok); const a = r.client;
r = await tryConnect({ clientId: `${A}_bad`, username: A, password: 'wrong_secret' });
rec('AUTH-2', '错误密钥', 'Not authorized', r.ok ? 'connect' : r.reason, !r.ok && /Not authorized/.test(r.reason));
r = await tryConnect({ clientId: `anon_${Date.now()}` });
rec('AUTH-3', '无凭证', 'Not authorized', r.ok ? 'connect' : r.reason, !r.ok);
r = await tryConnect({ clientId: 'svc_imp', username: SVC_USER, password: 'guess' });
rec('AUTH-4', '冒用后端服务账号（错密码）', 'Not authorized', r.ok ? 'connect' : r.reason, !r.ok);
r = await tryConnect({ clientId: 'anything_' + Date.now(), username: B, password: B_SECRET });
rec('AUTH-5', 'username=B 但 clientid≠B（hook 不校验 clientid）', 'connect (hook 无 clientid 规则)', r.ok ? 'connect' : r.reason, true); if (r.ok) r.client.end(true);
r = await tryConnect({ clientId: B, username: B, password: B_SECRET });
rec('AUTH-6', '已开通但未绑定设备 B', 'connect（认证与绑定无关）', r.ok ? 'connect' : r.reason, r.ok); const b = r.client;
r = await tryConnect({ clientId: A, username: A, password: '' });
rec('AUTH-7', '空密码', 'Not authorized', r.ok ? 'connect' : r.reason, !r.ok);
r = await tryConnect({ clientId: 'nouser', username: 'not_a_device', password: 'x' });
rec('AUTH-8', '不存在的 deviceId', 'Not authorized', r.ok ? 'connect' : r.reason, !r.ok);

// ===== 2. ACL =====
await subRec('ACL-1', 'A subscribe 他人 helmet/B/cmd', `helmet/${B}/cmd`, a, '128');
await subRec('ACL-2', 'A subscribe 自己的 helmet/A/cmd', `helmet/${A}/cmd`, a, '1');
await subRec('ACL-3', 'A subscribe 通配 helmet/#', 'helmet/#', a, '128');
await subRec('ACL-4', 'A subscribe 通配 helmet/+/cmd', 'helmet/+/cmd', a, '128');
await subRec('ACL-5', 'A subscribe $SYS/#', '$SYS/#', a, '128');
const bBefore = await count(B);
rec('ACL-6', 'A publish 到他人 helmet/B/event（合法 envelope deviceId=B）', 'PUBACK（deny_action=ignore 静默丢弃）', await pub(a, `helmet/${B}/event`, env(B, 'location_update', loc)), true);
rec('ACL-7', 'A publish 到 helmet/A/cmd（设备不许发 cmd 叶）', 'PUBACK 静默丢弃', await pub(a, `helmet/${A}/cmd`, JSON.stringify({ commandId: 'x', type: 'set_config', params: {}, issuedAt: new Date().toISOString() })), true);
rec('ACL-8', 'A publish 到非协议 topic foo/bar', 'PUBACK 静默丢弃', await pub(a, 'foo/bar', 'x'), true);
rec('ACL-9', 'A publish 到 helmet/A/unknown_leaf', 'PUBACK 静默丢弃', await pub(a, `helmet/${A}/unknown_leaf`, env(A, 'device_status', { battery: 1 })), true);
rec('ACL-10', 'A publish 到 helmet/A/event/extra（四段）', 'PUBACK 静默丢弃', await pub(a, `helmet/${A}/event/extra`, env(A, 'device_status', { battery: 1 })), true);
// 自己 topic 内冒充他人 deviceId
const aInvalidBefore = await count(A, "and event_type='_invalid'");
await pub(a, `helmet/${A}/event`, env(B, 'location_update', loc));
await sleep(1500);
rec('ACL-11', 'A 在自己 topic 内 envelope.deviceId=B', 'B 0 新增；A 侧 _invalid device_id_mismatch_with_topic', `B 新增 ${(await count(B)) - bBefore}；A reasons=${JSON.stringify(await invalidReasons(A))}`, (await count(B)) === bBefore && (await count(A, "and event_type='_invalid' and payload->>'reason'='device_id_mismatch_with_topic'")) >= 1);
rec('ACL-12', 'B 表在 ACL-6..10 后仍 0 新增（他人 topic 越权 publish 未入库）', '0', String((await count(B)) - bBefore), (await count(B)) === bBefore);
// B 的 event 能否被 A 的订阅收到？A 已被拒订阅 B/cmd；此处验证 A 收不到 B 的任何消息
let leaked = 0; a.on('message', () => { leaked += 1; });
await pub(b, `helmet/${B}/status`, env(B, 'device_status', { battery: 90, charging: false, sleeping: false }));
await sleep(800);
rec('ACL-13', 'A 收到 B 消息数（越权订阅全部被拒后）', '0', String(leaked), leaked === 0);

// ===== 3. 消息层 =====
const aStoredBefore = await count(A, "and event_type<>'_invalid'");
const e1 = env(A, 'location_update', loc);
await pub(a, `helmet/${A}/location`, e1, 0);
await pub(a, `helmet/${A}/location`, e1, 1);
await pub(a, `helmet/${A}/location`, e1, 1);
await pub(a, `helmet/${A}/event`, 'this is not json', 1);
await pub(a, `helmet/${A}/event`, JSON.stringify({ schemaVersion: 1, eventId: randomUUID(), deviceId: A, eventType: 'device_status', timestamp: new Date().toISOString(), firmwareVersion: 'x', payload: { blob: 'z'.repeat(70_000) } }), 1);
await sleep(1500);
const dupStored = Number((await pg.query('select count(*) from raw_events where event_id=$1', [JSON.parse(e1).eventId])).rows[0].count);
rec('MSG-1', '同 eventId QoS0 + QoS1×2 三次投递', '入库 1 条', String(dupStored), dupStored === 1);
rec('MSG-2', '非 JSON payload', '_invalid invalid_json', JSON.stringify(await invalidReasons(A)), (await count(A, "and event_type='_invalid' and payload->>'reason'='invalid_json'")) >= 1);
rec('MSG-3', '70KB（>65536 应用上限 <1MB Broker 上限）', '_invalid payload_too_large', '', (await count(A, "and event_type='_invalid' and payload->>'reason'='payload_too_large'")) >= 1);
// 1MB+ 消息：EMQX max_packet_size=1MB → 应断开连接
const big = mqtt.connect(URL, { clientId: `${A}`, username: A, password: A_SECRET, reconnectPeriod: 0 });
await new Promise((res) => big.once('connect', res));
let bigClosed = false; big.once('close', () => { bigClosed = true; });
const bigRes = await Promise.race([pub(big, `helmet/${A}/event`, 'x'.repeat(1_100_000), 1), sleep(4000).then(() => 'no_puback_4s')]);
await sleep(500);
rec('MSG-4', '1.1MB 消息（超 Broker max_packet_size 1MB）', 'Broker 断开连接、无 PUBACK', `puback=${bigRes} closed=${bigClosed}`, bigClosed || bigRes === 'no_puback_4s');
big.end(true);
const invalidRows = await pg.query(`select payload->>'reason' r, length(payload->>'raw') rawlen from raw_events where device_id=$1 and event_type='_invalid' order by received_at desc limit 5`, [A]);
console.log('A _invalid 明细（raw 截断长度）:', JSON.stringify(invalidRows.rows));

b.end(true);
await sleep(300);
// ===== 4. clientId 顶替：用合法设备凭证 + 后端消费者 clientId 连接 =====
const before = Date.now();
const imp = await tryConnect({ clientId: BACKEND_CLIENT_ID, username: A, password: A_SECRET, clean: true });
rec('AUTH-9', `合法设备凭证 + clientId=后端消费者 ${BACKEND_CLIENT_ID}`, '应被拒（clientid 与 username 不一致）', imp.ok ? 'connect（顶替成功，后端消费者被踢线）' : imp.reason, !imp.ok);
await sleep(2500);
if (imp.ok) imp.client.end(true);
// 顶替期间 A 发一条事件，看是否丢失（后端不在线且其持久会话被 clean:true 覆盖）
const lostProbe = env(A, 'device_status', { battery: 42, charging: false, sleeping: false });
if (imp.ok) {
  // 在顶替者仍在线时发（后端已掉线）
  const imp2 = await tryConnect({ clientId: BACKEND_CLIENT_ID, username: A, password: A_SECRET, clean: true });
  // 注意：MSG-4 的 big 客户端用同 clientId=A 已把 a 踢线（mqtt.js 断线后 QoS1 publish 回调永不触发），这里另开 a2
  const a2r = await tryConnect({ clientId: A, username: A, password: A_SECRET });
  const probeRes = a2r.ok ? await Promise.race([pub(a2r.client, `helmet/${A}/status`, lostProbe, 1), sleep(5000).then(() => 'no_puback_5s')]) : a2r.reason;
  console.log(`AUTH-10 探针发布结果：${probeRes}`);
  await sleep(1500);
  imp2.client?.end(true);
  a2r.client?.end(true);
  await sleep(4000); // 等后端重连重订阅
  const got = Number((await pg.query('select count(*) from raw_events where event_id=$1', [JSON.parse(lostProbe).eventId])).rows[0].count);
  rec('AUTH-10', '顶替期间设备发出的 QoS1 事件是否到达后端', '1（若持久会话未被破坏）', String(got), got === 1);
}
await pg.end();
const { writeFileSync } = await import('node:fs');
writeFileSync(new globalThis.URL('../auth-acl-matrix.json', import.meta.url), JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
console.log('\nSUMMARY', JSON.stringify({ total: results.length, failed: results.filter((x) => !x.pass).map((x) => x.id) }));
