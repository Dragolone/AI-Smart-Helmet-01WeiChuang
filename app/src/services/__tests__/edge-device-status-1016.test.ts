// 设备页 / 安全页状态推导的边界补测（2026-10-16）：电量环三段的临界、大图尺寸的临界、
// 连接结论在「蓝牙适配器 × 链路阶段 × 服务端在线 × 列表新鲜」全组合下的不变式、状态药丸与安全格的映射、
// 当前头盔的挑选、蓝牙那一行的入口、电量档位的 10 / 11 / 20 / 21。
import { describe, expect, it } from "@jest/globals";
import type { DevicePublic } from "@helmet/shared";

import { translate } from "@/i18n";
import type { BleAdapterState, BleLinkPhase } from "@/stores/ble-store";
import {
  OTHER_ROW_HEIGHT,
  RING_MAX,
  RING_MIN,
  TILE_HEIGHT,
  arcSegment,
  heroRingSize,
  linkPillOf,
  otherDevicesOf,
  safetyTileOf,
} from "../device-home";
import {
  batteryTierOf,
  bleRowOf,
  commandTouches,
  isBatteryLow,
} from "../device-view";
import {
  currentHelmetOf,
  helmetLinkOf,
  isLinkFault,
  linkCheckLevelOf,
  linkLabelKey,
  linkLevelOf,
  protectionStateOf,
  sosTargetOf,
  type HelmetLink,
  type NotifyPermission,
  type ProtectionState,
} from "../safety-status";

const ADAPTERS: BleAdapterState[] = [
  "unknown",
  "unsupported",
  "unauthorized",
  "off",
  "on",
];
const PHASES: (BleLinkPhase | undefined)[] = [
  undefined,
  "idle",
  "scanning",
  "connecting",
  "handshaking",
  "connected",
  "disconnected",
  "error",
];
const LINKS: HelmetLink[] = [
  "connected",
  "online",
  "searching",
  "bluetoothOff",
  "bluetoothDenied",
  "disconnected",
  "mismatch",
  "offline",
  "unknown",
];

const dev = (
  deviceId: string,
  online: boolean,
  over: Partial<DevicePublic> = {},
): DevicePublic => ({
  deviceId,
  name: null,
  bindCode: null,
  boundAt: null,
  createdAt: "2026-10-01T00:00:00Z",
  online,
  lastSeenAt: null,
  battery: null,
  charging: null,
  signalLevel: null,
  sleeping: false,
  firmwareVersion: null,
  ...over,
});

describe("arcSegment：电量环 270° 拆三段", () => {
  const segs = (p: number) => [0, 1, 2].map((i) => arcSegment(p, i));

  it("0 和 1 两头；三分之一、三分之二正好走满前一段", () => {
    expect(segs(0)).toEqual([0, 0, 0]);
    expect(segs(1)).toEqual([1, 1, 1]);
    expect(segs(1 / 3)[0]).toBeCloseTo(1);
    expect(segs(1 / 3)[1]).toBeCloseTo(0);
    expect(segs(2 / 3)[1]).toBeCloseTo(1);
    expect(segs(2 / 3)[2]).toBeCloseTo(0);
  });

  it("一半：第一段满、第二段一半、第三段空", () => {
    expect(segs(0.5)).toEqual([1, 0.5, 0]);
  });

  it("超出 0–1（电量 101、-5）夹到两头，不画出第四段或负的", () => {
    expect(segs(1.01)).toEqual([1, 1, 1]);
    expect(segs(-0.05)).toEqual([0, 0, 0]);
    expect(arcSegment(0.5, 3)).toBe(0);
    expect(arcSegment(0.5, -1)).toBe(1);
  });

  it("各段之和 × 90° = 进度 × 270°（0–1 之间任取）", () => {
    for (const p of [0.01, 0.1, 0.2, 0.33, 0.5, 0.66, 0.8, 0.99]) {
      expect(segs(p).reduce((a, b) => a + b, 0)).toBeCloseTo(p * 3);
    }
  });
});

