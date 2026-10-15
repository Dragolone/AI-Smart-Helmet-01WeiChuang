// backup-upload 的命令行契约：deploy/backup.sh 的 cron 只看退出码（0 成功 / 2 参数或输入不合法 / 3 未配置 COS / 1 上传或清理失败）。
// 用子进程真跑脚本（tsx），但只走「上传之前就失败」的路：COS 环境变量全部清空或填假值、stdin 不是 pg_dump，绝不发网络请求。
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SCRIPT = join(__dirname, 'backup-upload.ts');
const TSX = require.resolve('tsx/cli');

/** 只透传跑 node 需要的变量，其余（尤其真实 COS 密钥）一律不带进子进程 */
const baseEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_OPTIONS: '',
});

const run = (args: string[], env: NodeJS.ProcessEnv, stdin = '') =>
  spawnSync(process.execPath, [TSX, SCRIPT, ...args], {
    env,
    input: stdin,
    encoding: 'utf-8',
    timeout: 60_000,
  });

const FAKE_COS = {
  TENCENT_COS_SECRET_ID: 'AKID_FAKE_FOR_TEST',
  TENCENT_COS_SECRET_KEY: 'KEY_FAKE_FOR_TEST',
  TENCENT_COS_BUCKET: 'media-fake-1250000000',
  TENCENT_COS_REGION: 'ap-guangzhou',
};

describe('backup-upload 命令行退出码', () => {
  jest.setTimeout(120_000);

  it('参数不合法：退出码 2，stderr 说明原因', () => {
    const r = run(['--key', 'media/x.dump'], baseEnv());
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('✕ --key 必须形如 backups/');
  });

  it('没配 COS：退出码 3（不读 stdin、不建客户端）', () => {
    const r = run(['--key', 'backups/x.dump'], baseEnv());
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('未配置 TENCENT_COS_SECRET_ID');
  });

  it('stdin 不是 pg_dump 产物（pg_dump 失败了）：退出码 1；没单独配备份桶时先打 ⚠️ 提示', () => {
    const r = run(
      ['--key', 'backups/x.dump'],
      { ...baseEnv(), ...FAKE_COS },
      'pg_dump: error: connection to server failed\n',
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('⚠️ 未设置 TENCENT_COS_BACKUP_BUCKET');
    expect(r.stderr).toContain('✕ 备份失败：stdin 不是 pg_dump 自定义格式');
    expect(r.stdout).not.toContain('✓');
  });

  it('配了单独的备份桶：不打 ⚠️；空输入同样退出码 1', () => {
    const r = run(['--key', 'backups/x.dump'], {
      ...baseEnv(),
      ...FAKE_COS,
      TENCENT_COS_BACKUP_BUCKET: 'backup-fake-1250000000',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain('⚠️');
    expect(r.stderr).toContain('（0 字节');
  });
});
