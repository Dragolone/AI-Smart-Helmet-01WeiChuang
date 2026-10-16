# 后端镜像（构建 context = 仓库根，见 deploy/docker-compose.prod.yml）
# 单阶段：镜像含 devDependencies 与源码——刻意为之，MVP 换的是省心：
#   ① provision:device / create:admin 脚本走 tsx（devDep），运维开通设备要用；
#   ② prisma migrate deploy 需要 CLI 与 schema；
#   ③ 免去多阶段裁剪 node_modules 符号链接/native 模块的坑。镜像偏大（GB 级），2C4G 磁盘无压力。
FROM node:24-slim

# openssl/ca-certificates：Prisma schema engine 与 TLS 出站；python3/make/g++：bcrypt 预编译包下载失败时的兜底编译链
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# 清单层单独 COPY：源码改动不触发重新 npm ci（.dockerignore 已把 app/mock-device 瘦成仅 package.json）
COPY package.json package-lock.json .nvmrc ./
COPY backend/package.json backend/
COPY packages/shared/package.json packages/shared/
COPY admin/package.json admin/
COPY app/package.json app/
COPY mock-device/package.json mock-device/

# --ignore-scripts：此时 shared 源码未拷入，其 prepare(build) 必失败；native 模块的 install 脚本延后到 rebuild 补跑
RUN npm ci -w backend -w packages/shared --ignore-scripts

COPY packages/shared/ packages/shared/
COPY backend/ backend/

# rebuild 补跑被跳过的 install 脚本（bcrypt 预编译二进制、prisma engines）；随后按依赖序构建
RUN npm rebuild bcrypt @prisma/engines \
 && npm run build -w packages/shared \
 && npm run build -w backend

ENV NODE_ENV=production
WORKDIR /repo/backend
EXPOSE 3000

# 每次启动先应用未执行的 migration（幂等），再起服务——CLAUDE.md「Migration 必须能在空库从头跑通」的运行时兑现。
# 必须 exec：镜像里的 sh 是 dash，不 exec 的话它一直当 PID 1、不转发 SIGTERM，docker stop 等满 stop_grace_period
# 后 SIGKILL——/health 503 排空、在途请求、通知投递的收尾全都不执行（2026-10-17 云端实测 PID 1 是 sh）
CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/main"]
