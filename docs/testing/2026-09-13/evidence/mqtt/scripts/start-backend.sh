#!/bin/zsh
# 启动真实后端进程（PORT=3100，专用库，真实 EMQX 51883）；日志追加到 EV/backend-<tag>.log；PID 写 scratchpad
source "$(dirname "$0")/env.sh"
TAG=${1:-main}
cd $REPO/backend
nohup node dist/main >> $EV/backend-$TAG.log 2>&1 &
echo $! > $SP/mqtt/backend.pid
echo "backend pid $(cat $SP/mqtt/backend.pid) log $EV/backend-$TAG.log"
for i in {1..30}; do curl -sf -o /dev/null $API/health 2>/dev/null && break; curl -s -o /dev/null -w '%{http_code}' $API/devices | grep -q 401 && break; sleep 0.5; done
