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
import json
import os
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
        self.name_only = False  # --name-only：广播不带服务 UUID
        self.device_id = device_id
        MEM[0x40:0x50] = device_id.encode("ascii").ljust(16, b"\x00")[:16]
        self.seq = 1000  # Event_Seq 开机预分配 +1000
        # 落盘的是「已预留到哪」：开机从它起步再预留 1000，保证不会复用上次运行发过的序号（周期包也占序号，
        # 原来只在存 / 擦高危帧时写盘，重启后读回旧值，重复使用发过的序号 → 服务端按 eventId 撞号另存，10-20 实测）
        self.reserved = self.seq
        self.lat, self.lng = lat, lng
        self.battery = 85
        self.subscribed = False
        self.server: Optional[BlessServer] = None
        self.pending_ack: Dict[int, Tuple[bytes, int, float]] = {}  # seq -> (frame, retries, deadline)
        # 高危离线保护队列（高危帧原样存）；落盘模拟 Flash 掉电保持，重启仿真器后仍可补传
        self.flash_file = os.path.expanduser(f"~/.helmet/ble-sim-flash.{device_id}.json")
        self.flash: List[bytes] = self._load_flash()
        # 开机先整体跳过一个区段：旧格式的落盘值（只在存 / 擦高危帧时写）可能低于上次实际用到的序号
        self.seq += 1000
        self.reserved = self.seq + 1000
        self.save_flash()
        MEM[0x34:0x38] = self.seq.to_bytes(4, "little")
        self.rtc_offset = 0  # 对时后与本机时钟差
        self.synced = False
        self.log_prefix = f"[{device_id}]"

    # —— Flash 落盘 ——
    def _load_flash(self) -> List[bytes]:
        try:
            with open(self.flash_file) as f:
                data = json.load(f)
            self.seq = max(self.seq, int(data.get("seq", self.seq)))
            return [bytes.fromhex(h) for h in data.get("frames", [])]
        except (OSError, ValueError):
            return []

    def save_flash(self) -> None:
        os.makedirs(os.path.dirname(self.flash_file), exist_ok=True)
        with open(self.flash_file, "w") as f:
            json.dump({"seq": max(self.seq, getattr(self, "reserved", self.seq)), "frames": [fr.hex() for fr in self.flash]}, f)

    # —— 工具 ——
    def now_utc(self) -> int:
        return int(time.time()) + self.rtc_offset if self.synced else 0

    def next_seq(self) -> int:
        self.seq += 1
        if self.seq >= self.reserved:  # 预留用完再续 1000 并落盘（固件同样按段预分配，省 Flash 擦写）
            self.reserved = self.seq + 1000
            self.save_flash()
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
                self.save_flash()
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
                    self.save_flash()
                    continue
                self.log(f"seq={seq} 1.5s 无 ACK，重发第 {retries + 1} 次")
                await self.notify(frame)
                self.pending_ack[seq] = (frame, retries + 1, now + 1.5)

    async def re_advertise(self) -> None:
        """macOS 中心断开后不会自动恢复广播；不能再走 server.start()（服务不可重复添加），直接重开广播。"""
        from bless.backends.corebluetooth.server import (  # type: ignore
            CBAdvertisementDataLocalNameKey,
            CBAdvertisementDataServiceUUIDsKey,
        )

        assert self.server is not None
        if await self.server.is_advertising():
            return
        delegate = self.server.peripheral_manager_delegate
        uuids = [] if self.name_only else [svc.obj.UUID() for svc in self.server.services.values()]
        await delegate.start_advertising(
            {CBAdvertisementDataLocalNameKey: self.server.name, CBAdvertisementDataServiceUUIDsKey: uuids}
        )
        self.log("已重新广播")

    async def link_watchdog(self) -> None:
        """bless 无断连回调：轮询 is_connected；中心断开后清订阅并重新广播（macOS 不会自动恢复广播）。"""
        was = False
        while True:
            await asyncio.sleep(1)
            if not self.server:
                continue
            now_conn = bool(await self.server.is_connected())
            if now_conn and not was:
                self.subscribed = True
                self.log("中心已订阅 Notify（连接建立）")
            if was and not now_conn:
                self.subscribed = False
                self.log("中心已断开 → 停止推送，重新广播")
                try:
                    await self.re_advertise()
                except Exception as e:  # noqa: BLE001
                    self.log(f"重新广播失败：{e}")
            was = now_conn

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
                    self.save_flash()
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
    ap.add_argument(
        "--name-only",
        action="store_true",
        help="广播只带本地名、不带 FEE0 服务 UUID：macOS 把 UUID 塞进广播包后本地名发不出去（手机只看到电脑名），"
        "App 20 秒一轮的全量扫描按名字能找到；代价是 iOS 后台按服务 UUID 的过滤扫描扫不到（2026-10-19）",
    )
    args = ap.parse_args()

    helmet = Helmet(args.device_id, args.lat, args.lng)
    helmet.name_only = args.name_only
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
    # 默认 prioritize_local_name=False：广播包同时带 FEE0 服务 UUID（App 按服务 UUID 过滤扫描，iOS 后台扫描硬性要求）；
    # --name-only 时让 bless 丢掉 UUID（名字超过 10 字时才会丢），本地名才发得出去
    await server.start(prioritize_local_name=args.name_only)
    helmet.log(
        f"广播中：{name}（{'只带名字、不带服务 UUID' if args.name_only else '服务 FEE0'}）。"
        f"命令：fall/sos/collision/obstacle/clear/loc/hb/offline N/quit；Flash 队列 {len(helmet.flash)} 条"
    )

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
    asyncio.create_task(helmet.link_watchdog())

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
