#!/bin/bash
# 在 Linux 容器里跑后端 e2e。macOS 本机 kern.ipc.somaxconn=128，压力 / 限频 / 大量 WS 连接的用例
# 会报 ECONNRESET，不是代码问题；容器里 somaxconn=4096，与 GitHub Actions 的结果一致。
#
# 用法：
#   run-e2e-in-container.sh                 全量
#   run-e2e-in-container.sh edge-cases sos  只跑文件名匹配的套件（jest 路径匹配，空格分隔）
#   run-e2e-in-container.sh --down          删掉容器和网络
set -euo pipefail

NET=helmet-e2e-net
PG=helmet-e2e-pg
NODE=helmet-e2e-node
DB_URL="postgresql://helmet:helmet_ci@${PG}:5432/helmet_ci"

if [ "${1:-}" = "--down" ]; then
  docker rm -f "$PG" "$NODE" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  echo "已清理 $PG / $NODE / $NET"
  exit 0
fi

cd "$(git rev-parse --show-toplevel)"

docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
if ! docker ps --format '{{.Names}}' | grep -qx "$PG"; then
  docker rm -f "$PG" >/dev/null 2>&1 || true
  # 数据放内存盘：e2e 每次都重建库，不需要落盘
  docker run -d --name "$PG" --network "$NET" \
    -e POSTGRES_USER=helmet -e POSTGRES_PASSWORD=helmet_ci -e POSTGRES_DB=helmet_ci \
    --tmpfs /var/lib/postgresql/data postgres:16 -c max_connections=300 >/dev/null
fi
if ! docker ps --format '{{.Names}}' | grep -qx "$NODE"; then
  docker rm -f "$NODE" >/dev/null 2>&1 || true
  docker run -d --name "$NODE" --network "$NET" --sysctl net.core.somaxconn=4096 \
    -w /work node:24-bookworm sleep infinity >/dev/null
fi

# 拷工作区当前内容进容器（含未提交改动，不含被忽略的文件）。源码目录先清掉，删掉的文件才不会残留；
# node_modules 留在容器文件系统里，不走挂载，装一次之后每次都快。
# 显式跳过 node_modules：在 worktree 里把 node_modules 做成软链时，`.gitignore` 的 `node_modules/`（带斜杠）
# 不匹配软链，`git ls-files -o` 会把它当未跟踪文件列出来，解包时撞上容器里的真目录整条管道退出 2（2026-10-14）
docker exec "$NODE" sh -c 'rm -rf /work/backend/src /work/backend/test /work/backend/prisma /work/backend/scripts /work/packages/shared/src /work/mock-device/src'
git ls-files -co --exclude-standard -- package.json package-lock.json .nvmrc backend packages mock-device \
  | while IFS= read -r f; do case "$f" in *node_modules*) continue;; esac; [ -e "$f" ] && printf '%s\n' "$f"; done \
  | COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -cf - -T - 2>/dev/null \
  | docker exec -i "$NODE" sh -c 'tar -xf - -C /work 2>/dev/null'

until docker exec "$PG" pg_isready -U helmet >/dev/null 2>&1; do sleep 1; done
docker exec "$PG" psql -U helmet -d postgres -q \
  -c 'DROP DATABASE IF EXISTS helmet_ci WITH (FORCE)' -c 'CREATE DATABASE helmet_ci'

docker exec \
  -e DATABASE_URL="$DB_URL" -e JWT_SECRET=ci_only_test_secret \
  -e ADMIN_JWT_SECRET=ci_only_admin_secret -e EMQX_INTERNAL_TOKEN=ci_only_internal_token \
  -e CI=true "$NODE" sh -c '
    set -e
    cd /work
    [ -d node_modules/.bin ] || npm ci -w backend -w packages/shared -w mock-device --include-workspace-root --no-audit --no-fund
    npm run build -w @helmet/shared
    cd backend
    npx prisma migrate deploy
    npm run build
    npm run test:e2e -- "$@"
  ' sh "$@"
