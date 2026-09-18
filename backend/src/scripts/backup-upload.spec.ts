import {
  BACKUP_PREFIX,
  isValidBackupKey,
  looksLikePgDump,
  parseArgs,
  runBackup,
  selectExpired,
  type BackupStore,
  type RemoteObject,
} from './backup-upload';

const day = 24 * 60 * 60 * 1000;
const now = new Date('2026-09-18T03:00:00Z');
const obj = (name: string, ageDays: number): RemoteObject => ({
  key: `${BACKUP_PREFIX}${name}`,
  lastModified: new Date(now.getTime() - ageDays * day),
});
const dump = (): Buffer =>
  Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(64, 1)]);

describe('backup-upload：参数与输入校验', () => {
  it('parseArgs：默认保留 30 天、至少留 7 份；--key 必须在 backups/ 下且只含安全字符', () => {
    expect(
      parseArgs(['--key', 'backups/helmet_20260918T030000Z.dump']),
    ).toEqual({
      key: 'backups/helmet_20260918T030000Z.dump',
      retentionDays: 30,
      keepMin: 7,
    });
    expect(
      parseArgs([
        '--key',
        'backups/a.dump',
        '--retention-days',
        '14',
        '--keep-min',
        '3',
      ]),
    ).toMatchObject({ retentionDays: 14, keepMin: 3 });
    expect(() => parseArgs([])).toThrow('--key');
    expect(() => parseArgs(['--key', 'media/x.dump'])).toThrow('--key');
    expect(() => parseArgs(['--key', 'backups/../x'])).toThrow('--key');
    expect(() =>
      parseArgs(['--key', 'backups/a.dump', '--retention-days', '0']),
    ).toThrow('retention');
    expect(() => parseArgs(['--key', 'backups/a.dump', '--bogus'])).toThrow(
      '未知参数',
    );
  });

  it.each([
    ['backups/helmet_2026.dump', true],
    ['backups/.hidden', false],
    ['backups/', false],
    ['backups/sub/dir.dump', false],
    ['helmet.dump', false],
  ])('isValidBackupKey(%p) → %p', (key, ok) => {
    expect(isValidBackupKey(key)).toBe(ok);
  });

  it('looksLikePgDump：只认 PGDMP 文件头——pg_dump 失败时的空输入/错误文本一律拒绝', () => {
    expect(looksLikePgDump(dump())).toBe(true);
    expect(looksLikePgDump(Buffer.alloc(0))).toBe(false);
    expect(
      looksLikePgDump(Buffer.from('pg_dump: error: connection failed\n')),
    ).toBe(false);
    expect(looksLikePgDump(Buffer.from('PGDMP'))).toBe(false); // 只有魔数没有内容
  });
});

describe('backup-upload：保留策略', () => {
  it('最新 keepMin 份无论多旧都保留；其余超过保留期的删除；非 backups/ 前缀不碰', () => {
    const objects = [
      obj('d0.dump', 0),
      obj('d10.dump', 10),
      obj('d40.dump', 40),
      obj('d50.dump', 50),
      obj('d90.dump', 90),
      { key: 'media/helmet_x/video.mp4', lastModified: new Date(0) },
    ];
    // 保留 30 天、至少 2 份：d0/d10 无条件留；d40/d50/d90 超期删
    expect(selectExpired(objects, now, 30, 2).map((o) => o.key)).toEqual([
      'backups/d40.dump',
      'backups/d50.dump',
      'backups/d90.dump',
    ]);
    // 至少 4 份：d40 也留下（即便超期）
    expect(selectExpired(objects, now, 30, 4).map((o) => o.key)).toEqual([
      'backups/d90.dump',
    ]);
    // 保留 100 天：没有超期的
    expect(selectExpired(objects, now, 100, 1)).toEqual([]);
  });
});

describe('backup-upload：runBackup 编排（假存储）', () => {
  const makeStore = (existing: RemoteObject[]) => {
    const puts: Array<[string, number]> = [];
    const removed: string[] = [];
    const put = jest.fn((key: string, body: Buffer) => {
      puts.push([key, body.length]);
      return Promise.resolve();
    });
    const list = jest.fn(() => Promise.resolve(existing));
    const remove = jest.fn((keys: string[]) => {
      removed.push(...keys);
      return Promise.resolve();
    });
    const store: BackupStore = { put, list, remove };
    return { store, put, list, remove, puts, removed };
  };

  it('上传 → 列出 → 删除过期；本次上传的对象即使被列出也不会被删', async () => {
    const key = 'backups/helmet_20260918T030000Z.dump';
    const { store, puts, removed } = makeStore([
      { key, lastModified: now },
      obj('old1.dump', 45),
      obj('old2.dump', 60),
      obj('recent.dump', 3),
    ]);
    const result = await runBackup(
      store,
      dump(),
      { key, retentionDays: 30, keepMin: 1 },
      now,
    );
    expect(puts).toEqual([[key, 69]]);
    expect(removed).toEqual(['backups/old1.dump', 'backups/old2.dump']);
    expect(result).toEqual({
      key,
      bytes: 69,
      deleted: ['backups/old1.dump', 'backups/old2.dump'],
      remaining: 2,
    });
  });

  it('输入不是 pg_dump 产物 → 不上传、不清理、抛错（退出码 1 让 cron 告警）', async () => {
    const { store, put, remove } = makeStore([obj('old.dump', 99)]);
    await expect(
      runBackup(
        store,
        Buffer.from('pg_dump: error: FATAL'),
        { key: 'backups/x.dump', retentionDays: 30, keepMin: 1 },
        now,
      ),
    ).rejects.toThrow('不是 pg_dump');
    expect(put).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('没有过期备份时不调用 remove', async () => {
    const store = makeStore([obj('fresh.dump', 1)]);
    await runBackup(
      store,
      dump(),
      { key: 'backups/y.dump', retentionDays: 30, keepMin: 1 },
      now,
    );
    expect(store.remove).not.toHaveBeenCalled();
  });
});
