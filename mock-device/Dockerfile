# 演示常驻 Mock 头盔镜像（构建 context = 仓库根，见 deploy/docker-compose.prod.yml）
# 与本地 `npm run start -w mock-device` 完全同一份代码、同 Contract、同 MQTT 认证——对 Backend 而言与真机不可区分（CLAUDE.md Mock Data Strategy）
FROM node:24-slim
WORKDIR /repo

# 清单层单独 COPY：源码改动不触发重新 npm ci
COPY package.json package-lock.json .nvmrc ./
COPY mock-device/package.json mock-device/
COPY packages/shared/package.json packages/shared/
COPY backend/package.json backend/
COPY admin/package.json admin/
COPY app/package.json app/

# --ignore-scripts：shared 源码未拷入时其 prepare(build) 必失败，下面显式 build
RUN npm ci -w mock-device -w packages/shared --ignore-scripts

COPY packages/shared/ packages/shared/
COPY mock-device/ mock-device/

RUN npm run build -w packages/shared

ENV NODE_ENV=production
WORKDIR /repo/mock-device
CMD ["npm", "run", "start"]
