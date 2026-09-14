// SIGTERM 优雅退出探针：30 路并发 app-relay（各 100 条）在途时向后端发 SIGTERM，
// 记录每路结果、退出耗时/退出码、端口释放、入库行数与 accepted 之和是否一致。
// 用法: DATABASE_URL=... node 41-sigterm-inflight.mjs <PID> <BASE> <CREDS_JSON>
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
const require = createRequire('/Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang/backend/package.json');
const { Client } = require('pg');
const [PID, BASE, CREDS] = [Number(process.argv[2]), process.argv[3], process.argv[4]];
const creds = JSON.parse(readFileSync(CREDS, 'utf8'));
const pg = new Client({ connectionString: process.env.DATABASE_URL }); await pg.connect();
const ids = creds.users.map((u) => u.deviceId);
const count = async () => (await pg.query(`select count(*)::int n from location_points where device_id = any($1)`, [ids])).rows[0].n;
const before = await count();
const env = (deviceId, i) => ({ schemaVersion: 1, eventId: randomUUID(), deviceId, eventType: 'location_update', timestamp: new Date().toISOString(), firmwareVersion: '0.1.0-sigterm', payload: { latitude: 31.2 + i * 1e-5, longitude: 121.5, coordinateSystem: 'gcj02', accuracy: 5, speed: 1, heading: 0 } });
const t0 = Date.now();
const reqs = Array.from({ length: 30 }, (_, k) => {
  const u = creds.users[k % creds.users.length];
  return fetch(`${BASE}/api/v1/ingest/app-relay`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${u.token}` }, body: JSON.stringify({ deviceId: u.deviceId, envelopes: Array.from({ length: 100 }, (_, i) => env(u.deviceId, i)) }) })
    .then(async (r) => ({ status: r.status, body: r.status === 202 ? await r.json() : (await r.text()).slice(0, 80), ms: Date.now() - t0 }))
    .catch((e) => ({ status: 'ERR', err: String(e?.cause?.code ?? e?.message).slice(0, 80), ms: Date.now() - t0 }));
});
await new Promise((r) => setTimeout(r, 40));
process.kill(PID, 'SIGTERM'); const tSig = Date.now();
const results = await Promise.all(reqs);
let alive = true; let exitWaitMs = null;
while (Date.now() - tSig < 70000) { try { process.kill(PID, 0); } catch { alive = false; exitWaitMs = Date.now() - tSig; break; } await new Promise((r) => setTimeout(r, 25)); }
let portListening = true; try { execSync(`lsof -nP -iTCP:${new URL(BASE).port} -sTCP:LISTEN`, { stdio: 'pipe' }); } catch { portListening = false; }
await new Promise((r) => setTimeout(r, 300));
const after = await count();
const accepted = results.reduce((a, r) => a + (r.status === 202 ? r.body.accepted : 0), 0);
const summary = { sigtermSentAfterMs: tSig - t0, completed202: results.filter((r) => r.status === 202).length, failed: results.filter((r) => r.status !== 202).map((r) => `${r.status}:${r.err ?? r.body}`).slice(0, 5), failedCount: results.filter((r) => r.status !== 202).length, exitedWithinMs: exitWaitMs, stillAlive: alive, portStillListening: portListening, acceptedSum: accepted, dbRowsDelta: after - before, note: 'dbRowsDelta > acceptedSum 表示有请求已部分入库但客户端未收到响应（逐条入库、幂等 eventId 可补传）' };
console.log(JSON.stringify(summary));
await pg.end();
