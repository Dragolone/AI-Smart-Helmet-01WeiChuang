#!/bin/zsh
# 公共环境：Node 24 + audit.env + 本领域专用库/Broker 覆盖。用法：source env.sh
source ~/.nvm/nvm.sh >/dev/null && nvm use 24 >/dev/null
REPO=/Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang
SP=/private/tmp/claude-501/-Users-dravenzhong-Desktop-AI-Smart-Helmet-01WeiChuang/f23220c2-7807-4477-a125-d5f13c84ad94/scratchpad
EV=$REPO/docs/testing/2026-09-13/evidence/mqtt
set -a; source $SP/audit.env; set +a
export DATABASE_URL=postgresql://audit:audit_0913@127.0.0.1:55432/helmet_audit_mqtt
export MQTT_URL=mqtt://127.0.0.1:51883
export PORT=3100
export API=http://127.0.0.1:3100/api/v1
# 加速口径（仅审计）：SOS 15s、命令回执超时 8s、扫描 1s
export SOS_COUNTDOWN_SECONDS=15 SOS_SCAN_INTERVAL_MS=1000 COMMAND_ACK_TIMEOUT_SECONDS=8 COMMAND_SCAN_INTERVAL_MS=1000
psqlq() { docker exec helmet-audit-0913-pg psql -U audit -d helmet_audit_mqtt -At -c "$1"; }
