#!/usr/bin/env bash
# 真实进程限频验证（2026-09-13 auth 审计）：node dist/main.js（main.ts 开 trust proxy=1），不设 RATE_LIMIT_DISABLED。
# ① 同 IP+手机号 login 11 次 → 第 11 次 429 + Retry-After；② 直连时逐条伪造 X-Forwarded-For 发码 → 是否绕过；
# ③ 固定 XFF 6 条 → 第 6 条 429。短信走 Console Mock（audit.env 无 TENCENT_SMS_*），不发真实短信。
set -u
source ~/.nvm/nvm.sh >/dev/null && nvm use 24 >/dev/null
ROOT=/Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang
EV=$ROOT/docs/testing/2026-09-13/evidence/auth
ENVF=/private/tmp/claude-501/-Users-dravenzhong-Desktop-AI-Smart-Helmet-01WeiChuang/f23220c2-7807-4477-a125-d5f13c84ad94/scratchpad/audit.env
set -a; source "$ENVF"; set +a
export DATABASE_URL=postgresql://audit:audit_0913@127.0.0.1:55432/helmet_audit_auth
export MQTT_URL=mqtt://127.0.0.1:51899
export PORT=${AUDIT_PORT:-3160}  # audit.env 的 PORT=3100 属 mqtt 代理，这里固定用 3160
unset RATE_LIMIT_DISABLED
LOG=$EV/real-ratelimit.log
: > "$LOG"
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$LOG"; }
if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then log "端口 $PORT 已被占用，放弃"; exit 2; fi
cd "$ROOT/backend"
node dist/main.js > "$EV/real-backend-stdout.log" 2>&1 &
PID=$!
log "backend pid=$PID port=$PORT 启动中"
for i in $(seq 1 40); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/api/v1/health"; then break; fi
  sleep 0.5
done
if ! curl -s -o /dev/null "http://127.0.0.1:$PORT/api/v1/health"; then log "health 不可达"; kill $PID; exit 3; fi
log "health OK"
BASE="http://127.0.0.1:$PORT/api/v1"
PHONE="19$(printf '%09d' $((RANDOM * 32768 + RANDOM)))"
# ① login 同 IP+手机号
codes=""
for i in $(seq 1 11); do
  out=$(curl -s -o /dev/null -w '%{http_code} %header{retry-after}' -H 'Content-Type: application/json' \
    -X POST "$BASE/auth/login" -d "{\"phone\":\"$PHONE\",\"password\":\"wrong_pw_1\"}")
  codes="$codes [$i:$out]"
done
log "login 同号 ×11（真实进程）→$codes"
# ② 直连 + 伪造 XFF（逐条换）
codes=""
for i in $(seq 1 8); do
  P="19$(printf '%09d' $((RANDOM * 32768 + RANDOM)))"
  out=$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -H "X-Forwarded-For: 203.0.113.$i" \
    -X POST "$BASE/auth/sms-code" -d "{\"phone\":\"$P\",\"purpose\":\"register\"}")
  codes="$codes $out"
done
log "sms-code 逐条换 XFF ×8（trust proxy=1，直连）→$codes"
# ③ 固定 XFF
codes=""
for i in $(seq 1 6); do
  P="19$(printf '%09d' $((RANDOM * 32768 + RANDOM)))"
  out=$(curl -s -o /dev/null -w '%{http_code}/%header{retry-after}' -H 'Content-Type: application/json' -H "X-Forwarded-For: 198.51.100.9" \
    -X POST "$BASE/auth/sms-code" -d "{\"phone\":\"$P\",\"purpose\":\"register\"}")
  codes="$codes $out"
done
log "sms-code 固定 XFF ×6 →$codes"
# ④ 无 XFF（socket 地址 127.0.0.1）
codes=""
for i in $(seq 1 6); do
  P="19$(printf '%09d' $((RANDOM * 32768 + RANDOM)))"
  out=$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
    -X POST "$BASE/auth/sms-code" -d "{\"phone\":\"$P\",\"purpose\":\"register\"}")
  codes="$codes $out"
done
log "sms-code 无 XFF ×6（按 127.0.0.1 计）→$codes"
# ⑤ 429 响应体格式
body=$(curl -s -H 'Content-Type: application/json' -X POST "$BASE/auth/login" -d "{\"phone\":\"$PHONE\",\"password\":\"wrong_pw_1\"}")
log "429 响应体 → $body"
kill $PID; wait $PID 2>/dev/null
log "backend 已停止"
# 清理本脚本产生的验证码行（只删自己造的 19 开头随机号 24h 内记录由服务自行清理；此处不动库）
