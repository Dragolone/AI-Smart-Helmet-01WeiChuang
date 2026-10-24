#!/bin/bash
# 在安卓模拟器登录页用 uiautomator 找控件位置后登录（登录页可能带「登录已失效」提示框，位置会变）
export ANDROID_HOME=$HOME/Library/Android/sdk; ADB=$ANDROID_HOME/platform-tools/adb
P=com.lingyiweichuang.app
center() { python3 - "$1" "$2" <<'PY'
import re,sys
xml=open(sys.argv[1],encoding='utf-8').read(); key=sys.argv[2]
for m in re.finditer(r'<node [^>]*>', xml):
    n=m.group(0)
    if key in n:
        b=re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', n)
        if b:
            x1,y1,x2,y2=map(int,b.groups()); print((x1+x2)//2,(y1+y2)//2); break
PY
}
$ADB shell rm -f /sdcard/ui.xml; $ADB shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; $ADB pull /sdcard/ui.xml /tmp/ui-login.xml >/dev/null 2>&1
PW=$(center /tmp/ui-login.xml 'text="8 位以上"'); PH=$(center /tmp/ui-login.xml 'text="11 位大陆手机号"'); BTN=$(center /tmp/ui-login.xml 'text="登录"')
echo "phone-hint=[$PH] password=[$PW] login=[$BTN]"
if [ -n "$PH" ]; then $ADB shell input tap $PH; sleep 1; $ADB shell input text 13800009001; $ADB shell input keyevent KEYCODE_BACK; sleep 0.8; fi
[ -z "$PW" ] && { echo "no password field"; exit 1; }
$ADB shell input tap $PW; sleep 1.2; $ADB shell input text "${TEST_PASSWORD:?本地测试账号密码}"; sleep 0.5; $ADB shell input keyevent KEYCODE_BACK; sleep 1
$ADB shell rm -f /sdcard/ui.xml; $ADB shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; $ADB pull /sdcard/ui.xml /tmp/ui-login.xml >/dev/null 2>&1
BTN=$(center /tmp/ui-login.xml 'text="登录"'); echo "login btn=[$BTN]"; $ADB shell input tap $BTN
sleep 8
$ADB logcat -d -s ReactNativeJS:I 2>/dev/null | grep -E '链路启动|effect authed' | tail -2
$ADB shell dumpsys activity services $P 2>/dev/null | grep -c 'isForeground=true' | sed 's/^/foreground services: /'
