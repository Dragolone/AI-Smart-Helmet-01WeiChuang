# AI 智能头盔 — 软件系统

AI 智能头盔的软件部分：用户 App、云端后端、管理后台。硬件与算法由其他团队负责，本系统只接收其最终结果并完成业务流程。

## 项目结构

```text
app/            React Native App（Expo Development Build + Expo Router，Android + iOS）
backend/        NestJS 后端（模块化单体：REST + WebSocket + MQTT 消费）
admin/          管理后台（React + Vite + Ant Design）
mock-device/    Mock 设备模拟器（与真机同协议，发 MQTT）
packages/shared TS 共享类型（事件 Schema、API DTO、枚举）
docs/           Contract 与决策文档（EVENTS / DEVICE_PROTOCOL / DECISIONS 等）
```

## 开发前必读

1. `CLAUDE.md` — 项目全部开发约定（架构、规范、流程、双端要求）。
2. `docs/DECISIONS.md` — 已拍板的技术决策，不允许无理由推翻。

## 环境要求

- Node 24 LTS（仓库根 `.nvmrc` 锁定，`nvm use` 切换）
- Docker（本地 PostgreSQL + EMQX，经 `docker-compose.yml`）
- Xcode（iOS 构建）+ Android Studio（Android SDK）

安装与本地启动步骤见 `docs/DEVELOPMENT.md`（Week 1 逐步补全）。
