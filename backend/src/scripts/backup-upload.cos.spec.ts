// backup-upload 的 COS 适配层与失败分支：COS 客户端用假对象顶替（只记录调用），绝不真上传。
import type COS from 'cos-nodejs-sdk-v5';
import {
  BACKUP_PREFIX,
  cosStore,
  parseArgs,
  runBackup,
  selectExpired,
  type BackupStore,
  type RemoteObject,
} from './backup-upload';

const day = 24 * 60 * 60 * 1000;
const now = new Date('2026-10-16T03:00:00Z');
const dump = (n = 64): Buffer =>
  Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(n, 7)]);

interface FakeCos {
  putObject: jest.Mock;
  getBucket: jest.Mock;
  deleteMultipleObject: jest.Mock;
}
const fakeCos = (): FakeCos => ({
  putObject: jest.fn(() => Promise.resolve({})),
  getBucket: jest.fn(() =>
    Promise.resolve({ Contents: [], IsTruncated: 'false' }),
  ),
  deleteMultipleObject: jest.fn(() => Promise.resolve({})),
});
const asCos = (c: FakeCos): COS => c as unknown as COS;

describe('cosStore：COS SDK 适配', () => {
  it('put：带桶名、地域、键和 ContentLength 上传整块 Buffer', async () => {
    const cos = fakeCos();
    const body = dump();
    await cosStore(asCos(cos), 'backup-1', 'ap-guangzhou').put(
      'backups/a.dump',
      body,
    );
    expect(cos.putObject).toHaveBeenCalledWith({
      Bucket: 'backup-1',
      Region: 'ap-guangzhou',
      Key: 'backups/a.dump',
      Body: body,
      ContentLength: body.length,
    });
  });

  it('list：按 Marker 翻页直到 IsTruncated≠"true"，LastModified 转成 Date', async () => {
    const cos = fakeCos();
    cos.getBucket
      .mockResolvedValueOnce({
        Contents: [
          { Key: 'backups/a.dump', LastModified: '2026-10-01T00:00:00.000Z' },
          { Key: 'backups/b.dump', LastModified: '2026-10-02T00:00:00.000Z' },
        ],
        IsTruncated: 'true',
        NextMarker: 'backups/b.dump',
      })
      .mockResolvedValueOnce({
        Contents: [
          { Key: 'backups/c.dump', LastModified: '2026-10-03T00:00:00.000Z' },
        ],
        IsTruncated: 'false',
      });
    const out = await cosStore(asCos(cos), 'bk', 'ap-gz').list(BACKUP_PREFIX);
    expect(out).toEqual([
      { key: 'backups/a.dump', lastModified: new Date('2026-10-01T00:00:00Z') },
      { key: 'backups/b.dump', lastModified: new Date('2026-10-02T00:00:00Z') },
      { key: 'backups/c.dump', lastModified: new Date('2026-10-03T00:00:00Z') },
    ]);
    expect(cos.getBucket).toHaveBeenNthCalledWith(1, {
      Bucket: 'bk',
      Region: 'ap-gz',
      Prefix: 'backups/',
      Marker: undefined,
      MaxKeys: 1000,
    });
    expect(cos.getBucket).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ Marker: 'backups/b.dump' }),
    );
  });

  it('list：IsTruncated="true" 却没给 NextMarker 时停止翻页（防死循环）；空页没有 Contents 也不报错', async () => {
    const cos = fakeCos();
    cos.getBucket.mockResolvedValueOnce({ IsTruncated: 'true' });
    const out = await cosStore(asCos(cos), 'bk', 'r').list(BACKUP_PREFIX);
    expect(out).toEqual([]);
    expect(cos.getBucket).toHaveBeenCalledTimes(1);
  });

  it('remove：每批最多 1000 个（COS 上限），2500 个分三批', async () => {
    const cos = fakeCos();
    const keys = Array.from({ length: 2500 }, (_, i) => `backups/${i}.dump`);
    await cosStore(asCos(cos), 'bk', 'r').remove(keys);
    expect(cos.deleteMultipleObject).toHaveBeenCalledTimes(3);
    const sizes = cos.deleteMultipleObject.mock.calls.map(
      (c) => (c[0] as { Objects: unknown[] }).Objects.length,
    );
    expect(sizes).toEqual([1000, 1000, 500]);
    expect(cos.deleteMultipleObject.mock.calls[2][0]).toMatchObject({
      Bucket: 'bk',
      Region: 'r',
      Objects: expect.arrayContaining([{ Key: 'backups/2499.dump' }]),
    });
  });

  it('remove：空列表不发请求', async () => {
    const cos = fakeCos();
    await cosStore(asCos(cos), 'bk', 'r').remove([]);
    expect(cos.deleteMultipleObject).not.toHaveBeenCalled();
  });
});

