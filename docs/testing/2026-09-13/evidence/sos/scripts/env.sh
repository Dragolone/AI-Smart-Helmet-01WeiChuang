# SOS 真实进程重启复验（2026-09-13 审计 §4）：环境变量。专用库 helmet_audit_sos；MQTT 指向死端口（不连 EMQX）。
export REPO=/Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang
export EV=$REPO/docs/testing/2026-09-13/evidence/sos
export SP=/private/tmp/claude-501/-Users-dravenzhong-Desktop-AI-Smart-Helmet-01WeiChuang/f23220c2-7807-4477-a125-d5f13c84ad94/scratchpad
source ~/.nvm/nvm.sh >/dev/null && nvm use 24 >/dev/null
set -a; source $SP/audit.env; set +a
export DATABASE_URL=postgresql://audit:audit_0913@127.0.0.1:55432/helmet_audit_sos
export MQTT_URL=mqtt://127.0.0.1:51899
export PORT=3300
export SOS_SCAN_INTERVAL_MS=1000
export SOS_COUNTDOWN_SECONDS=20
export API=http://127.0.0.1:$PORT/api/v1
