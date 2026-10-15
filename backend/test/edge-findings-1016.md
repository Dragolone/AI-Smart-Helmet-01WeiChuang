# 后端边界测试发现（2026-10-16）

> 范围：本地 PostgreSQL + 完整应用（与 main.ts 同管线），`test/edge-*.e2e-spec.ts` 十四个套件。
> 不涉及云端 dev、不发真短信 / 推送。10-15 云端那一轮（S1–S5、F1–F27）不重复。
> 失败的测试一律没有提交到 `test/backend-edge-1016`（CI 必须绿）；B1–B6、B8 的复现测试和修复在 `fix/backend-edge-1016`（叠在测试分支之上，只推分支不合并，后端归 Draven 审）。

## 严重度口径

- **高**：保命链路丢单 / 错发，或越权成功、数据损坏
- **中**：行为与文档冲突、保命链路信息错误、隐私口径（决策 #39）被绕过、可稳定触发的 500
- **低**：口径不一致、误导性展示、需要负责人 / Draven 定的契约问题

## 发现清单

| 编号 | 严重度 | 一句话 | 修复分支 |
|------|--------|--------|----------|
| B1 | 中 | 所有分页接口 `page` 没有上限：`page=1e20` → 500 INTERNAL_ERROR（ERROR 日志带堆栈） | 有 |
| B2 | 中 | SOS 位置快照回落到最新轨迹点时不排除 (0,0)：联系人短信里位置是 `0.00000,0.00000` | 有 |
| B3 | 中 | SOS 位置快照回落不按绑定区间（决策 #39）：换绑后新主人的事故位置 / 短信用的是前主人的最后位置 | 有 |
| B4 | 中（潜在高） | envelope `timestamp` 小数秒超过 3 位（如 `.123456Z`）整条判 invalid：这样的 possible_fall 不建单 | 有 |
| B5 | 低 | 未知 schemaVersion、未知 eventType 的事件出现在 App 事件历史和详情里（schemaVersion=999 的摔倒显示「疑似摔倒」但没建单）；未知 eventType 入库时也没有告警日志 | 有 |
| B6 | 低 | `DELETE /users/me` 的 password 没有 72 字节上限：超过 72 字节、前 72 字节对就能注销（改密 / 换号 / 登录都按字节拒） | 有 |
| B7 | 低 | `PATCH /devices/{id}` 不传 `name`（空对象）也会把自定义名清空 | 无（契约要定） |
| B8 | 低 | EMQX 认证回调 `username` / `password` 不是字符串时 500（带 ERROR 堆栈）；只有持内部令牌的调用方能触发，结果从不为 allow | 有 |

---

### B1 分页 page 无上限 → 500

- **现象**：`GET /devices/{id}/events?page=1e20`（以及 locations / accidents / commands / admin 全部列表）返回 `500 INTERNAL_ERROR`。`page=1e20` 能过 `@IsInt()`（`Number.isInteger(1e20) === true`），`skip = (page-1) × pageSize ≈ 2e21` 超出 Prisma / PostgreSQL 的 int8，查询抛错。
- **复现**：`curl '/api/v1/devices/<自己的设备>/events?page=1e20' -H 'Authorization: Bearer …'` → 500；`page=9007199254740993`、`page=1e15` 是 200（skip 还在 int8 内）。
- **期望**：API.md §1「统一错误格式」——参数问题应 400 VALIDATION_FAILED；现有用例要求 `page=2147483647` 为 200（hardening-sos「分页极值」）。
- **位置**：`backend/src/common/page-query.dto.ts`（所有列表 DTO 都继承它）。
- **修法**：`page` 加 `@Max(2_147_483_647)`。int4 上限，保留现有 `page=2147483647 → 200` 的口径，`2147483648` 起 400。

### B2 SOS 快照回落取到 (0,0)

