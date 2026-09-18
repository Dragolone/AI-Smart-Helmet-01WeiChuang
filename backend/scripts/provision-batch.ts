// 批量开通脚本：一次生成 N 台设备的 deviceId / deviceSecret / 绑定码并注册进库，
// 输出产线交接用的 CSV 与每台一张绑定二维码（DEVICE_PROTOCOL §11 格式 ①，SVG 供印刷、PNG 供预览）。
// 单台开通仍用 scripts/provision-device.ts；两者凭证规则完全一致（见 src/scripts/provision-batch.lib.ts）。
//
// 用法：npm run provision:batch -w backend -- --count 20 [--out provision-out] [--qr-base https://01weichuang.com/bind] [--no-qr]
// 产物：<out>/batch-<UTC 时间>/devices.csv + qr/<deviceId>.svg|png。CSV 含 deviceSecret，目录已 gitignore，交接后自行销毁。
// 交接口径：产线把 deviceId 烧进头盔 0x40（16 字节，不足补 0），deviceSecret 视硬件答复决定是否烧 0x50；
//           二维码印机身或说明卡；App 绑定用 deviceId + bindCode。
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as QRCode from 'qrcode';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import {
  allocateBatch,
  buildCsv,
  hashSecret,
  parseBatchArgs,
} from '../src/scripts/provision-batch.lib';

async function main(): Promise<void> {
  const args = parseBatchArgs(process.argv.slice(2));

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    // 库内已有的 deviceId / bindCode 一次读出来做去重（MVP 规模几百台，一把读完最简单）
    const existing = await prisma.device.findMany({
      select: { deviceId: true, bindCode: true },
    });
    const taken = {
      deviceIds: new Set(existing.map((d) => d.deviceId)),
      bindCodes: new Set(
        existing.flatMap((d) => (d.bindCode ? [d.bindCode] : [])),
      ),
    };
    const rows = allocateBatch(args.count, taken, args.qrBase);

    // createMany 是单条语句：任一行撞唯一约束整批回滚，不会留半批
    await prisma.device.createMany({
      data: rows.map((r) => ({
        deviceId: r.deviceId,
        deviceSecretHash: hashSecret(r.deviceSecret),
        bindCode: r.bindCode,
      })),
    });

    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d+Z$/, 'Z');
    const dir = resolve(args.out, `batch-${stamp}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'devices.csv'), buildCsv(rows), 'utf-8');

    if (args.qr) {
      const qrDir = join(dir, 'qr');
      mkdirSync(qrDir, { recursive: true });
      for (const r of rows) {
        const svg = await QRCode.toString(r.qrContent, {
          type: 'svg',
          errorCorrectionLevel: 'M',
          margin: 2,
        });
        writeFileSync(join(qrDir, `${r.deviceId}.svg`), svg, 'utf-8');
        await QRCode.toFile(join(qrDir, `${r.deviceId}.png`), r.qrContent, {
          type: 'png',
          errorCorrectionLevel: 'M',
          margin: 2,
          width: 512,
        });
      }
    }

    console.log(`已开通 ${rows.length} 台，产物目录：${dir}`);
    console.log(
      `  devices.csv（含 deviceSecret，敏感；交接后销毁）${args.qr ? ' + qr/ 每台 SVG 与 PNG' : ''}`,
    );
    console.log(
      `  首台：${rows[0].deviceId}（广播名 ${rows[0].broadcastName}，绑定码 ${rows[0].bindCode}）`,
    );
    console.log(`  二维码内容形如：${rows[0].qrContent}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('批量开通失败：', err instanceof Error ? err.message : err);
  process.exit(err instanceof Error && err.message.includes('用法') ? 2 : 1);
});
