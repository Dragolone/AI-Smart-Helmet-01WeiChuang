// 保命链路的接线（2026-10-05 评审）。这些都在带 hooks 的组件里，本仓库的 jest 渲染不了，
// 用源码不变式兜住「被改回去」——同 audit-legal-consent 的做法。真机回归见 REGRESSION 2.5 / 1.4。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@jest/globals";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("实时通道 / BLE 中转 / 推送与登录态同生命周期，不随某个页面卸载", () => {
  const layout = read("app/_layout.tsx");

  it("挂在根布局，且在错误边界之外：页面渲染崩溃不该把保命链路停掉", () => {
    const bridge = layout.indexOf("<RealtimeBridge />");
    const boundary = layout.indexOf("<AppErrorBoundary");
    expect(bridge).toBeGreaterThan(0);
    expect(boundary).toBeGreaterThan(0);
    expect(bridge).toBeLessThan(boundary);
    expect(layout).toMatch(
      /function RealtimeBridge\(\) \{\s*useRealtimeUpdates\(\);\s*return null;\s*\}/,
    );
  });

  it("不再挂在 (tabs) 布局：根栈上多出一个 (tabs) 再弹掉时，它的清理会停掉 WS、BLE、上行队列并删推送别名", () => {
    expect(read("app/(tabs)/_layout.tsx")).not.toContain("useRealtimeUpdates(");
  });

  it("全仓只有一处调用", () => {
    const callers = [
      "app/_layout.tsx",
      "app/(tabs)/_layout.tsx",
      "app/(tabs)/index.tsx",
      "app/(tabs)/safety.tsx",
    ].filter((f) => read(f).includes("useRealtimeUpdates("));
    expect(callers).toEqual(["app/_layout.tsx"]);
  });
});

describe("绑定成功后的跳转", () => {
  const src = read("app/bind-device.tsx");

  it("先 dismissAll 再去地图页：扫码进来时栈上有两张绑定页，back 只弹一张，随后的跳转会新压一个 (tabs)", () => {
    const submit = src.slice(src.indexOf("const submit = async"));
    const dismiss = submit.indexOf("router.dismissAll()");
    const go = submit.indexOf('router.push("/map")');
    expect(dismiss).toBeGreaterThan(0);
    expect(go).toBeGreaterThan(dismiss);
    expect(submit).not.toContain("router.back()");
  });
});

describe("use-realtime 的启动顺序", () => {
  const src = read("hooks/use-realtime.ts");

  it("蓝牙链路在通知权限有结果之后才启动（Android 一次只允许一个权限请求，并发时蓝牙权限框不出现）", () => {
    expect(src).toContain(
      "const permissionReady = ensureSosAlertPermission();",
    );
    expect(src).toMatch(
      /Promise\.all\(\[permissionReady, cachedReady\]\)\.then\(\(\) => \{\s*if \(!cancelled\) void startBleLink\(bleTargetsOf\(\)\);/,
    );
    // 全文件只有这一处启动链路
    expect(src.match(/startBleLink\(/g)).toHaveLength(1);
  });

  it("设备列表没有数据时不动链路目标（拉取失败 ≠ 一台都没绑）", () => {
    const sub = src.slice(src.indexOf("getQueryCache().subscribe"));
    const guard = sub.indexOf("if (live === null) return;");
    const set = sub.indexOf("setBleTargets(live)");
    expect(guard).toBeGreaterThan(0);
    expect(set).toBeGreaterThan(guard);
  });

  it("effect 清理后不再启动链路、不再重试拉列表", () => {
    const cleanup = src.slice(src.lastIndexOf("return () => {"));
    expect(cleanup).toContain("cancelled = true;");
    expect(cleanup).toContain("devicesLoad.cancel();");
  });
});
