# AI Helmet mock RTSP — same contract as the helmet
# rtsp://<this-pc>:8554/ch0   H.264 1280x720 30fps  TCP

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$listen = "rtsp://0.0.0.0:8554/ch0"

function Find-Ffmpeg {
    $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($p in @(
        "C:\ffmpeg\bin\ffmpeg.exe",
        "$env:LOCALAPPDATA\Microsoft\WinGet\Links\ffmpeg.exe",
        "$env:ProgramFiles\ffmpeg\bin\ffmpeg.exe",
        "$env:ProgramFiles\Gyan\FFmpeg\bin\ffmpeg.exe"
    )) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

$ff = Find-Ffmpeg
if (-not $ff) {
    Write-Host ""
    Write-Host "未找到 ffmpeg。"
    Write-Host "请先安装： winget install Gyan.FFmpeg"
    Write-Host "或从 https://ffmpeg.org/download.html 下载，并把 bin 加入 PATH。"
    Write-Host ""
    exit 1
}

$ips = @()
try {
    $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne "WellKnown" } |
        Select-Object -ExpandProperty IPAddress
} catch {}

Write-Host ""
Write-Host "模拟头盔视频（与真机协议相同）"
Write-Host "  路径      /ch0"
Write-Host "  端口      8554"
Write-Host "  编码      H.264  1280x720  30fps  无音频"
Write-Host "  传输      RTSP over TCP"
Write-Host ""
Write-Host "本机 VLC 验证（打开网络串流，选项加 :rtsp-tcp）："
Write-Host "  rtsp://127.0.0.1:8554/ch0"
if ($ips) {
    Write-Host "手机 APP 使用（手机和本机连同一个 Wi-Fi）："
    foreach ($ip in $ips) {
        Write-Host ("  rtsp://{0}:8554/ch0" -f $ip)
    }
}
Write-Host ""
Write-Host "ffmpeg 监听一次只接一个客户端。先关 VLC 再开 APP。"
Write-Host "按 Ctrl+C 停止。"
Write-Host ""

& $ff -hide_banner -loglevel info -re `
    -f lavfi -i "testsrc=size=1280x720:rate=30" `
    -c:v libx264 -pix_fmt yuv420p `
    -preset ultrafast -tune zerolatency `
    -g 30 -bf 0 -an `
    -f rtsp -rtsp_flags listen -rtsp_transport tcp `
    $listen
