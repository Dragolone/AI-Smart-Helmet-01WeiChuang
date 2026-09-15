#!/usr/bin/env python3
"""BLE 头盔仿真器（bless，macOS CoreBluetooth 外设）——严格按 v0.6 手册实现 GATT Server。

用途：硬件未到之前，用 Mac 扮演头盔，让真机 App 跑通「广播→连接→握手→事件→ACK→补传→设置写入」全链路。
不是 Mock Device Simulator（那是云端 MQTT 侧）；本脚本只覆盖 BLE 近场协议，事件经 App 中转到云端。

用法：
    python3 tools/ble-helmet-sim/helmet_sim.py --device-id helmet_94173f
    交互命令（stdin）：fall | sos | collision | obstacle | clear | loc | hb | offline N | quit
      offline N：模拟离线期间产生 N 条跌倒事件压入 Flash（重连后走 0x07/0x08 补传）
依赖：pip install bless（已在开发机安装）；Mac 蓝牙需开启（blueutil -p 1）。
"""
import argparse
import asyncio
import struct
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

from bless import (  # type: ignore
    BlessGATTCharacteristic,
    BlessServer,
    GATTAttributePermissions,
    GATTCharacteristicProperties,
)

SERVICE = "0000FEE0-0000-1000-8000-00805F9B34FB"
CHAR_A = "0000FEE1-0000-1000-8000-00805F9B34FB"  # notify
CHAR_B = "0000FEE2-0000-1000-8000-00805F9B34FB"  # write

INS_PING, INS_READ, INS_WRITE, INS_TIME, INS_EVENT, INS_ACK, INS_RQ, INS_RD, INS_RECOVERY, INS_RESET = range(1, 11)
HIGH_RISK = {1, 2, 3, 4}

# 内存控制表（手册 §2.0 默认值）
MEM = bytearray(0x60)
MEM[0x00:0x03] = bytes([1, 0, 3])
MEM[0x03] = 0x12
MEM[0x04:0x06] = (1).to_bytes(2, "little")
MEM[0x08] = 0  # 仿真默认解锁
MEM[0x0A] = 85
MEM[0x20] = 60
MEM[0x21] = 5
MEM[0x22] = 30
MEM[0x23] = 1
MEM[0x24] = 80
MEM[0x25] = 2
MEM[0x26] = 0
MEM[0x27] = 1
MEM[0x28] = 2
MEM[0x29] = 1
MEM[0x2A] = 15
MEM[0x2B] = 1
MEM[0x2C] = 1
MEM[0x2D] = 0
WRITABLE = {0x04, 0x05, 0x08, *range(0x20, 0x2E), *range(0x40, 0x50), *range(0x50, 0x60)}
RANGES = {0x24: (1, 100), 0x25: (0, 3), 0x26: (0, 3), 0x28: (1, 3), 0x2A: (5, 30)}


