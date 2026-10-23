#!/bin/bash
# 用法：android-tap.sh "<控件 text 或 content-desc 片段>"  —— uiautomator dump 后点中心
export ANDROID_HOME=$HOME/Library/Android/sdk; ADB=$ANDROID_HOME/platform-tools/adb
$ADB shell rm -f /sdcard/ui.xml; $ADB shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; $ADB pull /sdcard/ui.xml /tmp/ui-tap.xml >/dev/null 2>&1
XY=$(python3 - "$1" <<'PY'
import re,sys
xml=open('/tmp/ui-tap.xml',encoding='utf-8').read(); key=sys.argv[1]
nodes=[m.group(0) for m in re.finditer(r'<node [^>]*>', xml)]
exact=[n for n in nodes if f'text="{key}"' in n or f'content-desc="{key}"' in n]
loose=[n for n in nodes if f'text="{key}' in n or f'content-desc="{key}' in n or key in n]
for n in exact+loose:
    if True:
        b=re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', n)
        if b:
            x1,y1,x2,y2=map(int,b.groups())
            if x2>x1 and y2>y1: print((x1+x2)//2,(y1+y2)//2); break
PY
)
[ -z "$XY" ] && { echo "not found: $1"; exit 1; }
echo "tap $1 @ $XY"; $ADB shell input tap $XY
