-- 约束验证（在 helmet_audit_upgrade 上运行；每段独立事务，预期报错处用 \echo 标注）
\set ON_ERROR_STOP off
\echo '### A. sos_cases partial unique: 每设备至多一个 pending（第二条 pending 应报错）'
INSERT INTO sos_cases(id,device_id,user_id,trigger_event_id,trigger_type,status,deadline,updated_at)
 VALUES ('sos_c1','upg_helmet_003','u_old_3','c-evt-1','manual_sos','pending','2099-01-01',now());
INSERT INTO sos_cases(id,device_id,user_id,trigger_event_id,trigger_type,status,deadline,updated_at)
 VALUES ('sos_c2','upg_helmet_003','u_old_3','c-evt-2','manual_sos','pending','2099-01-01',now());
\echo '--- 同设备再插一条 notified 应成功（partial 只限 pending）'
INSERT INTO sos_cases(id,device_id,user_id,trigger_event_id,trigger_type,status,deadline,updated_at)
 VALUES ('sos_c3','upg_helmet_003','u_old_3','c-evt-3','manual_sos','notified','2099-01-01',now());
SELECT id,status FROM sos_cases WHERE device_id='upg_helmet_003' ORDER BY 1;
\echo '### B. raw_events.event_id 唯一（重复 eventId 应报错）'
INSERT INTO raw_events(id,event_id,device_id,event_type,timestamp,schema_version,payload) VALUES ('re_c1','upg-evt-1','upg_helmet_001','device_status',now(),1,'{}');
\echo '### C. voice_channel_members (channel_id,user_id) 唯一'
INSERT INTO voice_channels(id,name,invite_code,owner_id) VALUES ('vc_c1','ch','ABC123','u_old_1');
INSERT INTO voice_channel_members(id,channel_id,user_id) VALUES ('vm_c1','vc_c1','u_old_1');
INSERT INTO voice_channel_members(id,channel_id,user_id) VALUES ('vm_c2','vc_c1','u_old_1');
\echo '--- 成员引用不存在频道应被外键阻止'
INSERT INTO voice_channel_members(id,channel_id,user_id) VALUES ('vm_c3','vc_missing','u_old_1');
\echo '### D. 外键：删除有 refresh_tokens / emergency_contacts 的用户应被 RESTRICT 阻止'
DELETE FROM users WHERE id='u_old_1';
\echo '--- 删除有绑定设备但无 token/联系人的用户：devices.bind_user_id ON DELETE SET NULL（设备会被静默解绑）'
BEGIN;
DELETE FROM users WHERE id='u_old_2';
SELECT device_id, bind_user_id, bound_at FROM devices WHERE device_id='upg_helmet_002';
SELECT count(*) AS binding_rows_still_present FROM device_bindings WHERE device_id='upg_helmet_002';
ROLLBACK;
\echo '--- 删除有 sos_notifications 的 sos_cases 应被 RESTRICT 阻止'
DELETE FROM sos_cases WHERE id='sos_old_1';
\echo '### E. 事务回滚'
BEGIN;
INSERT INTO users(id,phone,password_hash) VALUES ('u_tx_1','19100000099','x');
SELECT count(*) AS in_tx FROM users WHERE id='u_tx_1';
ROLLBACK;
SELECT count(*) AS after_rollback FROM users WHERE id='u_tx_1';
\echo '### F. 唯一约束: users.phone / devices.bind_code / location_points.event_id / media(device_id,video_id)'
INSERT INTO users(id,phone,password_hash) VALUES ('u_dup','19100000001','x');
INSERT INTO devices(device_id,device_secret_hash,bind_code) VALUES ('upg_helmet_dup','h','UPG001');
INSERT INTO media(id,event_id,device_id,video_id) VALUES ('m_dup','upg-evt-vdup','upg_helmet_001','vid_1');
\echo '### G. 索引清单（sos_cases / raw_events / location_points / device_bindings）'
SELECT tablename, indexname, indexdef FROM pg_indexes WHERE tablename IN ('sos_cases','raw_events','location_points','device_bindings','device_commands') ORDER BY 1,2;
