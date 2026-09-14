#!/usr/bin/env bash
# §11 可恢复性：A SIGTERM 优雅退出（在途请求）；B DATABASE_URL 指错端口；C 缺 JWT_SECRET；D 缺 DATABASE_URL
# 用法：bash 40-recoverability.sh   （输出到 evidence/dbops/40-recoverability.log 由调用方 tee）
set -u
source ~/.nvm/nvm.sh >/dev/null && nvm use 24 >/dev/null
ROOT=/Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang
EV=$ROOT/docs/testing/2026-09-13/evidence/dbops
SP=/private/tmp/claude-501/-Users-dravenzhong-Desktop-AI-Smart-Helmet-01WeiChuang/f23220c2-7807-4477-a125-d5f13c84ad94/scratchpad/dbops
mkdir -p $SP; : > $SP/empty.env
set -a; source /private/tmp/claude-501/-Users-dravenzhong-Desktop-AI-Smart-Helmet-01WeiChuang/f23220c2-7807-4477-a125-d5f13c84ad94/scratchpad/audit.env; set +a
export MQTT_URL=mqtt://127.0.0.1:51899 RATE_LIMIT_DISABLED=1
export DOTENV_CONFIG_PATH=$SP/empty.env   # 屏蔽 backend/.env，让「缺失」真的缺失
DBOPS=postgresql://audit:audit_0913@127.0.0.1:55432/helmet_audit_dbops
strip() { sed 's/\x1b\[[0-9;]*m//g' | grep -v "InstanceLoader\|RouterExplorer\|RoutesResolver\|MQTT"; }
wait_health() { for i in $(seq 1 40); do curl -s -m 1 -o /dev/null -w '%{http_code}' http://127.0.0.1:$1/api/v1/health 2>/dev/null | grep -q 200 && return 0; sleep 0.25; done; return 1; }
cd $ROOT/backend

echo "### A. SIGTERM 优雅退出（PORT 3501, helmet_audit_dbops）"
DATABASE_URL=$DBOPS PORT=3501 node dist/main > $SP/A.log 2>&1 & A=$!
wait_health 3501 && echo "started pid $A, health ok" || echo "start FAILED"
CREDS_OUT=$SP/recover-creds.json DATABASE_URL=$DBOPS node $EV/scripts/20-seed-load.mjs http://127.0.0.1:3501 2 2>&1 | sed 's#/private.*scratchpad#<scratchpad>#'
DATABASE_URL=$DBOPS node $EV/scripts/41-sigterm-inflight.mjs $A http://127.0.0.1:3501 $SP/recover-creds.json
wait $A; echo "exit code = $?"
echo "--- 退出期间日志（去 MQTT 噪音）："; strip < $SP/A.log | tail -6
echo "--- 空闲态 SIGTERM 退出耗时："
DATABASE_URL=$DBOPS PORT=3501 node dist/main > $SP/A2.log 2>&1 & A2=$!
wait_health 3501; T0=$(python3 -c 'import time;print(time.time())'); kill -TERM $A2; wait $A2; RC=$?; python3 -c "import time;print('idle SIGTERM exit: %.0f ms, rc=$RC' % ((time.time()-$T0)*1000))"
lsof -nP -iTCP:3501 -sTCP:LISTEN >/dev/null 2>&1 && echo "port 3501 STILL LISTENING" || echo "port 3501 released"

echo; echo "### B. DATABASE_URL 指错端口（55499）→ 启动行为 + /health"
DATABASE_URL=postgresql://audit:audit_0913@127.0.0.1:55499/helmet_audit_dbops PORT=3502 node dist/main > $SP/B.log 2>&1 & B=$!
sleep 6
if kill -0 $B 2>/dev/null; then echo "process ALIVE after 6s (启动不因库不可达而失败)"; else wait $B; echo "process EXITED rc=$?"; fi
echo "health => $(curl -s -m 3 -w ' [%{http_code}]' http://127.0.0.1:3502/api/v1/health)"
echo "--- 6s 内日志：总 $(wc -l < $SP/B.log) 行；SOS 扫描失败 $(grep -c 'SOS 扫描轮次失败' $SP/B.log) 次；命令扫描失败 $(grep -c '命令扫描轮次失败' $SP/B.log) 次"
strip < $SP/B.log | grep -v "^\s*at \|^$\|→\|^\s*[0-9]* " | head -12 | cut -c1-160
kill -TERM $B 2>/dev/null; wait $B 2>/dev/null

echo; echo "### C. 缺 JWT_SECRET"
( unset JWT_SECRET; DATABASE_URL=$DBOPS PORT=3503 node dist/main > $SP/C.log 2>&1; echo "rc=$?" > $SP/C.rc ) & C=$!
sleep 6; if kill -0 $C 2>/dev/null; then echo "still ALIVE after 6s"; kill -TERM $C; else cat $SP/C.rc; fi
strip < $SP/C.log | grep -i "JWT_SECRET\|Error" | head -3 | cut -c1-200

echo; echo "### D. 缺 DATABASE_URL"
( unset DATABASE_URL; PORT=3505 node dist/main > $SP/D.log 2>&1; echo "rc=$?" > $SP/D.rc ) & Dp=$!
sleep 6; if kill -0 $Dp 2>/dev/null; then echo "still ALIVE after 6s"; kill -TERM $Dp; else cat $SP/D.rc; fi
strip < $SP/D.log | grep -i "DATABASE_URL\|Error" | head -3 | cut -c1-200

echo; echo "### E. 缺 ADMIN_JWT_SECRET"
( unset ADMIN_JWT_SECRET; DATABASE_URL=$DBOPS PORT=3506 node dist/main > $SP/E.log 2>&1; echo "rc=$?" > $SP/E.rc ) & Ep=$!
sleep 6; if kill -0 $Ep 2>/dev/null; then echo "still ALIVE after 6s"; kill -TERM $Ep; else cat $SP/E.rc; fi
strip < $SP/E.log | grep -i "ADMIN_JWT_SECRET\|Error" | head -3 | cut -c1-200
echo "### done"
