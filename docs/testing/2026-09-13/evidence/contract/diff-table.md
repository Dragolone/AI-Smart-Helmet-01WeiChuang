# Contract 一致性差异表（2026-09-13，HEAD 2295eef）

列：文档 / shared 类型 / 实现 / 测试。「建议以…为准」= 应修哪一方；不自行改预期迎合实现。

| # | 项 | 文档 | shared | 实现 | 测试 | 谁与谁不一致 | 建议以谁为准 |
|---|----|------|--------|------|------|-------------|-------------|
| CONTRACT-01 | change-password newPassword 字节上限 | API.md §2 "与注册同规则（8–72）"+login 行 "≤72 字节" | ChangePasswordRequest 无注释 | auth.dto.ts:104-107 只 @MaxLength(72)（字符），无 @MaxBytes | audit-contract ✕（204 / 截断后登录 200） | 实现≠文档；旧报告 #11 只落在 register/reset | 文档（加 @MaxBytes(72)） |
| CONTRACT-02 | 未知 schemaVersion | EVENTS.md §1/§9、DEVICE_PROTOCOL §9 "未知版本进原始事件表并告警，不进业务流程" | CURRENT_SCHEMA_VERSION=1 | envelope.ts 只查整数/范围；ingest.service.ts:78-127 不比对版本即 dispatchStored | audit-contract ✕（schemaVersion=999 possible_fall 建了 SOS） | 实现≠文档 | 文档（≠1 → _invalid 留档 reason=schema_version_unsupported 并告警） |
| CONTRACT-03 | battery-history 归属范围 | API.md §4:93 只列 §5/§6/§9 按绑定区间；决策 #39/DATABASE.md 口径为「设备历史数据按绑定区间」 | BatteryHistoryResponse | devices.service.ts:184-195 直查 raw_events，无 BindingScope，按设备 timestamp 而非 receivedAt | audit-contract ✕（新主看到前主 77% 点；同设备 events 已过滤为 0） | 实现 与 决策 #39 不一致；API.md 未覆盖 | 决策 #39（加 scopeWhere('receivedAt')），API.md §4 补一句 |
| CONTRACT-04 | PUT /devices/{id}/settings 响应类型 | API.md §8 `202 { commandId, status:"pending" }` | 无对应类型 | commands.service.ts:203 返回 {commandId,status} | audit-contract ✓（实测只有两键） | App devices.ts:50-54 标 `api<CommandPublic>` 过宽 | 文档/实现（shared 增 PutSettingsResponse，App 改用） |
| CONTRACT-05 | 频道成员对象 | API.md §13:239 `{ userId, nickname, avatarUrl, phone }` | VoiceChannelMemberPublic 含 joinedAt | voice.service.ts:150-158 返回 joinedAt | audit-contract ✓ | 文档漏 joinedAt | shared/实现（补文档） |
| CONTRACT-06 | AdminDeviceRow / AdminDeviceDetail | API.md §10.1 item 无 name/bindCode | `AdminDeviceRow extends DevicePublic` → name/bindCode 必有 | admin.service.ts:92-126、172-200 不返回 name/bindCode | audit-contract ✓（行内无这两键） | shared≠文档/实现 | 文档/实现（shared 改为显式字段或 Omit） |
| CONTRACT-07 | /health 503 响应体 | API.md §1.2 `503 { status:"error", database:"unreachable" }` | — | health.controller.ts:15-18 抛 ServiceUnavailableException(body)，但 UnifiedExceptionFilter 只输出 {code,message,requestId}（http-exception.filter.ts:46-64） | audit-contract ✕（实测 `{code:"SERVICE_UNAVAILABLE",message:"Service Unavailable Exception",requestId}`） | 实现≠文档 | 二选一：文档改为统一错误格式（推荐，探活只看状态码）或控制器直接 res.status(503).json |
| CONTRACT-08 | BLE 帧→envelope 翻译规则（静态） | DEVICE_PROTOCOL §1.2 翻译规则；EVENTS.md 4.2 accuracy/speed/heading 必填、heading 0–360 | LocationUpdatePayload 全必填 | 手册 v0.6：heading 无效 0xFFFF、accuracy 无定位 0xFF、altitude 无效 0x7FFF；risk_cleared 载荷=Event_Seq(4B，全 0=清全部)；possible_fall/manual_sos/collision 额外原始字段（冲击力/倾角/触发方式/按键时长/TTC/逼近速度 km/h）；location-recorder.service.ts:33-37 对 heading>360 整点丢弃 | 无（App 解析器未实现） | 文档（§1.2/EVENTS.md）未定义哨兵映射与额外字段 | 先定文档：哨兵→字段缺省/可选（需改 EVENTS.md 4.2 必填口径或给定回落值），risk_cleared Event_Seq→clearedEventId(v5) 与全 0→缺省，额外字段登记为选填 |
| CONTRACT-09 | App 错误码文案映射 | API.md §1.1 "客户端只依赖 code" | — | app/src/api/error-messages.ts:8-23 缺 EMERGENCY_CONTACT_LIMIT_REACHED / SOS_ALREADY_FINALIZED / CHANNEL_FULL / TRTC_NOT_CONFIGURED / MEDIA_NOT_READY / NOT_FOUND / PAYLOAD_TOO_LARGE / FORBIDDEN / CONFLICT；app/src 无页面单独处理这些 code | 无 | App≠文档 | 补映射 |
| CONTRACT-10 | App auth.ts 本地重复类型 | — | shared 已有 SmsCodePurpose/ChangePasswordRequest(refreshToken?)/ChangePhoneRequest/DeleteAccountRequest | app/src/api/auth.ts:1-34 本地重定义（refreshToken 必填）且注释「待 shared 同步后切回」已过时 | — | App≠shared | shared |
| CONTRACT-11 | §1.1 错误码表完整性 | 表内 FORBIDDEN/CONFLICT 仅作兜底、无显式抛出；SERVICE_UNAVAILABLE 兜底码（filter:21）未列；各节自有码未汇总 | — | grep 实现共 20 个 code | — | 文档表不全 | 文档补 SERVICE_UNAVAILABLE 与各节码索引 |
| CONTRACT-12 | relay-ack executedAt | API.md §8 "缺省取服务器时间" | RelayAckRequest.executedAt?: string | RelayAckDto @IsString 无 ISO 校验；非法值静默以服务器时间兜底（commands.service.ts:230-238） | commands-relay e2e 未覆盖非法值 | 文档未说明非法值行为 | 文档补一句或 DTO 加 @IsISO8601 |
| CONTRACT-13 | 根路由 GET /api/v1/ | 未文档化 | — | app.controller.ts @Public getHello | — | 实现多出 | 文档登记或删除 |
| CONTRACT-14 | objectType 未知值 | EVENTS.md 4.5 "按 unknown 落库并告警" | RiskObjectType | ingest.service.ts:162-172 原样留档 + warn（不改写为 unknown） | — | 文档≠实现 | 实现（原样留档更符合留档原则）→ 改文档措辞 |
| CONTRACT-15 | CLAUDE.md 头部「找回密码页归 A 线（待办 ④）」 | CLAUDE.md | — | app/src/app/(auth)/reset-password.tsx 已存在；weekly-plan:247 标 ✅ 完成 | — | CLAUDE.md 过时 | 更新 CLAUDE.md |

