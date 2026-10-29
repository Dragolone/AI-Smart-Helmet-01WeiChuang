#!/bin/bash
# usage: footprint.sh <label> — 每分钟记一行安卓 App 的 Native Heap / Java Heap / Unknown / Graphics / TOTAL PSS（KB），写到 $FOOTPRINT_LOG（默认 ~/footprint.log）
ADB=$HOME/Library/Android/sdk/platform-tools/adb; P=com.lingyiweichuang.app
LOG=${FOOTPRINT_LOG:-$HOME/footprint.log}
while true; do
  m=$($ADB shell dumpsys meminfo $P 2>/dev/null)
  nh=$(echo "$m" | awk '/Native Heap:/{print $3; exit}'); dv=$(echo "$m" | awk '/Java Heap:/{print $3; exit}')
  un=$(echo "$m" | awk '/^ *Unknown:/{print $2; exit}'); tot=$(echo "$m" | awk '/TOTAL PSS:/{print $3; exit}')
  gfx=$(echo "$m" | awk '/Graphics:/{print $2; exit}')
  echo "$(date +%H:%M:%S) $1 native_heap=$nh dalvik=$dv unknown=$un graphics=$gfx total_pss=$tot" >> "$LOG"
  sleep 60
done
