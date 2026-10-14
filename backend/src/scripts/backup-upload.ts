/**
 * 数据库备份上传（上线前清单 #6 ①）：把 stdin 收到的 pg_dump 产物存进 COS，并按保留期清理旧备份。
 * 由 deploy/backup.sh 经 `docker compose exec -T backend node dist/scripts/backup-upload.js` 调用，
 * COS 凭证直接用容器里已有的 TENCENT_COS_*，宿主机不落任何密钥。
 *
 *   pg_dump -Fc … | node dist/scripts/backup-upload.js --key backups/helmet_20260918T030000Z.dump [--retention-days 30] [--keep-min 7]
 *
 * 只接受 pg_dump 自定义格式（文件头 PGDMP）：pg_dump 失败时 stdin 是空的或错误文本，绝不能把它当备份传上去。
 * 备份桶与媒体桶分开（TENCENT_COS_BACKUP_BUCKET，2026-10-14）：媒体换链接接口按设备上报的路径签名，
 * 同桶等于给拿到设备凭证的人一条通往整库导出的路；没填时落到媒体桶并在 stderr 打 ⚠️，不中断备份。
 * 退出码：0 成功；2 参数/输入不合法；3 未配置 COS；1 上传或清理失败（cron 据此告警）。
 */
import COS from 'cos-nodejs-sdk-v5';
import { errorMessage } from '../common/error-text';
import { tencentCosConfigFromEnv } from '../providers/tencent-cos.provider';

export const BACKUP_PREFIX = 'backups/';
const PG_DUMP_MAGIC = 'PGDMP';

/** 备份桶：优先 TENCENT_COS_BACKUP_BUCKET；没填 / 空串 / 与媒体桶同名都算没分桶，回落媒体桶（调用方要出声） */
export function resolveBackupBucket(
  env: Record<string, string | undefined>,
  mediaBucket: string,
): { bucket: string; dedicated: boolean } {
  const dedicated = env.TENCENT_COS_BACKUP_BUCKET?.trim();
  return dedicated && dedicated !== mediaBucket
    ? { bucket: dedicated, dedicated: true }
    : { bucket: mediaBucket, dedicated: false };
}

export interface BackupArgs {
  key: string;
  retentionDays: number;
  keepMin: number;
}

export interface RemoteObject {
  key: string;
  lastModified: Date;
}

/** 与 COS SDK 解耦的最小接口，便于单测注入假实现 */
export interface BackupStore {
  put(key: string, body: Buffer): Promise<void>;
  list(prefix: string): Promise<RemoteObject[]>;
  remove(keys: string[]): Promise<void>;
}

