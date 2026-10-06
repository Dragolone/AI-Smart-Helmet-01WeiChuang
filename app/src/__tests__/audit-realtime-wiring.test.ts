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

describe("绑定 / 扫码 / 解绑的收尾（2026-10-05 评审 R-01 + 2026-10-06 iPhone 实测）", () => {
  const bind = read("app/bind-device.tsx");
  const submitAt = bind.indexOf("const submit = async");
  const submit = bind.slice(submitAt, bind.indexOf("return (", submitAt));

  it("绑定成功：dismissAll 回到发起页，不再跳任何标签页路由（焦点在绑定页时那样会在根栈上新压一套 (tabs)）", () => {
    expect(submit).toContain("router.dismissAll()");
    expect(submit).not.toContain("router.back()");
    expect(submit).not.toMatch(/router\.(push|navigate|replace)\(/);
  });

  it("绑定成功：先把新设备写进列表缓存再收尾，不等重新拉取（等待期间页面不动，用户会再点一次）", () => {
    const ok = submit.slice(0, submit.indexOf("} catch"));
    const write = ok.indexOf('setQueryData<DevicePublic[]>(["devices"]');
    const dismiss = ok.indexOf("router.dismissAll()");
    expect(write).toBeGreaterThan(0);
    expect(dismiss).toBeGreaterThan(write);
    expect(ok).not.toContain("await queryClient.invalidateQueries");
    // 成功后按钮保持不可点：busy 只在失败时复位
    expect(ok).not.toContain("setBusy(false)");
  });

  it("扫码页是回到底下那张绑定页（dismissTo），不是再换出一张", () => {
    const scan = read("app/scan-bind.tsx");
    expect(scan).toContain("router.dismissTo({");
    expect(scan).not.toContain("router.replace(");
    // 绑定页要把带回来的参数填进输入框
    expect(bind).toContain("filledFrom.deviceId !== params.deviceId");
  });

  it("解绑成功：先把设备从列表缓存拿掉并返回，不等重新拉取；按钮不复位", () => {
    const detail = read("app/device/[deviceId].tsx");
    const start = detail.indexOf(".unbind(deviceId)");
    const ok = detail.slice(start, detail.indexOf(".catch(", start));
    expect(ok).toContain("prev?.filter((d) => d.deviceId !== deviceId)");
    expect(ok).toContain("router.back()");
    expect(ok).not.toContain("await ");
    expect(ok).not.toContain("setUnbinding(false)");
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
