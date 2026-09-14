#!/bin/zsh
# §11 可恢复性复测：SIGTERM 优雅退出 / 误配启动 / 备份恢复。只用端口 3501 与本轮隔离库。
source ~/.nvm/nvm.sh >/dev/null 2>&1; nvm use 24 >/dev/null 2>&1
R=/Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang
SP=/private/tmp/claude-501/-Users-dravenzhong-Desktop-AI-Smart-Helmet-01WeiChuang/f23220c2-7807-4477-a125-d5f13c84ad94/scratchpad
cd $R/backend
set -a; source $SP/audit.env; set +a
export DATABASE_URL=postgresql://audit:audit_0913@127.0.0.1:55432/helmet_audit_dbops
export MQTT_URL=mqtt://127.0.0.1:51899 PORT=3501

echo "### A. SIGTERM 优雅退出（进行中请求是否完成 / 端口是否释放）"
node dist/main > /tmp/audit-3501.log 2>&1 &
BE=$!
for i in $(seq 1 40); do curl -sf http://127.0.0.1:3501/api/v1/health >/dev/null 2>&1 && break; sleep 0.5; done
curl -s http://127.0.0.1:3501/api/v1/health; echo
# 发一个较慢的请求（大批量 app-relay 需要鉴权，这里用 health 并发 + 立即 SIGTERM 观察行为）
( for i in $(seq 1 30); do curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3501/api/v1/health; done > /tmp/audit-inflight.txt ) &
INF=$!
sleep 0.15
kill -TERM $BE
wait $INF 2>/dev/null
echo "SIGTERM 后 in-flight 请求状态码分布：$(sort /tmp/audit-inflight.txt | uniq -c | tr '\n' ' ')"
for i in $(seq 1 30); do kill -0 $BE 2>/dev/null || break; sleep 0.5; done
if kill -0 $BE 2>/dev/null; then echo "✕ 进程 30s 后仍存活（未优雅退出）"; kill -9 $BE; else echo "✓ 进程已退出"; fi
echo "关停日志尾部："; tail -6 /tmp/audit-3501.log
lsof -nP -iTCP:3501 -sTCP:LISTEN >/dev/null 2>&1 && echo "✕ 端口 3501 仍被监听" || echo "✓ 端口 3501 已释放"

echo; echo "### B. 误配启动：DATABASE_URL 指向不存在的端口"
DATABASE_URL=postgresql://audit:audit_0913@127.0.0.1:55499/helmet_audit_dbops timeout 25 node dist/main > /tmp/audit-badurl.log 2>&1
echo "exit=$? （非 0 = 启动失败）"; grep -iE "error|P1001|Can't reach|unreachable" /tmp/audit-badurl.log | head -3

echo; echo "### C. 误配启动：缺 JWT_SECRET"
env -u JWT_SECRET timeout 20 node dist/main > /tmp/audit-nojwt.log 2>&1 &
NJ=$!
sleep 8
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3501/api/v1/health 2>/dev/null)
echo "缺 JWT_SECRET 时 /health = $HEALTH （200 = 照常启动，密钥缺失未在启动时校验）"
if [ "$HEALTH" = "200" ]; then
  R1=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:3501/api/v1/auth/login -H 'content-type: application/json' -d '{"phone":"19900000000","password":"whatever1"}')
  echo "登录返回 $R1"
fi
kill -9 $NJ 2>/dev/null; wait $NJ 2>/dev/null

echo; echo "### D. 备份恢复（pg_dump -Fc → 新库 → 计数与外键核对）"
docker exec helmet-audit-0913-pg pg_dump -U audit -Fc helmet_audit_dbops > /tmp/audit-dbops.dump 2>/tmp/audit-dump.err
echo "dump 大小：$(wc -c < /tmp/audit-dbops.dump) 字节 $(head -2 /tmp/audit-dump.err)"
docker exec helmet-audit-0913-pg psql -U audit -d postgres -q -c "DROP DATABASE IF EXISTS helmet_audit_restore;" -c "CREATE DATABASE helmet_audit_restore;"
docker exec -i helmet-audit-0913-pg pg_restore -U audit -d helmet_audit_restore < /tmp/audit-dbops.dump 2>&1 | tail -3
echo "表计数对比（源 vs 恢复）："
for t in users devices raw_events location_points sos_cases sos_notifications device_bindings device_commands emergency_contacts; do
  A=$(docker exec helmet-audit-0913-pg psql -U audit -d helmet_audit_dbops -At -c "select count(*) from $t")
  B=$(docker exec helmet-audit-0913-pg psql -U audit -d helmet_audit_restore -At -c "select count(*) from $t")
  [ "$A" = "$B" ] && M="✓" || M="✕"
  printf "  %-20s %8s vs %8s %s\n" "$t" "$A" "$B" "$M"
done
echo "恢复库外键/唯一约束数：$(docker exec helmet-audit-0913-pg psql -U audit -d helmet_audit_restore -At -c "select count(*) from pg_constraint where contype in ('f','u','p')")（源：$(docker exec helmet-audit-0913-pg psql -U audit -d helmet_audit_dbops -At -c "select count(*) from pg_constraint where contype in ('f','u','p')")）"
echo "sos_cases 部分唯一索引是否恢复：$(docker exec helmet-audit-0913-pg psql -U audit -d helmet_audit_restore -At -c "select indexdef from pg_indexes where tablename='sos_cases' and indexdef like '%WHERE%'" | head -1)"
docker exec helmet-audit-0913-pg psql -U audit -d postgres -q -c "DROP DATABASE helmet_audit_restore;" && echo "恢复库已清理"
