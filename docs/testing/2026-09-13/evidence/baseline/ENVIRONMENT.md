# 本轮环境与基线记录（2026-09-13，主代理）

## 版本与工作区
- 时间（UTC）：2026-09-13 09:01 开始
- HEAD：2295eef9a132bdf04ea00c8ae1f6bce6d4c057ac（main）；`git diff --stat` 无已跟踪改动
- 未跟踪文件（保留、未动）：`backend/prisma/migrations/20260908144829_sms_codes/migration 2.sql`、`backend/src/auth/sms-code.service 2.ts`（**内容为旧版本**：缺 change_phone 用途）、`backend/src/auth/sms-code.service.spec 2.ts`、`backend/src/providers/tencent-sms.provider 2.ts`、`backend/test/helpers/register 2.ts`、`docs/CLAUDE_FULL_TEST_PROMPT.md`、`docs/hardware/BLE通信协议手册-v0.6 2.html`
- **已跟踪的杂散副本**（已提交进仓库）：`backend/prisma/migrations/20260815054823_raw_events_source_clock_skew/migration 2.sql`、`app/assets/expo.icon/Assets/expo-symbol 2.svg`
- node_modules 内 iCloud 副本：`npm ls` 报 44 个 `<pkg> 2@ extraneous`，`find node_modules -maxdepth 2 -name '* 2'` 计 383 个目录
- OS：macOS 26.6.2（Darwin 25.6.0，arm64），14 核 / 48GB
- Node：终端默认 v25.9.0（npm 11.12.1）；`nvm use 24` → v24.19.0（npm 11.17.0）；`.nvmrc`=24；本轮所有命令在 Node 24 下执行
- Docker 28.4.0（启动时守护进程未运行，本轮由主代理 `open -a Docker` 拉起）
- 本机 3000/5432/1883/18083/5173 端口开始时均空闲；Homebrew 只有 postgresql@14（未使用），PG16 用容器

## 隔离资源（label helmet-audit=0913）
- `helmet-audit-0913-pg`：postgres:16，127.0.0.1:55432，用户 audit；库：helmet_audit（E2E 基线）、helmet_audit_{sos,auth,ingest,admin,dbops,perf,mqtt,voice,v1,v2,v3,v4}（各代理专用），全部经 `prisma migrate deploy` 从空库迁移（16 个 migration）
- `helmet-audit-0913-emqx`：emqx:5，127.0.0.1:51883 / Dashboard 58083；配置为仓库 `emqx/emqx.conf` 副本，回调改指 `host.docker.internal:3100`，内部 token 改为本轮专用值
- 环境变量模板：scratchpad `audit.env`（专用 JWT/ADMIN/内部 token/Webhook Key/占位 TRTC Key；**未配置 TENCENT_SMS_***，短信恒为 Console Mock；Push/Storage 为 Console/Mock）
- 清理：`docker rm -f helmet-audit-0913-pg helmet-audit-0913-emqx`（无卷）

## 基线命令结果（Node 24，scratchpad/baseline/*.log 已复制到本目录）
| 步骤 | 结果 | 备注 |
|---|---|---|
| build @helmet/shared | ✅ | |
| typecheck backend/app/admin/mock-device/shared | ✅ 全绿 | app 的 `.expo/types/router.d.ts` 为 2026-09-12 生成，未过期 |
| lint backend | ❌ 1 error / 358 warning | 唯一 error 在杂散副本 `src/auth/sms-code.service.spec 2.ts:46`；warning 全为测试文件 `any` |
| lint app / admin | ✅ | expo lint 0 error（本机） |
| test backend（单测） | ✅ 8 套件 86 用例 | |
| test app（单测） | ✅ 3 套件 16 用例 | |
| test:cov backend | 语句 21.06% / 分支 20.17% / 函数 13.89% | 分母=src 全部 .ts（含未被 import 的业务文件，collectCoverageFrom `**/*.(t|j)s`）；仅单测口径 |
| test app --coverage | 语句 81.25% / 分支 68.75% | **分母只含被 import 的 3 个文件**（coords.ts、ble-relay*.ts），不代表 App 整体 |
| build backend | ✅ | dist 内混入杂散副本 `auth/sms-code.service 2.js`、`sms-code.service.spec 2.js`、`providers/tencent-sms.provider 2.js`（tsconfig 无 include 白名单） |
| build admin | ✅ | 单 chunk 1.1MB 警告 |
| prisma migrate deploy（空库） | ✅ 16/16 | 隔离库 helmet_audit |
| test:e2e（隔离库） | ✅ 25 套件 227 用例，67 秒 | 脚本固定 `RATE_LIMIT_DISABLED=1` + `--forceExit`；MQTT_URL 指向死端口（等价 CI 无 Broker），日志有持续 ECONNREFUSED 噪声 |

## 既有 E2E 全量覆盖率（本轮补跑，2026-09-13 14:11Z；配置 `jest-e2e-cov.json`，日志 `e2e-cov.log`，摘要 `e2e-coverage/coverage-summary.json`）
- 分母：`backend/src/**/*.ts`，排除 `generated/**`、`*.spec.ts`、杂散 `* 2.ts`、`main.ts`（bootstrap，e2e 不经过）；不含本轮新增 `audit-*` 用例
- 结果：语句 **92.35%** / 分支 **77.78%** / 函数 93.83% / 行 92.97%（25 套件 227 用例全过）
- 最低文件：`ingest/mqtt-consumer.service.ts` 41%（e2e 无 Broker，订阅/重试/PUBACK 路径只靠真实进程测试覆盖）、`providers/tencent-sms.provider.ts` 61%（真发分支未触达）、`health.controller.ts` 67%（503 分支）、`common/rate-limit.guard.ts` 80%、`ingest/ingest.service.ts` 82%
- 分支覆盖最低目录：`providers` 21.9%（腾讯云短信分支）、`emqx` 68%、`voice` 71%
