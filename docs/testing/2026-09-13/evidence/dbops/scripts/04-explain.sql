-- 与 Prisma 生成语义等价的手写 SQL（参数按 service 代码：绑定区间 30 天前起、无 unbound）
\set dev '''perf_helmet_0001'''
\set uid '''perf_u_1'''
\echo '### Q1 §5 轨迹范围 count（24h 全范围 + 绑定区间 OR）'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT count(*) FROM location_points WHERE device_id=:dev AND "timestamp">=now()-interval '24 hours' AND "timestamp"<=now() AND (received_at >= now()-interval '30 days');
\echo '### Q2 §5 轨迹范围 findMany page=1 pageSize=100'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT * FROM location_points WHERE device_id=:dev AND "timestamp">=now()-interval '24 hours' AND "timestamp"<=now() AND (received_at >= now()-interval '30 days') ORDER BY "timestamp" ASC LIMIT 100 OFFSET 0;
\echo '### Q3 §5 轨迹范围 findMany 深分页 page=2500 pageSize=100（OFFSET 249900）'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT * FROM location_points WHERE device_id=:dev AND "timestamp">=now()-interval '24 hours' AND "timestamp"<=now() AND (received_at >= now()-interval '30 days') ORDER BY "timestamp" ASC LIMIT 100 OFFSET 249900;
\echo '### Q4 §5 latest'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT * FROM location_points WHERE device_id=:dev AND (received_at >= now()-interval '30 days') ORDER BY "timestamp" DESC LIMIT 1;
\echo '### Q5 §6 事件列表 count（无 type 过滤：event_type <> _invalid + 绑定区间）'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT count(*) FROM raw_events WHERE device_id=:dev AND event_type <> '_invalid' AND (received_at >= now()-interval '30 days');
\echo '### Q6 §6 事件列表 findMany page=1 pageSize=20 type=collision_risk'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT * FROM raw_events WHERE device_id=:dev AND event_type IN ('collision_risk') AND (received_at >= now()-interval '30 days') ORDER BY "timestamp" DESC LIMIT 20 OFFSET 0;
\echo '### Q7 §4 battery-history 24h（device_status，take 5000）'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT "timestamp", payload FROM raw_events WHERE device_id=:dev AND event_type='device_status' AND "timestamp">=now()-interval '24 hours' AND "timestamp"<=now() ORDER BY "timestamp" ASC LIMIT 5000;
\echo '### Q8 Admin listEvents 默认（无 deviceId；event_type <> _invalid；ORDER BY received_at DESC LIMIT 20）'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT * FROM raw_events WHERE event_type <> '_invalid' ORDER BY received_at DESC LIMIT 20 OFFSET 0;
\echo '### Q9 Admin listEvents count 默认'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT count(*) FROM raw_events WHERE event_type <> '_invalid';
\echo '### Q10 Admin listEvents deviceId 过滤 ORDER BY received_at DESC LIMIT 20'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT * FROM raw_events WHERE device_id=:dev AND event_type <> '_invalid' ORDER BY received_at DESC LIMIT 20;
\echo '### Q11 Admin getDeviceDetail recent 10（device_id，ORDER BY received_at DESC LIMIT 10）'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT * FROM raw_events WHERE device_id=:dev ORDER BY received_at DESC LIMIT 10;
\echo '### Q12 Admin statsOverview todayEvents（received_at >= 今日 UTC+8 零点）'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT count(*) FROM raw_events WHERE received_at >= date_trunc('day', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai' AND event_type <> '_invalid';
\echo '### Q13 Admin statsOverview deviceOnline'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT count(*) FROM devices WHERE last_seen_at >= now()-interval '2 minutes';
\echo '### Q14 Admin listUsers keyword（phone contains / nickname ilike）+ _count devices'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT u.id, u.phone, (SELECT count(*) FROM devices d WHERE d.bind_user_id=u.id) FROM users u WHERE u.phone LIKE '%1950000%' OR u.nickname ILIKE '%压测%' ORDER BY created_at DESC LIMIT 20;
\echo '### Q15 Admin listDevices keyword（deviceId ilike / bindUser.phone contains）'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT d.device_id FROM devices d LEFT JOIN users u ON u.id=d.bind_user_id WHERE (d.device_id ILIKE '%helmet_00%' OR u.phone LIKE '%19500%') ORDER BY d.created_at DESC LIMIT 20;
\echo '### Q16 Admin listAccidents status=notified ORDER BY created_at DESC'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT * FROM sos_cases WHERE status='notified' ORDER BY created_at DESC LIMIT 20;
\echo '### Q17 SOS 扫描 tick（pending & deadline<=now）'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT id FROM sos_cases WHERE status='pending' AND deadline<=now() ORDER BY deadline ASC LIMIT 50;
\echo '### Q18 SOS 触发 findFirst pending by device'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT * FROM sos_cases WHERE device_id=:dev AND status='pending' LIMIT 1;
\echo '### Q19 SOS resolveSnapshot last point（无 received_at 过滤）'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT latitude,longitude FROM location_points WHERE device_id=:dev ORDER BY "timestamp" DESC LIMIT 1;
