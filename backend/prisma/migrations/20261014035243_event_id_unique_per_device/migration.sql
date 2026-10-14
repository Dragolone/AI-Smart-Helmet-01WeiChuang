-- eventId 幂等粒度改为「设备内唯一」（决策 #54，2026-10-14）：四张表的 event_id 全局唯一索引换成 (device_id, event_id)。
-- 先建新索引再删旧的：期间写入仍受唯一约束保护。
CREATE UNIQUE INDEX "raw_events_device_id_event_id_key" ON "raw_events"("device_id", "event_id");
DROP INDEX "raw_events_event_id_key";

CREATE UNIQUE INDEX "location_points_device_id_event_id_key" ON "location_points"("device_id", "event_id");
DROP INDEX "location_points_event_id_key";

CREATE UNIQUE INDEX "media_device_id_event_id_key" ON "media"("device_id", "event_id");
DROP INDEX "media_event_id_key";

CREATE UNIQUE INDEX "sos_cases_device_id_trigger_event_id_key" ON "sos_cases"("device_id", "trigger_event_id");
DROP INDEX "sos_cases_trigger_event_id_key";
