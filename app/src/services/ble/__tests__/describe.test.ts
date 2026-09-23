// 工程模式帧描述单测：夹具用硬件 2026-09-23 发的《BLE十六进制对照》（docs/hardware/BLE十六进制对照-2026-09-23.txt）
// 与手册 v0.6 示例帧。经纬度按字节流解析（ED 4E CD 01 = 30.232301），不按对照表标注的 30.256877。
import { describe, expect, it } from "@jest/globals";

import { hexToBytes } from "../bytes";
import {
  describeInbound,
  describeOutbound,
  eventName,
  parseHexInput,
  regName,
} from "../describe";

const h = hexToBytes;

describe("describeOutbound（对照表「常用帧」）", () => {
  it("PING / 对时 / 查离线 / 拉离线 / 恢复出厂 / 软重启", () => {
    expect(describeOutbound(h("01 01"))).toBe("PING seq=1");
    expect(describeOutbound(h("04 05 88 79 A2 6A"))).toBe(
      "TIME SYNC 1789032840（2026-09-10T09:34:00Z）",
    );
    expect(describeOutbound(h("07 06"))).toBe("RESEND QUERY seq=6");
    expect(describeOutbound(h("08 07 00 00 03"))).toBe(
      "RESEND DATA 偏移 0 条数 3",
    );
    expect(describeOutbound(h("09 08"))).toBe("RECOVERY seq=8（恢复出厂参数）");
    expect(describeOutbound(h("0A 09 01"))).toBe("RESET seq=9 参数 0x01");
  });

  it("READ / WRITE 带寄存器名；连写标出字节数", () => {
    expect(describeOutbound(h("02 01 40 10"))).toBe(
      "READ 0x40 deviceId 长度 16",
    );
    expect(describeOutbound(h("02 02 10 0A"))).toBe(
      "READ 0x10 battery 长度 10",
    );
    expect(describeOutbound(h("03 03 21 03"))).toBe(
      "WRITE 0x21 locationPeriodMoving=3",
    );
    // 对照表「开蜂鸣器 + 音量 90%」：0x23 起连写两字节
    expect(describeOutbound(h("03 04 23 01 5A"))).toBe(
      "WRITE 0x23 buzzer=1 volume=90（连写 2 字节）",
    );
  });

  it("ACK 无流水号，按事件码与 Event_Seq 描述", () => {
    expect(describeOutbound(h("06 01 65 00 00 00 00"))).toBe(
      "ACK possible_fall seq=101",
    );
  });

  it("未知指令 / 短帧不抛", () => {
    expect(describeOutbound(h("7F 01"))).toBe("未知指令 0x7f seq=1");
    expect(describeOutbound(h("01"))).toBe("帧太短（1 字节）");
  });
});

