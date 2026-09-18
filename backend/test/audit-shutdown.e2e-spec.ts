// 真实进程（node dist/main.js）验证 SIGTERM 排空（审计 DBOPS-07）：
// 收到信号后 /health 立即 503 draining（网关/拨测据此摘流量），排空期内其他请求照常服务，
// 期满后进程自行以 0 退出并释放端口。in-process 的 app.close() 用例（audit-dbops）覆盖不到信号路径，故起真进程。
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';

jest.setTimeout(180_000);

const BACKEND_DIR = join(__dirname, '..');
const DIST_MAIN = join(BACKEND_DIR, 'dist', 'main.js');
const DRAIN_MS = 1500;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });

const health = async (
  base: string,
): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(`${base}/health`, {
    signal: AbortSignal.timeout(2000),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

describe('审计 §11：SIGTERM 排空（真实进程 node dist/main.js）', () => {
  let child: ChildProcess;
  let base: string;
  const output: string[] = [];

  beforeAll(async () => {
    // CI 里 Build 步骤先于 e2e；本地若没构建过就现场构建一次（约 15s）
    if (!existsSync(DIST_MAIN)) {
      execSync('npm run build', { cwd: BACKEND_DIR, stdio: 'inherit' });
    }
    const port = await freePort();
    base = `http://127.0.0.1:${port}/api/v1`;
    child = spawn(process.execPath, [DIST_MAIN], {
      cwd: BACKEND_DIR,
      env: {
        ...process.env,
        PORT: String(port),
        SHUTDOWN_DRAIN_MS: String(DRAIN_MS),
        // 没有 Broker：消费者只会持续重连并记错误，不影响 HTTP 与关闭流程
        MQTT_URL: 'mqtt://127.0.0.1:1',
        RATE_LIMIT_DISABLED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d: Buffer) => output.push(String(d)));
    child.stderr?.on('data', (d: Buffer) => output.push(String(d)));
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (child.exitCode !== null) {
        throw new Error(
          `后端进程提前退出（code=${child.exitCode}）：\n${output.join('')}`,
        );
      }
      const ok = await health(base)
        .then((r) => r.status === 200)
        .catch(() => false);
      if (ok) break;
      if (Date.now() > deadline) {
        throw new Error(`后端 90s 内未就绪：\n${output.slice(-20).join('')}`);
      }
      await sleep(500);
    }
  });

  afterAll(() => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
  });

  it('SIGTERM → /health 立即 503 draining；排空期内业务请求仍被服务；期满以 0 退出并释放端口', async () => {
    expect((await health(base)).status).toBe(200);
    const exited = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) =>
        child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    const t0 = Date.now();
    expect(child.kill('SIGTERM')).toBe(true);
    await sleep(150);

    const draining = await health(base);
    expect(draining.status).toBe(503);
    expect(draining.body).toEqual({
      status: 'draining',
      database: 'connected',
    });

    // 排空期内连接仍被接受并处理：登录接口给出业务上的 401，而不是连接被拒
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13800000000', password: 'wrong_pw_1' }),
      signal: AbortSignal.timeout(2000),
    });
    expect(login.status).toBe(401);

    const result = await Promise.race([
      exited,
      sleep(20_000).then(() => 'timeout' as const),
    ]);
    if (result === 'timeout') {
      throw new Error(
        `进程在排空后 20s 内未退出：\n${output.slice(-20).join('')}`,
      );
    }
    expect(result).toEqual({ code: 0, signal: null });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(DRAIN_MS);
    expect(output.join('')).toContain('503 draining');

    // 端口已释放：再探活只能是连接被拒
    await expect(health(base)).rejects.toThrow();
  });
});
