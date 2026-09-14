#!/bin/zsh
# 既有 E2E 全量 + 全部业务源码覆盖率（分母 src/**/*.ts，排除 generated/spec/杂散副本）；不含 audit-* 新增用例
source ~/.nvm/nvm.sh >/dev/null 2>&1; nvm use 24 >/dev/null 2>&1
cd /Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang/backend
set -a; source /private/tmp/claude-501/-Users-dravenzhong-Desktop-AI-Smart-Helmet-01WeiChuang/f23220c2-7807-4477-a125-d5f13c84ad94/scratchpad/audit.env; set +a
export MQTT_URL=mqtt://127.0.0.1:51899 RATE_LIMIT_DISABLED=1 NODE_OPTIONS=--experimental-vm-modules
OUT=/Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang/docs/testing/2026-09-13/evidence/baseline/e2e-coverage
echo "start=$(date -u +%FT%TZ)"
npx jest --config /Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang/docs/testing/2026-09-13/evidence/baseline/jest-e2e-cov.json --runInBand --watchman=false --forceExit 2>&1 | grep -vE "MQTT 错误：connect ECONNREFUSED"
echo "rc=${pipestatus[1]}"
echo "end=$(date -u +%FT%TZ)"
