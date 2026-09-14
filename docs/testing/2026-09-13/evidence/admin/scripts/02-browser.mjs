// Admin 浏览器验收（Playwright + 本机 Chrome）。截图/Console/失败请求落 evidence；不改业务代码。
import { chromium } from 'playwright';
import fs from 'node:fs';
const EV = '/Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang/docs/testing/2026-09-13/evidence/admin';
const BASE = 'http://127.0.0.1:5173';
const env = Object.fromEntries(fs.readFileSync(`${EV}/.admin.env`, 'utf8').trim().split('\n').map(l => l.split('=')));
const results = []; const consoleMsgs = []; const failedReqs = [];
const rec = (id, name, status, detail) => { results.push({ id, name, status, detail }); console.log(`[${status}] ${id} ${name}${detail ? ' :: ' + detail : ''}`); };

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('console', m => { if (['error', 'warning'].includes(m.type())) consoleMsgs.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
page.on('requestfailed', r => failedReqs.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText}`));
page.on('response', r => { if (r.status() >= 400 && r.url().includes('/api/')) failedReqs.push(`HTTP ${r.status()} ${r.url()}`); });
const shot = n => page.screenshot({ path: `${EV}/screenshots/${n}.png`, fullPage: true });

// A1 未登录深链 → 应回登录页
await page.goto(`${BASE}/devices/audit_ui_4`, { waitUntil: 'networkidle' });
rec('A1', '未登录直接打开设备详情深链', /登录|login/i.test(await page.content()) ? 'PASS' : 'FAIL', 'url=' + page.url());
await shot('A1-unauth-deeplink');

// A2 错密码提示
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.fill('input[id*="username"], input[placeholder*="用户名"], form input:not([type="password"])', env.ADMIN_USER);
await page.fill('input[type="password"]', 'definitely_wrong_pw');
await page.click('button[type="submit"], button:has-text("登录")');
await page.waitForTimeout(1200);
const wrongPwText = await page.textContent('body');
rec('A2', '错误密码提示', /用户名或密码|401|失败|错误/.test(wrongPwText) ? 'PASS' : 'FAIL', (wrongPwText.match(/.{0,40}(密码|失败|错误).{0,30}/) || [''])[0].replace(/\s+/g, ' ').slice(0, 90));
await shot('A2-wrong-password');

// A3 后端不可达时的提示（用 route 拦截模拟网络错误）
await ctx.route('**/api/v1/admin/auth/login', r => r.abort('connectionrefused'));
await page.fill('input[type="password"]', 'whatever');
await page.click('button[type="submit"], button:has-text("登录")');
await page.waitForTimeout(1000);
const offlineText = await page.textContent('body');
rec('A3', '后端不可达提示是否与密码错误区分', /网络|无法连接|连接失败|Failed to fetch|请求失败/.test(offlineText) ? 'PASS' : 'FAIL', (offlineText.match(/.{0,40}(网络|失败|错误).{0,30}/) || [''])[0].replace(/\s+/g, ' ').slice(0, 90));
await shot('A3-backend-unreachable');
await ctx.unroute('**/api/v1/admin/auth/login');

// A4 正确登录
await page.reload({ waitUntil: 'networkidle' });
await page.fill('input[id*="username"], input[placeholder*="用户名"], form input:not([type="password"])', env.ADMIN_USER);
await page.fill('input[type="password"]', env.ADMIN_PASS);
await page.click('button[type="submit"], button:has-text("登录")');
await page.waitForTimeout(2000);
rec('A4', '正确凭证登录', !/请输入用户名|登录$/.test(await page.title()) && !page.url().endsWith('/login') ? 'PASS' : 'FAIL', 'url=' + page.url());
await shot('A4-overview');

// B1..B5 遍历各页
const pages = [['B1', '概览', '/'], ['B2', '用户', '/users'], ['B3', '设备', '/devices'], ['B4', '事故', '/accidents'], ['B5', '事件', '/events']];
for (const [id, name, path] of pages) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const body = await page.textContent('body');
  const hasError = /Something went wrong|Error|错误/.test(body) && !/错误码/.test(body);
  const rows = await page.locator('.ant-table-row').count().catch(() => 0);
  rec(id, `${name}页渲染`, body.length > 200 && !hasError ? 'PASS' : 'FAIL', `rows=${rows} len=${body.length}`);
  await shot(`${id}-${name}`);
}

// C1 XSS：注入的昵称不得执行
await page.goto(BASE + '/users', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const xssFired = await page.evaluate(() => !!(window.__XSS__ || window.__XSS2__));
const usersBody = await page.textContent('body');
rec('C1', '昵称含 <img onerror> 不执行、原样转义显示', !xssFired && usersBody.includes('<img src=x onerror=alert(1)>') ? 'PASS' : (xssFired ? 'FAIL' : 'PARTIAL'), `xssFired=${xssFired}`);
await shot('C1-xss-users');

// C2 emoji/换行/超长昵称显示
rec('C2', 'emoji/换行/超长昵称显示不破版', /🚴/.test(usersBody) && /超长昵称超长昵称/.test(usersBody) ? 'PASS' : 'FAIL', '');

// D1 搜索 + 清空 + 分页重置
const searchBox = page.locator('input[placeholder*="搜索"], .ant-input-search input, input[type="search"]').first();
if (await searchBox.count()) {
  await searchBox.fill('🚴'); await page.keyboard.press('Enter'); await page.waitForTimeout(900);
  const filtered = await page.locator('.ant-table-row').count();
  await searchBox.fill(''); await page.keyboard.press('Enter'); await page.waitForTimeout(900);
  const all = await page.locator('.ant-table-row').count();
  rec('D1', '用户搜索命中与清空恢复', filtered >= 1 && all >= filtered ? 'PASS' : 'FAIL', `filtered=${filtered} all=${all}`);
  await searchBox.fill('%'); await page.keyboard.press('Enter'); await page.waitForTimeout(900);
  const pct = await page.locator('.ant-table-row').count();
  rec('D2', '搜索 % 是否被当成 LIKE 通配符（应只命中含 % 的行）', pct >= all && all > 0 ? 'FAIL' : 'PASS', `rows(%)=${pct} rows(all)=${all}`);
  await searchBox.fill(''); await page.keyboard.press('Enter'); await page.waitForTimeout(600);
} else rec('D1', '用户搜索框', 'NOT_RUN', '未找到搜索框');

// E1 接口 500 是否被渲染成空列表
await ctx.route('**/api/v1/admin/users**', r => r.fulfill({ status: 500, contentType: 'application/json', body: '{"code":"INTERNAL_ERROR","message":"boom","requestId":"req_x"}' }));
await page.goto(BASE + '/users', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const errBody = await page.textContent('body');
const showsError = /加载失败|错误|失败|重试|Error/.test(errBody);
const showsEmpty = /暂无数据|No data|空/.test(errBody);
rec('E1', '用户接口 500 时页面显示错误而非"暂无数据"', showsError && !showsEmpty ? 'PASS' : 'FAIL', `showsError=${showsError} showsEmpty=${showsEmpty}`);
await shot('E1-api-500');
await ctx.unroute('**/api/v1/admin/users**');

// E2 概览接口 500
await ctx.route('**/api/v1/admin/stats/overview**', r => r.fulfill({ status: 500, contentType: 'application/json', body: '{"code":"INTERNAL_ERROR","message":"boom","requestId":"req_y"}' }));
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const ovBody = await page.textContent('body');
const zeros = (ovBody.match(/\b0\b/g) || []).length;
rec('E2', '概览接口 500 时不把故障显示成 0', /加载失败|错误|失败|重试|Error/.test(ovBody) ? 'PASS' : 'FAIL', `zeroCount=${zeros}`);
await shot('E2-overview-500');
await ctx.unroute('**/api/v1/admin/stats/overview**');

// F1 token 过期：注入 1 秒前过期的 token
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
const storageKeys = await page.evaluate(() => Object.keys(localStorage));
await page.evaluate(k => { for (const key of k) if (/token/i.test(key)) localStorage.setItem(key, 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ4IiwidHlwIjoiYWRtaW4iLCJleHAiOjF9.aaa'); }, storageKeys);
await page.goto(BASE + '/users', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
rec('F1', '过期/无效 token → 回登录页', /登录/.test(await page.textContent('body')) ? 'PASS' : 'FAIL', 'url=' + page.url() + ' keys=' + storageKeys.join(','));
await shot('F1-expired-token');

fs.writeFileSync(`${EV}/browser-results.json`, JSON.stringify({ results, consoleMsgs: [...new Set(consoleMsgs)], failedReqs: [...new Set(failedReqs)] }, null, 2));
console.log('\n--- console errors/warnings (deduped):'); console.log([...new Set(consoleMsgs)].slice(0, 15).join('\n') || '(none)');
console.log('--- failed/4xx-5xx requests:'); console.log([...new Set(failedReqs)].slice(0, 15).join('\n') || '(none)');
await browser.close();