describe("heroRingSize 的临界", () => {
  // FIXED = 180：标题栏 + 名字 + 状态 + 留白 + 底部内边距
  const FIXED = 180;
  it("刚好放得下 280 的高度给 280；少 1 像素给 279", () => {
    const exact = FIXED + TILE_HEIGHT + RING_MAX;
    expect(heroRingSize(exact, 0)).toBe(RING_MAX);
    expect(heroRingSize(exact - 1, 0)).toBe(RING_MAX - 1);
  });

  it("有一台其他设备：多算小标题（44）和一行（60）", () => {
    const exact = FIXED + TILE_HEIGHT + 44 + OTHER_ROW_HEIGHT + RING_MAX;
    expect(heroRingSize(exact, 1)).toBe(RING_MAX);
    expect(heroRingSize(exact - 1, 1)).toBe(RING_MAX - 1);
  });

  it("小数高度向下取整；还没量到（0）或量出负数时给下限 200", () => {
    expect(heroRingSize(FIXED + TILE_HEIGHT + 250.9, 0)).toBe(250);
    expect(heroRingSize(0, 0)).toBe(RING_MIN);
    expect(heroRingSize(-100, 5)).toBe(RING_MIN);
  });

  it("一万台其他设备：仍是 200，不出负数", () => {
    expect(heroRingSize(800, 10_000)).toBe(RING_MIN);
  });
});

describe("helmetLinkOf：全组合下的不变式", () => {
  const all: {
    adapter: BleAdapterState;
    phase?: BleLinkPhase;
    online: boolean;
    fresh: boolean;
    link: HelmetLink;
  }[] = [];
  for (const adapter of ADAPTERS)
    for (const phase of PHASES)
      for (const online of [true, false])
        for (const fresh of [true, false])
          all.push({
            adapter,
            phase,
            online,
            fresh,
            link: helmetLinkOf({ online }, { phase, adapter }, fresh),
          });

  it("本机连着就是已连接——蓝牙适配器状态还没跟上（刚关蓝牙的一瞬）也一样（现状）", () => {
    for (const c of all.filter((x) => x.phase === "connected"))
      expect(c.link).toBe("connected");
  });

  it("只有本机连着才会是 connected", () => {
    for (const c of all.filter((x) => x.link === "connected"))
      expect(c.phase).toBe("connected");
  });

  it("「在线」只在列表新鲜、服务端在线、本机没有更直接的结论时出现", () => {
    for (const c of all.filter((x) => x.link === "online")) {
      expect(c.fresh).toBe(true);
      expect(c.online).toBe(true);
      expect(["connected", "disconnected", "error"]).not.toContain(c.phase);
    }
  });

  it("「待确认」只在列表拉取失败、且本机没有连接 / 掉线 / 握手失败的证据时出现", () => {
    for (const c of all.filter((x) => x.link === "unknown")) {
      expect(c.fresh).toBe(false);
      expect(["connected", "disconnected", "error"]).not.toContain(c.phase);
    }
    for (const c of all.filter(
      (x) =>
        !x.fresh &&
        !["connected", "disconnected", "error"].includes(x.phase ?? ""),
    )) {
      expect(c.link).toBe("unknown");
    }
  });

  it("握手失败（error）不管别的条件都是身份不符", () => {
    for (const c of all.filter((x) => x.phase === "error"))
      expect(c.link).toBe("mismatch");
  });

  it("蓝牙关着 / 没权限时不会说「正在搜索」", () => {
    for (const c of all.filter(
      (x) => x.adapter === "off" || x.adapter === "unauthorized",
    )) {
      expect(c.link).not.toBe("searching");
    }
  });

  it("没有链路记录（phase 为空）和 idle 结论相同", () => {
    for (const adapter of ADAPTERS)
      for (const online of [true, false])
        for (const fresh of [true, false])
          expect(
            helmetLinkOf({ online }, { phase: undefined, adapter }, fresh),
          ).toBe(helmetLinkOf({ online }, { phase: "idle", adapter }, fresh));
  });

  it("蓝牙不支持 / 状态未知时，离线头盔按搜索中或未连接走，不说成蓝牙关", () => {
    expect(
      helmetLinkOf(
        { online: false },
        { phase: "scanning", adapter: "unsupported" },
        true,
      ),
    ).toBe("searching");
    expect(
      helmetLinkOf(
        { online: false },
        { phase: "idle", adapter: "unknown" },
        true,
      ),
    ).toBe("offline");
  });

  it("每个结论都有三种语言的标题，且层级只有 ok / unknown / down 三种", () => {
    for (const link of LINKS) {
      for (const loc of ["zh-CN", "zh-TW", "en"] as const) {
        const text = translate(linkLabelKey(link), undefined, loc);
        expect(typeof text).toBe("string");
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toMatch(/^safety\./);
      }
      expect(["ok", "unknown", "down"]).toContain(linkLevelOf(link));
    }
  });

  it("颜色轻重：只有身份不符是故障红；红叉只给要用户动手的三种", () => {
    expect(LINKS.filter(isLinkFault)).toEqual(["mismatch"]);
    expect(LINKS.filter((l) => linkCheckLevelOf(l) === "bad")).toEqual([
      "bluetoothOff",
      "bluetoothDenied",
      "mismatch",
    ]);
    expect(LINKS.filter((l) => linkCheckLevelOf(l) === "ok")).toEqual([
      "connected",
      "online",
    ]);
    expect(LINKS.filter((l) => linkCheckLevelOf(l) === "unknown")).toEqual([
      "unknown",
    ]);
  });
});

