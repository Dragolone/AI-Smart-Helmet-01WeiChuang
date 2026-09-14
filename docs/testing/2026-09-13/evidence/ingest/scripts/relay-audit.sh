#!/usr/bin/env bash
# 2026-09-13 交付审计 ingest 领域：真实后端进程（PORT=3400）+ Mock Device（TRANSPORT=app-relay）剧本可复跑脚本。
# 用法：
#   relay-audit.sh start                       # 起真实进程（dist），日志 evidence/ingest/backend-3400.log
#   relay-audit.sh setup                       # 注册账号（验证码从 Console SMS 日志取）+ psql 造设备 + 绑定；凭证写 $CREDS
#   relay-audit.sh scenario <fall|sos|risk|ski|riding> <秒> [额外 env...]   # 跑一轮剧本后 SIGINT 收尾
#   relay-audit.sh command <success|failed|silent> <秒>                    # 起 Mock 后 PUT settings，轮询回执终态
#   relay-audit.sh verify <tag>                # psql 汇总该设备的 raw/sos/轨迹/事件（脱敏）
#   relay-audit.sh stop
set -euo pipefail
ROOT=/Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang
EV=$ROOT/docs/testing/2026-09-13/evidence/ingest
SCRATCH=${SCRATCH:-/private/tmp/claude-501/-Users-dravenzhong-Desktop-AI-Smart-Helmet-01WeiChuang/f23220c2-7807-4477-a125-d5f13c84ad94/scratchpad}
CREDS=${CREDS:-$SCRATCH/relay-creds.env}
WANT_PORT=${PORT:-3400}
PG="psql -h 127.0.0.1 -p 55432 -U audit -d helmet_audit_ingest -Atq"
export PGPASSWORD=audit_0913

source ~/.nvm/nvm.sh >/dev/null && nvm use 24 >/dev/null
set -a; source "$SCRATCH/audit.env"; set +a
PORT=$WANT_PORT   # audit.env 里的 PORT=3100 是主代理的，覆盖回本领域端口
API=http://127.0.0.1:$PORT
export DATABASE_URL=postgresql://audit:audit_0913@127.0.0.1:55432/helmet_audit_ingest
export MQTT_URL=mqtt://127.0.0.1:51899   # 死端口：MVP 无 4G，命令 MQTT 发布失败留 pending，由 WS/relay-ack 驱动
export PORT SOS_COUNTDOWN_SECONDS=15 SOS_SCAN_INTERVAL_MS=1000 COMMAND_ACK_TIMEOUT_SECONDS=8 COMMAND_SCAN_INTERVAL_MS=1000
export RATE_LIMIT_DISABLED=1

