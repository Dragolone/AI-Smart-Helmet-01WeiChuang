// SOS 真实进程重启复验（决策 #8：持久化 deadline + 周期扫描；重启接管）。
// 场景 A：app-relay 建单 → deadline 前 SIGKILL → 过 deadline 后重启 → 扫描接管 notified，[MOCK SMS]/[MOCK PUSH] 各恰一次。
// 场景 B：库态「sos notified 但通知行 pending/attempts=0」（= 事务已提交、投递前崩溃）→ 启进程 → 续投恰一次。
// 场景 C：库态「通知行 failed/attempts=1」→ 启进程 → 重试到 sent；再观察 3 轮扫描不重复。
// 只用 psql + fetch；所有数据合成、结束清理；退出码 0 = 全部断言通过。
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';

const { REPO, EV, DATABASE_URL, API, PORT } = process.env;
const BACKEND = `${REPO}/backend`;
const results = { startedAt: new Date().toISOString(), env: { PORT, SOS_SCAN_INTERVAL_MS: process.env.SOS_SCAN_INTERVAL_MS, SOS_COUNTDOWN_SECONDS: process.env.SOS_COUNTDOWN_SECONDS }, scenarios: {}, failures: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const psql = (sql) => execFileSync('psql', [DATABASE_URL, '-At', '-F', '|', '-c', sql], { encoding: 'utf-8' }).trim();
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`);
  if (!ok) results.failures.push({ name, detail });
  return ok;
};
const mask = (p) => `${p.slice(0, 3)}****${p.slice(-4)}`;

let child = null;
let currentLog = null;
function startBackend(tag) {
  currentLog = `${EV}/rp-backend-${tag}.log`;
  const out = fs.openSync(currentLog, 'w');
  child = spawn('node', ['dist/main'], { cwd: BACKEND, env: process.env, stdio: ['ignore', out, out] });
  console.log(`[backend ${tag}] pid=${child.pid} log=${currentLog}`);
  return child;
}
async function waitHealthy(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${API}/health`);
      if (r.ok) return Date.now() - t0;
    } catch {}
    await sleep(250);
  }
  throw new Error('backend 未在超时内就绪');
}
function killHard() {
  if (!child) return;
  const pid = child.pid;
  child.kill('SIGKILL');
  console.log(`[backend] SIGKILL pid=${pid} at ${new Date().toISOString()}`);
  child = null;
}
const logText = (tag) => fs.readFileSync(`${EV}/rp-backend-${tag}.log`, 'utf-8').split('\n').filter((l) => !l.includes('ECONNREFUSED'));
const countSosSms = (tag) => logText(tag).filter((l) => l.includes('[MOCK SMS]') && l.includes('[sos_alert]')).length;
const countSosPush = (tag) => logText(tag).filter((l) => l.includes('[MOCK PUSH]') && l.includes('SOS 已通知紧急联系人')).length;
const countStartPush = (tag) => logText(tag).filter((l) => l.includes('[MOCK PUSH]') && l.includes('SOS 倒计时已开始')).length;
const takeoverLine = (tag) => logText(tag).find((l) => l.includes('启动接管')) ?? null;

async function api(method, path, body, token) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json ?? text };
}

