// 管理员账号创建脚本：API.md §10 定稿——管理员由种子脚本创建，不做自助注册。
// 用法：npm run create:admin -w backend [-- <username>] [-- --reset]
//   已存在同名管理员时报错退出；加 --reset 则重置该账号密码。
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcrypt';
import { PrismaClient } from '../src/generated/prisma/client';

const BCRYPT_ROUNDS = 10;

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const reset = args.includes('--reset');
  const username = args.find((a) => !a.startsWith('--')) ?? 'admin';

  // 密码只由脚本生成（不接受命令行传入，避免留在 shell history）
  const password = randomBytes(12).toString('base64url');
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    const existing = await prisma.adminUser.findUnique({ where: { username } });
    if (existing && !reset) {
      console.error(
        `管理员 ${username} 已存在。如需重置密码：npm run create:admin -w backend -- ${username} --reset`,
      );
      process.exit(1);
    }
    if (existing) {
      await prisma.adminUser.update({
        where: { username },
        data: { passwordHash },
      });
    } else {
      await prisma.adminUser.create({ data: { username, passwordHash } });
    }
    console.log(
      `管理员${existing ? '密码已重置' : '创建成功'}（密码只显示这一次，立即保存到密码管理器）：`,
    );
    console.log(`  USERNAME = ${username}`);
    console.log(`  PASSWORD = ${password}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('创建失败：', err instanceof Error ? err.message : err);
  process.exit(1);
});
