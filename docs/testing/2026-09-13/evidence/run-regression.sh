#!/bin/zsh
# 修复后的回归：既有 e2e 全量（不含 audit-*）+ 后端单测，跑在隔离库 helmet_audit 上
source ~/.nvm/nvm.sh >/dev/null 2>&1; nvm use 24 >/dev/null 2>&1
cd /Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang/backend
set -a; source /private/tmp/claude-501/-Users-dravenzhong-Desktop-AI-Smart-Helmet-01WeiChuang/f23220c2-7807-4477-a125-d5f13c84ad94/scratchpad/audit.env; set +a
export MQTT_URL=mqtt://127.0.0.1:51899 RATE_LIMIT_DISABLED=1 NODE_OPTIONS=--experimental-vm-modules
echo "### unit"; npx jest --runInBand --watchman=false 2>&1 | grep -E "^(PASS|FAIL|Tests:|Test Suites:)|●.*›" | grep -v Console
echo "### e2e (existing suites)"; npx jest --config ./test/jest-e2e.json --runInBand --watchman=false --forceExit --testPathIgnorePatterns='/node_modules/' --testPathIgnorePatterns='audit-' 2>&1 | grep -E "^(PASS|FAIL|Tests:|Test Suites:)|●.*›" | grep -v Console
echo "### done"
