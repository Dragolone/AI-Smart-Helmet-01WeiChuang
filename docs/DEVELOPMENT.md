# DEVELOPMENT.md — 本地开发环境与常用命令

## 一次性环境安装（macOS）

1. **VS Code**：https://code.visualstudio.com 下载安装（日常写代码都在这里），并在扩展商店安装 **Claude Code** 插件（或直接在终端运行 `claude`）。用 Cursor 也可以，任选其一。
2. **Xcode**：Mac App Store 安装 → 打开一次 → 组件只勾选 iOS → 等待安装完成。仅作 iOS 构建工具链，平时不用打开。
3. **Android Studio**：https://developer.android.com/studio 下载 Mac Apple 芯片版 → 首次打开选 Standard → License 全部 Accept → 等 SDK 装完即可关闭。仅作 Android SDK/工具链。
4. **Homebrew**：https://brew.sh 按首页命令安装。
5. **命令行工具**：`brew install watchman cocoapods gh`
6. **nvm + Node 24**：
   ```bash
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
   # 重开终端后：
   nvm install 24
   ```
7. **Docker Desktop**：https://docker.com 下载安装（本地跑 PostgreSQL + EMQX）。
8. **JDK 17**（Android 原生构建必需）：`brew install --cask temurin@17`，并在 shell 配置（`~/.zshrc`）加 `export JAVA_HOME=$(/usr/libexec/java_home -v 17)`。⚠️ 系统默认 Java 为 24/25 时 React Native 原生构建必定失败（JEP 472 限制），报错信息极具误导性：`A restricted method in java.lang.System has been called`——看到它先查 Java 版本。

## 克隆与安装

**⚠️ 仓库必须放在不含空格和中文的路径下**（例如 `~/Desktop/AI-Smart-Helmet-01WeiChuang`）。iOS 原生构建脚本无法处理带空格/中文的路径，会在编译末期报 `No such file or directory` 失败。

```bash
git clone <仓库地址>
cd AI-Smart-Helmet-01WeiChuang
nvm use          # 切到 .nvmrc 锁定的 Node 24
npm install      # 根目录一次装完所有 workspace（唯一 lockfile 在根目录）
```

**规则：只在仓库根目录跑 `npm install`。禁止在子目录用 yarn/pnpm，禁止生成第二个 lockfile。**

## 本地基础设施

```bash
docker compose up -d     # 启动 PostgreSQL(5432) + EMQX(1883, Dashboard 18083)
docker compose down      # 停止
```

- PostgreSQL 本地凭证：`helmet / helmet_local_dev`，库名 `helmet`（仅本地开发用）。
- EMQX Dashboard：http://localhost:18083（默认 admin/public）。

**首次启动后端前**（一次性）：

```bash
cp backend/.env.example backend/.env
# 编辑 backend/.env，按上面的本地凭证组装 DATABASE_URL：
# DATABASE_URL=postgresql://helmet:helmet_local_dev@localhost:5432/helmet
cd backend && npx prisma migrate dev   # 建表（要求 docker 里的 postgres 已启动）
```

- 后端起来后访问 http://localhost:3000/api/v1/health 应返回 `{"status":"ok","database":"connected"}`。
- 数据库表结构改动一律通过 `npx prisma migrate dev --name <名字>`（backend 目录）生成 migration，禁止手改库。

**已知坑：`prisma generate` / `migrate` 与后端 watch 进程抢文件**——生成器重写 `src/generated` 时可能把正在跑的 `start:dev` 绊倒（表现为后端悄悄退出、接口拒绝连接、或启动报 `Cannot find module dist/main`）。处理：停掉 start:dev → `rm -rf backend/dist backend/tsconfig.build.tsbuildinfo` → 重新 `npm run start:dev -w backend`。建议习惯：跑 generate/migrate 前先停后端。

## 常用命令（都在仓库根目录执行）

| 目的 | 命令 |
|------|------|
| 启动 App 开发服务器（日常 JS 开发） | `npm run start -w app` 后**在模拟器里手动点开已安装的 app**。⚠️ 不要按 `i`/`a`、不要扫码——当前 app 未装 expo-dev-client，那样会进被禁止的 Expo Go。首次或原生依赖变更后先用下面的 run 命令装一次 |
| 启动 Mock 头盔模拟器 | `npm run start -w mock-device`（需 EMQX 和后端已启动；Ctrl+C 停止；DEVICE_ID/间隔可用环境变量覆盖） |
| App 装到 iOS 真机/模拟器（含原生构建） | `npx expo run:ios`（在 `app/` 目录） |
| App 装到 Android 真机/模拟器（含原生构建） | `npx expo run:android`（在 `app/` 目录） |
| 启动后端（热重载） | `npm run start:dev -w backend` |
| 启动管理后台 | `npm run dev -w admin` |
| 全部类型检查 | `npm run typecheck --workspaces --if-present` |
| 全部 lint | `npm run lint --workspaces --if-present` |
| 全部测试 | `npm test --workspaces --if-present` |

原生构建（`expo run:ios/android`）只在首次和新增原生模块后需要；日常改代码保存即热更新（Fast Refresh）。

## 真机调试

- **iPhone**：设置 → 隐私与安全性 → 开发者模式 → 打开并重启；用数据线连 Mac，首次需在手机上信任此电脑。
- **Android**：设置 → 关于手机 → 连点「版本号」7 次开启开发者选项 → 打开「USB 调试」；连线后允许调试授权。

## 平台限制清单（持续维护）

> 记录 Week 2 Spike 及后续开发中实测到的 iOS / Android 系统限制。禁止静默降级——任何限制先记录在此并与负责人确认口径。

| 日期 | 平台 | 能力 | 实测限制 | 口径/结论 |
|------|------|------|---------|----------|
| 2026-08-15 | iOS | 签名/推送 | 个人免费开发团队无法签 `aps-environment`（远程推送）entitlement；同一 Bundle ID 无法注册到第二个个人团队（`com.dravenzhong.helmet` 已归属队友团队，另一台 Mac 开发期临时用 `com.zixim.helmet.spike`） | 开发期两人各用独立 Bundle ID；APNs 验证与签名统一等公司 Apple Developer 账号（待负责人确认） |
| 2026-08-15 | Android（华为无 GMS） | 定位 | 冷启动首次锁星需 1–2 分钟，一次性 `getCurrentPositionAsync` 长时间挂起无反馈；锁星后 watchPosition 每 2s 稳定更新、精度可到 5m | 定位功能一律用持续监听 + 中间状态展示，禁止一次性等待（待负责人确认口径） |
| 2026-08-15 | iOS + Android | RTC（TRTC） | 双机对讲互通、锁屏后台音频（iOS 已配 `UIBackgroundModes: audio`）、蓝牙耳机路由，双端真机全部通过 | 无限制发现；支撑 TRTC 选型定案（待负责人确认） |
| 2026-08-15 | iOS + Android | BLE 后台 | 前台扫描/连接/断连检测双端通过；**后台断连检测未测** | Week 11 防丢开发前必须实测：iOS `bluetooth-central` 后台模式 + 华为激进杀后台 |
