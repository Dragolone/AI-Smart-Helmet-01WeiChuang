# DATABASE.md — 数据模型设计决策

> **Schema 的唯一权威是 `backend/prisma/schema.prisma`**（含逐字段注释），本文件只记录"为什么这样设计"的决策，避免与 schema 重复。
> 变更规则见 CLAUDE.md「Database Rules」：只通过 Prisma migration 变更；一个 PR 最多一个 migration；CI 对空库验证全部 migration。

## 当前表与设计决策（Week 2 起步态）

| 表 | 关键决策 | 原因 |
|----|----------|------|
| users | 业务主键 cuid；phone 唯一 | MVP 以手机号为注册凭据（待定稿，见 API.md §2） |
| devices | 主键直接用硬件 deviceId，不造代理键 | 设备全链路（MQTT Topic、事件、绑定）都以硬件 ID 为准，翻译层只会添乱 |
| raw_events | event_id 全局唯一约束 = 幂等去重的兜底；**不建**到 devices 的外键 | 幂等必须由数据库保证（并发/重发场景应用层拦不住）；未注册设备/未知来源的事件也必须能原样落库（Ingest 规则） |
| raw_events | `(device_id, timestamp)` 复合索引 | 高频表按设备+时间查询是唯一主路径（CLAUDE.md Database Rules） |

## 已知的后续演进点（审查发现，已排期）

- **clock_skew 标记与 source 字段**（DEVICE_PROTOCOL §8 / EVENTS.md §1 承诺的服务端字段）：随 Week 3 的第一个业务 migration 一起补，避免为两个字段单开 migration。
- **eventId 幂等粒度**：当前为全局唯一；待硬件确认 eventId 生成规则后评估是否改为 `(device_id, event_id)` 复合唯一（防理论上的跨设备事件压制）。结论记入 DECISIONS.md。
- **位置数据生命周期**：MVP 不实现 Retention/降采样，但轨迹查询必须走服务层、不裸查表（CLAUDE.md Database Rules），为未来留余地。
