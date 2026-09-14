#!/usr/bin/env bash
# 用法: 10-start-backend.sh <PORT> <DBNAME> <LOGNAME> [KEY=VAL ...]
# 以真实进程（exec node dist/main）起后端，指向隔离 PG，MQTT 指死端口；pid 写到 <LOGNAME>.pid。
# 需由调用方放在后台常驻（Bash 工具 run_in_background），否则随调用 shell 一起被回收。
set -u
source ~/.nvm/nvm.sh >/dev/null && nvm use 24 >/dev/null
PORT_=$1; DB_=$2; LOG_=$3; shift 3
ROOT=/Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang
EV=$ROOT/docs/testing/2026-09-13/evidence/dbops
set -a; source /private/tmp/claude-501/-Users-dravenzhong-Desktop-AI-Smart-Helmet-01WeiChuang/f23220c2-7807-4477-a125-d5f13c84ad94/scratchpad/audit.env; set +a
export DATABASE_URL=postgresql://audit:audit_0913@127.0.0.1:55432/$DB_
export MQTT_URL=mqtt://127.0.0.1:51899
export PORT=$PORT_
export RATE_LIMIT_DISABLED=1
for kv in "$@"; do export "$kv"; done
cd $ROOT/backend
echo $$ > "$EV/$LOG_.pid"
exec node dist/main > "$EV/$LOG_.log" 2>&1
