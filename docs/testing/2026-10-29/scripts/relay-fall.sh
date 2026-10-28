#!/bin/bash
# usage: relay-fall.sh <deviceId> [possible_fall|manual_sos] — 用 app-relay 入口替某顶头盔注入一条求救事件（用户 JWT 来自 chain-at.txt）
SP=/private/tmp/claude-501/-Users-dravenzhong-Desktop-AI-Smart-Helmet-01WeiChuang/2463c696-f597-444c-b2db-9ef46bbf956d/scratchpad
dev=$1; type=${2:-possible_fall}
AT=$(cat "$SP/chain-at.txt"); id=$(uuidgen | tr 'A-Z' 'a-z'); ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if [ "$type" = possible_fall ]; then
  payload='{"confidence":0.9,"algorithmVersion":"mock-fall-v1","impactG":4.2,"tiltDeg":80,"location":{"latitude":22.5431,"longitude":114.0579,"coordinateSystem":"gcj02","accuracy":5,"speed":0,"heading":0}}'
else
  payload='{"triggerMode":"long_press","pressDurationMs":2100,"location":{"latitude":22.5431,"longitude":114.0579,"coordinateSystem":"gcj02","accuracy":5,"speed":0,"heading":0}}'
fi
curl -s -m 8 -X POST http://localhost:3000/api/v1/ingest/app-relay -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' \
  -d "{\"deviceId\":\"$dev\",\"envelopes\":[{\"schemaVersion\":1,\"eventId\":\"$id\",\"deviceId\":\"$dev\",\"eventType\":\"$type\",\"timestamp\":\"$ts\",\"firmwareVersion\":\"1.0.3\",\"payload\":$payload}]}"
echo " <- $type for $dev eventId=$id at $ts"
