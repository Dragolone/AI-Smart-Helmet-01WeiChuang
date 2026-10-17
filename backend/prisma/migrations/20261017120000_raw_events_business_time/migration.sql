-- raw_events 加业务时间列（决策 #59，2026-10-17）：App 事件历史按它排序、按时间窗过滤，返回给 App 的 timestamp 也是它。
-- 规则同 backend/src/common/device-time.ts businessTime：设备时间比收到时超前 5 分钟以上、或早 72 小时以上（时钟错乱）用收到时间，
-- 否则用设备时间。原来按设备时间排，RTC 归零报 1970 的最新事件沉到列表底、报 2099 的永远排第一（10-17 第二轮评审 r2）。
-- 先可空加列、回填、再设非空：一步加 NOT NULL 列会因为老数据没有值而失败。DEFAULT 只为回滚兜底（旧代码不写这一列）。
-- 实测：65 万行（约 450 MB）本机 7 s，回填占绝大部分；迁移在 backend 启动时执行，这段时间后端不可用。
ALTER TABLE "raw_events" ADD COLUMN "business_time" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;

UPDATE "raw_events" SET "business_time" = CASE
  WHEN "timestamp" > "received_at" + interval '5 minutes'
    OR "timestamp" < "received_at" - interval '72 hours'
  THEN "received_at"
  ELSE "timestamp"
END;

ALTER TABLE "raw_events" ALTER COLUMN "business_time" SET NOT NULL;

CREATE INDEX "raw_events_device_id_business_time_idx" ON "raw_events"("device_id", "business_time");
