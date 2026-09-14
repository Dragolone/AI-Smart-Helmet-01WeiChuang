#!/bin/zsh
# 起 Admin 浏览器验收所需的后端(3000)+Admin dev(5173)；凭证写 .admin.env（gitignore 外，不进报告）
source ~/.nvm/nvm.sh >/dev/null 2>&1; nvm use 24 >/dev/null 2>&1
R=/Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang
SP=/private/tmp/claude-501/-Users-dravenzhong-Desktop-AI-Smart-Helmet-01WeiChuang/f23220c2-7807-4477-a125-d5f13c84ad94/scratchpad
EV=$R/docs/testing/2026-09-13/evidence/admin
cd $R/backend; set -a; source $SP/audit.env; set +a
export DATABASE_URL=postgresql://audit:audit_0913@127.0.0.1:55432/helmet_audit_admin
export MQTT_URL=mqtt://127.0.0.1:51899 PORT=3010 RATE_LIMIT_DISABLED=1
node dist/main > $EV/backend-3010.log 2>&1 & echo $! > $EV/backend-3010.pid
for i in $(seq 1 40); do curl -sf http://127.0.0.1:3010/api/v1/health >/dev/null && break; sleep 0.5; done
curl -s http://127.0.0.1:3010/api/v1/health; echo
cd $R/admin; npx vite --config $EV/scripts/vite.audit.config.ts --port 5173 --strictPort > $EV/vite-5173.log 2>&1 & echo $! > $EV/vite-5173.pid
for i in $(seq 1 40); do curl -sf http://127.0.0.1:5173/ >/dev/null && break; sleep 0.5; done
curl -s -o /dev/null -w "admin dev server: %{http_code}\n" http://127.0.0.1:5173/
