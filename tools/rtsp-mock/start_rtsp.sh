#!/usr/bin/env bash
# 无硬件视频测试流（macOS / Linux 版）：与硬件 2026-09-23 发的 Windows 包 start_rtsp.ps1 同一约定，
# 也就是和真机头盔同一约定——rtsp://<本机>:8554/ch0，H.264 1280x720 30fps，无音频，RTSP over TCP。
# 真机差别只有主机：头盔热点 X821cam / Aa123456，固定 IP 192.168.176.1（docs/DEVICE_PROTOCOL.md §1.3）。
#
# 实现：MediaMTX 当 RTSP 服务器收流，ffmpeg 把彩条测试图推进去。不用 ffmpeg 自带的 listen 模式，
# 因为 ffmpeg 9 已把 RTSP muxer 的 `-rtsp_flags listen` 去掉（Windows 脚本在老版本上才能跑），
# 而且 MediaMTX 允许 VLC 和 App 同时拉流，不用先关一个再开另一个。
# 用法：tools/rtsp-mock/start_rtsp.sh      依赖：brew install ffmpeg mediamtx
set -euo pipefail
cd "$(dirname "$0")"

for bin in ffmpeg mediamtx; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "未找到 $bin，先执行：brew install ffmpeg mediamtx" >&2
    exit 1
  fi
done

if lsof -nP -iTCP:8554 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 8554 已被占用（上次的测试流没停？）：lsof -nP -iTCP:8554" >&2
  exit 1
fi

mediamtx mediamtx.yml > /tmp/helmet-rtsp-mock-mediamtx.log 2>&1 &
mtx_pid=$!
trap 'kill "$mtx_pid" 2>/dev/null || true' EXIT INT TERM

for _ in $(seq 1 20); do
  lsof -nP -iTCP:8554 -sTCP:LISTEN >/dev/null 2>&1 && break
  sleep 0.5
done
if ! lsof -nP -iTCP:8554 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "MediaMTX 没起来，看 /tmp/helmet-rtsp-mock-mediamtx.log" >&2
  exit 1
fi

echo
echo "模拟头盔视频（与真机协议相同）"
echo "  路径   /ch0"
echo "  端口   8554"
echo "  编码   H.264  1280x720  30fps  无音频"
echo "  传输   RTSP over TCP"
echo
echo "本机验证（VLC 打开网络串流，选项加 :rtsp-tcp；或 ffplay -rtsp_transport tcp）："
echo "  rtsp://127.0.0.1:8554/ch0"
echo "手机 App 使用（手机和本机连同一个 Wi-Fi）："
for ip in $(ifconfig 2>/dev/null | awk '/inet / && $2 != "127.0.0.1" {print $2}'); do
  echo "  rtsp://${ip}:8554/ch0"
done
echo
echo "VLC 和 App 可以同时拉。Ctrl+C 停止（MediaMTX 一起退出）。"
echo

ffmpeg -hide_banner -loglevel warning -stats -re \
  -f lavfi -i "testsrc=size=1280x720:rate=30" \
  -c:v libx264 -pix_fmt yuv420p \
  -preset ultrafast -tune zerolatency \
  -g 30 -bf 0 -an \
  -f rtsp -rtsp_transport tcp \
  rtsp://127.0.0.1:8554/ch0
