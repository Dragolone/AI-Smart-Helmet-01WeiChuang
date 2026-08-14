import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// CI 无数据库也要能跑 prisma generate（generate 不连库），所以不用会抛错的 env() 助手；
// 需要真连库的命令（migrate 等）在占位符下会以“连接失败”显式报错，不会静默误用。
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://placeholder:placeholder@localhost:5432/placeholder';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: databaseUrl,
  },
});
