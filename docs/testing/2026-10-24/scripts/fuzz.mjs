// 对本地后端所有路由打一轮畸形请求，只找 5xx / 非 JSON 错误 / 无 code 的错误体；不碰会破坏测试状态的删除类接口
import fs from 'node:fs';
const SP = '/private/tmp/claude-501/-Users-dravenzhong-Desktop-AI-Smart-Helmet-01WeiChuang/2463c696-f597-444c-b2db-9ef46bbf956d/scratchpad';
const BASE = 'http://localhost:3000';
const routes = fs.readFileSync(`${SP}/routes.txt`, 'utf8').trim().split('\n').map((l) => { const [p, m] = l.split(', '); return { path: p, method: m }; });
const skip = [/^\/api\/v1\/users\/me$/, /binding$/, /emergency-contacts\/:/, /change-password/, /change-phone/, /reset-password/, /internal\/emqx/];
async function login(path, body) { const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return (await r.json()).accessToken; }
const user = await login('/api/v1/auth/login', { phone: '13800009001', password: process.env.TEST_PASSWORD ?? '' });
const admin = await login('/api/v1/admin/auth/login', { username: 'fradmin', password: process.env.ADMIN_PW });
const ids = { deviceId: 'helmet_fr_001', eventId: '8f3d11e4-5538-4509-b82c-a73c54be040c', sosId: 'cmvl5pedo0006o0y0hjilq9ar', accidentId: 'cmvl5pedo0006o0y0hjilq9ar', commandId: 'cmvl496wn00d4rny0iri9b6ot', contactId: 'x', channelId: 'x', mediaId: 'x', id: 'x', userId: 'x' };
const weirdParams = ['', ' ', '%00', '..%2F..', "' OR 1=1 --", '<script>', '😀'.repeat(50), 'a'.repeat(3000), '-1', '1e309', 'null', 'undefined', '__proto__'];
const bodies = ['', '{', '[]', 'null', '"str"', '{"__proto__":{"a":1}}', JSON.stringify({ a: 'x'.repeat(200000) }), JSON.stringify({ phone: 123, password: null, settings: 'no', stage: 42, page: -1, pageSize: 1e9, name: '😀'.repeat(300), code: {}, deviceId: [], bindCode: { $gt: '' } }), JSON.stringify({ settings: { volume: '80', light: 9, bogus: true }, stage: 'executed', result: 'maybe', executedAt: 'yesterday', items: new Array(101).fill({}), events: [{}] })];
const queries = ['?page=0&pageSize=0', '?page=-1&pageSize=999999', '?page=abc&pageSize=xyz', '?from=foo&to=bar', '?from=2026-01-01T00:00:00Z&to=2025-01-01T00:00:00Z', '?type=nope,also', '?hours=99999', '?online=maybe', '?keyword=' + encodeURIComponent("' OR 1=1 --"), '?invalid=1&status=weird&deviceId=' + 'x'.repeat(500)];
const findings = [];
let n = 0;
for (const { path, method } of routes) {
  if (skip.some((re) => re.test(path))) continue;
  const token = path.includes('/admin') ? admin : user;
  const variants = [];
  const fill = (v) => path.replace(/:([a-zA-Z]+)/g, (_, k) => encodeURIComponent(v === undefined ? (ids[k] ?? 'x') : v));
  variants.push({ url: fill(), body: undefined });
  for (const w of weirdParams) if (path.includes(':')) variants.push({ url: fill(w), body: undefined });
  for (const q of queries) if (method === 'GET') variants.push({ url: fill() + q, body: undefined });
  if (method !== 'GET') for (const b of bodies) variants.push({ url: fill(), body: b });
  for (const v of variants) {
    n++;
    const headers = { authorization: `Bearer ${token}` };
    if (v.body !== undefined) headers['content-type'] = 'application/json';
    let r, text;
    try { r = await fetch(`${BASE}${v.url}`, { method, headers, body: v.body }); text = await r.text(); } catch (e) { findings.push({ path, method, url: v.url, body: (v.body ?? '').slice(0, 60), status: 'EXC', detail: e.message }); continue; }
    let json; try { json = text ? JSON.parse(text) : null; } catch { json = undefined; }
    const bad = r.status >= 500 || (r.status >= 400 && (json === undefined || (json && typeof json === 'object' && !json.code && r.status !== 404)));
    if (bad) findings.push({ path, method, url: v.url.slice(0, 120), body: (v.body ?? '').slice(0, 60), status: r.status, detail: text.slice(0, 160) });
  }
}
console.log(`requests: ${n}, findings: ${findings.length}`);
for (const f of findings) console.log(JSON.stringify(f));
fs.writeFileSync(`${SP}/logs/fuzz-findings.json`, JSON.stringify(findings, null, 2));
