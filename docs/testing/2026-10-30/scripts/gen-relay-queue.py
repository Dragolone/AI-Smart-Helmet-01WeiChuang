# 用法: gen-relay-queue.py <ownerUserId> <deviceId> <out.json> [N=10000] —— 生成 App 中转队列文件（v2 格式）：N 条 location_update + 3 条 collision_risk 夹在第 5000 条，
# 放到 App 沙盒 Documents/ble-relay-queue.<ownerUserId>.json 后冷启动即补传（REGRESSION 8.44）。iOS 模拟器沙盒路径：xcrun simctl get_app_container <udid> <bundle> data
import json, uuid, sys, datetime
owner, dev, out = sys.argv[1], sys.argv[2], sys.argv[3]
now = datetime.datetime.now(datetime.timezone.utc)
ev = []
N = int(sys.argv[4]) if len(sys.argv) > 4 else 10000
for i in range(N):
    ts = (now - datetime.timedelta(seconds=(N - i) * 0.36)).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
    ev.append({"schemaVersion": 1, "eventId": str(uuid.uuid4()), "deviceId": dev, "eventType": "location_update",
               "timestamp": ts, "firmwareVersion": "1.0.3",
               "payload": {"latitude": 22.5431 + i * 1e-5, "longitude": 114.0579 + i * 1e-5, "coordinateSystem": "gcj02",
                           "accuracy": 5, "speed": 3.2, "heading": 90, "altitude": 30}})
    if i in (5000, 5001, 5002):  # 3 条高危夹在中间：看它们是不是最先传
        ev.append({"schemaVersion": 1, "eventId": str(uuid.uuid4()), "deviceId": dev, "eventType": "collision_risk",
                   "timestamp": ts, "firmwareVersion": "1.0.3",
                   "payload": {"riskLevel": "high", "objectType": "vehicle", "direction": "rear", "distance": 12 - (i - 5000),
                               "ttcSeconds": 1.8, "approachSpeedKmh": 55, "confidence": 0.92, "algorithmVersion": "mock-risk-v1",
                               "location": {"latitude": 22.5431, "longitude": 114.0579, "coordinateSystem": "gcj02", "accuracy": 5, "speed": 3.2, "heading": 90}}})
json.dump({"v": 2, "owner": owner, "events": ev}, open(out, "w"))
print(len(ev), "events written")
