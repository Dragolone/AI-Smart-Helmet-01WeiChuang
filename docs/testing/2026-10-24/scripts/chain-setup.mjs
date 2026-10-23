// 全链路准备：注册账号 → 绑定 Mock 头盔 → 加紧急联系人 → 开 WS 记录推送
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('/private/tmp/claude-501/-Users-dravenzhong-Desktop-AI-Smart-Helmet-01WeiChuang/2463c696-f597-444c-b2db-9ef46bbf956d/scratchpad/wt/backend/package.json');
const WebSocket = require('ws');
const SP = '/private/tmp/claude-501/-Users-dravenzhong-Desktop-AI-Smart-Helmet-01WeiChuang/2463c696-f597-444c-b2db-9ef46bbf956d/scratchpad';
const API = process.env.API ?? 'http://localhost:3000/api/v1';
const phone = process.env.PHONE ?? '13800009001';
const password = process.env.TEST_PASSWORD ?? '';
const deviceId = process.env.DEVICE_ID ?? 'helmet_fr_001';
const bindCode = process.env.BIND_CODE ?? '32613964';
const log = (...a) => console.log(new Date().toISOString(), ...a);
async function call(method, path, body, token) {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}
let tokens;
const login = await call('POST', '/auth/login', { phone, password });
if (login.status === 200) { tokens = login.json; log('已有账号，直接登录'); }
else {
  const sc = await call('POST', '/auth/sms-code', { phone, purpose: 'register' });
  log('sms-code', sc.status, JSON.stringify(sc.json).slice(0, 120));
  await new Promise(r => setTimeout(r, 500));
  const logText = fs.readFileSync(`${SP}/logs/backend-server.log`, 'utf8');
  const m = [...logText.matchAll(/\[MOCK SMS\][^\n]*验证码为(\d{6})/g)].pop();
  if (!m) throw new Error('日志里没找到验证码');
  const reg = await call('POST', '/auth/register', { phone, code: m[1], password, nickname: '全链路测试' });
  log('register', reg.status, reg.status !== 201 && reg.status !== 200 ? JSON.stringify(reg.json) : 'ok');
  tokens = reg.json;
}
const at = tokens.accessToken;
fs.writeFileSync(`${SP}/chain-tokens.json`, JSON.stringify({ accessToken: at, refreshToken: tokens.refreshToken, userId: tokens.user?.id }, null, 2));
const bind = await call('POST', '/devices/bind', { deviceId, bindCode }, at);
log('bind', bind.status, JSON.stringify(bind.json).slice(0, 200));
const contacts = await call('GET', '/users/me/emergency-contacts', undefined, at);
if (Array.isArray(contacts.json) && contacts.json.length === 0) {
  const c = await call('POST', '/users/me/emergency-contacts', { name: '联系人甲', phone: '13800009002', relation: 'family' }, at);
  log('contact', c.status, JSON.stringify(c.json).slice(0, 160));
} else log('contacts', contacts.status, Array.isArray(contacts.json) ? contacts.json.length : JSON.stringify(contacts.json).slice(0, 120));
const devs = await call('GET', '/devices', undefined, at);
log('devices', devs.status, JSON.stringify(devs.json).slice(0, 300));
// WS 记录
const wsLog = fs.createWriteStream(`${SP}/logs/ws-messages.jsonl`, { flags: 'a' });
const ws = new WebSocket(`${API.replace(/^http/, 'ws').replace(/\/api\/v1$/, '')}/ws?token=${at}`);
ws.on('open', () => log('WS 已连接'));
ws.on('message', (d) => { const s = d.toString(); wsLog.write(JSON.stringify({ t: new Date().toISOString(), msg: JSON.parse(s) }) + '\n'); });
ws.on('close', (c, r) => { log('WS 关闭', c, r.toString()); process.exit(0); });
ws.on('error', (e) => log('WS 错误', e.message));
const stopAfter = Number(process.env.WS_SECONDS ?? 0);
if (stopAfter > 0) setTimeout(() => { ws.close(); }, stopAfter * 1000);
