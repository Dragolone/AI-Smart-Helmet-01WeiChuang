"""本地后端小工具：req / env / login（A 线 10-25 内存缓涨复现用）"""
import json, uuid, datetime, urllib.request, urllib.error, os
S = os.environ.get("LEAK_WORKDIR", os.path.dirname(os.path.abspath(__file__)))  # 账号文件 user-e2e.json 放这里（不入库）
API = os.environ.get("API", "http://127.0.0.1:3000/api/v1")
def req(method, path, body=None, tok=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    h = {"content-type": "application/json"}
    if tok: h["authorization"] = "Bearer " + tok
    r = urllib.request.Request(API + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as f:
            raw = f.read(); return f.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw)
        except Exception: return e.code, raw.decode("utf-8", "ignore")
def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
def env(device_id, event_type, payload, ts=None):
    return {"schemaVersion": 1, "eventId": str(uuid.uuid4()), "deviceId": device_id, "eventType": event_type,
            "timestamp": ts or now_iso(), "firmwareVersion": "1.0.0", "payload": payload}
def login(phone, password):
    st, d = req("POST", "/auth/login", {"phone": phone, "password": password})
    assert st == 200, (st, d); return d["accessToken"]
