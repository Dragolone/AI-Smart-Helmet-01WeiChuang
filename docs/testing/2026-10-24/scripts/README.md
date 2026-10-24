# 2026-10-24 这轮用到的脚本（都在本机 scratchpad 跑，这里归档供下次复用）

| 脚本 | 用途 | 跑法 |
|---|---|---|
| `mqtt-matrix-v2.mjs` | 真实 EMQX + 真实后端的认证 / ACL / 消息层矩阵（#239 之后 `deny_action = disconnect` 口径，取代 09-13 的 `auth-acl-matrix.mjs`） | 先 `provision:device` 开通 `audit_mqtt_a` / `audit_mqtt_b`，`WT=<仓库根> MQTT_URL=mqtt://127.0.0.1:1883 DATABASE_URL=… MQTT_BACKEND_USERNAME=… MQTT_BACKEND_CLIENT_ID=backend_ingest audit_mqtt_a_DEVICE_ID=… audit_mqtt_a_DEVICE_SECRET=… audit_mqtt_b_… node mqtt-matrix-v2.mjs` |
| `fuzz.mjs` | 按后端启动日志里的路由表对每条路由打畸形路径参数 / 查询串 / 请求体，只报 5xx 与无 `code` 的错误体 | 把启动日志的 `Mapped {…}` 行整理成 `routes.txt`（`路径, 方法` 一行一条）放在脚本同目录的上一级；`TEST_PASSWORD=… ADMIN_PW=… node fuzz.mjs` |
| `chain-setup.mjs` | 注册 / 登录测试账号、绑定 Mock 头盔、加紧急联系人、开 WS 把推送记到 `ws-messages.jsonl` | `TEST_PASSWORD=… DEVICE_ID=… BIND_CODE=… WS_SECONDS=150 node chain-setup.mjs`（验证码从后端日志的 `[MOCK SMS]` 行读） |
| `android-login.sh` / `android-tap.sh` | 安卓模拟器上用 `uiautomator dump` 找控件再点（登录页带提示框时位置会变，不能写死坐标） | `TEST_PASSWORD=… ./android-login.sh`；`./android-tap.sh "退出登录"` |
| `soak-sample.sh` / `longsoak-sample.sh` | 每 1 / 2 分钟记双端 App 内存、安卓崩溃数、后端 RSS、PG 连接、EMQX 内存、事件总数 | 改里面的模拟器 UDID 后直接跑 |

脚本里的路径是当次 scratchpad 的绝对路径，复用时先改。
