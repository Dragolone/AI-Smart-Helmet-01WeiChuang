// 容量测试账号/设备准备（helmet_audit_perf 专用，全部 load_ 前缀；凭证写入 scratchpad，不进证据目录）
// 用法: node 20-seed-load.mjs <BASE_URL> <N_USERS>
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang/backend/package.json');
const { Client } = require('pg');
const bcrypt = require('bcrypt');

const BASE = process.argv[2] ?? 'http://127.0.0.1:3500';
const N = Number(process.argv[3] ?? 60);
const DB = process.env.DATABASE_URL;
const PASSWORD = 'load_pw_0913';
const OUT = process.env.CREDS_OUT ?? '/private/tmp/claude-501/-Users-dravenzhong-Desktop-AI-Smart-Helmet-01WeiChuang/f23220c2-7807-4477-a125-d5f13c84ad94/scratchpad/dbops/load-creds.json';

const pg = new Client({ connectionString: DB });
await pg.connect();
const hash = await bcrypt.hash(PASSWORD, 10);
const users = [];
for (let i = 1; i <= N; i++) {
  const id = `load_u_${i}`;
  const phone = `197${String(10000000 + i).padStart(8, '0')}`;
  const deviceId = `load_helmet_${String(i).padStart(3, '0')}`;
  await pg.query(
    `INSERT INTO users(id, phone, password_hash, nickname) VALUES ($1,$2,$3,$4)
     ON CONFLICT (id) DO UPDATE SET password_hash=EXCLUDED.password_hash, phone=EXCLUDED.phone, deleted_at=NULL`,
    [id, phone, hash, `压测${i}`],
  );
  await pg.query(
    `INSERT INTO devices(device_id, device_secret_hash, bind_code) VALUES ($1,$2,$3) ON CONFLICT (device_id) DO NOTHING`,
    [deviceId, createHash('sha256').update('load').digest('hex'), `LOAD${String(i).padStart(3, '0')}`],
  );
  users.push({ id, phone, deviceId, bindCode: `LOAD${String(i).padStart(3, '0')}` });
}
// perf_helmet_0001（30 万点）的主人：改成已知密码以便压读接口（压测库专用数据）
await pg.query(`UPDATE users SET password_hash=$1 WHERE id='perf_u_1'`, [hash]);
const login = async (phone) => {
  const r = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, password: PASSWORD }) });
  if (!r.ok) throw new Error(`login ${phone} ${r.status} ${await r.text()}`);
  const j = await r.json();
  return { token: j.accessToken, userId: j.user?.id };
};
const creds = [];
for (const u of users) {
  const { token } = await login(u.phone);
  const b = await fetch(`${BASE}/api/v1/devices/bind`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ deviceId: u.deviceId, bindCode: u.bindCode }) });
  if (![200, 201].includes(b.status)) throw new Error(`bind ${u.deviceId} ${b.status} ${await b.text()}`);
  creds.push({ userId: u.id, phone: u.phone, token, deviceId: u.deviceId });
}
const perfOwner = await login('19500000001');
writeFileSync(OUT, JSON.stringify({ password: PASSWORD, users: creds, perfOwner: { ...perfOwner, phone: '19500000001', deviceId: 'perf_helmet_0001' } }, null, 1));
const cnt = await pg.query(`SELECT (SELECT count(*) FROM users WHERE id LIKE 'load_u_%') u, (SELECT count(*) FROM devices WHERE device_id LIKE 'load_helmet_%' AND bind_user_id IS NOT NULL) bound`);
console.log('seeded', cnt.rows[0], 'creds ->', OUT.replace(/\/private.*scratchpad/, '<scratchpad>'));
await pg.end();
