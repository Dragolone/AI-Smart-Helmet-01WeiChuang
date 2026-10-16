#!/bin/sh
# PostgreSQL 每日自动备份到 COS（上线前清单 #6 ①）。宿主机 cron 调用，例：
#   0 3 * * * /home/ubuntu/AI-Smart-Helmet-01WeiChuang/deploy/backup.sh >> /home/ubuntu/helmet-backup.log 2>&1
# 日志必须写到 cron 用户可写的位置：普通用户写 /var/log 会因重定向失败而整条任务不执行（2026-09-18~22 实际踩中，4 天无备份）。
# 服务器没装 MTA，cron 的失败输出会被丢弃——脚本失败不会自动通知任何人，定期看日志或 COS backups/ 的最新时间。
# 流程：postgres 容器 pg_dump -Fc（自定义格式，自带压缩，pg_restore 可选表恢复）
#      → 管道进 backend 容器 node dist/scripts/backup-upload.js（COS 凭证只在容器里，宿主机不落密钥）
#      → 对象键 backups/helmet_<UTC 时间>.dump；上传后按 BACKUP_RETENTION_DAYS 清理旧备份（至少留 BACKUP_KEEP_MIN 份）
# 可选 BACKUP_LOCAL_DIR：同时在宿主机留一份（如 /opt/helmet-backups），自行用 find -mtime 清理。
# 任一环节失败脚本以非 0 退出并打印 ✕ 行——拨测/cron 邮件据此告警。
# pg_dump 先落临时文件、成功了才上传：/bin/sh 是 dash，没有 pipefail，原来 `dump | 上传` 时 pg_dump 中途失败，
# 截断的文件头照样是 PGDMP，会被当成有效备份传上去、打印「备份完成」（2026-10-17 评审实测）。
set -eu

cd "$(dirname "$0")"
COMPOSE="docker compose -f docker-compose.prod.yml"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
KEY="backups/helmet_${STAMP}.dump"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
KEEP_MIN="${BACKUP_KEEP_MIN:-7}"

echo "[$(date -u +%FT%TZ)] 开始备份 → ${KEY}（保留 ${RETENTION_DAYS} 天，至少 ${KEEP_MIN} 份）"

TMP=$(mktemp "${TMPDIR:-/tmp}/helmet_${STAMP}.XXXXXX")
trap 'rm -f "$TMP"' EXIT

# compose exec 透传 pg_dump 的退出码：失败时 set -e 直接退出，不上传、不清理旧备份
$COMPOSE exec -T postgres pg_dump -U helmet -Fc --no-owner helmet > "$TMP"
$COMPOSE exec -T backend node dist/scripts/backup-upload.js --key "$KEY" --retention-days "$RETENTION_DAYS" --keep-min "$KEEP_MIN" < "$TMP"

if [ -n "${BACKUP_LOCAL_DIR:-}" ]; then
  mkdir -p "$BACKUP_LOCAL_DIR"
  LOCAL="$BACKUP_LOCAL_DIR/helmet_${STAMP}.dump"
  mv "$TMP" "$LOCAL"
  echo "[$(date -u +%FT%TZ)] 本地副本：$LOCAL（$(du -h "$LOCAL" | cut -f1)）"
fi

echo "[$(date -u +%FT%TZ)] 备份完成"
