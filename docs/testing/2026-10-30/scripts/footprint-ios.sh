#!/bin/bash
# usage: footprint-ios.sh <label> — 每分钟记一行 iOS 模拟器里 App 进程的 physical footprint（vmmap --summary）与 MALLOC 总量
LOG=${FOOTPRINT_LOG:-$HOME/footprint-ios.log}
while true; do
  pid=$(pgrep -f "Containers/Bundle/Application/.*/app.app/app$" | head -1)
  if [ -n "$pid" ]; then
    v=$(vmmap --summary "$pid" 2>/dev/null)
    fp=$(echo "$v" | awk '/Physical footprint:/{print $3; exit}')
    mz=$(echo "$v" | awk '/^MALLOC ZONE/{f=1} f && /TOTAL/{print $2; exit}')
    echo "$(date +%H:%M:%S) $1 pid=$pid footprint=$fp malloc_total=$mz" >> "$LOG"
  else
    echo "$(date +%H:%M:%S) $1 no app process" >> "$LOG"
  fi
  sleep 60
done
