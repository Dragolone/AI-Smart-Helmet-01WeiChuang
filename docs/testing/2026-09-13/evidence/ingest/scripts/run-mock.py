#!/usr/bin/env python3
"""起 Mock Device 跑 N 秒后发 SIGINT（非交互 bash 的 & 子进程会忽略 SIGINT，故用 Python 以默认信号处置启动）。
用法：run-mock.py <log> <seconds> -- <cmd...>   环境变量原样继承。"""
import os, signal, subprocess, sys, time
log, secs = sys.argv[1], float(sys.argv[2])
cmd = sys.argv[sys.argv.index('--') + 1:]
with open(log, 'w') as f:
    p = subprocess.Popen(cmd, stdout=f, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                         restore_signals=True, start_new_session=True)
    with open(os.environ.get('MOCK_PID_FILE', '/dev/null'), 'w') as pf:
        pf.write(str(p.pid))
    try:
        p.wait(timeout=secs)
    except subprocess.TimeoutExpired:
        p.send_signal(signal.SIGINT)
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            p.kill()
sys.exit(0)
