#!/bin/zsh
# 按 CI 口径跑全部 e2e（含 audit-*）：不加载 backend/.env，只给 CI 里有的四个变量，单库单进程顺序执行
source ~/.nvm/nvm.sh >/dev/null 2>&1; nvm use 24 >/dev/null 2>&1
cd /Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang/backend
: > /tmp/audit-empty.env
export DOTENV_CONFIG_PATH=/tmp/audit-empty.env
export DATABASE_URL=postgresql://audit:audit_0913@127.0.0.1:55432/helmet_audit
export JWT_SECRET=ci_only_test_secret ADMIN_JWT_SECRET=ci_only_admin_secret EMQX_INTERNAL_TOKEN=ci_only_internal_token
unset MQTT_URL MQTT_BACKEND_USERNAME MQTT_BACKEND_PASSWORD INGEST_WEBHOOK_API_KEY TRTC_SDK_APP_ID TRTC_SECRET_KEY
echo "start=$(date -u +%FT%TZ)"
npm run test:e2e -- --watchman=false 2>&1 | grep -E "^(PASS|FAIL|Tests:|Test Suites:|Time:)|●.*›" | grep -v Console
echo "end=$(date -u +%FT%TZ)"