class Helmet:
    def __init__(self, device_id: str, lat: float, lng: float):
        self.device_id = device_id
        MEM[0x40:0x50] = device_id.encode("ascii").ljust(16, b"\x00")[:16]
        self.seq = 1000  # Event_Seq 开机预分配 +1000
        MEM[0x34:0x38] = self.seq.to_bytes(4, "little")
        self.lat, self.lng = lat, lng
        self.battery = 85
        self.subscribed = False
        self.server: Optional[BlessServer] = None
        self.pending_ack: Dict[int, Tuple[bytes, int, float]] = {}  # seq -> (frame, retries, deadline)
        self.flash: List[bytes] = []  # 高危离线保护队列（高危帧原样存）
        self.rtc_offset = 0  # 对时后与本机时钟差
        self.synced = False
        self.log_prefix = f"[{device_id}]"

    # —— 工具 ——
    def now_utc(self) -> int:
        return int(time.time()) + self.rtc_offset if self.synced else 0

    def next_seq(self) -> int:
        self.seq += 1
        return self.seq

    def log(self, msg: str) -> None:
        print(f"{self.log_prefix} {msg}", flush=True)

    def coord(self) -> bytes:
        return struct.pack("<ii", int(self.lat * 1e6), int(self.lng * 1e6))

    # —— 事件帧 ——
    def event_frame(self, code: int, payload: bytes, seq: Optional[int] = None, ts: Optional[int] = None) -> bytes:
        s = seq if seq is not None else self.next_seq()
        t = ts if ts is not None else self.now_utc()
        return bytes([INS_EVENT, code]) + struct.pack("<II", s, t) + payload

    def payload_fall(self) -> bytes:
        return bytes([95, 45, 85]) + self.coord()

    def payload_sos(self) -> bytes:
        return bytes([1]) + struct.pack("<H", 2300) + self.coord()

    def payload_risk(self, level: int = 3, obj: int = 1, direction: int = 2) -> bytes:
        return bytes([level, obj, direction]) + struct.pack("<H", 125) + bytes([18, 55]) + self.coord()

    def payload_loc(self) -> bytes:
        self.lat += 0.00004
        self.lng += 0.00003
        return self.coord() + struct.pack("<HHB h", 68, 900, 5, 42)

    def payload_hb(self) -> bytes:
        self.battery = max(0, self.battery - 1)
        MEM[0x0A] = self.battery
        return bytes([self.battery, 0])

    # —— 发送 ——
    async def notify(self, frame: bytes) -> None:
        if not self.server or not self.subscribed:
            return
        char = self.server.get_characteristic(CHAR_A)
        char.value = bytearray(frame)
        self.server.update_value(SERVICE, CHAR_A)
        self.log(f"notify ← {frame.hex(' ')}")

    async def emit(self, code: int, payload: bytes) -> None:
        frame = self.event_frame(code, payload)
        if not self.subscribed:
            if code in HIGH_RISK:
                self.flash.append(frame)
                self.log(f"离线：高危事件 code={code} seq={self.seq} 压入 Flash（队列 {len(self.flash)}）")
            return  # 周期事件离线即丢（FIFO 语义，仿真不保存），不刷屏
        await self.notify(frame)
        if code in HIGH_RISK:
            self.pending_ack[self.seq] = (frame, 0, time.time() + 1.5)

    async def ack_watchdog(self) -> None:
        while True:
            await asyncio.sleep(0.2)
            now = time.time()
            for seq, (frame, retries, deadline) in list(self.pending_ack.items()):
                if now < deadline:
                    continue
                if retries >= 3:
                    self.log(f"seq={seq} 重发 3 次无 ACK → 压入 Flash 保护队列")
                    del self.pending_ack[seq]
                    self.flash.append(frame)
                    continue
                self.log(f"seq={seq} 1.5s 无 ACK，重发第 {retries + 1} 次")
                await self.notify(frame)
                self.pending_ack[seq] = (frame, retries + 1, now + 1.5)

    async def periodic(self) -> None:
        last_loc = last_hb = 0.0
        while True:
            await asyncio.sleep(0.5)
            now = time.time()
            if now - last_loc >= MEM[0x21]:
                last_loc = now
                await self.emit(0x06, self.payload_loc())
            if now - last_hb >= MEM[0x20]:
                last_hb = now
                await self.emit(0x07, self.payload_hb())

    # —— 下行处理 ——
    async def handle_write(self, data: bytes) -> None:
        self.log(f"write → {data.hex(' ')}")
        if len(data) < 2:
            return
        ins = data[0]
        if ins == INS_ACK:
            if len(data) >= 7:
                seq = struct.unpack("<I", data[2:6])[0]
                if self.pending_ack.pop(seq, None) is not None:
                    self.log(f"ACK seq={seq} 妥投")
                before = len(self.flash)
                self.flash = [f for f in self.flash if struct.unpack("<I", f[2:6])[0] != seq]
                if len(self.flash) != before:
                    self.log(f"ACK seq={seq} → Flash 擦除（剩余 {len(self.flash)}）")
            return
        seq = data[1]
        resp: bytes
        if ins == INS_PING:
            resp = bytes([ins, seq, 0])
        elif ins == INS_READ and len(data) >= 4:
            addr, length = data[2], data[3]
            if addr + length > len(MEM):
                resp = bytes([ins, seq, 3])
            elif 0x50 <= addr < 0x60:
                resp = bytes([ins, seq, 2])  # deviceSecret 只写不可读
            else:
                resp = bytes([ins, seq, 0]) + bytes(MEM[addr : addr + length])
        elif ins == INS_WRITE and len(data) >= 4:
            addr, payload = data[2], data[3:]
            if addr + len(payload) > len(MEM):
                resp = bytes([ins, seq, 3])
            elif MEM[0x08] == 1 and addr != 0x08:
                resp = bytes([ins, seq, 4])
            elif any((addr + i) not in WRITABLE for i in range(len(payload))):
                resp = bytes([ins, seq, 3])
            else:
                bad = False
                for i, b in enumerate(payload):
                    lo, hi = RANGES.get(addr + i, (0, 255))
                    if not lo <= b <= hi:
                        bad = True
                if bad:
                    resp = bytes([ins, seq, 5])
                else:
                    MEM[addr : addr + len(payload)] = payload
                    self.log(f"内存表写入 0x{addr:02X} = {payload.hex(' ')}")
                    resp = bytes([ins, seq, 0])
        elif ins == INS_TIME and len(data) >= 6:
            utc = struct.unpack("<I", data[2:6])[0]
            self.rtc_offset = utc - int(time.time())
            self.synced = True
            self.log(f"对时 → UTC {utc}（偏移 {self.rtc_offset}s）")
            resp = bytes([ins, seq, 0])
        elif ins == INS_RQ:
            resp = bytes([ins, seq, 0]) + struct.pack("<H", len(self.flash))
        elif ins == INS_RD and len(data) >= 5:
            offset = struct.unpack("<H", data[2:4])[0]
            count = data[4]
            batch = self.flash[offset : offset + count]
            for frame in batch:
                await self.notify(frame)
                await asyncio.sleep(0.04)  # 补发流控 30–50ms
            resp = bytes([ins, seq, 0, len(batch)])
        elif ins == INS_RECOVERY:
            resp = bytes([ins, seq, 0])
        elif ins == INS_RESET and len(data) >= 3:
            resp = bytes([ins, seq, 0])
        else:
            resp = bytes([ins, seq, 2 if ins not in range(1, 11) else 1])
        await self.notify(resp)


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--device-id", default="helmet_94173f")
    ap.add_argument("--lat", type=float, default=22.5431)
    ap.add_argument("--lng", type=float, default=114.0579)
    args = ap.parse_args()

    helmet = Helmet(args.device_id, args.lat, args.lng)
    name = f"Helmet-{args.device_id[-6:]}"
    loop = asyncio.get_running_loop()
    server = BlessServer(name=name, loop=loop)
    helmet.server = server

    def on_read(char: BlessGATTCharacteristic, **_: Any) -> bytearray:
        return char.value or bytearray(b"\x00")

    def on_write(char: BlessGATTCharacteristic, value: Any, **_: Any) -> None:
        if str(char.uuid).upper() == CHAR_B:
            asyncio.run_coroutine_threadsafe(helmet.handle_write(bytes(value)), loop)

    server.read_request_func = on_read
    server.write_request_func = on_write

    await server.add_new_service(SERVICE)
    await server.add_new_characteristic(
        SERVICE, CHAR_A,
        GATTCharacteristicProperties.notify | GATTCharacteristicProperties.read,
        None, GATTAttributePermissions.readable,  # CoreBluetooth：带缓存值的特征必须只读，动态值传 None
    )
    await server.add_new_characteristic(
        SERVICE, CHAR_B,
        GATTCharacteristicProperties.write | GATTCharacteristicProperties.write_without_response,
        None, GATTAttributePermissions.writeable,
    )
    await server.start()
    helmet.log(f"广播中：{name}（服务 FEE0）。命令：fall/sos/collision/obstacle/clear/loc/hb/offline N/quit")

    # bless 没有通用的「订阅状态」回调：把 CCCD 语义近似为「服务已启动且有中心连接」——
    # 首次收到任何 write（握手 Step 3 READ 在开 Notify 之后）即视为已订阅。
    orig = helmet.handle_write

    async def handle_write_and_mark(data: bytes) -> None:
        if not helmet.subscribed:
            helmet.subscribed = True
            helmet.log("收到首个下行帧 → 视为 Notify 已订阅（连接建立）")
        await orig(data)

    helmet.handle_write = handle_write_and_mark  # type: ignore[method-assign]

    asyncio.create_task(helmet.ack_watchdog())
    asyncio.create_task(helmet.periodic())

    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)
    while True:
        line = (await reader.readline()).decode().strip()
        if not line:
            continue
        cmd, *rest = line.split()
        if cmd == "quit":
            break
        if cmd == "fall":
            await helmet.emit(0x01, helmet.payload_fall())
        elif cmd == "sos":
            await helmet.emit(0x02, helmet.payload_sos())
        elif cmd == "collision":
            await helmet.emit(0x03, helmet.payload_risk())
        elif cmd == "obstacle":
            await helmet.emit(0x04, helmet.payload_risk(2, 3, 1))
        elif cmd == "clear":
            await helmet.emit(0x05, b"\x00\x00\x00\x00")
        elif cmd == "loc":
            await helmet.emit(0x06, helmet.payload_loc())
        elif cmd == "hb":
            await helmet.emit(0x07, helmet.payload_hb())
        elif cmd == "disconnect":
            helmet.subscribed = False
            helmet.log("模拟断连：后续高危事件进 Flash")
        elif cmd == "offline":
            n = int(rest[0]) if rest else 1
            was = helmet.subscribed
            helmet.subscribed = False
            for _ in range(n):
                await helmet.emit(0x01, helmet.payload_fall())
            helmet.subscribed = was
            helmet.log(f"Flash 队列现有 {len(helmet.flash)} 条，App 下次握手会补传")
        else:
            helmet.log(f"未知命令 {cmd}")
    await server.stop()


if __name__ == "__main__":
    asyncio.run(main())
