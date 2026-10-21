# DATABASE.md — 数据模型设计决策

> **Schema 的唯一权威是 `backend/prisma/schema.prisma`**（含逐字段注释），本文件只记录"为什么这样设计"的决策，避免与 schema 重复。
> 变更规则见 CLAUDE.md「Database Rules」：只通过 Prisma migration 变更；一个 PR 最多一个 migration；CI 对空库验证全部 migration。

## 当前表与设计决策（Week 2 起步态）

| 表 | 关键决策 | 原因 |
|----|----------|------|
| users | 业务主键 cuid；phone 唯一；`deleted_at` 软删除（2026-09-11）；`time_zone` 手机时区（2026-10-22，O13：IANA 名，可空；JWT 守卫按请求头 `X-Client-Timezone` 在值变化时写入，推送正文时间按它写，没有时写「北京时间」；只留最新一个，注销时清空） | MVP 以手机号为注册凭据（见 API.md §2）；注销时 phone 改写为 `deleted:<id>` 释放号码（原号不保留），留档不物理删除 |
| devices | 主键直接用硬件 deviceId，不造代理键 | 设备全链路（MQTT Topic、事件、绑定）都以硬件 ID 为准，翻译层只会添乱 |
| device_bindings | 每段绑定关系一行（device_id, user_id, bound_at, unbound_at）；不建外键；migration 回填现有绑定 | 决策 #39：事件/轨迹/媒体的用户可见范围 = 本人绑定区间（按服务端 receivedAt 判），换绑后前主数据对新主不可见、同一人解绑再绑回来历史仍在；raw_events/location_points 保持无 user 字段（留档原则不变） |
| raw_events | `(device_id, event_id)` 复合唯一约束 = 幂等去重的兜底（**设备内唯一**，决策 #54，2026-10-14；原为 event_id 全局唯一）；**不建**到 devices 的外键 | 幂等必须由数据库保证（并发/重发场景应用层拦不住）；全局唯一时任何绑了头盔的用户都能用自己的设备抢先占用别人的 eventId，让对方之后的摔倒被当成重复、不建单；未注册设备/未知来源的事件也必须能原样落库（Ingest 规则） |
| raw_events | `(device_id, timestamp)` 复合索引 | 高频表按设备+时间查询是唯一主路径（CLAUDE.md Database Rules） |
| raw_events | `business_time` 列 + `(device_id, business_time)` 索引（2026-10-17） | 决策 #59：业务时间（设备时钟错乱时取收到时间，规则同 `common/device-time` businessTime）入库时写好，App 事件历史、电量曲线、乱序心跳判断都按它；`timestamp` 永远是设备原值。迁移回填存量；列默认 now() 只为回滚兜底（旧代码不写这一列时插入不失败） |
| raw_events | `(received_at)` 索引（2026-10-03） | Admin 概览「今日事件数」、Admin 全量事件列表（按接收时间倒序）、SOS 对账窗口扫描都按接收时间查；200 万行实测无索引 77–143 ms（全表扫描，随行数线性涨），有索引 0.03–8 ms。代价：每条事件多写一个 B-tree 条目（接收时间单调递增，追加写），200 万行约 43 MB |
| location_points | 类型化列而非复用 raw_events 的 JSON payload；`(device_id, event_id)` 唯一（与源事件 1:1，决策 #54）；不建外键；仅已注册设备写入 | 轨迹查询是高频主路径，JSON 提取查不动索引；(device_id, event_id) 唯一兜底并发重放幂等；未注册设备只留 raw；altitude 单列保留（滑雪场景核心维度） |
| sos_notifications | `push_title` 列（2026-10-22，O17）：本人推送实际发出时用的标题，短信行为空；「重试后补推」行建行时就写好标题 | 状态推送以「SOS 紧急联系人通知发送失败」发出、之后又有短信重试成功时补推一条，每单最多一条：判断靠这一列，建补推行与写「已发送」在同一事务里（先锁 sos_cases 那一行），重启不漏建、并发不多建。只加可空列不回填；上线前发出的推送没有标题，不补 |

## 已知的后续演进点（审查发现，已排期）

- **clock_skew 标记与 source 字段**（DEVICE_PROTOCOL §8 / EVENTS.md §1 承诺的服务端字段）：随 Week 3 的第一个业务 migration 一起补，避免为两个字段单开 migration。
- **eventId 幂等粒度** ✅ 2026-10-14 改为**设备内唯一**（决策 #54，推翻 #44）：#44「跨设备撞不上」的前提是客户端诚实，但 BLE 版 eventId 由公开算法（App 内常量命名空间 + 广播名里的 deviceId + 小整数序号）推出，全局唯一时任何用户都能用自己的设备抢占别人的 eventId 让对方的摔倒被判成重复。migration `20261014…_event_id_unique_per_device` 把 raw_events / location_points / media 换成 `(device_id, event_id)`、sos_cases 换成 `(device_id, trigger_event_id)`。
- **位置数据生命周期**：MVP 不实现 Retention/降采样，但轨迹查询必须走服务层、不裸查表（CLAUDE.md Database Rules），为未来留余地。
