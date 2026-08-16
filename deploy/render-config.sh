#!/bin/sh
# 渲染生产配置：把 deploy/.env 的密钥填进模板，产出 deploy/generated/（gitignored）
# 用法：cd deploy && sh render-config.sh
set -eu

cd "$(dirname "$0")"

[ -f .env ] || { echo "错误：deploy/.env 不存在。先 cp .env.example .env 并填入真实值。"; exit 1; }

# 只取渲染需要的键，不 source 整个文件（值里可能有特殊字符）
EMQX_INTERNAL_TOKEN=$(grep -E '^EMQX_INTERNAL_TOKEN=' .env | head -1 | cut -d= -f2-)

[ -n "$EMQX_INTERNAL_TOKEN" ] || { echo "错误：deploy/.env 里 EMQX_INTERNAL_TOKEN 为空。用 openssl rand -hex 32 生成一个。"; exit 1; }
case "$EMQX_INTERNAL_TOKEN" in
  *[!A-Za-z0-9_-]*) echo "错误：EMQX_INTERNAL_TOKEN 只能含字母/数字/_/-（它要进 URL 和 sed，别用特殊字符，openssl rand -hex 32 天然满足）。"; exit 1 ;;
esac

mkdir -p generated
sed "s|__EMQX_INTERNAL_TOKEN__|$EMQX_INTERNAL_TOKEN|g" emqx.prod.conf.template > generated/emqx.conf

echo "已生成 deploy/generated/emqx.conf（含密钥，勿提交、勿外传）"
