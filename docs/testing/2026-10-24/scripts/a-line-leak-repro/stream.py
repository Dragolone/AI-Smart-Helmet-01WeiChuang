"""内存缓涨复现（回归 8.55）：DEV=<模拟器序列号> python3 stream.py <分钟> <Hz> <设备,设备…> [标签]；Hz=0 只心跳
每 1/Hz 秒经 app-relay 给指定设备送一个位置点；每 30 s 给两顶 e2e 头盔送心跳（保持在线）；每 60 s 记 Native Heap / PSS / 进程号。"""
import sys, json, time, math, subprocess, re, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import lib
ADB = [os.path.expanduser("~/Library/Android/sdk/platform-tools/adb"), "-s", os.environ.get("DEV", "emulator-5556")]
P = "com.lingyiweichuang.app"
mins, hz, dev = float(sys.argv[1]), float(sys.argv[2]), sys.argv[3]; tag = sys.argv[4] if len(sys.argv) > 4 else dev
devs = dev.split(",")  # 多个设备用逗号隔开：逐条轮流发（总频率 = hz）
u = json.load(open(lib.S + "/user-e2e.json"))  # {"phone": ..., "pw": ...}; tok = lib.login(u["phone"], u["pw"]); relog = time.time() + 600
def sh(*a): return subprocess.run(ADB + ["shell", *a], capture_output=True, text=True, stdin=subprocess.DEVNULL).stdout
def mem():
    """App Summary 各分类（MB）：Java / Native / Code / Stack / Graphics / Private Other / System / TOTAL PSS"""
    out = sh("dumpsys", "meminfo", P)
    def g(label):
        m = re.search(label + r":\s+(\d+)", out); return int(m.group(1)) // 1024 if m else -1
    pss = re.search(r"TOTAL PSS:\s+(\d+)", out) or re.search(r"TOTAL\s+(\d+)", out)
    return {"java": g("Java Heap"), "native": g("Native Heap"), "code": g("Code"), "stack": g("Stack"), "gfx": g("Graphics"),
            "other": g("Private Other"), "sys": g("System"), "pss": int(pss.group(1)) // 1024 if pss else -1}
def fmt(m, m0=None):
    keys = ("java", "native", "code", "gfx", "other", "sys", "pss")
    return " ".join(f"{k}={m[k]}" + (f"({m[k]-m0[k]:+d})" if m0 else "") for k in keys)
def heartbeat():
    for d in ("helmet_e2e_map", "helmet_e2e_ski"):
        lib.req("POST", "/ingest/app-relay", {"deviceId": d, "envelopes": [lib.env(d, "device_status", {"battery": 80, "charging": False, "signalLevel": 3, "online": True})]}, tok, timeout=10)
t0 = time.time(); n = 0; errs = 0; nextlog = t0; nexthb = t0; pid0 = sh("pidof", P).strip()
heartbeat(); m0 = mem()
print(f"[{tag}] start pid={pid0} rate={hz}Hz dev={dev} {fmt(m0)}", flush=True)
while time.time() - t0 < mins * 60:
    now = time.time()
    if now >= relog: tok = lib.login(u["phone"], u["pw"]); relog += 600
    if now >= nexthb: heartbeat(); nexthb += 30
    if hz <= 0:  # 只心跳不发位置（对照组）
        if time.time() >= nextlog:
            m = mem(); print(f"[{tag}] +{(time.time()-t0)/60:4.1f} min sent={n} errs={errs} pid={sh('pidof', P).strip()} {fmt(m, m0)}", flush=True); nextlog += 60
        time.sleep(1); continue
    a = n / 600 * 2 * math.pi
    d_ = devs[n % len(devs)]
    env = lib.env(d_, "location_update", {"latitude": 22.54 + 0.01 * math.sin(a), "longitude": 113.95 + 0.01 * math.cos(a), "coordinateSystem": "wgs84", "accuracy": 5, "speed": 6.0, "heading": (n * 7) % 360, "altitude": 12})
    st, r = lib.req("POST", "/ingest/app-relay", {"deviceId": d_, "envelopes": [env]}, tok, timeout=10)
    if st not in (200, 201, 202): errs += 1
    n += 1
    if time.time() >= nextlog:
        m = mem()
        print(f"[{tag}] +{(time.time()-t0)/60:4.1f} min sent={n} errs={errs} pid={sh('pidof', P).strip()} {fmt(m, m0)}", flush=True)
        nextlog += 60
    time.sleep(max(0, 1 / hz - (time.time() - now)))
m = mem()
print(f"[{tag}] end sent={n} errs={errs} over {mins} min pid={sh('pidof', P).strip()} (start {pid0}) {fmt(m, m0)}", flush=True)