describe('runBackup + cosStore：各失败分支（退出码 1 让 cron 告警）', () => {
  const args = {
    key: 'backups/helmet_20261016T030000Z.dump',
    retentionDays: 30,
    keepMin: 1,
  };

  it('全流程：上传 → 列出 → 删除过期，结果里的 remaining 不含被删的', async () => {
    const cos = fakeCos();
    cos.getBucket.mockResolvedValueOnce({
      Contents: [
        { Key: args.key, LastModified: now.toISOString() },
        {
          Key: 'backups/old.dump',
          LastModified: new Date(now.getTime() - 40 * day).toISOString(),
        },
      ],
      IsTruncated: 'false',
    });
    const res = await runBackup(
      cosStore(asCos(cos), 'bk', 'r'),
      dump(),
      args,
      now,
    );
    expect(res).toEqual({
      key: args.key,
      bytes: 69,
      deleted: ['backups/old.dump'],
      remaining: 1,
    });
    expect(cos.deleteMultipleObject).toHaveBeenCalledWith({
      Bucket: 'bk',
      Region: 'r',
      Objects: [{ Key: 'backups/old.dump' }],
    });
  });

  it('上传失败：直接抛出，不列、不删（旧备份一份都不能少）', async () => {
    const cos = fakeCos();
    cos.putObject.mockRejectedValue(new Error('AccessDenied'));
    await expect(
      runBackup(cosStore(asCos(cos), 'bk', 'r'), dump(), args, now),
    ).rejects.toThrow('AccessDenied');
    expect(cos.getBucket).not.toHaveBeenCalled();
    expect(cos.deleteMultipleObject).not.toHaveBeenCalled();
  });

  it('上传成功但列举失败：抛出（备份已在桶里，清理没做），不调删除', async () => {
    const cos = fakeCos();
    cos.getBucket.mockRejectedValue(new Error('NoSuchBucket'));
    await expect(
      runBackup(cosStore(asCos(cos), 'bk', 'r'), dump(), args, now),
    ).rejects.toThrow('NoSuchBucket');
    expect(cos.putObject).toHaveBeenCalledTimes(1);
    expect(cos.deleteMultipleObject).not.toHaveBeenCalled();
  });

  it('翻页途中失败：整个 list 失败，不拿半截列表去删', async () => {
    const cos = fakeCos();
    cos.getBucket
      .mockResolvedValueOnce({
        Contents: [
          {
            Key: 'backups/old.dump',
            LastModified: new Date(now.getTime() - 99 * day).toISOString(),
          },
        ],
        IsTruncated: 'true',
        NextMarker: 'backups/old.dump',
      })
      .mockRejectedValueOnce(new Error('socket hang up'));
    await expect(
      runBackup(cosStore(asCos(cos), 'bk', 'r'), dump(), args, now),
    ).rejects.toThrow('socket hang up');
    expect(cos.deleteMultipleObject).not.toHaveBeenCalled();
  });

  it('删除过期失败：抛出（cron 告警），上传已完成', async () => {
    const cos = fakeCos();
    cos.getBucket.mockResolvedValueOnce({
      Contents: [
        { Key: args.key, LastModified: now.toISOString() },
        {
          Key: 'backups/old.dump',
          LastModified: new Date(now.getTime() - 99 * day).toISOString(),
        },
      ],
      IsTruncated: 'false',
    });
    cos.deleteMultipleObject.mockRejectedValue(new Error('SlowDown'));
    await expect(
      runBackup(cosStore(asCos(cos), 'bk', 'r'), dump(), args, now),
    ).rejects.toThrow('SlowDown');
    expect(cos.putObject).toHaveBeenCalledTimes(1);
  });

  it('输入不是 pg_dump：错误里带字节数与前 5 字节，便于排查 pg_dump 输出了什么', async () => {
    const put = jest.fn();
    const store: BackupStore = { put, list: jest.fn(), remove: jest.fn() };
    await expect(
      runBackup(store, Buffer.from('pg_dump: error'), args, now),
    ).rejects.toThrow(
      'stdin 不是 pg_dump 自定义格式（14 字节，文件头 "pg_du"）',
    );
    expect(put).not.toHaveBeenCalled();
  });

  it('列表里还没出现刚上传的对象：keepMin 照样按列出来的算——宁可多留，不会删到一份不剩', async () => {
    const cos = fakeCos();
    cos.getBucket.mockResolvedValueOnce({
      Contents: [
        {
          Key: 'backups/old.dump',
          LastModified: new Date(now.getTime() - 99 * day).toISOString(),
        },
      ],
      IsTruncated: 'false',
    });
    const res = await runBackup(
      cosStore(asCos(cos), 'bk', 'r'),
      dump(),
      args,
      now,
    );
    expect(res.deleted).toEqual([]);
    expect(cos.deleteMultipleObject).not.toHaveBeenCalled();
  });

  it('不传 now 时按当前时间判过期（默认参数）', async () => {
    const store: BackupStore = {
      put: jest.fn(() => Promise.resolve()),
      list: jest.fn(() =>
        Promise.resolve<RemoteObject[]>([
          { key: 'backups/ancient.dump', lastModified: new Date(0) },
          { key: 'backups/fresh.dump', lastModified: new Date() },
        ]),
      ),
      remove: jest.fn(() => Promise.resolve()),
    };
    const res = await runBackup(store, dump(), args);
    expect(res.deleted).toEqual(['backups/ancient.dump']);
  });
});

