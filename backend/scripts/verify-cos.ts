/**
 * COS 端到端自检（THIRD_PARTY.md §3）：用 backend/.env（或容器环境变量）里的 TENCENT_COS_* 对真实桶做一轮验证。
 *   npm run verify:cos -w backend
 * 步骤：上传一个临时对象 → 用 TencentCosProvider 签发短时效链接 → 带签名能读、内容一致 →
 *       不带签名 403（桶私有）→ 篡改签名 403 → 过期后 403 → 删除临时对象。
 * 只打印结论，不打印链接与签名（链接带凭证）。部署到服务器后可在容器内跑同一条命令验收。
 */
import 'dotenv/config';
import COS from 'cos-nodejs-sdk-v5';
import { randomUUID } from 'node:crypto';
import {
  TencentCosProvider,
  tencentCosConfigFromEnv,
} from '../src/providers/tencent-cos.provider';

const EXPIRES_SEC = 3;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function status(url: string): Promise<{ code: number; body: string }> {
  const res = await fetch(url);
  return { code: res.status, body: await res.text() };
}

async function main(): Promise<void> {
  const config = tencentCosConfigFromEnv();
  if (!config) {
    console.error(
      '✕ 未配置 TENCENT_COS_SECRET_ID / TENCENT_COS_SECRET_KEY / TENCENT_COS_BUCKET',
    );
    process.exit(2);
  }
  console.log(`桶：${config.bucket}（${config.region}）`);
  const cos = new COS({
    SecretId: config.secretId,
    SecretKey: config.secretKey,
    Protocol: 'https:',
  });
  const provider = new TencentCosProvider(config);
  const key = `_healthcheck/verify-cos-${Date.now()}-${randomUUID().slice(0, 8)}.txt`;
  const content = `helmet cos verify ${new Date().toISOString()}`;
  const results: Array<[string, boolean, string]> = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    results.push([name, ok, detail]);
    console.log(`${ok ? '✓' : '✕'} ${name}：${detail}`);
  };

  try {
    await cos.putObject({
      Bucket: config.bucket,
      Region: config.region,
      Key: key,
      Body: content,
    });
    check('上传临时对象', true, key);

    const url = await provider.getSignedUrl(key, EXPIRES_SEC);
    const signed = await status(url);
    check(
      '签名链接可读且内容一致',
      signed.code === 200 && signed.body === content,
      `HTTP ${signed.code}`,
    );

    const bare = await status(url.split('?')[0]);
    check('不带签名被拒（桶为私有）', bare.code === 403, `HTTP ${bare.code}`);

    const tampered = await status(
      url.replace(/q-signature=([0-9a-f])/, (_m, c: string) =>
        `q-signature=${c === 'a' ? 'b' : 'a'}`,
      ),
    );
    check('篡改签名被拒', tampered.code === 403, `HTTP ${tampered.code}`);

    await sleep((EXPIRES_SEC + 5) * 1000);
    const expired = await status(url);
    check(
      `过期（${EXPIRES_SEC}s）后被拒`,
      expired.code === 403,
      `HTTP ${expired.code}`,
    );
  } catch (err) {
    check('执行', false, err instanceof Error ? err.message : String(err));
  } finally {
    try {
      await cos.deleteObject({
        Bucket: config.bucket,
        Region: config.region,
        Key: key,
      });
      console.log('✓ 已删除临时对象');
    } catch (err) {
      console.error(
        `✕ 删除临时对象失败，请在控制台手动删除 ${key}：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const failed = results.filter(([, ok]) => !ok);
  console.log(
    failed.length === 0
      ? `\nCOS 自检通过（${results.length} 项）`
      : `\nCOS 自检失败 ${failed.length} 项`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

void main();
