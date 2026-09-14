// 容量/可恢复性负载器（真实进程 node dist/main @3500，helmet_audit_perf）
// 用法: DATABASE_URL=... node 30-load.mjs <scenario> [KEY=VAL ...]
//   scenario: relay | getloc | ws | settings | sms | mixed | recovery | sos
// 输出 JSON 一行（同时追加到 30-load-results.jsonl）；所有数据合成，凭证只在 scratchpad。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
const require = createRequire('/Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang/backend/package.json');
const { Client } = require('pg');
const WebSocket = require('ws');

const EV = '/Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang/docs/testing/2026-09-13/evidence/dbops';
const SP = '/private/tmp/claude-501/-Users-dravenzhong-Desktop-AI-Smart-Helmet-01WeiChuang/f23220c2-7807-4477-a125-d5f13c84ad94/scratchpad/dbops';
const scenario = process.argv[2];
const opts = Object.fromEntries(process.argv.slice(3).map((kv) => kv.split('=')));
const BASE = opts.BASE ?? 'http://127.0.0.1:3500';
const WSBASE = BASE.replace('http', 'ws');
const PID = Number(readFileSync(`${EV}/10-backend-3500.pid`, 'utf8').trim());
const creds = JSON.parse(readFileSync(`${SP}/load-creds.json`, 'utf8'));
const pg = new Client({ connectionString: process.env.DATABASE_URL });
await pg.connect();

const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)].toFixed(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hdr = (token) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });
const envelope = (deviceId, eventType, payload) => ({ schemaVersion: 1, eventId: randomUUID(), deviceId, eventType, timestamp: new Date().toISOString(), firmwareVersion: '0.1.0-load', payload });
let seq = 0;
const loc = () => { seq += 1; return { latitude: 31.2 + (seq % 1000) * 0.00001, longitude: 121.5 + (seq % 1000) * 0.00001, coordinateSystem: 'gcj02', accuracy: 5, speed: 3.2, heading: 90, altitude: 12 }; };
const relay = (u, envelopes) => fetch(`${BASE}/api/v1/ingest/app-relay`, { method: 'POST', headers: hdr(u.token), body: JSON.stringify({ deviceId: u.deviceId, envelopes }) });

async function procSample() {
  const out = execSync(`ps -o rss=,%cpu= -p ${PID}`).toString().trim().split(/\s+/);
  const conn = await pg.query(`select count(*)::int total, count(*) filter (where state='active')::int active, count(*) filter (where wait_event_type='Lock')::int waiting from pg_stat_activity where datname=current_database() and backend_type='client backend' and pid<>pg_backend_pid()`);
  return { t: new Date().toISOString(), rssMB: +(Number(out[0]) / 1024).toFixed(0), cpuPct: Number(out[1]), pgConn: conn.rows[0] };
}
function startSampler(everyMs = 5000) {
  const samples = [];
  const h = setInterval(() => { procSample().then((s) => samples.push(s)).catch(() => {}); }, everyMs);
  return { samples, stop: () => clearInterval(h) };
}
async function closedLoop(name, concurrency, durationMs, taskFactory) {
  const lat = []; const statuses = {}; const errors = []; let ok = 0; let bad = 0;
  const end = performance.now() + durationMs;
  const workers = Array.from({ length: concurrency }, (_, i) => (async () => {
    const task = taskFactory(i);
    while (performance.now() < end) {
      const t0 = performance.now();
      try {
        const st = await task();
        lat.push(performance.now() - t0);
        statuses[st] = (statuses[st] ?? 0) + 1;
        if (st >= 200 && st < 300) ok += 1; else { bad += 1; }
      } catch (e) {
        lat.push(performance.now() - t0); bad += 1; statuses.EXC = (statuses.EXC ?? 0) + 1;
        if (errors.length < 3) errors.push(String(e?.cause?.code ?? e?.message ?? e).slice(0, 120));
      }
    }
  })());
  const t0 = performance.now();
  await Promise.all(workers);
  const elapsed = (performance.now() - t0) / 1000;
  return { name, concurrency, durationS: +elapsed.toFixed(1), requests: lat.length, rps: +(lat.length / elapsed).toFixed(1), p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: pct(lat, 100), statuses, errorRate: +((bad / Math.max(1, lat.length)) * 100).toFixed(2) + '%', errors };
}
const countLoadRows = async () => (await pg.query(`select (select count(*) from location_points where device_id like 'load_helmet_%')::int lp, (select count(*) from raw_events where device_id like 'load_helmet_%')::int re`)).rows[0];