describe('parseArgs：其余拒绝分支', () => {
  it('参数缺取值：点名是哪个参数', () => {
    expect(() => parseArgs(['--key'])).toThrow('--key 缺少取值');
    expect(() => parseArgs(['--key', 'backups/a.dump', '--keep-min'])).toThrow(
      '--keep-min 缺少取值',
    );
  });

  it.each([['0'], ['-1'], ['1.5'], ['abc']])(
    '--keep-min=%p 不是 ≥1 的整数：拒绝',
    (v) => {
      expect(() =>
        parseArgs(['--key', 'backups/a.dump', '--keep-min', v]),
      ).toThrow('--keep-min 必须是 ≥1 的整数');
    },
  );

  it.each([['abc'], ['2.5'], ['-3']])(
    '--retention-days=%p 不是 ≥1 的整数：拒绝',
    (v) => {
      expect(() =>
        parseArgs(['--key', 'backups/a.dump', '--retention-days', v]),
      ).toThrow('--retention-days 必须是 ≥1 的整数');
    },
  );

  it('报错信息里把空 key 写成「(空)」', () => {
    expect(() => parseArgs(['--retention-days', '3'])).toThrow('实际：(空)');
  });
});

describe('selectExpired：边界', () => {
  it('恰好等于保留期边界的不删（严格早于 cutoff 才删）', () => {
    const objs: RemoteObject[] = [
      { key: 'backups/new.dump', lastModified: now },
      {
        key: 'backups/edge.dump',
        lastModified: new Date(now.getTime() - 30 * day),
      },
      {
        key: 'backups/over.dump',
        lastModified: new Date(now.getTime() - 30 * day - 1),
      },
    ];
    expect(selectExpired(objs, now, 30, 1).map((o) => o.key)).toEqual([
      'backups/over.dump',
    ]);
  });
});