- **现象**：头盔没定到位时上报 `location_update`（0,0）（GPS 模组常见哨兵，10-15 F15），随后的 possible_fall 不带位置 → 快照回落到这条 (0,0) 点，`locationSource=last_point`；到期 / 确认后短信 `locationText` 为 `0.00000,0.00000`，事故详情地图钉在几内亚湾。
- **复现**：app-relay 先投 `location_update {latitude:0, longitude:0, …}`，再投 `possible_fall {confidence:0.9}` → `sos_cases.latitude = 0, longitude = 0, location_source = 'last_point'`。
- **期望**：代码本身已写明口径——`extractSosLocation` 对事件内嵌 (0,0)「按缺失处理，回落最新轨迹点，否则事故地点会被钉在赤道上」；回落这一步同样应跳过 (0,0)，都没有就空快照（短信写「暂不可用」）。
- **位置**：`backend/src/sos/sos-trigger.service.ts` `resolveSnapshot()` 的 `locationPoint.findFirst`。
- **修法**：查询条件加 `NOT: { latitude: 0, longitude: 0 }`（两者同时为 0 才排除），找更早一个真实点。

### B3 SOS 快照回落不按绑定区间

- **现象**：A 用过的头盔留有轨迹点；A 解绑、B 绑定；B 的 `GET …/locations/latest` 正确返回 `null`（决策 #39），但 B 的头盔摔倒（事件不带位置）时，快照回落到 A 期间的最后一个点：B 的事故详情 `location` 是 A 的位置，B 的紧急联系人收到的短信也是 A 的位置。
- **复现**：见 `fix/backend-edge-1016` 的 `edge-fixes-1016.e2e-spec.ts`「B3」用例：B 绑定后不传任何位置直接摔 → 修复前 `location_source = 'last_point'` 且坐标等于 A 的点。
- **期望**：决策 #39「§5 轨迹只返回当前用户绑定区间内到达的数据——换绑后新主看不到前主期间的数据」。事故归属建单用户，快照也应只取该用户绑定区间内到达的点；没有就空快照。
- **位置**：同上 `resolveSnapshot()`。
- **修法**：`SosModule` 引入 `DevicesModule`，用 `BindingScopeService.intervals(deviceId, userId)` + `scopeWhere('receivedAt', …)` 限定回落范围（与 `locations.service` 的 latest 同口径）。顺带把 `orderBy` 补上 `id` 次序键。

### B4 timestamp 小数秒超过 3 位判 invalid

- **现象**：`ISO8601_WITH_TZ` 正则只允许 `.\d{1,3}`。`2026-10-15T03:00:00.123456Z`（Python `isoformat()`、Go `RFC3339Nano`、多数 C 库默认的微秒 / 纳秒精度）整条 envelope 判 `timestamp_not_iso8601_with_timezone`，以 `_invalid` 留档；如果是 possible_fall / manual_sos，不建单、不通知。
- **复现**：app-relay 投 `possible_fall`，timestamp 用 `new Date().toISOString().replace('Z','123Z')` → `{ accepted:0, invalid:1 }`、`sos_cases` 无记录。
- **期望**：EVENTS.md §1 只要求「ISO 8601 UTC、必须带显式时区、日历合法、年份 ≥ 1970」，没有限制小数位数；ISO 8601 允许任意位小数秒。
- **影响面**：现在唯一真机链路（BLE → App 中转）由 App 用 JS `toISOString()` 生成，3 位，不受影响；算法 webhook（服务端语言未定）和将来 4G 直连固件一旦用微秒格式，事件全部进 `_invalid`，保命链路静默失效——所以标「潜在高」。
- **位置**：`backend/src/ingest/envelope.ts` `ISO8601_WITH_TZ`。
- **修法**：小数部分放宽到 `(\.\d{1,9})?`（JS `Date` 会截到毫秒，入库精度不变）。

### B5 未知版本 / 未知类型事件出现在 App 事件历史