// ---- scenarios ----
async function relayScenario(C, batch, durMs) {
  const before = await countLoadRows();
  let accepted = 0; let duplicate = 0; let invalid = 0;
  const res = await closedLoop(`app-relay C=${C} batch=${batch}`, C, durMs, (i) => {
    const u = creds.users[i % creds.users.length];
    return async () => {
      const r = await relay(u, Array.from({ length: batch }, () => envelope(u.deviceId, 'location_update', loc())));
      if (r.status === 202) { const j = await r.json(); accepted += j.accepted; duplicate += j.duplicate; invalid += j.invalid; } else await r.text();
      return r.status;
    };
  });
  const after = await countLoadRows();
  return { ...res, sent: res.requests * batch, accepted, duplicate, invalid, dbDelta: { location_points: after.lp - before.lp, raw_events: after.re - before.re }, storedMatchesAccepted: after.lp - before.lp === accepted, eventsPerSec: +(accepted / res.durationS).toFixed(0) };
}
async function getlocScenario(C, durMs) {
  const o = creds.perfOwner; const to = new Date(); const from = new Date(to.getTime() - 24 * 3600e3);
  return closedLoop(`GET locations 24h pageSize=100 C=${C}`, C, durMs, () => async () => {
    const page = 1 + Math.floor(Math.random() * 2900);
    const r = await fetch(`${BASE}/api/v1/devices/${o.deviceId}/locations?from=${from.toISOString()}&to=${to.toISOString()}&page=${page}&pageSize=100`, { headers: hdr(o.token) });
    await r.arrayBuffer();
    return r.status;
  });
}
async function wsScenario(CONN, PUSHES) {
  const u = creds.users[0]; const lat = []; let opened = 0; let closedEarly = 0; const sockets = [];
  const t0 = performance.now();
  await Promise.all(Array.from({ length: CONN }, () => new Promise((resolve) => {
    const ws = new WebSocket(`${WSBASE}/ws?token=${u.token}`);
    sockets.push(ws);
    ws.on('open', () => { opened += 1; resolve(); });
    ws.on('error', () => { closedEarly += 1; resolve(); });
    ws.on('close', () => { closedEarly += 1; });
    ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.type === 'location_update') lat.push(Date.now() - Date.parse(m.sentAt)); });
  })));
  const connectMs = +(performance.now() - t0).toFixed(0);
  const t1 = performance.now();
  for (let k = 0; k < PUSHES; k++) { const r = await relay(u, [envelope(u.deviceId, 'location_update', loc())]); if (r.status !== 202) console.error('relay', r.status); }
  const deadline = performance.now() + 15000;
  while (lat.length < CONN * PUSHES && performance.now() < deadline) await sleep(50);
  const totalMs = +(performance.now() - t1).toFixed(0);
  sockets.forEach((s) => s.close());
  await sleep(500);
  return { name: `WS ${CONN} conn × ${PUSHES} pushes`, opened, connectMs, expected: CONN * PUSHES, delivered: lat.length, deliveryRate: +((lat.length / (CONN * PUSHES)) * 100).toFixed(2) + '%', totalMs, p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), closedEarly };
}
async function settingsScenario(C, durMs) {
  const beforeIds = new Set((await pg.query(`select id from device_commands where device_id like 'load_helmet_%'`)).rows.map((r) => r.id));
  const res = await closedLoop(`PUT settings + relay-ack(delivered,executed) C=${C}`, C, durMs, (i) => {
    const u = creds.users[i % creds.users.length];
    return async () => {
      const r = await fetch(`${BASE}/api/v1/devices/${u.deviceId}/settings`, { method: 'PUT', headers: hdr(u.token), body: JSON.stringify({ settings: { ledBrightness: Math.floor(Math.random() * 100), radioChannel: 3 } }) });
      if (r.status !== 200 && r.status !== 201 && r.status !== 202) { await r.text(); return r.status; }
      const { commandId } = await r.json();
      const a1 = await fetch(`${BASE}/api/v1/devices/${u.deviceId}/commands/${commandId}/relay-ack`, { method: 'POST', headers: hdr(u.token), body: JSON.stringify({ stage: 'delivered' }) });
      await a1.text(); if (a1.status >= 300) return a1.status;
      const a2 = await fetch(`${BASE}/api/v1/devices/${u.deviceId}/commands/${commandId}/relay-ack`, { method: 'POST', headers: hdr(u.token), body: JSON.stringify({ stage: 'executed', result: 'success', executedAt: new Date().toISOString() }) });
      await a2.text(); return a2.status >= 300 ? a2.status : 200;
    };
  });
  const rows = (await pg.query(`select status, count(*)::int n from device_commands where device_id like 'load_helmet_%' group by 1`)).rows;
  const newRows = (await pg.query(`select count(*)::int n from device_commands where device_id like 'load_helmet_%'`)).rows[0].n - beforeIds.size;
  return { ...res, newCommands: newRows, statusDistributionAll: Object.fromEntries(rows.map((r) => [r.status, r.n])) };
}
async function smsScenario(C, durMs) {
  const before = (await pg.query(`select count(*)::int n from sms_codes`)).rows[0].n;
  const res = await closedLoop(`POST /auth/sms-code (unique phones) C=${C}`, C, durMs, () => async () => {
    const phone = `198${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    const r = await fetch(`${BASE}/api/v1/auth/sms-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, purpose: 'register' }) });
    await r.text(); return r.status;
  });
  const after = (await pg.query(`select count(*)::int n from sms_codes`)).rows[0].n;
  return { ...res, smsCodesRowsDelta: after - before };
}
async function sosInject(u, label) {
  const ws = new WebSocket(`${WSBASE}/ws?token=${u.token}`);
  const events = [];
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.type === 'sos_update') events.push({ at: Date.now(), status: m.data.status, deadline: m.data.deadline, sosId: m.data.sosId }); });
  const env = envelope(u.deviceId, 'possible_fall', { confidence: 0.93, algorithmVersion: 'load-v1' });
  const pendingBefore = (await pg.query(`select count(*)::int n from sos_cases where status='pending'`)).rows[0].n;
  const t0 = Date.now();
  const r = await relay(u, [env]);
  const httpMs = Date.now() - t0; const body = await r.json().catch(() => ({}));
  let dbMs = null;
  while (Date.now() - t0 < 10000) { const q = await pg.query(`select created_at from sos_cases where trigger_event_id=$1`, [env.eventId]); if (q.rowCount) { dbMs = Date.now() - t0; break; } await sleep(10); }
  while (!events.some((e) => e.status === 'pending') && Date.now() - t0 < 10000) await sleep(10);
  const pend = events.find((e) => e.status === 'pending');
  while (!events.some((e) => e.status === 'notified') && Date.now() - t0 < 30000) await sleep(20);
  const notif = events.find((e) => e.status === 'notified');
  ws.close();
  const notifRow = pend ? (await pg.query(`select status, deadline, (select count(*)::int from sos_notifications n where n.sos_id=s.id) notifications from sos_cases s where id=$1`, [pend.sosId])).rows[0] : null;
  return { label, httpStatus: r.status, relayCounts: body, httpMs, sosCaseVisibleInDbMs: dbMs, wsPendingMs: pend ? pend.at - t0 : null, deadlineMinusSubmitMs: pend ? Date.parse(pend.deadline) - t0 : null, notifiedLagAfterDeadlineMs: notif ? notif.at - Date.parse(notif.deadline) : null, pendingCasesBefore: pendingBefore, finalRow: notifRow };
}
async function mixedScenario(durMs) {
  const sampler = startSampler(5000);
  // 20 条 WS 连接常驻（用户 1..20）
  const wsList = creds.users.slice(1, 21).map((u) => new WebSocket(`${WSBASE}/ws?token=${u.token}`));
  let wsMsgs = 0; wsList.forEach((w) => w.on('message', () => { wsMsgs += 1; })); wsList.forEach((w) => w.on('error', () => {}));
  const sosUser = creds.users[creds.users.length - 1];
  const sosResults = [];
  const sosTask = (async () => { await sleep(10000); sosResults.push(await sosInject(sosUser, 'SOS #1 @10s under mixed load')); await sleep(5000); sosResults.push(await sosInject(sosUser, 'SOS #2 @~40s under mixed load')); })();
  const parts = await Promise.all([
    relayScenario(10, 20, durMs), getlocScenario(10, durMs), settingsScenario(5, durMs), smsScenario(5, durMs), sosTask,
  ]);
  wsList.forEach((w) => w.close());
  sampler.stop();
  const total = parts.slice(0, 4).reduce((a, p) => a + p.requests, 0);
  const non2xx = parts.slice(0, 4).reduce((a, p) => a + Object.entries(p.statuses).filter(([k]) => !(k >= 200 && k < 300)).reduce((x, [, v]) => x + v, 0), 0);
  return { name: `mixed ${durMs / 1000}s (relay10×20 + getloc10 + settings5 + sms5 + 20 WS idle + SOS 注入)`, totalRequests: total, non2xx, wsMessagesOn20Idle: wsMsgs, parts: parts.slice(0, 4), sos: sosResults, samples: sampler.samples };
}
async function recoveryScenario(durMs) {
  const out = []; const t0 = Date.now();
  while (Date.now() - t0 <= durMs) { const s = await procSample(); s.fds = Number(execSync(`lsof -p ${PID} 2>/dev/null | wc -l`).toString().trim()); out.push(s); await sleep(10000); }
  return { name: `post-load recovery ${durMs / 1000}s`, samples: out };
}

