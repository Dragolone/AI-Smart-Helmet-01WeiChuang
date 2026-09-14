#!/bin/zsh
# 一键复跑：真实 dist 进程 + SIGKILL + 重启接管 + 「notified 但通知行 pending」续投。输出 EV/real-process-restart.log/.json
source "$(dirname "$0")/env.sh"
cd $REPO/backend
node "$EV/scripts/restart-recovery.mjs" 2>&1 | tee "$EV/real-process-restart.log"
