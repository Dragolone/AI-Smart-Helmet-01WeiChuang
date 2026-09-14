#!/usr/bin/env bash
# 审计 auth 领域 e2e 运行脚本（2026-09-13）。用法：run-audit-auth.sh <spec-basename> [RATE_LIMIT_DISABLED=1|0]
# 例：run-audit-auth.sh audit-auth-account 1
set -u
source ~/.nvm/nvm.sh >/dev/null && nvm use 24 >/dev/null
ROOT=/Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang
ENVF=/private/tmp/claude-501/-Users-dravenzhong-Desktop-AI-Smart-Helmet-01WeiChuang/f23220c2-7807-4477-a125-d5f13c84ad94/scratchpad/audit.env
set -a; source "$ENVF"; set +a
export DATABASE_URL=postgresql://audit:audit_0913@127.0.0.1:55432/helmet_audit_auth
export MQTT_URL=mqtt://127.0.0.1:51899
SPEC=$1; RL=${2:-1}
cd "$ROOT/backend"
if [ "$RL" = "1" ]; then export RATE_LIMIT_DISABLED=1; else unset RATE_LIMIT_DISABLED; fi
NODE_OPTIONS=--experimental-vm-modules npx jest --config ./test/jest-e2e.json --runInBand --watchman=false --forceExit "test/$SPEC.e2e-spec.ts" 2>&1 | tee "$ROOT/docs/testing/2026-09-13/evidence/auth/jest-$SPEC.txt"
