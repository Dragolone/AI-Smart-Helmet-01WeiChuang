#!/bin/zsh
# 停止本审计启动的后端（只杀 PORT=3100 的 dist/main）
source "$(dirname "$0")/env.sh"
PID=$(lsof -nP -iTCP:3100 -sTCP:LISTEN -t 2>/dev/null)
[ -n "$PID" ] && kill ${=PID} && echo "stopped $PID" || echo "no backend on 3100"
