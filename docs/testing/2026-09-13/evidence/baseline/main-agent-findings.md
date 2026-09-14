# 主代理直接确认的发现（环境 / 仓库卫生 / 测试基建）

| ID | 严重度 | 状态 | 现象 | 影响 | 建议 |
|---|---|---|---|---|---|
| HYG-01 | P3 | CONFIRMED(static) | 已提交进仓库的 iCloud 杂散副本：`backend/prisma/migrations/20260815054823_raw_events_source_clock_skew/migration 2.sql`、`app/assets/expo.icon/Assets/expo-symbol 2.svg`（`git ls-files` 可见） | Prisma 只读 `migration.sql`，迁移不受影响；但 migration 目录含非法文件违背「已合并 migration 不可编辑」精神，易误导后续 rebase | 单独 `chore:` PR 删除两文件（不改 migration.sql） |
| HYG-02 | P3 | CONFIRMED(baseline) | 未跟踪副本 `src/auth/sms-code.service 2.ts`（**旧版本，缺 change_phone**）、`sms-code.service.spec 2.ts`、`providers/tencent-sms.provider 2.ts`、`common/nul.guard 2.ts`、`test/helpers/register 2.ts` 被 tsconfig（无 include 白名单）纳入 typecheck/lint/`nest build`：本机 lint 1 error，dist 混入 `* 2.js` | 本机 `npm run lint` 红；dist 体积/混淆；若误 import 旧版会丢 change_phone 用途。CI 不受影响（未跟踪） | 仓库移出 iCloud 同步目录（DEVELOPMENT.md 已记 codesign 坑）；tsconfig 加 `include: ["src", "test", ...]` 或 `exclude: ["**/* 2.ts"]`；`.dockerignore`/`.gitignore` 加 `* 2.*` |
| ENV-01 | P3 | CONFIRMED | `node_modules` 内 383 个 `<name> 2` 目录、`npm ls` 44 个 extraneous | 解析歧义风险、磁盘浪费；`npm ci` 会清掉 | 同上：移出 iCloud 或 `rm -rf node_modules && npm ci` |
| ENV-02 | P3 | CONFIRMED | 终端默认 Node 25.9.0，`.nvmrc`=24 | 与 CI 不一致的假阳性/假阴性 | 本轮全部 `nvm use 24`；建议 shell 自动 `nvm use` |
| TEST-01 | P2 | SUSPECTED | `test:e2e` 脚本固定 `RATE_LIMIT_DISABLED=1` + `--forceExit` | 限频只在 hardening-auth 的 `withRateLimit` 局部开启（login/sms/…有覆盖）；`--forceExit` 掩盖退出句柄泄漏 | 见 mqtt 代理 `--detectOpenHandles` 结果；建议 CI 增加一条不带 forceExit 的小套件 |
| COV-01 | P3 | CONFIRMED | App 覆盖率 81% 分母仅 3 个被 import 文件 | 不代表 App 整体 | jest 配 `collectCoverageFrom: ['src/**/*.{ts,tsx}']` 得真实分母 |
| COV-02 | P3 | CONFIRMED | 后端单测覆盖 21%（分母 src 全部）；既有 e2e 全量覆盖 92.35% 语句 / 77.78% 分支（分母同上，排除 generated/spec/main.ts） | 业务覆盖主要靠 e2e，mqtt-consumer 仅 41%（无 Broker） | 把 e2e 覆盖率纳入 CI 报告 |

既有测试质量核查：25 个 e2e 套件无 `skip/only/todo`；hardening 套件 console 输出均伴随 expect（唯一只打印不断言的是「找回密码后旧 access token 15 分钟内仍有效」= API.md §2 设计窗口）。