describe("protectionStateOf：优先级", () => {
  const NOTIFY: (NotifyPermission | null)[] = [
    "granted",
    "denied",
    "undetermined",
    "unknown",
    null,
  ];
  const CONTACTS = [null, 0, 1, 5];

  it("没有头盔时其它一概不看", () => {
    for (const notify of NOTIFY)
      for (const contacts of CONTACTS) {
        expect(protectionStateOf({ link: null, notify, contacts })).toBe(
          "noHelmet",
        );
      }
  });

  it("连接断开压过一切；连接待确认压过通知和联系人", () => {
    for (const notify of NOTIFY)
      for (const contacts of CONTACTS) {
        expect(protectionStateOf({ link: "searching", notify, contacts })).toBe(
          "linkDown",
        );
        expect(protectionStateOf({ link: "unknown", notify, contacts })).toBe(
          "unknown",
        );
      }
  });

  it("连上之后：通知被关 > 通知没查到 / 没问过 > 联系人没拿到 > 没有联系人", () => {
    const at = (
      notify: NotifyPermission | null,
      contacts: number | null,
    ): ProtectionState =>
      protectionStateOf({ link: "connected", notify, contacts });
    expect(at("denied", 0)).toBe("notifyOff");
    expect(at("denied", null)).toBe("notifyOff");
    expect(at("undetermined", 3)).toBe("unknown");
    expect(at("unknown", 3)).toBe("unknown");
    expect(at(null, 3)).toBe("unknown");
    expect(at("granted", null)).toBe("unknown");
    expect(at("granted", 0)).toBe("noContacts");
    expect(at("granted", 1)).toBe("ready");
    expect(at("granted", 5)).toBe("ready");
  });

  it("服务端在线（另一条通道在带）和本机连着同样算连上", () => {
    expect(
      protectionStateOf({ link: "online", notify: "granted", contacts: 2 }),
    ).toBe("ready");
  });
});

describe("safetyTileOf / linkPillOf 的完整映射", () => {
  it("安全格：没有头盔和待确认都是灰色的「确认不了」，不亮提醒色", () => {
    for (const state of ["noHelmet", "unknown"] as const) {
      expect(safetyTileOf(state, "connected")).toEqual({
        text: "devices.safety.unknown",
        tone: "unknown",
      });
    }
  });

  it("安全格：连接断开时，离线 / 刚掉线 / 搜索中都写同一句「没连上」，提醒色", () => {
    for (const link of [
      "offline",
      "disconnected",
      "searching",
      "unknown",
    ] as const) {
      expect(safetyTileOf("linkDown", link)).toEqual({
        text: "devices.safety.linkDown",
        tone: "warn",
      });
    }
  });

  it("药丸：只有已连接 / 在线算连上；只有搜索中带转圈；待确认单独一句", () => {
    const pills = LINKS.map((l) => [l, linkPillOf(l)] as const);
    expect(pills.filter(([, p]) => p.linked).map(([l]) => l)).toEqual([
      "connected",
      "online",
    ]);
    expect(pills.filter(([, p]) => p.searching).map(([l]) => l)).toEqual([
      "searching",
    ]);
    expect(linkPillOf("unknown").text).toBe("devices.link.unknown");
    for (const l of [
      "bluetoothOff",
      "bluetoothDenied",
      "disconnected",
      "mismatch",
      "offline",
    ] as const) {
      expect(linkPillOf(l)).toEqual({
        text: "devices.link.notConnected",
        linked: false,
        searching: false,
      });
    }
  });
});

