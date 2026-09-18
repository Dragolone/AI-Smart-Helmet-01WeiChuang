import {
  DEFAULT_QR_BASE,
  allocateBatch,
  broadcastName,
  buildCsv,
  hashSecret,
  makeBindCode,
  makeDeviceId,
  makeDeviceSecret,
  parseBatchArgs,
  qrContent,
} from './provision-batch.lib';

describe('provision-batch.lib', () => {
  describe('parseBatchArgs', () => {
    it('--count 必填且限 1–500；默认输出目录、默认二维码前缀、默认出码', () => {
      expect(parseBatchArgs(['--count', '20'], {})).toEqual({
        count: 20,
        out: 'provision-out',
        qrBase: DEFAULT_QR_BASE,
        qr: true,
      });
      expect(() => parseBatchArgs([], {})).toThrow('--count');
      expect(() => parseBatchArgs(['--count', '0'], {})).toThrow('--count');
      expect(() => parseBatchArgs(['--count', '501'], {})).toThrow('--count');
      expect(() => parseBatchArgs(['--count', '2.5'], {})).toThrow('--count');
    });

    it('--out / --qr-base / --no-qr 与环境变量 BIND_QR_BASE_URL；未知参数报错', () => {
      const a = parseBatchArgs(
        [
          '--count',
          '3',
          '--out',
          '/tmp/x',
          '--qr-base',
          'https://example.com/b/',
          '--no-qr',
        ],
        {},
      );
      expect(a).toEqual({
        count: 3,
        out: '/tmp/x',
        qrBase: 'https://example.com/b',
        qr: false,
      });
      expect(
        parseBatchArgs(['--count', '1'], {
          BIND_QR_BASE_URL: 'http://dev.local/bind',
        }).qrBase,
      ).toBe('http://dev.local/bind');
      expect(() =>
        parseBatchArgs(['--count', '1', '--qr-base', 'ftp://x'], {}),
      ).toThrow('--qr-base');
      expect(() =>
        parseBatchArgs(['--count', '1', '--qr-base', 'https://x/b?d=1'], {}),
      ).toThrow('--qr-base');
      expect(() => parseBatchArgs(['--count', '1', '--bogus'], {})).toThrow(
        '未知参数',
      );
    });
  });

  it('凭证生成规则与单台开通一致：deviceId 13 字符可进 0x40，secret 32 字符正好 0x50，绑定码 8 位数字', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(makeDeviceId()).toMatch(/^helmet_[0-9a-f]{6}$/);
      expect(makeDeviceSecret()).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(makeBindCode()).toMatch(/^[1-9]\d{7}$/);
    }
    expect(hashSecret('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('广播名取 deviceId 后 6 位；二维码内容按 §11 格式 ① 且做 URL 编码', () => {
    expect(broadcastName('helmet_94173f')).toBe('Helmet-94173f');
    expect(
      qrContent('https://01weichuang.com/bind', 'helmet_94173f', '94041564'),
    ).toBe('https://01weichuang.com/bind?d=helmet_94173f&c=94041564');
    expect(qrContent('https://x/b', 'a&b', '1')).toBe(
      'https://x/b?d=a%26b&c=1',
    );
  });

  it('allocateBatch：跳过库内已有与批内重复的 deviceId / bindCode，且把新值记回 taken', () => {
    const ids = [
      'helmet_aaaaaa',
      'helmet_aaaaaa',
      'helmet_bbbbbb',
      'helmet_cccccc',
      'helmet_cccccc',
      'helmet_dddddd',
    ];
    const codes = ['11111111', '22222222', '22222222', '33333333', '44444444'];
    const gen = {
      deviceId: () => ids.shift()!,
      bindCode: () => codes.shift()!,
      deviceSecret: () => 's'.repeat(32),
    };
    const taken = {
      deviceIds: new Set(['helmet_bbbbbb']),
      bindCodes: new Set(['11111111']),
    };
    const rows = allocateBatch(3, taken, 'https://x/b', gen);
    expect(rows.map((r) => r.deviceId)).toEqual([
      'helmet_aaaaaa',
      'helmet_cccccc',
      'helmet_dddddd',
    ]);
    expect(rows.map((r) => r.bindCode)).toEqual([
      '22222222',
      '33333333',
      '44444444',
    ]);
    expect(rows[0]).toEqual({
      deviceId: 'helmet_aaaaaa',
      deviceSecret: 's'.repeat(32),
      bindCode: '22222222',
      broadcastName: 'Helmet-aaaaaa',
      qrContent: 'https://x/b?d=helmet_aaaaaa&c=22222222',
    });
    expect(taken.deviceIds.size).toBe(4);
    expect(taken.bindCodes.size).toBe(4);
  });

  it('allocateBatch：生成器一直撞重复时报错而不是死循环', () => {
    const gen = {
      deviceId: () => 'helmet_same00',
      bindCode: () => '12345678',
      deviceSecret: () => 'x',
    };
    expect(() =>
      allocateBatch(
        2,
        { deviceIds: new Set(), bindCodes: new Set() },
        'https://x/b',
        gen,
      ),
    ).toThrow('1000 次');
  });

  it('buildCsv：固定表头、CRLF、含逗号或引号的字段加引号转义', () => {
    const csv = buildCsv([
      {
        deviceId: 'helmet_000001',
        deviceSecret: 'se"cret,1',
        bindCode: '12345678',
        broadcastName: 'Helmet-000001',
        qrContent: 'https://x/b?d=helmet_000001&c=12345678',
      },
    ]);
    expect(csv).toBe(
      'deviceId,deviceSecret,bindCode,broadcastName,qrContent\r\n' +
        'helmet_000001,"se""cret,1",12345678,Helmet-000001,https://x/b?d=helmet_000001&c=12345678\r\n',
    );
  });
});