- **现象**：
  1. webhook / MQTT 送 `schemaVersion: 999` 的 possible_fall：按设计只留档不建单（EVENTS.md §1），但 `GET /devices/{id}/events` 列表里出现一条「疑似摔倒」，详情也能打开——App 安全记录里有摔倒却没有求救单，容易误导。
  2. webhook 送 `eventType: "foo_bar"`：列表里出现一条 summary 为 `foo_bar` 的事件；且 EVENTS.md §1 / §2 说「未知类型进原始事件表并告警」，入库时没有任何告警日志（app-relay 的 7 种白名单之外会告警，webhook / MQTT 不会）。
- **期望**：API.md §6 事件历史的取值范围是「EVENTS.md §3 eventType」，未知值查询时 400；未知版本「不进业务流程」。App 的查询面只应出现能正确解释的事件；Admin 事件查询（排查用）照旧全量可见。
- **位置**：`backend/src/events/events.service.ts`（list 的 `eventType: { not: '_invalid' }`、detail 只排除 `_invalid`）；`backend/src/ingest/ingest.service.ts`（缺告警）。
- **修法**：list 默认条件改为 `eventType ∈ EVENT_TYPES` 且 `schemaVersion ∈ SUPPORTED_SCHEMA_VERSIONS`，detail 同口径 404；ingestRaw 对已入库的未知 eventType 打一行 warn。

### B6 注销账号的密码没有 72 字节上限

- **现象**：用 24 个汉字（恰 72 字节）注册的账号，`DELETE /users/me` 传「24 个汉字 + 任意后缀」→ 204 注销成功。bcrypt 只比较前 72 字节。
- **期望**：API.md §2 对登录写明「≤ 72 字节，超出 400」，改密的 `oldPassword`、换号的 `password` 都按字节拒（审计 AUTH-02 / CONTRACT-01 修过）；注销是不可逆操作，口径应一致。实际风险低（攻击者仍需知道前 72 字节，即整个密码）。
- **位置**：`backend/src/users/users.controller.ts` `DeleteAccountDto`。
- **修法**：`auth.dto.ts` 导出已有的 `MaxBytes`，`DeleteAccountDto.password` 加 `@MaxBytes(72)`。

### B7 PATCH /devices/{id} 不传 name 也清空

- **现象**：`PATCH /devices/{id}` body `{}` → 200，`name` 变成 `null`（控制器 `dto.name ?? null`）。
- **期望**：API.md §4「body：`{ name?: string }`（≤20 字符，trim 后空串=清除）」——`name?` 是选填，通常理解为「不传不改」；文档只说「空串 = 清除」。
- **影响**：App 目前只在改名时带 `name` 调用，不会触发；但任何「只想改别的字段」的调用（将来加字段时）都会把名字抹掉。
- **建议**：要 Draven / 负责人定口径——「不传不改、传 null 或空串才清」（推荐，同 PATCH /users/me 与联系人 PATCH 的现状），定了再改控制器和 API.md。没开修复分支。

### B8 EMQX 认证回调的类型混淆 → 500

- **现象**：`POST /internal/emqx/authenticate`（带正确内部令牌）body 里 `username` 为数组 / 对象 / 布尔 → Prisma 校验异常；`password` 为数字 / 数组 / 对象 → `createHash().update()` 抛 TypeError；统一过滤器回 500 并打 ERROR 堆栈。`authorize` 同样的输入是 200 deny（正则对非字符串做了隐式转换）。
- **复现**：`curl -X POST '/api/v1/internal/emqx/authenticate' -H 'X-Internal-Token: …' -d '{"username":["helmet_001"],"password":"x"}'` → 500。
- **期望**：认证回调对任何畸形输入回 `200 { result: "deny" }`（与缺字段同口径，`AUTHN-EMPTY`）；EMQX 把非 200 当作「忽略」交给下一个认证器，行为依赖 EMQX 配置，不如明确 deny。
- **影响**：EMQX 只会按模板发字符串，正常链路触发不到；持内部令牌的人可以刷 ERROR 日志。结果从不为 allow（`edge-emqx` 已钉住这个不变式）。
- **位置**：`backend/src/emqx/emqx-hook.controller.ts`（body 只有 interface，没有 DTO 校验）。
- **修法**：控制器里非字符串字段按缺失处理（`typeof x === 'string' ? x : undefined`）再交给服务；authorize 同样收口。