describe("describeInbound 应答帧", () => {
  it("PING 应答带状态名", () => {
    const d = describeInbound(h("01 01 00"), h("01 01"));
    expect(d).toMatchObject({ kind: "response", error: 0 });
    expect(d.text).toBe("应答 PING seq=1 · STATUS_OK");
  });

  it("READ 0x40 → deviceId；READ 0x00 → 固件", () => {
    const id = describeInbound(
      h("02 01 00 68 65 6C 6D 65 74 5F 39 34 31 37 33 66 00 00 00"),
      h("02 01 40 10"),
    );
    expect(id.text).toBe('应答 READ seq=1 · STATUS_OK · deviceId "helmet_94173f"');
    const fw = describeInbound(h("02 02 00 01 00 03"), h("02 02 00 03"));
    expect(fw.text).toBe("应答 READ seq=2 · STATUS_OK · 固件 1.0.3");
  });

  it("READ 0x10（对照表例 2）：电量 + 经纬度按字节流解析", () => {
    const d = describeInbound(
      h("02 02 00 55 00 ED 4E CD 01 17 7C 29 07"),
      h("02 02 10 0A"),
    );
    expect(d.text).toBe(
      "应答 READ seq=2 · STATUS_OK · 电量 85% 未充电 纬度 30.232301 经度 120.159255",
    );
  });

  it("READ 0x20 设置表 → 逐键列出", () => {
    const d = describeInbound(h("02 03 00 3C 05 1E"), h("02 03 20 03"));
    expect(d.text).toBe(
      "应答 READ seq=3 · STATUS_OK · heartbeatPeriod=60 locationPeriodMoving=5 locationPeriodStill=30",
    );
  });

  it("WRITE 越界 → ERR_PARAM_VALUE，error 字段给页面着色", () => {
    const d = describeInbound(h("03 07 05"), h("03 07 24 C8"));
    expect(d).toMatchObject({ kind: "response", error: 5 });
    expect(d.text).toBe("应答 WRITE seq=7 · ERR_PARAM_VALUE");
  });

  it("RESEND QUERY / DATA 的条数", () => {
    expect(describeInbound(h("07 06 00 03 00"), h("07 06")).text).toBe(
      "应答 RESEND QUERY seq=6 · STATUS_OK · 离线事件 3 条",
    );
    expect(describeInbound(h("08 07 00 03"), h("08 07 00 00 03")).text).toBe(
      "应答 RESEND DATA seq=7 · STATUS_OK · 实际 3 条",
    );
  });

  it("没有配对请求时数据段按 hex 兜底", () => {
    expect(describeInbound(h("02 09 00 55 00")).text).toBe(
      "应答 READ seq=9 · STATUS_OK · 数据 55 00",
    );
  });
});

describe("describeInbound 事件帧（对照表示例）", () => {
  it("跌倒事件：置信度 / 冲击 / 倾角 / 位置，高危标记", () => {
    const d = describeInbound(
      h("05 01 65 00 00 00 88 79 A2 6A 5F 2D 55 ED 4E CD 01 17 7C 29 07"),
    );
    expect(d).toMatchObject({
      kind: "event",
      eventCode: 1,
      eventSeq: 101,
      highRisk: true,
    });
    expect(d.text).toBe(
      "事件 possible_fall seq=101 · 2026-09-10T09:34:00Z · 置信度 95% 冲击 4.5 g 倾角 85° 位置 30.232301,120.159255",
    );
  });

  it("后方来车（collision_risk）", () => {
    const d = describeInbound(
      h("05 03 66 00 00 00 88 79 A2 6A 03 01 02 7D 00 12 37 ED 4E CD 01 17 7C 29 07"),
    );
    expect(d.text).toBe(
      "事件 collision_risk seq=102 · 2026-09-10T09:34:00Z · high vehicle rear 距离 12.5 m TTC 1.8 s 逼近 55 km/h 位置 30.232301,120.159255",
    );
  });

  it("心跳（device_status）未校时 → 标「未校时」，非高危", () => {
    const d = describeInbound(h("05 07 0A 00 00 00 00 00 00 00 55 00"));
    expect(d).toMatchObject({ kind: "event", highRisk: false });
    expect(d.text).toBe("事件 device_status seq=10 · 未校时 · 电量 85% 未充电");
  });

  it("未知事件码 / 载荷不足不抛", () => {
    const d = describeInbound(h("05 09 01 00 00 00 00 00 00 00 AA"));
    expect(d.kind).toBe("event");
    expect(d.text).toContain("未知事件 0x09");
    expect(describeInbound(h("05")).kind).toBe("unknown");
  });
});

describe("辅助", () => {
  it("parseHexInput 容忍空格 / 逗号 / 0x 前缀，拒绝奇数位与单字节", () => {
    expect(Array.from(parseHexInput("03 07 24 32")!)).toEqual([3, 7, 0x24, 0x32]);
    expect(Array.from(parseHexInput("0x01,0x05")!)).toEqual([1, 5]);
    expect(parseHexInput("010")).toBeNull();
    expect(parseHexInput("01")).toBeNull();
    expect(parseHexInput("zz")).toBeNull();
  });

  it("regName / eventName", () => {
    expect(regName(0x24)).toBe("volume");
    expect(regName(0x40)).toBe("deviceId");
    expect(regName(0x77)).toBe("0x77");
    expect(eventName(2)).toBe("manual_sos");
  });
});
