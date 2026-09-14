#!/usr/bin/env bash
# §11 备份/恢复：pg_dump -Fc helmet_audit_upgrade → 恢复到 helmet_audit_restore，核对表计数/外键孤儿/migration 状态；
# 附带：空库全量 migrate deploy（restore 库先做一次）与 perf 库（60 万+ 行）dump 耗时/体积。
set -u
source ~/.nvm/nvm.sh >/dev/null && nvm use 24 >/dev/null
ROOT=/Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang
SP=/private/tmp/claude-501/-Users-dravenzhong-Desktop-AI-Smart-Helmet-01WeiChuang/f23220c2-7807-4477-a125-d5f13c84ad94/scratchpad/dbops
mkdir -p $SP
export PGPASSWORD=audit_0913
P="psql -h 127.0.0.1 -p 55432 -U audit -v ON_ERROR_STOP=1 -q"
SRC=helmet_audit_upgrade; DST=helmet_audit_restore
echo "### 0. 空库全量 migration（$DST 新建空库 → prisma migrate deploy）"
$P -d postgres -c "DROP DATABASE IF EXISTS $DST" -c "CREATE DATABASE $DST"
( cd $ROOT/backend && DATABASE_URL=postgresql://audit:audit_0913@127.0.0.1:55432/$DST npx prisma migrate deploy 2>&1 | tail -3 )
$P -d $DST -Atc "select count(*)||' migrations applied, '||count(*) filter (where finished_at is null)||' unfinished' from _prisma_migrations"
( cd $ROOT/backend && DATABASE_URL=postgresql://audit:audit_0913@127.0.0.1:55432/$DST npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code >/dev/null 2>&1; echo "migrate diff(db→schema) exit=$? (0=无漂移)" )

echo; echo "### 1. pg_dump -Fc $SRC（容器内 pg_dump）"
T0=$(date +%s.%N); docker exec helmet-audit-0913-pg pg_dump -U audit -Fc $SRC > $SP/$SRC.dump; echo "dump exit=$? size=$(stat -f %z $SP/$SRC.dump) bytes, $(python3 -c "print('%.2f s' % ($(date +%s.%N)-$T0))")"
echo "### 1b. perf 库（含 60 万+ 行）dump 耗时/体积（仅计时，不恢复）"
T0=$(date +%s.%N); docker exec helmet-audit-0913-pg pg_dump -U audit -Fc helmet_audit_perf > $SP/perf.dump; echo "perf dump exit=$? size=$(stat -f %z $SP/perf.dump) bytes, $(python3 -c "print('%.2f s' % ($(date +%s.%N)-$T0))")"; rm -f $SP/perf.dump

echo; echo "### 2. 恢复到空库 $DST（drop+create → pg_restore）"
$P -d postgres -c "DROP DATABASE IF EXISTS $DST" -c "CREATE DATABASE $DST"
T0=$(date +%s.%N); docker exec -i helmet-audit-0913-pg pg_restore -U audit -d $DST --no-owner < $SP/$SRC.dump; echo "restore exit=$? $(python3 -c "print('%.2f s' % ($(date +%s.%N)-$T0))")"

echo; echo "### 3. 表计数对照（源 vs 恢复）"
for t in $($P -d $SRC -Atc "select table_name from information_schema.tables where table_schema='public' order by 1"); do
  a=$($P -d $SRC -Atc "select count(*) from \"$t\""); b=$($P -d $DST -Atc "select count(*) from \"$t\""); [ "$a" = "$b" ] && st=OK || st=MISMATCH; printf "%-28s %8s %8s %s\n" $t $a $b $st; done
echo; echo "### 4. 外键孤儿检查（恢复库）"
$P -d $DST -Atc "select 'sos_notifications→sos_cases orphans: '||count(*) from sos_notifications n left join sos_cases s on s.id=n.sos_id where s.id is null
union all select 'device_bindings→devices orphans: '||count(*) from device_bindings b left join devices d on d.device_id=b.device_id where d.device_id is null
union all select 'device_bindings→users orphans: '||count(*) from device_bindings b left join users u on u.id=b.user_id where u.id is null
union all select 'refresh_tokens→users orphans: '||count(*) from refresh_tokens r left join users u on u.id=r.user_id where u.id is null
union all select 'emergency_contacts→users orphans: '||count(*) from emergency_contacts c left join users u on u.id=c.user_id where u.id is null
union all select 'devices.bind_user_id→users orphans: '||count(*) from devices d left join users u on u.id=d.bind_user_id where d.bind_user_id is not null and u.id is null"
echo; echo "### 5. 约束/索引数量对照"
for db in $SRC $DST; do echo "$db: constraints=$($P -d $db -Atc "select count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public'") indexes=$($P -d $db -Atc "select count(*) from pg_indexes where schemaname='public'") migrations=$($P -d $db -Atc "select count(*) from _prisma_migrations")"; done
echo; echo "### 6. 恢复库 migrate status"
( cd $ROOT/backend && DATABASE_URL=postgresql://audit:audit_0913@127.0.0.1:55432/$DST npx prisma migrate status 2>&1 | tail -2 )
echo "### done（$DST 保留至本轮结束后 DROP）"
