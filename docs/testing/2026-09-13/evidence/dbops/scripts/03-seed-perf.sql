-- 容量/查询计划测试数据（helmet_audit_perf 专用；全部以 perf_ 前缀，清理见 99-cleanup.sql）
-- 5000 用户、3000 设备（前 2500 台绑定到用户）、2000 sos_cases、
-- 设备 perf_helmet_001：30 万 location_points（近 24h）+ 20 万 raw_events（device_status/collision_risk/location_update）
\timing on
BEGIN;
INSERT INTO users(id, phone, password_hash, nickname, created_at)
SELECT 'perf_u_'||g, '19'||lpad((500000000+g)::text,9,'0'), '$2b$10$perfhash', '压测用户'||g, now() - (g||' seconds')::interval
FROM generate_series(1,5000) g;

INSERT INTO devices(device_id, device_secret_hash, bind_code, bind_user_id, bound_at, last_seen_at, battery, created_at)
SELECT 'perf_helmet_'||lpad(g::text,4,'0'), 'perfhash', 'PERF'||lpad(g::text,4,'0'),
       CASE WHEN g<=2500 THEN 'perf_u_'||g END,
       CASE WHEN g<=2500 THEN now() - interval '30 days' END,
       CASE WHEN g%3=0 THEN now() - (g%600||' seconds')::interval END,
       g%100, now() - (g||' minutes')::interval
FROM generate_series(1,3000) g;

INSERT INTO device_bindings(id, device_id, user_id, bound_at)
SELECT 'perf_b_'||g, 'perf_helmet_'||lpad(g::text,4,'0'), 'perf_u_'||g, now() - interval '30 days'
FROM generate_series(1,2500) g;

INSERT INTO sos_cases(id, device_id, user_id, trigger_event_id, trigger_type, status, deadline, created_at, updated_at)
SELECT 'perf_sos_'||g, 'perf_helmet_'||lpad((g%2500+1)::text,4,'0'), 'perf_u_'||(g%2500+1), 'perf-sos-evt-'||g,
       CASE WHEN g%2=0 THEN 'possible_fall' ELSE 'manual_sos' END,
       CASE WHEN g%5=0 THEN 'cancelled' ELSE 'notified' END,
       now() - (g||' hours')::interval, now() - (g||' hours')::interval, now()
FROM generate_series(1,2000) g;

-- 30 万位置点：近 24h 内，间隔 ~288ms；其中 g%1000=0 的 300 个点故意共用同一 timestamp（分页排序稳定性检验）
INSERT INTO location_points(id, event_id, device_id, timestamp, received_at, latitude, longitude, coordinate_system, accuracy, speed, heading, altitude)
SELECT 'perf_lp_'||g, 'perf-lp-'||g, 'perf_helmet_0001',
       CASE WHEN g%1000=0 THEN now() - interval '12 hours' ELSE now() - interval '24 hours' + (g*0.288||' seconds')::interval END,
       now() - interval '24 hours' + (g*0.288||' seconds')::interval,
       31.2 + (g%10000)*0.00001, 121.5 + (g%10000)*0.00001, 'gcj02', 5, 3.2, 90, 12
FROM generate_series(1,300000) g;

-- 20 万原始事件：70% device_status，20% location_update，10% collision_risk；近 24h
INSERT INTO raw_events(id, event_id, device_id, event_type, timestamp, received_at, schema_version, firmware_version, payload, source, clock_skew)
SELECT 'perf_re_'||g, 'perf-re-'||g, 'perf_helmet_0001',
       CASE WHEN g%10<7 THEN 'device_status' WHEN g%10<9 THEN 'location_update' ELSE 'collision_risk' END,
       now() - interval '24 hours' + (g*0.432||' seconds')::interval,
       now() - interval '24 hours' + (g*0.432||' seconds')::interval,
       1, '1.0.0',
       CASE WHEN g%10<7 THEN jsonb_build_object('battery', g%100, 'charging', g%2=0, 'signalLevel', 3)
            WHEN g%10<9 THEN jsonb_build_object('latitude',31.2,'longitude',121.5,'coordinateSystem','gcj02','accuracy',5,'speed',3,'heading',90)
            ELSE jsonb_build_object('riskLevel','high','objectType','vehicle','distance',3.5,'confidence',0.9) END,
       'app_relay', false
FROM generate_series(1,200000) g;
COMMIT;
ANALYZE users; ANALYZE devices; ANALYZE device_bindings; ANALYZE sos_cases; ANALYZE location_points; ANALYZE raw_events;
SELECT (select count(*) from users) users,(select count(*) from devices) devices,(select count(*) from device_bindings) bindings,(select count(*) from sos_cases) sos,(select count(*) from location_points) points,(select count(*) from raw_events) events;
SELECT pg_size_pretty(pg_total_relation_size('location_points')) lp_size, pg_size_pretty(pg_total_relation_size('raw_events')) re_size;
