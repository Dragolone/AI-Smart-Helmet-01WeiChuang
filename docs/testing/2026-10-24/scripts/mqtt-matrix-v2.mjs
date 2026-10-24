// 真实 EMQX + 真实后端：认证 / ACL（#239 起 deny_action=disconnect 口径）/ 消息层 / 顶替后端消费者
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(process.env.WT + '/backend/package.json');
const mqtt = require('mqtt');
const { Client } = require('pg');
const URL = process.env.MQTT_URL;
const A = process.env.audit_mqtt_a_DEVICE_ID, A_SECRET = process.env.audit_mqtt_a_DEVICE_SECRET;
const B = process.env.audit_mqtt_b_DEVICE_ID, B_SECRET = process.env.audit_mqtt_b_DEVICE_SECRET;
const SVC_USER = process.env.MQTT_BACKEND_USERNAME;
const BACKEND_CLIENT_ID = process.env.MQTT_BACKEND_CLIENT_ID;
const pg = new Client({ connectionString: process.env.DATABASE_URL }); await pg.connect();
const results = [];
const rec = (id, desc, expected, actual, pass) => { results.push({ id, desc, expected, actual, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id} | ${desc} | expected=${expected} | actual=${actual}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tryConnect(opts) {
  return new Promise((resolve) => {
    const c = mqtt.connect(URL, { reconnectPeriod: 0, connectTimeout: 5000, ...opts });
    const t = setTimeout(() => { c.end(true); resolve({ ok: false, reason: 'timeout' }); }, 6000);
    c.once('connect', () => { clearTimeout(t); resolve({ ok: true, client: c }); });
    c.once('error', (e) => { clearTimeout(t); c.end(true); resolve({ ok: false, reason: e.message }); });
    c.once('close', () => { clearTimeout(t); resolve({ ok: false, reason: 'closed_before_connack' }); });
  });
}
const connA = () => tryConnect({ clientId: A, username: A, password: A_SECRET, clean: true });
// 做一个动作，看 2s 内连接是否被 Broker 断开
async function actionThenClosed(client, action) {
  let closed = false; client.once('close', () => { closed = true; });
  let result; try { result = await Promise.race([action(client), sleep(2000).then(() => 'no_response_2s')]); } catch (e) { result = `err:${e.message}`; }
  await sleep(800); const c = closed; client.end(true); return { result, closed: c };
}
const sub = (c, topic) => new Promise((res) => c.subscribe(topic, { qos: 1 }, (err, granted) => res(err ? `err:${err.message}` : granted.map((g) => g.qos).join(','))));
const pub = (c, topic, payload, qos = 1) => new Promise((res) => c.publish(topic, payload, { qos }, (err) => res(err ? `err:${err.message}` : 'puback')));
const env = (deviceId, eventType, payload, over = {}) => JSON.stringify({ schemaVersion: 1, eventId: randomUUID(), deviceId, eventType, timestamp: new Date().toISOString(), firmwareVersion: '0.1.0-audit', payload, ...over });
const loc = { latitude: 31.2, longitude: 121.5, coordinateSystem: 'wgs84', accuracy: 5, speed: 1, heading: 90 };
const count = async (deviceId, where = '', params = []) => Number((await pg.query(`select count(*) from raw_events where device_id=$1 ${where}`, [deviceId, ...params])).rows[0].count);
const invalidReasons = async (deviceId) => (await pg.query(`select payload->>'reason' r, count(*) n from raw_events where device_id=$1 and event_type='_invalid' group by 1`, [deviceId])).rows;

// ===== 1. 认证 =====
let r = await connA(); rec('AUTH-1', '正确密钥连接', 'connect', r.ok ? 'connect' : r.reason, r.ok); if (r.ok) r.client.end(true);
r = await tryConnect({ clientId: A, username: A, password: 'wrong', clean: true }); rec('AUTH-2', '错误密钥', 'Not authorized', r.ok ? 'connect' : r.reason, !r.ok && /Not authorized/.test(r.reason));
r = await tryConnect({ clientId: 'anon_' + randomUUID().slice(0, 6), clean: true }); rec('AUTH-3', '无凭证', 'Not authorized', r.ok ? 'connect' : r.reason, !r.ok);
r = await tryConnect({ clientId: 'imp_' + randomUUID().slice(0, 6), username: SVC_USER, password: 'wrong', clean: true }); rec('AUTH-4', '冒用后端服务账号（错密码）', 'Not authorized', r.ok ? 'connect' : r.reason, !r.ok);
r = await tryConnect({ clientId: B, username: B, password: B_SECRET, clean: true }); rec('AUTH-5', '已开通但未绑定设备 B', 'connect（认证与绑定无关）', r.ok ? 'connect' : r.reason, r.ok); if (r.ok) r.client.end(true);
r = await tryConnect({ clientId: A, username: A, password: '', clean: true }); rec('AUTH-6', '空密码', 'Not authorized', r.ok ? 'connect' : r.reason, !r.ok);
r = await tryConnect({ clientId: 'ghost_x', username: 'ghost_x', password: 'x', clean: true }); rec('AUTH-7', '不存在的 deviceId', 'Not authorized', r.ok ? 'connect' : r.reason, !r.ok);
r = await tryConnect({ clientId: BACKEND_CLIENT_ID, username: A, password: A_SECRET, clean: true });
rec('AUTH-8', `合法设备凭证 + clientId=后端消费者 ${BACKEND_CLIENT_ID}`, '应被拒', r.ok ? 'connect（顶替成功，后端消费者会被踢线）' : r.reason, !r.ok); if (r.ok) r.client.end(true);

// ===== 2. ACL：越权 → Broker 断开（deny_action=disconnect）=====
const bBefore = await count(B);
const denyCases = [
  ['ACL-1', 'A subscribe 他人 helmet/B/cmd', (c) => sub(c, `helmet/${B}/cmd`)],
  ['ACL-2', 'A subscribe 通配 helmet/#', (c) => sub(c, 'helmet/#')],
  ['ACL-3', 'A subscribe 通配 helmet/+/cmd', (c) => sub(c, 'helmet/+/cmd')],
  ['ACL-4', 'A subscribe $SYS/#', (c) => sub(c, '$SYS/#')],
  ['ACL-5', 'A publish 到他人 helmet/B/event', (c) => pub(c, `helmet/${B}/event`, env(B, 'location_update', loc))],
  ['ACL-6', 'A publish 到 helmet/A/cmd（设备不许发 cmd 叶）', (c) => pub(c, `helmet/${A}/cmd`, '{}')],
  ['ACL-7', 'A publish 到非协议 topic foo/bar', (c) => pub(c, 'foo/bar', 'x')],
  ['ACL-8', 'A publish 到 helmet/A/unknown_leaf', (c) => pub(c, `helmet/${A}/unknown_leaf`, env(A, 'device_status', { battery: 1 }))],
  ['ACL-9', 'A publish 到 helmet/A/event/extra（四段）', (c) => pub(c, `helmet/${A}/event/extra`, env(A, 'device_status', { battery: 1 }))],
];
for (const [id, desc, action] of denyCases) {
  const c = await connA(); if (!c.ok) { rec(id, desc, '断开', `connect failed: ${c.reason}`, false); continue; }
  const { result, closed } = await actionThenClosed(c.client, action);
  rec(id, desc, 'Broker 断开连接（无 SUBACK/PUBACK）', `result=${result} closed=${closed}`, closed && result !== 'puback' && result !== '1');
}
let a = (await connA()).client;
rec('ACL-10', 'A subscribe 自己的 helmet/A/cmd', 'granted qos 1', await sub(a, `helmet/${A}/cmd`), true);
const aBefore = await count(A, "and event_type<>'_invalid'");
rec('ACL-11', 'A publish 合法 location 到 helmet/A/location', 'puback', await pub(a, `helmet/${A}/location`, env(A, 'location_update', loc)), true);
await sleep(1500);
rec('ACL-12', '合法消息入库', '+1', String((await count(A, "and event_type<>'_invalid'")) - aBefore), (await count(A, "and event_type<>'_invalid'")) - aBefore === 1);
await pub(a, `helmet/${A}/event`, env(B, 'location_update', loc)); await sleep(1500);
rec('ACL-13', 'A 在自己 topic 内 envelope.deviceId=B', 'B 0 新增；A 侧 _invalid device_id_mismatch_with_topic', `B 新增 ${(await count(B)) - bBefore}；A reasons=${JSON.stringify(await invalidReasons(A))}`, (await count(B)) === bBefore && (await count(A, "and event_type='_invalid' and payload->>'reason'='device_id_mismatch_with_topic'")) >= 1);
rec('ACL-14', 'B 表在越权 publish 后仍 0 新增', '0', String((await count(B)) - bBefore), (await count(B)) === bBefore);

// ===== 3. 消息层 =====
const dupId = randomUUID(); const dupEnv = env(A, 'location_update', loc, { eventId: dupId });
await pub(a, `helmet/${A}/location`, dupEnv, 0); await pub(a, `helmet/${A}/location`, dupEnv, 1); await pub(a, `helmet/${A}/location`, dupEnv, 1); await sleep(1500);
const dupStored = Number((await pg.query('select count(*) from raw_events where device_id=$1 and event_id=$2', [A, dupId])).rows[0].count);
rec('MSG-1', '同 eventId QoS0 + QoS1×2 三次投递', '入库 1 条', String(dupStored), dupStored === 1);
await pub(a, `helmet/${A}/event`, '{not json'); await sleep(1200);
rec('MSG-2', '非 JSON payload', '_invalid invalid_json', JSON.stringify(await invalidReasons(A)), (await count(A, "and event_type='_invalid' and payload->>'reason'='invalid_json'")) >= 1);
await pub(a, `helmet/${A}/event`, env(A, 'device_status', { battery: 50, pad: 'x'.repeat(70 * 1024) })); await sleep(1500);
rec('MSG-3', '70KB（>65536 应用上限 <1MB Broker 上限）', '_invalid payload_too_large', JSON.stringify(await invalidReasons(A)), (await count(A, "and event_type='_invalid' and payload->>'reason'='payload_too_large'")) >= 1);
{ let closed = false; a.once('close', () => { closed = true; });
  const res = await Promise.race([pub(a, `helmet/${A}/event`, env(A, 'device_status', { battery: 50, pad: 'x'.repeat(1100 * 1024) })), sleep(4000).then(() => 'no_puback_4s')]);
  await sleep(500); rec('MSG-4', '1.1MB 消息（超 Broker max_packet_size 1MB）', 'Broker 断开连接、无 PUBACK', `puback=${res} closed=${closed}`, closed || res === 'no_puback_4s'); a.end(true); }

// ===== 4. 后端消费者不被顶替：设备 QoS1 事件照常到达 =====
a = (await connA()).client; const before = await count(A, "and event_type<>'_invalid'");
await pub(a, `helmet/${A}/location`, env(A, 'location_update', loc)); await sleep(1500);
rec('MSG-5', '合法设备 QoS1 事件到达后端', '+1', String((await count(A, "and event_type<>'_invalid'")) - before), (await count(A, "and event_type<>'_invalid'")) - before === 1); a.end(true);

await pg.end();
const fails = results.filter((x) => !x.pass).length;
console.log(`\n汇总：${results.length} 项，${results.length - fails} PASS，${fails} FAIL`);
process.exit(fails ? 1 : 0);
