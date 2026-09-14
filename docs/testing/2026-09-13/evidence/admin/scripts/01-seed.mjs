// Admin 浏览器验收的合成数据：含 XSS/超长/换行/emoji 昵称与设备名、事故、危险事件、_invalid 留档
const API = 'http://127.0.0.1:3010/api/v1';
const j = async (p, o = {}) => {
  const r = await fetch(API + p, { ...o, headers: { 'content-type': 'application/json', ...(o.headers || {}) } });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
};
const phone = () => '19' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
const uuid = () => crypto.randomUUID();

// 后端短信为 Console Mock：验证码从后端日志取不方便，改用 DB 直读不可行（无连接）——
// 这里用 sms-code + 后端日志里最后一条验证码；为简化，改用注册接口 + 日志抓取。
import { execSync } from 'node:child_process';
const LOG = process.argv[2];
async function register(nickname) {
  const p = phone();
  const before = execSync(`wc -l < ${LOG}`).toString().trim();
  await j('/auth/sms-code', { method: 'POST', body: JSON.stringify({ phone: p, purpose: 'register' }) });
  const line = execSync(`tail -n +${before} ${LOG} | grep -a 'verify_code' | tail -1`).toString();
  const code = (line.match(/验证码为(\d{6})/) || [])[1];
  if (!code) throw new Error('验证码未在日志中找到：' + line.slice(0, 120));
  const r = await j('/auth/register', { method: 'POST', body: JSON.stringify({ phone: p, code, password: 'audit_pw_1234', nickname }) });
  if (r.status !== 201) throw new Error('register ' + r.status + ' ' + JSON.stringify(r.body));
  return { phone: p, ...r.body };
}
// 昵称上限 30 字符（UpdateMeDto/RegisterDto），敌意串裁到 30 内
const nick = {
  xss: '<img src=x onerror=alert(1)>',
  long: '超长昵称超长昵称超长昵称超长昵称超长昵称超长昵称',
  emoji: '🚴‍♂️骑行🔥\n第二行\t制表',
};
const users = {};
for (const [k, v] of Object.entries(nick)) users[k] = await register(v);
console.log('users:', Object.fromEntries(Object.entries(users).map(([k, u]) => [k, u.user.id])));

// 设备：用 Prisma 脚本开通不方便（需 DATABASE_URL），改用 provision 脚本的产物——这里直接调用 REST 不行。
// 由外层 shell 先 provision，把 deviceId/bindCode 通过 argv[3] 传入（JSON 数组）
const devs = JSON.parse(process.argv[3] || '[]');
const bound = [];
for (let i = 0; i < devs.length; i++) {
  const u = Object.values(users)[i % Object.keys(users).length];
  const r = await j('/devices/bind', { method: 'POST', headers: { authorization: `Bearer ${u.accessToken}` }, body: JSON.stringify(devs[i]) });
  if (r.status !== 200) { console.log('bind fail', devs[i].deviceId, r.status, r.body); continue; }
  bound.push({ ...devs[i], token: u.accessToken, user: u.user.id });
}
// 设备重命名（XSS 名）
if (bound[0]) await j(`/devices/${bound[0].deviceId}`, { method: 'PATCH', headers: { authorization: `Bearer ${bound[0].token}` }, body: JSON.stringify({ name: '<b>粗体设备</b>😀' }) });

const env = (deviceId, eventType, payload, over = {}) => ({ schemaVersion: 1, eventId: uuid(), deviceId, eventType, timestamp: new Date().toISOString(), firmwareVersion: '1.0.0-audit', payload, ...over });
for (const d of bound) {
  const batch = [
    env(d.deviceId, 'device_status', { battery: 60 + Math.floor(Math.random() * 30), charging: false, signalLevel: 3 }),
    env(d.deviceId, 'location_update', { latitude: 22.69, longitude: 114.35, coordinateSystem: 'gcj02', accuracy: 8, speed: 4.2, heading: 90, altitude: 30 }),
    env(d.deviceId, 'collision_risk', { riskLevel: 'high', objectType: 'vehicle', direction: 'rear', distance: 3.2, confidence: 0.9 }),
    env(d.deviceId, 'obstacle_risk', { riskLevel: 'low', objectType: 'obstacle', distance: 12 }),
  ];
  const r = await j('/ingest/app-relay', { method: 'POST', headers: { authorization: `Bearer ${d.token}` }, body: JSON.stringify({ deviceId: d.deviceId, envelopes: batch }) });
  console.log('relay', d.deviceId, r.status, JSON.stringify(r.body));
  // _invalid 留档（缺 firmwareVersion）
  await j('/ingest/app-relay', { method: 'POST', headers: { authorization: `Bearer ${d.token}` }, body: JSON.stringify({ deviceId: d.deviceId, envelopes: [{ schemaVersion: 1, eventId: uuid(), deviceId: d.deviceId, eventType: 'device_status', timestamp: new Date().toISOString(), payload: {} }] }) });
}
// 事故：第一台设备触发 possible_fall（保持 pending 供概览 activeSos 计数）
if (bound[0]) {
  const r = await j('/ingest/app-relay', { method: 'POST', headers: { authorization: `Bearer ${bound[0].token}` }, body: JSON.stringify({ deviceId: bound[0].deviceId, envelopes: [env(bound[0].deviceId, 'possible_fall', { confidence: 0.93, location: { latitude: 22.69, longitude: 114.35, coordinateSystem: 'gcj02' } })] }) });
  console.log('fall', r.status, JSON.stringify(r.body));
}
console.log('SEED_OK devices=' + bound.length);
