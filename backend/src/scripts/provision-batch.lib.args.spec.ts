// 批量开通参数解析与分配的其余分支：读环境变量里的二维码前缀、参数缺值、默认生成器。
import {
  DEFAULT_QR_BASE,
  allocateBatch,
  parseBatchArgs,
} from './provision-batch.lib';

describe('parseBatchArgs：其余分支', () => {
  const saved = process.env.BIND_QR_BASE_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.BIND_QR_BASE_URL;
    else process.env.BIND_QR_BASE_URL = saved;
  });

  it('不传 env 参数时读 process.env.BIND_QR_BASE_URL（去掉结尾斜杠）', () => {
    process.env.BIND_QR_BASE_URL = 'https://dev.example.com/bind/';
    expect(parseBatchArgs(['--count', '1']).qrBase).toBe(
      'https://dev.example.com/bind',
    );
    process.env.BIND_QR_BASE_URL = '   ';
    expect(parseBatchArgs(['--count', '1']).qrBase).toBe(DEFAULT_QR_BASE);
  });

  it('--out 写在最后没给值：按空目录拒绝', () => {
    expect(() => parseBatchArgs(['--count', '1', '--out'], {})).toThrow(
      '--out 不能为空',
    );
  });

  it('--qr-base 写在最后没给值：按非法地址拒绝', () => {
    expect(() => parseBatchArgs(['--count', '1', '--qr-base'], {})).toThrow(
      '--qr-base 必须是不带 query 的 http(s) 地址',
    );
  });

  it('--count 没给值：拒绝', () => {
    expect(() => parseBatchArgs(['--count'], {})).toThrow('--count 必须是');
  });
});

describe('allocateBatch：默认生成器', () => {
  it('不传生成器：deviceId = helmet_+6 位十六进制、绑定码 8 位数字、密钥 32 字符 base64url，二维码带参数', () => {
    const taken = {
      deviceIds: new Set<string>(),
      bindCodes: new Set<string>(),
    };
    const rows = allocateBatch(3, taken, 'https://x.test/bind');
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.deviceId).toMatch(/^helmet_[0-9a-f]{6}$/);
      expect(r.bindCode).toMatch(/^\d{8}$/);
      expect(r.deviceSecret).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(r.broadcastName).toBe(`Helmet-${r.deviceId.slice(-6)}`);
      expect(r.qrContent).toBe(
        `https://x.test/bind?d=${r.deviceId}&c=${r.bindCode}`,
      );
    }
    expect(taken.deviceIds.size).toBe(3);
    expect(taken.bindCodes.size).toBe(3);
  });
});