describe("otherDevicesOf / currentHelmetOf 的边", () => {
  it("当前头盔不在列表里（刚解绑）：其他设备就是全部", () => {
    const list = [dev("a", false), dev("b", true)];
    expect(
      otherDevicesOf(list, "gone", (d) => d.online).map((d) => d.deviceId),
    ).toEqual(["b", "a"]);
  });

  it("空列表：没有其他设备、没有当前头盔、求救也没有可记的头盔", () => {
    expect(otherDevicesOf([], "a", () => true)).toEqual([]);
    expect(currentHelmetOf([], "a")).toBeUndefined();
    expect(sosTargetOf([], null)).toBeUndefined();
  });

  it("选过的那台不在线、另有在线的：用在线的那台（求救不记到没开机的头盔上）", () => {
    const list = [dev("a", false), dev("b", false), dev("c", true)];
    expect(currentHelmetOf(list, "a")?.deviceId).toBe("c");
    expect(sosTargetOf(list, "a")?.deviceId).toBe("c");
  });

  it("都在线、选过的已解绑：取第一台在线的；都不在线、选过的已解绑：取第一台", () => {
    expect(
      currentHelmetOf([dev("a", true), dev("b", true)], "gone")?.deviceId,
    ).toBe("a");
    expect(
      currentHelmetOf([dev("a", false), dev("b", false)], "gone")?.deviceId,
    ).toBe("a");
  });

  it("列表里同一个编号出现两次（缓存合并出错）：取先出现的那条，不抛", () => {
    const first = dev("a", true, { name: "first" });
    const second = dev("a", true, { name: "second" });
    expect(currentHelmetOf([first, second], "a")).toBe(first);
  });
});

describe("电量档位与蓝牙那一行", () => {
  it("10 / 11 / 20 / 21 的分界；0 与 100；超出范围的照样归档", () => {
    expect([0, 10, 11, 20, 21, 100].map(batteryTierOf)).toEqual([
      "critical",
      "critical",
      "low",
      "low",
      "ok",
      "ok",
    ]);
    expect(batteryTierOf(101)).toBe("ok");
    expect(batteryTierOf(-1)).toBe("critical");
    expect(batteryTierOf(10.5)).toBe("low");
    expect(batteryTierOf(20.01)).toBe("ok");
  });

  it("没有读数：null / undefined / NaN 都是 none，也不算低电量", () => {
    for (const b of [null, undefined, Number.NaN]) {
      expect(batteryTierOf(b)).toBe("none");
    }
    expect(isBatteryLow(null)).toBe(false);
    expect(isBatteryLow(undefined)).toBe(false);
  });

  it("isBatteryLow 与 batteryTierOf 在 0–100 的每个整数上口径一致", () => {
    for (let b = 0; b <= 100; b += 1) {
      expect(isBatteryLow(b)).toBe(batteryTierOf(b) !== "ok");
    }
  });

  it("蓝牙那一行：只有确定开着、有链路记录、没连上才给「重试」", () => {
    for (const adapter of ADAPTERS) {
      for (const phase of PHASES) {
        const { action } = bleRowOf(adapter, phase);
        const retry =
          adapter === "on" && phase !== undefined && phase !== "connected";
        if (adapter === "off") expect(action).toBe("bluetoothSettings");
        else if (adapter === "unauthorized") expect(action).toBe("appSettings");
        else expect(action === "retry").toBe(retry);
      }
    }
  });

  it("commandTouches：参数里的键值是 undefined / null 也算改了这一项；继承来的键不算", () => {
    expect(commandTouches({ params: { volume: undefined } }, "volume")).toBe(
      true,
    );
    expect(
      commandTouches({ params: { volume: null } as never }, "volume"),
    ).toBe(true);
    expect(commandTouches({ params: {} }, "toString")).toBe(false);
    expect(commandTouches({ params: {} }, "__proto__")).toBe(false);
  });
});
