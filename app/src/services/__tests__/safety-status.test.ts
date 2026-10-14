// 安全首页状态卡的推导：守住「确认不了的不算正常」与 SOS 关联规则不被顺手改掉。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@jest/globals";
import type { DevicePublic } from "@helmet/shared";

import {
  currentHelmetOf,
  helmetLinkOf,
  isLinkFault,
  linkCheckLevelOf,
  linkLevelOf,
  protectionStateOf,
  sosTargetOf,
} from "../safety-status";

const dev = (deviceId: string, online: boolean): DevicePublic => ({
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
});

describe("helmetLinkOf", () => {
  const on = { adapter: "on" as const };

  it("本机蓝牙连着就是已连接，不管服务端状态拿没拿到", () => {
    expect(
      helmetLinkOf({ online: false }, { ...on, phase: "connected" }, false),
    ).toBe("connected");
  });

  it("本机链路刚掉：服务端还显示在线（90 秒窗口）也按断开算", () => {
    expect(
      helmetLinkOf({ online: true }, { ...on, phase: "disconnected" }, true),
    ).toBe("disconnected");
  });

  it("链路掉线的原因是蓝牙被关 / 权限被收回时，直接说原因", () => {
    expect(
      helmetLinkOf(
        { online: true },
        { adapter: "off", phase: "disconnected" },
        true,
      ),
    ).toBe("bluetoothOff");
    expect(
      helmetLinkOf(
        { online: false },
        { adapter: "unauthorized", phase: "disconnected" },
        true,
      ),
    ).toBe("bluetoothDenied");
  });

  it("握手失败单独成一类，不混进「未连接」", () => {
    expect(
      helmetLinkOf({ online: true }, { ...on, phase: "error" }, true),
    ).toBe("mismatch");
  });

  it("设备列表拉取失败时，缓存里的 online 不能当真", () => {
    expect(
      helmetLinkOf({ online: true }, { ...on, phase: "scanning" }, false),
    ).toBe("unknown");
    expect(helmetLinkOf({ online: true }, { adapter: "unknown" }, false)).toBe(
      "unknown",
    );
  });

  it("本机没连、服务端在线：另一条通道在带它（Mock / 另一台手机）", () => {
    expect(
      helmetLinkOf({ online: true }, { ...on, phase: "scanning" }, true),
    ).toBe("online");
    expect(
      helmetLinkOf({ online: true }, { adapter: "unsupported" }, true),
    ).toBe("online");
  });

  it("离线时按能说清的原因依次给：蓝牙关 → 没权限 → 正在找 → 未连接", () => {
    const off = { online: false };
    expect(helmetLinkOf(off, { adapter: "off", phase: "idle" }, true)).toBe(
      "bluetoothOff",
    );
    expect(
      helmetLinkOf(off, { adapter: "unauthorized", phase: "idle" }, true),
    ).toBe("bluetoothDenied");
    for (const phase of ["scanning", "connecting", "handshaking"] as const) {
      expect(helmetLinkOf(off, { ...on, phase }, true)).toBe("searching");
    }
    expect(helmetLinkOf(off, { ...on, phase: "idle" }, true)).toBe("offline");
    expect(helmetLinkOf(off, { adapter: "unsupported" }, true)).toBe("offline");
  });

  it("只有已连接 / 在线算连上；查不到算待确认；其余（含一直在搜索）都算没连上", () => {
    expect(linkLevelOf("connected")).toBe("ok");
    expect(linkLevelOf("online")).toBe("ok");
    expect(linkLevelOf("unknown")).toBe("unknown");
    for (const down of [
      "searching",
      "bluetoothOff",
      "bluetoothDenied",
      "disconnected",
      "mismatch",
      "offline",
    ] as const) {
      expect(linkLevelOf(down)).toBe("down");
    }
  });
});

describe("颜色轻重：红色只留给故障，头盔没连上是常态", () => {
  it("没连上（关机 / 搜索中 / 刚掉线）是提醒，不是红叉", () => {
    for (const resting of ["offline", "searching", "disconnected"] as const) {
      expect(linkCheckLevelOf(resting)).toBe("warn");
      expect(isLinkFault(resting)).toBe(false);
    }
  });

  it("要用户动手改的设置（蓝牙关、没给权限）是红叉，但状态卡仍是提醒色", () => {
    for (const blocked of ["bluetoothOff", "bluetoothDenied"] as const) {
      expect(linkCheckLevelOf(blocked)).toBe("bad");
      expect(isLinkFault(blocked)).toBe(false);
    }
  });

  it("身份不符是唯一让状态卡变红的连接状态", () => {
    expect(linkCheckLevelOf("mismatch")).toBe("bad");
    expect(isLinkFault("mismatch")).toBe(true);
  });

  it("连着是对勾，确认不了是问号", () => {
    expect(linkCheckLevelOf("connected")).toBe("ok");
    expect(linkCheckLevelOf("online")).toBe("ok");
    expect(linkCheckLevelOf("unknown")).toBe("unknown");
  });
});