---

## 观察项（按现状写进了测试，未当 bug；供定口径时参考）

1. 频道名不 trim：全空白名 `"   "` 可建频道（联系人名、设备名都会 trim）。`edge-voice`。
2. 联系人名 / 设备名只有零宽空格 `​` 时被当成非空保存（`trim()` 不去零宽字符），SOS 短信里会是空名。`edge-contacts` / `edge-devices`。
3. 查询参数里缺时区的时间（`2026-10-01T00:00:00`）和只有日期的写法被接受，按**服务器进程时区**解析（文档写一律 UTC）；容器若是 UTC 则与 Z 等价。`edge-locations`。
4. 设备名长度在 trim **之前**校验：20 字加首尾空格共 22 字符 → 400。
5. `GET /events/{eventId}`：eventId 只在设备内唯一（决策 #54），本人两台设备同号时只返回其中一条（`findFirst` 无排序，不保证是哪台）。`edge-events`。
6. Admin 事件 `from = to` 返回恰好落在该时刻的事件（两端闭区间，不校验先后）；App 端同参数 400。`edge-admin`。
7. Admin token 在管理员记录被删后、12h 有效期内仍可用（无状态、无吊销）。`edge-admin`。
8. 倒计时到期后、下一轮扫描前（默认扫描间隔内），取消仍 200 cancelled、不发通知——状态机以 pending 为准（API.md §7「仅 pending 可取消」）。`edge-sos`。
9. 同一单 / 同一设备 / 同一联系人并发删除（解绑、删联系人、注销）全部 204，顺序第二次才 404。无数据问题。
10. envelope timestamp 只到分钟（`T03:00Z`）判 invalid（ISO 8601 允许省略秒，EVENTS.md 示例带秒）。
11. 未知 schemaVersion 的同一事件重传：每次都计 `invalid`（不是 `duplicate`），原始表只有一条。
12. 换绑后，新主人可以替头盔回执上一位主人下发的命令并让其设置生效（API.md §8 鉴权口径：设备归属 + 命令属于该设备），但新主人查不到这条命令。
13. WS 网关验签后不检查 `typ`（HTTP 守卫会拒 `typ=admin`）；只在 `ADMIN_JWT_SECRET == JWT_SECRET` 误配时有意义，且 admin id 不对应任何设备，推不到数据。
14. SOS 快照回落的「最新轨迹点」没有时效上限：头盔几周没上报位置时，短信里仍是几周前的坐标且不注明时间。建议回落只取最近 N 小时的点，或短信注明「N 小时前的位置」。（与 B2 / B3 同一处代码，未一起改）
15. 密码只限长度不限字符：8 个空格可作为密码注册、登录。
16. 设备快照（lastSeenAt / firmwareVersion / 电量）按**到达顺序**覆盖，不比设备时间：App 补传 2 小时前、旧固件号的心跳会把固件号和电量回写成旧值，直到下一条实时心跳。`edge-ingest-business`。
17. EMQX 内部令牌：header 存在（哪怕是空串）就以 header 为准，query 里对的令牌不再看；令牌走 query 时会进访问日志。
18. EMQX 授权的 topic 若是单元素数组，会被隐式转成同一个字符串、等价于原 topic（不构成越权）；多元素数组 deny。

## 不稳定测试

`sos.e2e-spec.ts`「possible_fall → 建单 pending…」本机必挂：#194 后建单先发 WS、再 `void pushCreated()`（先查头盔名再 `push.send`），测试拿到 WS 就断言 `pushMock.send` 被调用。改为 `waitFor` 轮询等到这单的推送发出（只改测试）。同类写法一并改稳：`audit-sos`（链路层 3、25 并发）、`audit-sos-faults` ①、`sos-reliability` 补传说明三条、`sos-notify-order` 的 `arm`（先等建单推送发完再 `resetMocks`）。新增 `helpers/audit-sos.ts` 的 `waitForPushTitled`。