let result;
const sampler = startSampler(5000);
const baseline = await procSample();
switch (scenario) {
  case 'relay': result = await relayScenario(Number(opts.C ?? 20), Number(opts.BATCH ?? 50), Number(opts.DUR ?? 30000)); break;
  case 'getloc': result = await getlocScenario(Number(opts.C ?? 50), Number(opts.DUR ?? 30000)); break;
  case 'ws': result = await wsScenario(Number(opts.CONN ?? 200), Number(opts.PUSHES ?? 50)); break;
  case 'settings': result = await settingsScenario(Number(opts.C ?? 50), Number(opts.DUR ?? 30000)); break;
  case 'sms': result = await smsScenario(Number(opts.C ?? 20), Number(opts.DUR ?? 30000)); break;
  case 'sos': result = await sosInject(creds.users[creds.users.length - 2], opts.LABEL ?? 'SOS idle baseline'); break;
  case 'mixed': sampler.stop(); result = await mixedScenario(Number(opts.DUR ?? 60000)); break;
  case 'recovery': sampler.stop(); result = await recoveryScenario(Number(opts.DUR ?? 60000)); break;
  default: throw new Error('unknown scenario');
}
sampler.stop();
const after = await procSample();
const line = JSON.stringify({ scenario, at: new Date().toISOString(), baseline, result, after, samples: sampler.samples });
console.log(line);
appendFileSync(`${EV}/30-load-results.jsonl`, line + '\n');
await pg.end();
