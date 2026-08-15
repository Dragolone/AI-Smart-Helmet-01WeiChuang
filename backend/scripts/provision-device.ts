// 设备开通脚本：生成 deviceId + deviceSecret + bindCode 并注册到数据库。
// Mock 设备与未来真机走同一机制（出厂写入的软件版，DEVICE_PROTOCOL §3）。
// 用法：npm run provision:device -w backend [-- helmet_mock_002]
import 'dotenv/config';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

async function main() {
  const deviceId =
    process.argv[2] ?? `helmet_${randomBytes(3).toString('hex')}`;
  const deviceSecret = randomBytes(24).toString('base64url');
  // 绑定码：8 位数字，App 输入友好（真机形式待硬件确认后对齐）
  const bindCode = String(randomInt(10_000_000, 100_000_000));

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  await prisma.device.create({
    data: {
      deviceId,
      deviceSecretHash: createHash('sha256').update(deviceSecret).digest('hex'),
      bindCode,
    },
  });
  await prisma.$disconnect();

  console.log('设备开通成功（deviceSecret 只显示这一次，立即保存）：');
  console.log(`  DEVICE_ID     = ${deviceId}`);
  console.log(`  DEVICE_SECRET = ${deviceSecret}`);
  console.log(`  BIND_CODE     = ${bindCode}`);
  console.log(
    `\nMock 设备启动：DEVICE_ID=${deviceId} DEVICE_SECRET=${deviceSecret} npm run start -w mock-device`,
  );
}

main().catch((err) => {
  console.error('开通失败：', err instanceof Error ? err.message : err);
  process.exit(1);
});
