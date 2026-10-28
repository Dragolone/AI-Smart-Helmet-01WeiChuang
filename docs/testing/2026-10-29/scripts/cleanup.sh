#!/bin/bash
# 2026-10-29 收尾清理：把本轮测试占的硬盘全部还回去（用户要求「跑完把占硬盘的东西删掉」）
SP=/private/tmp/claude-501/-Users-dravenzhong-Desktop-AI-Smart-Helmet-01WeiChuang/2463c696-f597-444c-b2db-9ef46bbf956d/scratchpad
MAIN=/Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang
ADB=/Users/dravenzhong/Library/Android/sdk/platform-tools/adb
SIM=5FE921EA-7A65-4781-BF6F-BF9B8D711494
log(){ echo "[$(date +%H:%M:%S)] $*"; }

log "1/6 停进程（mock / 后端 / vite）"
pkill -f 'mock-device' 2>/dev/null; pkill -f 'node src/index.ts' 2>/dev/null
for p in 3000 5173; do pid=$(lsof -nP -iTCP:$p -sTCP:LISTEN -t); [ -n "$pid" ] && kill $pid; done
sleep 6

log "2/6 Docker：本轮 compose 栈 + e2e 容器/网络 + 本轮拉的镜像 + 构建缓存"
( cd "$SP/wt" && docker compose down -v --remove-orphans ) 2>&1 | tail -3
docker rm -f fr-e2e-node fr-e2e-pg 2>/dev/null; docker network rm fr-e2e-net 2>/dev/null
# 只删明确属于 scratchpad 工作副本的悬空卷（主工作区 compose 的卷不碰）
docker volume ls -q --filter dangling=true | grep -E '^(wt_|fr-e2e|[0-9a-f]{64}$)' | xargs docker volume rm 2>/dev/null
docker rmi caddy:2 docker:cli 2>/dev/null
docker builder prune -af >/dev/null 2>&1
docker system df

log "3/6 模拟器：卸载测试包并关机"
$ADB uninstall com.lingyiweichuang.app 2>/dev/null; $ADB emu kill 2>/dev/null
xcrun simctl uninstall "$SIM" com.lingyiweichuang.app 2>/dev/null; xcrun simctl shutdown "$SIM" 2>/dev/null

log "4/6 scratchpad 大文件（iOS DerivedData 7.4G / APK / 截图）"
rm -rf "$SP/dd-ios" "$SP/app-r2.apk" "$SP"/*.png

log "5/6 工作副本与本地分支"
cd "$MAIN" && git worktree remove --force "$SP/wt"; git worktree remove --force "$SP/wt-docs" 2>/dev/null; git worktree prune
for b in $(git branch --format='%(refname:short)' | grep -E '^(test/full-run-2026-10-29|fix/map-hidden-webview-updates|docs/testing-2026-10-29)$'); do git branch -D "$b"; done
git worktree list

log "6/6 磁盘对比"
df -k / | tail -1 | awk '{print "free_kb_now="$4}'; cat "$SP/disk-baseline.txt"
