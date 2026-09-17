import {
  TencentCosProvider,
  tencentCosConfigFromEnv,
} from './tencent-cos.provider';

const getObjectUrl = jest.fn();
const ctor = jest.fn();

jest.mock('cos-nodejs-sdk-v5', () =>
  jest.fn().mockImplementation((opts: unknown) => {
    ctor(opts);
    return { getObjectUrl };
  }),
);

const config = {
  secretId: 'AKID_TEST',
  secretKey: 'KEY_TEST',
  bucket: 'helmet-media-1250000000',
  region: 'ap-guangzhou',
};

describe('tencentCosConfigFromEnv', () => {
  const keys = [
    'TENCENT_COS_SECRET_ID',
    'TENCENT_COS_SECRET_KEY',
    'TENCENT_COS_BUCKET',
    'TENCENT_COS_REGION',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('密钥与桶名齐全时返回配置，地域缺省为广州', () => {
    process.env.TENCENT_COS_SECRET_ID = 'id';
    process.env.TENCENT_COS_SECRET_KEY = 'key';
    process.env.TENCENT_COS_BUCKET = 'bucket-1';
    expect(tencentCosConfigFromEnv()).toEqual({
      secretId: 'id',
      secretKey: 'key',
      bucket: 'bucket-1',
      region: 'ap-guangzhou',
    });
  });

  it('显式地域优先', () => {
    process.env.TENCENT_COS_SECRET_ID = 'id';
    process.env.TENCENT_COS_SECRET_KEY = 'key';
    process.env.TENCENT_COS_BUCKET = 'bucket-1';
    process.env.TENCENT_COS_REGION = 'ap-shanghai';
    expect(tencentCosConfigFromEnv()?.region).toBe('ap-shanghai');
  });

  it.each([
    'TENCENT_COS_SECRET_ID',
    'TENCENT_COS_SECRET_KEY',
    'TENCENT_COS_BUCKET',
  ])('缺 %s 时返回 null（回落 Mock）', (missing) => {
    process.env.TENCENT_COS_SECRET_ID = 'id';
    process.env.TENCENT_COS_SECRET_KEY = 'key';
    process.env.TENCENT_COS_BUCKET = 'bucket-1';
    delete process.env[missing];
    expect(tencentCosConfigFromEnv()).toBeNull();
  });
});

describe('TencentCosProvider.getSignedUrl', () => {
  beforeEach(() => {
    getObjectUrl.mockReset();
    ctor.mockReset();
  });

  it('用子账号密钥与 https 构造客户端', () => {
    new TencentCosProvider(config);
    expect(ctor).toHaveBeenCalledWith({
      SecretId: 'AKID_TEST',
      SecretKey: 'KEY_TEST',
      Protocol: 'https:',
    });
  });

  it('按桶/地域/键签发带签名的 GET 链接，时效透传', async () => {
    getObjectUrl.mockReturnValue(
      'https://helmet-media-1250000000.cos.ap-guangzhou.myqcloud.com/dev/v1.mp4?q-sign-algorithm=sha1',
    );
    const url = await new TencentCosProvider(config).getSignedUrl(
      'dev/v1.mp4',
      600,
    );
    expect(getObjectUrl).toHaveBeenCalledWith({
      Bucket: 'helmet-media-1250000000',
      Region: 'ap-guangzhou',
      Key: 'dev/v1.mp4',
      Sign: true,
      Expires: 600,
    });
    expect(url).toContain('q-sign-algorithm');
  });

  it('去掉键前导斜杠；时效取整且至少 1 秒', async () => {
    getObjectUrl.mockReturnValue('https://x.myqcloud.com/a');
    const p = new TencentCosProvider(config);
    await p.getSignedUrl('//dev/v1.mp4', 0.4);
    expect(getObjectUrl).toHaveBeenLastCalledWith(
      expect.objectContaining({ Key: 'dev/v1.mp4', Expires: 1 }),
    );
    await p.getSignedUrl('dev/v1.mp4', 599.9);
    expect(getObjectUrl).toHaveBeenLastCalledWith(
      expect.objectContaining({ Expires: 599 }),
    );
  });

  it('空键（或只有斜杠）拒绝签发，不去签桶根路径', async () => {
    const p = new TencentCosProvider(config);
    await expect(p.getSignedUrl('', 600)).rejects.toThrow('storageKey');
    await expect(p.getSignedUrl('///', 600)).rejects.toThrow('storageKey');
    expect(getObjectUrl).not.toHaveBeenCalled();
  });

  it('SDK 返回空或非 https 链接时抛错（调用方据此返回 5xx，不给客户端坏链接）', async () => {
    const p = new TencentCosProvider(config);
    getObjectUrl.mockReturnValue('');
    await expect(p.getSignedUrl('dev/v1.mp4', 600)).rejects.toThrow('COS');
    getObjectUrl.mockReturnValue('http://insecure.example/a');
    await expect(p.getSignedUrl('dev/v1.mp4', 600)).rejects.toThrow('COS');
  });
});
