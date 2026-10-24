#!/bin/bash
# 每 60 秒记一次双端内存：安卓 dumpsys meminfo TOTAL PSS；iOS 用 simctl spawn 的 ps RSS
export ANDROID_HOME=$HOME/Library/Android/sdk; ADB=$ANDROID_HOME/platform-tools/adb
UDID=5FE921EA-7A65-4781-BF6F-BF9B8D711494
OUT=/private/tmp/claude-501/-Users-dravenzhong-Desktop-AI-Smart-Helmet-01WeiChuang/2463c696-f597-444c-b2db-9ef46bbf956d/scratchpad/logs/soak.log
for i in $(seq 1 45); do
  A=$($ADB shell dumpsys meminfo com.lingyiweichuang.app 2>/dev/null | grep -E '^\s+TOTAL PSS:|TOTAL\s+[0-9]+' | head -1 | grep -oE '[0-9]+' | head -1)
  APID=$($ADB shell pidof com.lingyiweichuang.app 2>/dev/null | tr -d '\r')
  IPID=$(xcrun simctl spawn $UDID launchctl list 2>/dev/null | grep -i 'lingyiweichuang' | awk '{print $1}' | head -1)
  I=$( [ -n "$IPID" ] && ps -o rss= -p "$IPID" 2>/dev/null | tr -d ' ')
  echo "$(date +%H:%M:%S) android_pss_kb=$A android_pid=$APID ios_rss_kb=$I ios_pid=$IPID crashes=$($ADB logcat -d -s AndroidRuntime:E 2>/dev/null | grep -c FATAL)" >> "$OUT"
  sleep 60
done
