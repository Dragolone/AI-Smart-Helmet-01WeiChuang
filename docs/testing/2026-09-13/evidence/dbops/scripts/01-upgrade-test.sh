#!/usr/bin/env bash
# 从上一版本（前 13 个 migration，止于 20260908144829_sms_codes）升级到最新（16 个）的验证脚本。
# 用法：bash 01-upgrade-test.sh   （需要 nvm 24、隔离 PG 127.0.0.1:55432）
set -u
source ~/.nvm/nvm.sh >/dev/null && nvm use 24 >/dev/null
ROOT=/Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang/backend
SP=/private/tmp/claude-501/-Users-dravenzhong-Desktop-AI-Smart-Helmet-01WeiChuang/f23220c2-7807-4477-a125-d5f13c84ad94/scratchpad/dbops
PGURL_ADMIN=postgresql://audit:audit_0913@127.0.0.1:55432/postgres
export DATABASE_URL=postgresql://audit:audit_0913@127.0.0.1:55432/helmet_audit_upgrade
psql "$PGURL_ADMIN" -qc "DROP DATABASE IF EXISTS helmet_audit_upgrade" ; psql "$PGURL_ADMIN" -qc "CREATE DATABASE helmet_audit_upgrade"
echo "### step1: old-version migrate deploy (13 migrations)"
cd $ROOT && npx prisma migrate deploy --config $SP/prisma.old.config.ts 2>&1 | tail -8
echo "### step2: old-shape columns"
psql "$DATABASE_URL" -c "\d media" | grep size_bytes
psql "$DATABASE_URL" -c "select column_name from information_schema.columns where table_name='users' order by 1" | tr '\n' ' '; echo
psql "$DATABASE_URL" -c "select to_regclass('device_bindings') as device_bindings_table"
echo "### step3: seed representative old data"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO users(id, phone, password_hash, nickname) VALUES
 ('u_old_1','19100000001','$2b$10$oldhash1','旧用户1'),
 ('u_old_2','19100000002','$2b$10$oldhash2','旧用户2'),
 ('u_old_3','19100000003','$2b$10$oldhash3',NULL);
INSERT INTO devices(device_id, device_secret_hash, bind_code, bind_user_id, bound_at, created_at, battery) VALUES
 ('upg_helmet_001','h1','UPG001','u_old_1','2026-09-01 08:00:00','2026-08-20 00:00:00',80),
 ('upg_helmet_002','h2','UPG002','u_old_2',NULL,'2026-08-21 00:00:00',50),        -- bound_at 缺失：应回落 created_at
 ('upg_helmet_003','h3','UPG003',NULL,NULL,'2026-08-22 00:00:00',NULL),          -- 未绑定：不应回填
 ('upg_helmet_004','h4','UPG004','u_old_1','2026-09-05 10:00:00','2026-08-23 00:00:00',10); -- 同一用户第二台
INSERT INTO raw_events(id,event_id,device_id,event_type,timestamp,schema_version,payload,source) VALUES
 ('re_old_1','upg-evt-1','upg_helmet_001','device_status','2026-09-02 00:00:00',1,'{"battery":80}','mqtt'),
 ('re_old_2','upg-evt-2','upg_helmet_001','possible_fall','2026-09-02 00:01:00',1,'{"confidence":0.9}','webhook'),
 ('re_old_3','upg-evt-3','upg_helmet_002','location_update','2026-09-02 00:02:00',1,'{"latitude":1,"longitude":1}','app_relay');
INSERT INTO sos_cases(id,device_id,user_id,trigger_event_id,trigger_type,status,deadline,updated_at) VALUES
 ('sos_old_1','upg_helmet_001','u_old_1','upg-evt-2','possible_fall','notified','2026-09-02 00:02:00',now()),
 ('sos_old_2','upg_helmet_002','u_old_2','upg-evt-9','manual_sos','pending','2099-01-01 00:00:00',now());
INSERT INTO sos_notifications(id,sos_id,channel,target,status) VALUES ('sn_old_1','sos_old_1','sms','19100000009','sent');
INSERT INTO media(id,event_id,device_id,video_id,size_bytes,storage_key) VALUES
 ('m_old_1','upg-evt-v1','upg_helmet_001','vid_1',2147483647,'k1'),   -- int4 上限
 ('m_old_2','upg-evt-v2','upg_helmet_001','vid_2',NULL,NULL);
INSERT INTO refresh_tokens(id,user_id,token_hash,expires_at) VALUES ('rt_old_1','u_old_1','hash_old_1','2099-01-01');
INSERT INTO emergency_contacts(id,user_id,name,phone) VALUES ('ec_old_1','u_old_1','联系人A','19100000010');
SQL
echo "### step3b: old int4 overflow proof (size_bytes = 3GB must fail before upgrade)"
psql "$DATABASE_URL" -c "INSERT INTO media(id,event_id,device_id,video_id,size_bytes) VALUES ('m_old_3','upg-evt-v3','upg_helmet_001','vid_3',3221225472)" 2>&1 | head -2
echo "### step4: new-version migrate deploy (real config, remaining 3)"
cd $ROOT && npx prisma migrate deploy 2>&1 | tail -10
echo "### step5: verify"
psql "$DATABASE_URL" -c "select migration_name, finished_at is not null as done from _prisma_migrations order by started_at" | tail -6
psql "$DATABASE_URL" -c "select b.id, b.device_id, b.user_id, b.bound_at, b.unbound_at, d.bound_at as dev_bound_at, d.created_at as dev_created_at, (b.bound_at = coalesce(d.bound_at,d.created_at)) as bound_at_consistent from device_bindings b join devices d using(device_id) order by 1"
psql "$DATABASE_URL" -c "select (select count(*) from devices where bind_user_id is not null) as bound_devices, (select count(*) from device_bindings) as binding_rows, (select count(*) from device_bindings where unbound_at is null) as open_rows"
psql "$DATABASE_URL" -c "select column_name, data_type, column_default, is_nullable from information_schema.columns where (table_name='users' and column_name='deleted_at') or (table_name='media' and column_name='size_bytes')"
psql "$DATABASE_URL" -c "select id, deleted_at from users order by 1"
psql "$DATABASE_URL" -c "INSERT INTO media(id,event_id,device_id,video_id,size_bytes) VALUES ('m_new_3','upg-evt-v3','upg_helmet_001','vid_3',3221225472) returning id,size_bytes"
psql "$DATABASE_URL" -c "select id,size_bytes from media order by 1"
echo "### step6: status + diff vs schema"
cd $ROOT && npx prisma migrate status 2>&1 | tail -3
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script --exit-code 2>&1 | tail -3; echo "diff exit=$?"
echo "### step7: second migrate deploy is a no-op"
npx prisma migrate deploy 2>&1 | tail -2
