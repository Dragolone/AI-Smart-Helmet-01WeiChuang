#!/usr/bin/env python3
# 本地慢网代理：:3000 → :3001（后端）。每读到一段客户端数据，按 slow-proxy.json 决定推迟多久再转发，并记下每个 HTTP 请求到达的时刻。
# slow-proxy.json: {"all": 秒, "rules": [{"match": "子串", "delay": 秒, "drop": false}]} —— match 对请求首行；all 对其余全部（含 WS 帧）。文件每次都重读，改了即生效。
import asyncio, json, os, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
CFG = os.path.join(HERE, "slow-proxy.json"); LOG = os.path.join(HERE, "logs", "slow-proxy.log")
METHODS = (b"GET ", b"POST ", b"PUT ", b"PATCH ", b"DELETE ", b"HEAD ", b"OPTIONS ")
def cfg():
    try: return json.load(open(CFG))
    except Exception: return {}
def log(line):
    with open(LOG, "a") as f: f.write(time.strftime("%H:%M:%S") + (".%03d " % (time.time() % 1 * 1000)) + line + "\n")
async def pump_up(r, w):
    try:
        while True:
            chunk = await r.read(65536)
            if not chunk: break
            c = cfg(); delay = float(c.get("all", 0)); drop = False; first = None
            if chunk.startswith(METHODS):
                first = chunk.split(b"\r\n", 1)[0].decode("latin1")
                for rule in c.get("rules", []):
                    if rule.get("match", "\0") in first:
                        delay = float(rule.get("delay", delay)); drop = bool(rule.get("drop"))
                        if rule.get("once"):
                            c["rules"].remove(rule); json.dump(c, open(CFG, "w"))
                        break
                if "/health" not in first: log(f"REQ  {first}  delay={delay}{' DROP' if drop else ''}")
            if drop: break
            if delay > 0: await asyncio.sleep(delay)
            if first and "/health" not in first and delay > 0: log(f"SENT {first}")
            w.write(chunk); await w.drain()
    except (ConnectionError, asyncio.CancelledError): pass
    finally:
        try: w.close()
        except Exception: pass
async def pump_down(r, w):
    try:
        while True:
            chunk = await r.read(65536)
            if not chunk: break
            d = float(cfg().get("down", 0))
            if d > 0: await asyncio.sleep(d)
            w.write(chunk); await w.drain()
    except (ConnectionError, asyncio.CancelledError): pass
    finally:
        try: w.close()
        except Exception: pass
async def handle(cr, cw):
    try: ur, uw = await asyncio.open_connection("127.0.0.1", 3001)
    except OSError:
        cw.close(); return
    await asyncio.gather(pump_up(cr, uw), pump_down(ur, cw))
async def main():
    srv = await asyncio.start_server(handle, "0.0.0.0", 3000)
    async with srv: await srv.serve_forever()
asyncio.run(main())