export function parseArgs(argv: string[]): BackupArgs {
  let key: string | undefined;
  let retentionDays = 30;
  let keepMin = 7;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} 缺少取值`);
      i += 1;
      return v;
    };
    if (a === '--key') key = next();
    else if (a === '--retention-days') retentionDays = Number(next());
    else if (a === '--keep-min') keepMin = Number(next());
    else throw new Error(`未知参数 ${a}`);
  }
  if (!key || !isValidBackupKey(key)) {
    throw new Error(
      `--key 必须形如 ${BACKUP_PREFIX}<名称>（只含字母数字 . _ -），实际：${key ?? '(空)'}`,
    );
  }
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error('--retention-days 必须是 ≥1 的整数');
  }
  if (!Number.isInteger(keepMin) || keepMin < 1) {
    throw new Error('--keep-min 必须是 ≥1 的整数');
  }
  return { key, retentionDays, keepMin };
}

/** 只允许 backups/ 下的扁平对象名：防止把备份写到媒体前缀里，或用 ../ 之类的键 */
export function isValidBackupKey(key: string): boolean {
  if (!key.startsWith(BACKUP_PREFIX)) return false;
  const name = key.slice(BACKUP_PREFIX.length);
  return /^[A-Za-z0-9._-]{1,200}$/.test(name) && !name.startsWith('.');
}

export function looksLikePgDump(body: Buffer): boolean {
  return (
    body.length > PG_DUMP_MAGIC.length &&
    body.subarray(0, PG_DUMP_MAGIC.length).toString('latin1') === PG_DUMP_MAGIC
  );
}

/**
 * 选出要删的旧备份：按时间倒序，最新的 keepMin 份无论多旧都保留（保留期配得再短也不会删到只剩今天这一份），
 * 其余超过 retentionDays 的删除。只看 backups/ 前缀下的对象。
 */
export function selectExpired(
  objects: RemoteObject[],
  now: Date,
  retentionDays: number,
  keepMin: number,
): RemoteObject[] {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const sorted = [...objects]
    .filter((o) => o.key.startsWith(BACKUP_PREFIX))
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return sorted.slice(keepMin).filter((o) => o.lastModified.getTime() < cutoff);
}

export interface BackupResult {
  key: string;
  bytes: number;
  deleted: string[];
  remaining: number;
}

export async function runBackup(
  store: BackupStore,
  body: Buffer,
  args: BackupArgs,
  now = new Date(),
): Promise<BackupResult> {
  if (!looksLikePgDump(body)) {
    throw new Error(
      `stdin 不是 pg_dump 自定义格式（${body.length} 字节，文件头 ${JSON.stringify(body.subarray(0, 5).toString('latin1'))}）——pg_dump 大概率失败了，拒绝上传`,
    );
  }
  await store.put(args.key, body);
  const existing = await store.list(BACKUP_PREFIX);
  const expired = selectExpired(
    existing,
    now,
    args.retentionDays,
    args.keepMin,
  ).filter((o) => o.key !== args.key);
  if (expired.length > 0) await store.remove(expired.map((o) => o.key));
  return {
    key: args.key,
    bytes: body.length,
    deleted: expired.map((o) => o.key),
    remaining: existing.length - expired.length,
  };
}

/** 真实 COS 实现：list 走 Marker 分页，remove 每批 ≤1000（COS 上限） */
export function cosStore(
  cos: COS,
  bucket: string,
  region: string,
): BackupStore {
  return {
    async put(key, body) {
      await cos.putObject({
        Bucket: bucket,
        Region: region,
        Key: key,
        Body: body,
        ContentLength: body.length,
      });
    },
    async list(prefix) {
      const out: RemoteObject[] = [];
      let marker: string | undefined;
      for (;;) {
        const page = await cos.getBucket({
          Bucket: bucket,
          Region: region,
          Prefix: prefix,
          Marker: marker,
          MaxKeys: 1000,
        });
        for (const c of page.Contents ?? []) {
          out.push({ key: c.Key, lastModified: new Date(c.LastModified) });
        }
        if (page.IsTruncated !== 'true' || !page.NextMarker) break;
        marker = page.NextMarker;
      }
      return out;
    },
    async remove(keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        await cos.deleteMultipleObject({
          Bucket: bucket,
          Region: region,
          Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })),
        });
      }
    },
  };
}

function readStdin(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  let args: BackupArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`✕ ${errorMessage(err)}`);
    process.exit(2);
  }
  const config = tencentCosConfigFromEnv();
  if (!config) {
    console.error(
      '✕ 未配置 TENCENT_COS_SECRET_ID / TENCENT_COS_SECRET_KEY / TENCENT_COS_BUCKET，无法上传备份',
    );
    process.exit(3);
  }
  const target = resolveBackupBucket(process.env, config.bucket);
  if (!target.dedicated) {
    console.error(
      `⚠️ 未设置 TENCENT_COS_BACKUP_BUCKET，备份落到媒体桶 ${target.bucket}：媒体换链接接口按设备上报的路径签名，同桶等于给设备一条通往整库导出的路（见 deploy/.env.example）`,
    );
  }
  const body = await readStdin();
  const cos = new COS({
    SecretId: config.secretId,
    SecretKey: config.secretKey,
    Protocol: 'https:',
  });
  try {
    const result = await runBackup(
      cosStore(cos, target.bucket, config.region),
      body,
      args,
    );
    console.log(
      `✓ 已上传 ${result.key}（${(result.bytes / 1024 / 1024).toFixed(2)} MB）到 ${target.bucket}；清理 ${result.deleted.length} 份过期备份，现存 ${result.remaining} 份`,
    );
    for (const k of result.deleted) console.log(`  - 已删除 ${k}`);
  } catch (err) {
    console.error(`✕ 备份失败：${errorMessage(err)}`);
    process.exit(1);
  }
}

if (require.main === module) void main();
