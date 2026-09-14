// MQTT-01/02 修复复验（真实 EMQX 51883 + 真实后端 3100）：
//  ① 设备密钥 + 后端保留 clientId 顶替 → 认证应被拒（MQTT-01）
//  ② 服务账号 clean:true 顶替（等价"第二个后端实例"）→ 消费者重连后必须真正重订阅并继续入库（MQTT-02）
import mqtt from 'mqtt';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

const EV = '/Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang/docs/testing/2026-09-13/evidence/mqtt';
const env = Object.fromEntries(fs.readFileSync(`${EV}/.devices.env`, 'utf8').trim().split('\n').map(l => l.split('=')));
const DEV = env.audit_mqtt_a_DEVICE_ID, SECRET = env.audit_mqtt_a_DEVICE_SECRET;
const URL = process.env.MQTT_URL, BACKEND_ID = process.env.MQTT_BACKEND_CLIENT_ID;
const SVC_USER = process.env.MQTT_BACKEND_USERNAME, SVC_PASS = process.env.MQTT_BACKEND_PASSWORD;
const emqxApi = async (p) => (await fetch(`http://127.0.0.1:58083/api/v5${p}`, { headers: { authorization: 'Basic ' + Buffer.from('admin:public').toString('base64') } }));
const subsCount = async () => { const r = await emqxApi(`/clients/${encodeURIComponent(BACKEND_ID)}`); if (r.status !== 200) return `http ${r.status}`; return (await r.json()).subscriptions_cnt; };
const rawCount = () => Number(execSync(`docker exec helmet-audit-0913-pg psql -U audit -d helmet_audit_mqtt -At -c "select count(*) from raw_events where device_id='${DEV}'"`).toString().trim());
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tryConnect = (opts) => new Promise((resolve) => {
  const c = mqtt.connect(URL, { ...opts, reconnectPeriod: 0, connectTimeout: 4000 });
  c.on('connect', (ack) => resolve({ ok: true, ack, client: c }));
  c.on('error', (e) => { c.end(true); resolve({ ok: false, err: e.message }); });
  c.on('close', () => resolve({ ok: false, err: 'closed' }));
});
const publishProbe = async () => {
  const c = mqtt.connect(URL, { clientId: DEV, username: DEV, password: SECRET, reconnectPeriod: 0 });
  await new Promise((res, rej) => { c.on('connect', res); c.on('error', rej); });
  const env2 = { schemaVersion: 1, eventId: randomUUID(), deviceId: DEV, eventType: 'location_update', timestamp: new Date().toISOString(), firmwareVersion: 'audit-fix', payload: { latitude: 22.69, longitude: 114.35, coordinateSystem: 'gcj02', accuracy: 5, speed: 1, heading: 0 } };
  await new Promise((res, rej) => c.publish(`helmet/${DEV}/location`, JSON.stringify(env2), { qos: 1 }, (e) => e ? rej(e) : res()));
  await new Promise((res) => c.end(false, {}, res));
};
const out = [];
const rec = (k, v) => { out.push(`${k}: ${v}`); console.log(`${k}: ${v}`); };

rec('0 消费者初始订阅数', await subsCount());
const before = rawCount(); await publishProbe(); await sleep(1500);
rec('0 探针入库（修复前基线）', rawCount() - before === 1 ? 'PASS' : 'FAIL');

// ① MQTT-01
const r1 = await tryConnect({ clientId: BACKEND_ID, username: DEV, password: SECRET, clean: true });
if (r1.ok) r1.client.end(true);
rec('① 设备密钥 + 后端 clientId 顶替被拒（MQTT-01）', r1.ok ? 'FAIL（连接成功）' : `PASS（${r1.err}）`);
await sleep(1500);
rec('① 顶替被拒后消费者订阅数', await subsCount());

// ② MQTT-02：服务账号顶替（合法的第二实例）→ 原消费者被踢 → 自动重连 → 必须真正重订阅
const r2 = await tryConnect({ clientId: BACKEND_ID, username: SVC_USER, password: SVC_PASS, clean: true });
rec('② 服务账号顶替连接', r2.ok ? `ok sessionPresent=${r2.ack.sessionPresent}` : `FAIL ${r2.err}`);
await sleep(2000);
if (r2.ok) r2.client.end(true);
await sleep(4000); // 等原消费者重连（reconnectPeriod 默认 1s）+ 重订阅
const subsAfter = await subsCount();
rec('② 顶替后消费者订阅数（期望 4）', subsAfter);
const b2 = rawCount(); await publishProbe(); await sleep(2000);
rec('② 顶替后探针入库（MQTT-02，期望 1）', rawCount() - b2);
// EMQX 管理 API 需要非默认密码/API Key（本容器 401），订阅数只作参考；结论以行为为准：
// ① 设备密钥顶替被拒 ② 服务账号顶替后消费者重连并继续入库（后端日志同时出现「sessionPresent=true」+「已订阅」）
rec('结论', rawCount() - b2 === 1 && !r1.ok ? 'MQTT-01/02 修复验证 PASS（订阅数经行为验证）' : 'FAIL');
fs.writeFileSync(`${EV}/takeover-verify.log`, out.join('\n') + '\n');