cmd=${1:-}; shift || true
case "$cmd" in
  start)
    if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then echo "端口 $PORT 已被占用"; exit 1; fi
    ( cd "$ROOT/backend" && nohup node dist/main.js >"$EV/backend-$PORT.log" 2>&1 & echo $! >"$SCRATCH/backend-$PORT.pid" )
    for i in $(seq 1 40); do curl -sf "$API/api/v1/health" >/dev/null 2>&1 && { echo "backend up pid=$(cat "$SCRATCH/backend-$PORT.pid")"; exit 0; }; sleep 0.5; done
    echo "backend 未就绪"; tail -20 "$EV/backend-$PORT.log"; exit 1;;
  stop)
    [ -f "$SCRATCH/backend-$PORT.pid" ] && kill "$(cat "$SCRATCH/backend-$PORT.pid")" 2>/dev/null || true
    pkill -f "mock-device/src/index.ts" 2>/dev/null || true
    echo stopped;;
  setup)
    PHONE="19$(printf '%09d' $((RANDOM * 30000 + RANDOM)))"
    PASSWORD="relay_audit_pw_$RANDOM"
    DEVICE_ID="audit_relay_$(date +%s)"
    curl -sf -X POST "$API/api/v1/auth/sms-code" -H 'content-type: application/json' -d "{\"phone\":\"$PHONE\",\"purpose\":\"register\"}" -o /dev/null
    sleep 0.3
    CODE=$(grep "MOCK SMS" "$EV/backend-$PORT.log" | grep verify_code | tail -1 | grep -oE '[0-9]{6}' | tail -1)
    [ -n "$CODE" ] || { echo "未从日志取到验证码"; exit 1; }
    REG=$(curl -s -X POST "$API/api/v1/auth/register" -H 'content-type: application/json' -d "{\"phone\":\"$PHONE\",\"password\":\"$PASSWORD\",\"code\":\"$CODE\",\"nickname\":\"relay-audit\"}")
    TOKEN=$(echo "$REG" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).accessToken')
    USER_ID=$(echo "$REG" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).user.id')
    $PG -c "insert into devices(device_id, device_secret_hash, bind_code) values ('$DEVICE_ID', repeat('0',64), 'bc_$DEVICE_ID')"
    curl -sf -X POST "$API/api/v1/devices/bind" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "{\"deviceId\":\"$DEVICE_ID\",\"bindCode\":\"bc_$DEVICE_ID\"}" >/dev/null
    printf 'RELAY_PHONE=%s\nRELAY_PASSWORD=%s\nDEVICE_ID=%s\nUSER_ID=%s\n' "$PHONE" "$PASSWORD" "$DEVICE_ID" "$USER_ID" >"$CREDS"
    echo "setup ok: device=$DEVICE_ID user=$USER_ID phone=${PHONE:0:3}****${PHONE:7}";;
  scenario)
    SCENARIO=$1; SECS=$2; shift 2
    set -a; source "$CREDS"; set +a
    SUFFIX=""; [ $# -gt 0 ] && SUFFIX="-${1%%=*}"
    LOG="$EV/mock-$SCENARIO$SUFFIX.log"
    ( cd "$ROOT/mock-device" && env TRANSPORT=app-relay API_BASE_URL=$API SCENARIO=$SCENARIO \
        LOCATION_INTERVAL_MS=500 STATUS_INTERVAL_MS=2000 RELAY_FLUSH_INTERVAL_MS=500 EMERGENCY_AFTER_POINTS=3 "$@" \
        MOCK_PID_FILE="$SCRATCH/mock.pid" python3 "$EV/scripts/run-mock.py" "$LOG" "$SECS" -- node src/index.ts )
    echo "scenario $SCENARIO done → $LOG"; grep -c "已中转" "$LOG" | sed 's/^/flush 次数: /'; grep -h "🚨\|📵\|invalid=[1-9]\|失败\|异常" "$LOG" | head -20;;
  command)
    RESULT=$1; SECS=$2
    set -a; source "$CREDS"; set +a
    LOG="$EV/mock-cmd-$RESULT.log"
    ( cd "$ROOT/mock-device" && env TRANSPORT=app-relay API_BASE_URL=$API SCENARIO=riding MOCK_CMD_RESULT=$RESULT \
        LOCATION_INTERVAL_MS=5000 STATUS_INTERVAL_MS=60000 RELAY_FLUSH_INTERVAL_MS=1000 \
        MOCK_PID_FILE="$SCRATCH/mock.pid" python3 "$EV/scripts/run-mock.py" "$LOG" "$((SECS + 4))" -- node src/index.ts & )
    sleep 2
    TOKEN=$(curl -s -X POST "$API/api/v1/auth/login" -H 'content-type: application/json' -d "{\"phone\":\"$RELAY_PHONE\",\"password\":\"$RELAY_PASSWORD\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).accessToken')
    PUT=$(curl -s -X PUT "$API/api/v1/devices/$DEVICE_ID/settings" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "{\"settings\":{\"volume_$RESULT\":7}}")
    echo "PUT → $PUT"
    CMD=$(echo "$PUT" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).commandId')
    for i in $(seq 1 $((SECS * 2))); do
      S=$(curl -s "$API/api/v1/commands/$CMD" -H "authorization: Bearer $TOKEN" | node -pe 'const c=JSON.parse(require("fs").readFileSync(0,"utf8")); `${c.status} ack=${c.ackResult} err=${c.errorCode} delivered=${c.deliveredAt?"y":"n"}`')
      echo "t+$((i/2))s $S"
      case "$S" in success*|failed*|offline*) break;; esac
      sleep 0.5
    done
    curl -s "$API/api/v1/devices/$DEVICE_ID/settings" -H "authorization: Bearer $TOKEN" | node -pe 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); "settings="+JSON.stringify(s.settings)+" last="+s.lastCommand.status'
    sleep 5  # 等 run-mock.py 到时发 SIGINT 收尾
    echo "--- mock log 命令相关:"; grep -h "命令\|回执\|relay-ack\|WS" "$LOG" | head -12;;
  verify)
    set -a; source "$CREDS"; set +a
    echo "== raw_events by source/type (device=$DEVICE_ID)"; $PG -c "select source, event_type, count(*), bool_or(clock_skew) from raw_events where device_id='$DEVICE_ID' group by 1,2 order by 1,2"
    echo "== distinct eventId == rows"; $PG -c "select count(*), count(distinct event_id) from raw_events where device_id='$DEVICE_ID'"
    echo "== sos_cases"; $PG -c "select trigger_type, status, (deadline - created_at) as countdown, finalized_at is not null as finalized from sos_cases where device_id='$DEVICE_ID' order by created_at"
    echo "== sos_notifications"; $PG -c "select n.channel, n.status, count(*) from sos_notifications n join sos_cases c on c.id=n.sos_id where c.device_id='$DEVICE_ID' group by 1,2"
    echo "== location_points (altitude)"; $PG -c "select count(*), count(altitude) as with_altitude, min(altitude), max(altitude) from location_points where device_id='$DEVICE_ID'"
    echo "== device snapshot"; $PG -c "select battery, last_seen_at is not null, settings from devices where device_id='$DEVICE_ID'"
    echo "== commands"; $PG -c "select status, ack_result, error_code, params from device_commands where device_id='$DEVICE_ID' order by issued_at";;
  *) echo "unknown cmd"; exit 1;;
esac
