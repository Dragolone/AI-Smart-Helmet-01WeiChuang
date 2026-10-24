#!/bin/bash
# 长时 soak 采样：每 120 s 记后端 RSS / PG 连接数 / EMQX 内存 / 双端 App 内存 / 安卓崩溃数 / 事件入库总数
export ANDROID_HOME=$HOME/Library/Android/sdk; ADB=$ANDROID_HOME/platform-tools/adb
UDID=5FE921EA-7A65-4781-BF6F-BF9B8D711494
OUT=/private/tmp/claude-501/-Users-dravenzhong-Desktop-AI-Smart-Helmet-01WeiChuang/2463c696-f597-444c-b2db-9ef46bbf956d/scratchpad/logs/longsoak.log
END=$(date -j -f '%H:%M' '11:45' +%s 2>/dev/null)
while [ "$(date +%s)" -lt "$END" ]; do
  BPID=$(lsof -nP -iTCP:3000 -sTCP:LISTEN -t 2>/dev/null | head -1)
  B=$( [ -n "$BPID" ] && ps -o rss= -p "$BPID" | tr -d ' ')
  PG=$(docker exec helmet-postgres psql -U helmet -d helmet -At -c "select count(*) from pg_stat_activity where datname='helmet'" 2>/dev/null)
  EV=$(docker exec helmet-postgres psql -U helmet -d helmet -At -c "select count(*) from raw_events" 2>/dev/null)
  EM=$(docker stats --no-stream --format '{{.MemUsage}}' helmet-emqx 2>/dev/null | cut -d/ -f1 | tr -d ' ')
  A=$($ADB shell dumpsys meminfo com.lingyiweichuang.app 2>/dev/null | grep -E 'TOTAL PSS:|TOTAL\s+[0-9]+' | head -1 | grep -oE '[0-9]+' | head -1)
  APID=$($ADB shell pidof com.lingyiweichuang.app 2>/dev/null | tr -d '\r')
  IPID=$(xcrun simctl spawn $UDID launchctl list 2>/dev/null | grep -i 'lingyiweichuang' | awk '{print $1}' | head -1)
  I=$( [ -n "$IPID" ] && ps -o rss= -p "$IPID" 2>/dev/null | tr -d ' ')
  echo "$(date +%H:%M:%S) backend_rss_kb=$B pg_conn=$PG raw_events=$EV emqx=$EM android_pss_kb=$A android_pid=$APID ios_rss_kb=$I ios_pid=$IPID android_crashes=$($ADB logcat -d -s AndroidRuntime:E 2>/dev/null | grep -c FATAL)" >> "$OUT"
  sleep 120
done
echo "longsoak sampler done $(date +%T)" >> "$OUT"