describe("protectionStateOf", () => {
  const ok = {
    link: "connected" as const,
    notify: "granted" as const,
    contacts: 2,
  };

  it("三项都核实过才算正常", () => {
    expect(protectionStateOf(ok)).toBe("ready");
    expect(protectionStateOf({ ...ok, link: "online" })).toBe("ready");
  });

  it("没有头盔", () => {
    expect(protectionStateOf({ ...ok, link: null })).toBe("noHelmet");
  });

  it("任何一项还确认不了，都不显示正常", () => {
    expect(protectionStateOf({ ...ok, link: "unknown" })).toBe("unknown");
    expect(protectionStateOf({ ...ok, notify: null })).toBe("unknown");
    expect(protectionStateOf({ ...ok, notify: "unknown" })).toBe("unknown");
    // 系统还没问过用户：没被拒，但也没开
    expect(protectionStateOf({ ...ok, notify: "undetermined" })).toBe(
      "unknown",
    );
    expect(protectionStateOf({ ...ok, contacts: null })).toBe("unknown");
  });

  it("多项同时有问题时的先后：连接断开 > 确认不了 > 通知被关 > 没有联系人", () => {
    expect(
      protectionStateOf({ link: "offline", notify: "denied", contacts: 0 }),
    ).toBe("linkDown");
    // 头盔关机：本机一直在搜索——这是没连上，不是「正在确认」
    expect(protectionStateOf({ ...ok, link: "searching" })).toBe("linkDown");
    expect(
      protectionStateOf({ link: "unknown", notify: "denied", contacts: 0 }),
    ).toBe("unknown");
    expect(
      protectionStateOf({ link: "connected", notify: "denied", contacts: 0 }),
    ).toBe("notifyOff");
    expect(protectionStateOf({ ...ok, contacts: 0 })).toBe("noContacts");
  });
});

describe("当前头盔：设备页大图、安全页、App 内求救记在谁名下，是同一顶", () => {
  const a = dev("helmet_a", false);
  const b = dev("helmet_b", true);
  const c = dev("helmet_c", true);

  it("求救：没在设备页选过时，第一台在线的，都离线则第一台", () => {
    expect(sosTargetOf([a, b], null)?.deviceId).toBe("helmet_b");
    expect(sosTargetOf([a, dev("helmet_d", false)], null)?.deviceId).toBe(
      "helmet_a",
    );
    expect(sosTargetOf([], null)).toBeUndefined();
  });

  it("求救：同时在线多台时，记在设备页「设为当前」的那台名下（2026-10-07 负责人定）", () => {
    expect(sosTargetOf([a, b, c], "helmet_c")?.deviceId).toBe("helmet_c");
    expect(sosTargetOf([a, b, c], "helmet_b")?.deviceId).toBe("helmet_b");
  });

  it("求救：选过的那台不在线时不记到它名下——只要有在线的，就记在线的", () => {
    // 选的是 a（离线），在线的有 b、c：第一台在线的
    expect(sosTargetOf([a, b, c], "helmet_a")?.deviceId).toBe("helmet_b");
    // 只有一台在线：就是它
    expect(sosTargetOf([a, b], "helmet_a")?.deviceId).toBe("helmet_b");
  });

  it("求救：都不在线时取选过的那台；选过的已解绑则回到第一台", () => {
    const d = dev("helmet_d", false);
    expect(sosTargetOf([a, d], "helmet_d")?.deviceId).toBe("helmet_d");
    expect(sosTargetOf([a, d], "helmet_gone")?.deviceId).toBe("helmet_a");
  });

  it("安全页传给求救的只能是设备页「设为当前」的选择；这一页自己不再切换头盔", () => {
    // 第二个入参是设备页的选择。想让求救跟着别的东西走（比如某一页上临时看的头盔），得先改这里并过评审
    expect(sosTargetOf.length).toBe(2);
    const page = readFileSync(
      join(__dirname, "../../app/(tabs)/safety.tsx"),
      "utf8",
    );
    expect(page).toContain("sosTargetOf(list, helmets.chosenId)");
    expect(page).not.toMatch(/sosTargetOf\([^)]*(viewed|selectedId|picked)/);
    expect(page).not.toContain("HelmetSwitcher");
  });

  it("设备页大图与求救关联是同一条规则", () => {
    expect(currentHelmetOf([a, b, c], "helmet_c")).toBe(
      sosTargetOf([a, b, c], "helmet_c"),
    );
    const home = readFileSync(
      join(__dirname, "../../app/(tabs)/index.tsx"),
      "utf8",
    );
    expect(home).toContain("currentHelmetOf(list, choice.chosenId)");
  });
});