const run = Date.now();
const phone = `19${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
const contactPhone = `19${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
const deviceA = `audit_rp_a_${run}`;
const deviceB = `audit_rp_b_${run}`;
const deviceC = `audit_rp_c_${run}`;
let userId = null;
const created = { sosIds: [], notifIds: [] };

async function registerAndSetup() {
  const sms = await api('POST', '/auth/sms-code', { phone, purpose: 'register' });
  if (sms.status !== 204) throw new Error(`sms-code ${sms.status} ${JSON.stringify(sms.body)}`);
  await sleep(300);
  const line = logText('1').reverse().find((l) => l.includes('[MOCK SMS]') && l.includes(mask(phone)) && l.includes('verify_code'));
  const code = /您的验证码为(\d{6})/.exec(line ?? '')?.[1];
  if (!code) throw new Error('未从 Mock SMS 日志取到验证码');
  const reg = await api('POST', '/auth/register', { phone, password: 'audit_rp_pw_1', code });
  if (reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.body)}`);
  userId = reg.body.user.id;
  const token = reg.body.accessToken;
  const hash = createHash('sha256').update('audit_rp').digest('hex');
  for (const d of [deviceA, deviceB, deviceC]) {
    psql(`insert into devices(device_id, device_secret_hash, bind_code) values ('${d}','${hash}','bc_${d}')`);
    const b = await api('POST', '/devices/bind', { deviceId: d, bindCode: `bc_${d}` }, token);
    if (b.status !== 200) throw new Error(`bind ${d} ${b.status} ${JSON.stringify(b.body)}`);
  }
  const c = await api('POST', '/users/me/emergency-contacts', { name: '家人', phone: contactPhone }, token);
  if (c.status !== 201) throw new Error(`contact ${c.status}`);
  return token;
}

const sosRow = (where) => {
  const r = psql(`select id,status,to_char(deadline at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),coalesce(to_char(finalized_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),''),to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),coalesce(location_source,'') from sos_cases where ${where}`);
  if (!r) return null;
  const [id, status, deadline, finalizedAt, createdAt, locationSource] = r.split('|');
  return { id, status, deadline, finalizedAt: finalizedAt || null, createdAt, locationSource };
};
const notifRows = (sosId) => psql(`select channel,status,attempts,coalesce(last_error,'') from sos_notifications where sos_id='${sosId}' order by created_at`).split('\n').filter(Boolean).map((l) => { const [channel, status, attempts, lastError] = l.split('|'); return { channel, status, attempts: Number(attempts), lastError }; });

async function scenarioA(token) {
  const S = (results.scenarios.A = { title: 'app-relay 建单 → deadline 前 SIGKILL → 过 deadline 重启 → 扫描接管' });
  const eventId = randomUUID();
  const envelope = { schemaVersion: 1, eventId, deviceId: deviceA, eventType: 'possible_fall', timestamp: new Date().toISOString(), firmwareVersion: '0.1.0-audit', payload: { confidence: 0.92, algorithmVersion: 'audit-v1', location: { latitude: 30.51, longitude: 114.31, coordinateSystem: 'gcj02', accuracy: 6 } } };
  const t0 = Date.now();
  const r = await api('POST', '/ingest/app-relay', { deviceId: deviceA, envelopes: [envelope] }, token);
  check('A1 app-relay 202 accepted=1', r.status === 202 && r.body.accepted === 1, r.body);
  const c = sosRow(`trigger_event_id='${eventId}'`);
  created.sosIds.push(c?.id);
  check('A2 sos_cases pending，deadline≈接收时间+20s', c && c.status === 'pending' && Math.abs(new Date(c.deadline).getTime() - t0 - 20000) < 1500, c);
  check('A3 位置快照 source=event', c?.locationSource === 'event');
  S.sosId = c?.id; S.deadline = c?.deadline;
  await sleep(5000);
  killHard();
  S.killedAt = new Date().toISOString();
  const afterKill = sosRow(`id='${c.id}'`);
  check('A4 SIGKILL 后单仍 pending（未被内存 timer 提前处理）', afterKill.status === 'pending', afterKill);
  check('A5 进程 1 未发任何 sos_alert/终态 Push（倒计时 Push 恰 1 次）', countSosSms('1') === 0 && countSosPush('1') === 0 && countStartPush('1') === 1, { sms: countSosSms('1'), push: countSosPush('1'), start: countStartPush('1') });
  const waitMs = new Date(c.deadline).getTime() + 3000 - Date.now();
  console.log(`[A] 进程已死，等待越过 deadline（${Math.round(waitMs / 1000)}s）…`);
  await sleep(Math.max(0, waitMs));
  const stillPending = sosRow(`id='${c.id}'`);
  check('A6 越过 deadline 且无进程：单仍 pending（没有后端就没有终态化，等待接管）', stillPending.status === 'pending', stillPending);
  startBackend('2');
  const readyMs = await waitHealthy();
  S.restartReadyMs = readyMs;
  let final = null;
  const t1 = Date.now();
  while (Date.now() - t1 < 15000) {
    final = sosRow(`id='${c.id}'`);
    if (final.status !== 'pending') break;
    await sleep(250);
  }
  S.takeoverMs = Date.now() - t1;
  S.final = final;
  check('A7 重启后扫描接管：pending → notified', final.status === 'notified', final);
  check('A8 finalizedAt ≥ deadline（到期后处理，不提前）', final.finalizedAt && new Date(final.finalizedAt) >= new Date(c.deadline), { finalizedAt: final.finalizedAt, deadline: c.deadline });
  await sleep(3500); // 再跑 ≥3 轮扫描，确认不重复投递
  const rows = notifRows(c.id);
  S.notifications = rows;
  check('A9 通知行：sms sent×1 + push sent×1，attempts 均 1', rows.length === 2 && rows.every((x) => x.status === 'sent' && x.attempts === 1) && rows.map((x) => x.channel).sort().join() === 'push,sms', rows);
  S.log2 = { takeover: takeoverLine('2'), sms: countSosSms('2'), push: countSosPush('2') };
  check('A10 进程 2 日志：启动接管 1 个 + [MOCK SMS] sos_alert 恰 1 + [MOCK PUSH] 终态恰 1', S.log2.takeover?.includes('1 个') && S.log2.sms === 1 && S.log2.push === 1, S.log2);
  const active = await api('GET', `/devices/${deviceA}/sos/active`, undefined, token);
  check('A11 REST active 为 null', active.status === 200 && active.body.sos === null, active.body);
  const detail = await api('GET', `/accidents/${c.id}`, undefined, token);
  check('A12 事故详情 notified + 通知记录脱敏', detail.status === 200 && detail.body.status === 'notified' && !JSON.stringify(detail.body).includes(contactPhone), { status: detail.body.status });
}

async function scenarioB() {
  const S = (results.scenarios.B = { title: '库态 notified + 通知行 pending/attempts=0（事务提交后、投递前崩溃）→ 启进程续投恰一次' });
  killHard();
  await sleep(500);
  const sosId = `audit_rp_sos_${randomBytes(6).toString('hex')}`;
  const n1 = `audit_rp_n_${randomBytes(6).toString('hex')}`;
  const n2 = `audit_rp_n_${randomBytes(6).toString('hex')}`;
  const ev = randomUUID();
  created.sosIds.push(sosId);
  psql(`insert into sos_cases(id,device_id,user_id,trigger_event_id,trigger_type,status,deadline,finalized_at,created_at,updated_at) values ('${sosId}','${deviceB}','${userId}','${ev}','possible_fall','notified',now()-interval '30 seconds',now()-interval '10 seconds',now()-interval '50 seconds',now())`);
  psql(`insert into sos_notifications(id,sos_id,channel,target,contact_name,status,attempts,created_at) values ('${n1}','${sosId}','sms','${contactPhone}','家人','pending',0,now()-interval '10 seconds'),('${n2}','${sosId}','push','user:${userId}',null,'pending',0,now()-interval '10 seconds')`);
  const before = notifRows(sosId);
  check('B1 预置库态：2 行 pending/attempts=0', before.length === 2 && before.every((x) => x.status === 'pending' && x.attempts === 0), before);
  startBackend('3');
  await waitHealthy();
  let rows = before;
  const t1 = Date.now();
  while (Date.now() - t1 < 10000) {
    rows = notifRows(sosId);
    if (rows.every((x) => x.status === 'sent')) break;
    await sleep(250);
  }
  S.resumeMs = Date.now() - t1;
  await sleep(3500);
  rows = notifRows(sosId);
  S.notifications = rows;
  check('B2 启进程后扫描续投：两行 sent/attempts=1（无 finalize 也能投）', rows.every((x) => x.status === 'sent' && x.attempts === 1), rows);
  S.log3 = { takeover: takeoverLine('3'), sms: countSosSms('3'), push: countSosPush('3') };
  check('B3 进程 3 日志：sos_alert 恰 1 + 终态 Push 恰 1；无 pending 单故无「启动接管」', S.log3.sms === 1 && S.log3.push === 1 && S.log3.takeover === null, S.log3);
}

async function scenarioC() {
  const S = (results.scenarios.C = { title: '库态 notified + sms 行 failed/attempts=1 → 启进程重试到 sent（最多 3 次）' });
  killHard();
  await sleep(500);
  const sosId = `audit_rp_sos_${randomBytes(6).toString('hex')}`;
  const n1 = `audit_rp_n_${randomBytes(6).toString('hex')}`;
  const n2 = `audit_rp_n_${randomBytes(6).toString('hex')}`;
  created.sosIds.push(sosId);
  psql(`insert into sos_cases(id,device_id,user_id,trigger_event_id,trigger_type,status,deadline,finalized_at,created_at,updated_at) values ('${sosId}','${deviceC}','${userId}','${randomUUID()}','manual_sos','notified',now()-interval '30 seconds',now()-interval '10 seconds',now()-interval '50 seconds',now())`);
  psql(`insert into sos_notifications(id,sos_id,channel,target,contact_name,status,attempts,last_error,created_at) values ('${n1}','${sosId}','sms','${contactPhone}','家人','failed',1,'audit: 上一进程投递失败',now()-interval '10 seconds'),('${n2}','${sosId}','push','user:${userId}',null,'sent',1,null,now()-interval '10 seconds')`);
  startBackend('4');
  await waitHealthy();
  let rows;
  const t1 = Date.now();
  while (Date.now() - t1 < 10000) {
    rows = notifRows(sosId);
    if (rows.find((x) => x.channel === 'sms').status === 'sent') break;
    await sleep(250);
  }
  await sleep(3500);
  rows = notifRows(sosId);
  S.notifications = rows;
  const smsRow = rows.find((x) => x.channel === 'sms');
  const pushRow = rows.find((x) => x.channel === 'push');
  check('C1 failed 行被重试 → sent/attempts=2；已 sent 的 push 行不重发（attempts 仍 1）', smsRow.status === 'sent' && smsRow.attempts === 2 && pushRow.status === 'sent' && pushRow.attempts === 1, rows);
  // 观察项（不作断言）：重试成功后 last_error 未清空，事故详情会同时显示 sent + 旧错误文本
  S.observation_lastErrorAfterSent = smsRow.lastError;
  S.log4 = { sms: countSosSms('4'), push: countSosPush('4') };
  check('C2 进程 4 日志：sos_alert 恰 1、终态 Push 0', S.log4.sms === 1 && S.log4.push === 0, S.log4);
}

function cleanup() {
  killHard();
  const ids = created.sosIds.filter(Boolean).map((s) => `'${s}'`).join(',');
  const devs = [deviceA, deviceB, deviceC].map((d) => `'${d}'`).join(',');
  if (ids) psql(`delete from sos_notifications where sos_id in (${ids})`);
  psql(`delete from sos_cases where device_id in (${devs})`);
  psql(`delete from raw_events where device_id in (${devs})`);
  psql(`delete from device_bindings where device_id in (${devs})`);
  psql(`delete from devices where device_id in (${devs})`);
  if (userId) {
    psql(`delete from emergency_contacts where user_id='${userId}'`);
    psql(`delete from refresh_tokens where user_id='${userId}'`);
    psql(`delete from users where id='${userId}'`);
  }
  psql(`delete from sms_codes where phone='${phone}'`);
  console.log('[cleanup] done');
}

(async () => {
  let code = 0;
  try {
    startBackend('1');
    results.bootMs = await waitHealthy();
    const token = await registerAndSetup();
    await scenarioA(token);
    await scenarioB();
    await scenarioC();
  } catch (err) {
    console.error('ERROR', err);
    results.failures.push({ name: 'exception', detail: String(err?.stack ?? err) });
  } finally {
    try { cleanup(); } catch (e) { console.error('cleanup error', e); }
    results.finishedAt = new Date().toISOString();
    results.result = results.failures.length === 0 ? 'PASS' : 'FAIL';
    fs.writeFileSync(`${EV}/real-process-restart.json`, JSON.stringify(results, null, 2));
    console.log(`RESULT ${results.result} (${results.failures.length} failures) → ${EV}/real-process-restart.json`);
    code = results.failures.length === 0 ? 0 : 1;
  }
  process.exit(code);
})();