## 已核对一致（抽样）
- 路由清单：API.md §1.2/§2/§3/§4/§5/§6/§7/§8/§9/§10.1/§12/§12.1/§13 全部端点在 backend/src/**/\*.controller.ts 存在，方法/路径一致；HttpCode：sms-code/reset/change-password/logout/unbind/contact delete/leave 204；bind/login/refresh/change-phone/join/token/cancel/confirm/relay-ack 200；settings PUT/webhook/app-relay 202。DEVICE_PROTOCOL §3.1 internal/emqx 两端点存在。
- 分页：所有 PageQueryDto page≥1、pageSize 1–100 默认 20，响应 {items,total,page,pageSize}。
- 限频规则表（API.md §2）与 auth.controller.ts / admin-auth.controller.ts 逐条一致；sms-code 规则（6 位/300s/60s/日 10/错 5 次）与 sms-code.service.ts 一致；SmsCodePurpose 三值一致。
- 常量：SOS 60s（sos.constants.ts）、命令超时 30s（commands.constants.ts）、在线窗口 90s（devices.service.ts:14）、媒体 URL 600s、联系人 5、频道 20、app-relay ≤100 + 7 类型（app-relay.controller.ts）、settings ≤20 键。
- WS：六类 type 与 shared WsMessageType 一致；data 形状与 WsLocationData/WsDeviceStatusData/EventDetail/EventListItem/WsDeviceCommandData 一致；4401 + exp 定时关闭已实现。
- envelope.ts 与 EVENTS.md §1/§2 值域一致（int32、年份≥1970、日历、时区、NUL、64KB）；device_status signalLevel 0–4；location 六字段必填校验；possible_fall location 可选（sos-trigger.service.ts:23）。
- mock-device：topic helmet/{id}/{status,location,event,cmd,cmd_ack}、QoS 1、cmd_ack {commandId,result,errorCode?,executedAt}、eventId UUID v4、relay 批 ≤100、7 类过滤——与 DEVICE_PROTOCOL §4–§7 / API.md §12.1 一致。
- DEVICE_PROTOCOL §1.2 摘要 vs 手册 v0.6：FEE0/FEE1/FEE2、MTU 247、4–25B、事件代码 0x01–0x07 与载荷长度（11/11/15/15/4/15/2）、ACK 1.5s×3、0x20–0x2D/0x34/0x40/0x50 地址、广播名一致；已知 3 处文档级修正（例 4 地址、握手读两段、补传范围）与 §10 第 1 条记录一致。
- CLAUDE.md 声明核对：App 已接 WS device_command + relay-ack（use-realtime.ts:82-85 → ble-relay.ts）✓；APNs 未接（仅 spike-push.tsx）✓；Admin §10.2 清零（7 端点 + admin 页面全部使用）✓。
