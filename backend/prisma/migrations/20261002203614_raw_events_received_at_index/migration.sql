-- raw_events 按接收时间的查询原先只能全表扫描：Admin 概览「今日事件数」、Admin 全量事件列表（按接收时间倒序）、
-- SOS 启动对账（最近 15 分钟的 possible_fall / manual_sos）。表是全库最大的一张，行数随时间线性涨。
CREATE INDEX "raw_events_received_at_idx" ON "raw_events"("received_at");
