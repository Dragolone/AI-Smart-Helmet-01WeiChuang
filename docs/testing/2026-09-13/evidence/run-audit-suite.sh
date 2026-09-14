#!/bin/zsh
# 用法：run-audit-suite.sh <db-suffix> <test-file...>；如 run-audit-suite.sh voice audit-voice
source ~/.nvm/nvm.sh >/dev/null 2>&1; nvm use 24 >/dev/null 2>&1
cd /Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang/backend
set -a; source /private/tmp/claude-501/-Users-dravenzhong-Desktop-AI-Smart-Helmet-01WeiChuang/f23220c2-7807-4477-a125-d5f13c84ad94/scratchpad/audit.env; set +a
DB=$1; shift
export DATABASE_URL="postgresql://audit:audit_0913@127.0.0.1:55432/helmet_audit_${DB}"
export MQTT_URL=mqtt://127.0.0.1:51899 RATE_LIMIT_DISABLED=1 NODE_OPTIONS=--experimental-vm-modules
FILES=""
for f in "$@"; do FILES="$FILES test/$f.e2e-spec.ts"; done
npx jest --config ./test/jest-e2e.json --runInBand --watchman=false --forceExit $=FILES 2>&1 | grep -vE "MQTT 错误：connect ECONNREFUSED"
