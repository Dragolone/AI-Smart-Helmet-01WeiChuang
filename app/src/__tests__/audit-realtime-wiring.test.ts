// 保命链路的接线（2026-10-05 评审）。这些都在带 hooks 的组件里，本仓库的 jest 渲染不了，
// 用源码不变式兜住「被改回去」——同 audit-legal-consent 的做法。真机回归见 REGRESSION 2.5 / 1.4。
import { existsSync, readFileSync } from "node:fs";
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

  // 清理分三种情况（10-18 起）：界面重建 → 只拆自己的订阅；界面被拆而人还登录着 → 什么都不停、交给孤儿机制
  //（services/bridge-lifecycle，有单测）；真的退出登录 → 拆订阅 + 停全部共享连接
  const hook = read("hooks/use-realtime.ts");
  const body = (name: string) => {
    const at = hook.indexOf(`const ${name} = () => {`);
    expect(at).toBeGreaterThan(0);
    return hook.slice(at, hook.indexOf("\n    };", at));
  };
  const cleanup = hook.slice(hook.lastIndexOf("return () => {"));

  it("自己的订阅和共享连接分开收：detach 只拆订阅，stopShared 停 WS / BLE / 队列、撤求救提醒、解绑推送别名", () => {
    const detach = body("detach");
    for (const own of [
      "unsubscribe();",
      "unsubscribeState();",
      "unsubscribeUser();",
      "appState.remove();",
      "unsubscribeCache();",
    ])
      expect(detach).toContain(own);
    const shared = body("stopShared");
    for (const s of [
      "realtimeClient.stop();",
      "stopRelayUplink();",
      "stopBleLink();",
      "presentedSos.current.clear();",
      "resetSosAlerts();",
      "stopPush();",
    ]) {
      expect(shared).toContain(s);
      expect(detach).not.toContain(s);
    }
  });

  it("界面重建时旧根的清理不拆共享连接：按启动序号判断，只拆自己的订阅（2026-10-15 华为改字体实测）", () => {
    expect(hook).toContain("const generation = ++bridgeGeneration;");
    const guard = cleanup.indexOf("if (generation !== bridgeGeneration) {");
    expect(guard).toBeGreaterThan(0);
    const branch = cleanup.slice(guard, cleanup.indexOf("return;", guard));
    expect(branch).toContain("detach();");
    expect(branch).not.toContain("stopShared();");
  });

  it("界面被拆而人还登录着（安卓从多任务划掉 App，进程还活着）：订阅和连接都留着交给孤儿机制，只有真的登出才停（10-18）", () => {
    const loggedIn = cleanup.indexOf(
      "if (useAuthStore.getState().tokens !== null) {",
    );
    expect(loggedIn).toBeGreaterThan(cleanup.indexOf("bridgeGeneration"));
    const branch = cleanup.slice(
      loggedIn,
      cleanup.indexOf("return;", loggedIn),
    );
    expect(branch).toContain("orphanBridge({ detach, stopShared }");
    expect(branch).not.toContain("detach();");
    expect(branch).not.toContain("stopShared();");
    // 停共享连接只在两个判断都过了之后（真的退出登录），全清理函数里只有这一处
    expect(cleanup.split("stopShared();").length - 1).toBe(1);
    expect(cleanup.lastIndexOf("stopShared();")).toBeGreaterThan(loggedIn);
  });

  it("界面起来先接手孤儿并清掉「拉起过」的登记；界面不在时不跳页（导航器没挂着会抛错，锁屏提醒也跟着弹不出）", () => {
    expect(hook).toMatch(
      /if \(attachBridgeUi\(\)\) presentedSos\.current\.clear\(\);/,
    );
    expect(hook).toMatch(
      /if \(sosScreen\.mounted \|\| !bridgeUi\.attached\) return;\s*router\.push\(/,
    );
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

describe("绑定 / 解绑的收尾（2026-10-05 评审 R-01 + 2026-10-06 iPhone 实测；2026-10-08 扫码页并进绑定页）", () => {
  const bind = read("app/bind-device.tsx");
  const block = (start: string) => {
    const at = bind.indexOf(start);
    expect(at).toBeGreaterThan(0);
    return bind.slice(at, bind.indexOf("\n  };\n", at));
  };

  it("绑定页不跳任何路由：成功后 dismissAll，关闭按钮 back（焦点在绑定页时再 push 标签页会在根栈上新压一套 (tabs)）", () => {
    expect(bind).toContain("router.dismissAll()");
    expect(bind).not.toMatch(/router\.(push|navigate|replace|dismissTo)\(/);
    // back 只有顶上那个关闭按钮一处；绑定成功的收尾不走它
    expect(bind.match(/router\.back\(\)/g)).toHaveLength(1);
  });

  it("绑定成功：服务端一确认就把新设备写进列表缓存，不等重新拉取（等待期间页面不动，用户会再点一次）", () => {
    const fn = block("const bind = async");
    const ok = fn.slice(0, fn.indexOf("} catch"));
    const write = ok.indexOf('setQueryData<DevicePublic[]>(["devices"]');
    expect(write).toBeGreaterThan(0);
    expect(ok.indexOf("return { ok: true")).toBeGreaterThan(write);
    expect(fn).not.toContain("await queryClient.invalidateQueries");
  });

  it("手输绑定成功后「绑定」按钮不复位（面板正在收起，杜绝重复提交）：busy 只在失败时复位", () => {
    const submit = block("const submitManual = async");
    const failed = submit.indexOf("if (!result.ok) {");
    const reset = submit.indexOf("setBusy(false)");
    expect(failed).toBeGreaterThan(0);
    expect(reset).toBeGreaterThan(failed);
    expect(reset).toBeLessThan(submit.indexOf("return;", reset));
    expect(submit.match(/setBusy\(false\)/g)).toHaveLength(1);
  });

  it("扫码并进了绑定页：没有第二张页面可叠（原来是扫码页 dismissTo 回绑定页）", () => {
    expect(existsSync(join(__dirname, "..", "app/scan-bind.tsx"))).toBe(false);
    expect(read("app/_layout.tsx")).not.toContain('name="scan-bind"');
    // 扫到一个码只处理一次：相机在页面重新渲染之前还会把同一个码再报几遍
    const scanned = block("const onScanned = ");
    expect(scanned.indexOf("scanLock.current = true;")).toBeLessThan(
      scanned.indexOf("void bindScanned("),
    );
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
    // O10：蓝牙权限还没给过时再等通知那次申请（可能被推迟到倒计时页关掉后）有结果
    expect(src).toMatch(
      /Promise\.all\(\[permissionReady, cachedReady\]\)\.then\(async \(\) => \{[\s\S]*?checkBlePermissions\(\)[\s\S]*?await whenSosAlertPermissionAsked\(\);[\s\S]*?await whenCountdownClearForPrompt\(\);[\s\S]*?void startBleLink\(bleTargetsOf\(\)\);/,
    );
    // 全文件只有这一处启动链路
    expect(src.match(/startBleLink\(/g)).toHaveLength(1);
  });

  it("设备列表没有数据时不动链路目标（拉取失败 ≠ 一台都没绑）", () => {
    const sub = src.slice(src.indexOf("getQueryCache().subscribe"));
    const guard = sub.indexOf("if (live === null) return;");
    // 交给链路的是列表本身或把当前头盔挪到最前的那份（10-19：列表一到 / 一刷新也排当前头盔第一）
    const set = sub.search(/setBleTargets\((live|ordered)\)/);
    expect(guard).toBeGreaterThan(0);
    expect(set).toBeGreaterThan(guard);
  });

  it("effect 清理后不再启动链路、不再重试拉列表：detach 里收掉；界面重建和退出登录都走 detach（界面被拆而仍登录时由孤儿机制在接手 / 登出时再 detach，10-18）", () => {
    const at = src.indexOf("const detach = () => {");
    const detach = src.slice(at, src.indexOf("\n    };", at));
    expect(detach).toContain("cancelled = true;");
    expect(detach).toContain("devicesLoad.cancel();");
    const cleanup = src.slice(src.lastIndexOf("return () => {"));
    expect(cleanup.split("detach();").length - 1).toBe(2);
  });
});

describe("B 线 10-06 评审 F8 / F-7 / F-10（接线断言）", () => {
  const hook = read("hooks/use-realtime.ts");

  it("F8：用户档案晚到时，上行队列换到该用户名下并重载他的缓存目标", () => {
    const fn = hook.slice(
      hook.indexOf("const onUserReady = () => {"),
      hook.indexOf("onUserReady();"),
    );
    // 匿名 → 本人用认领（队列带着走，10-16 A6）；换账号才 stop 再 start
    expect(fn).toContain("adoptRelayUplinkOwner(uid)");
    expect(fn).toContain("stopRelayUplink();");
    expect(fn).toContain("startRelayUplink(uid);");
    expect(fn).toContain("loadCachedTargets(uid)");
    // 目标顺序把「当前头盔」排到最前（10-16 A11）：缓存目标和实时目标都经 prioritizeCurrent
    expect(fn).toContain("setBleTargets(prioritizeCurrent(queryClient, ids));");
    expect(hook).toMatch(
      /const bleTargetsOf = \(\) =>\s*prioritizeCurrent\(queryClient, liveTargets\(queryClient\) \?\? known\)/,
    );
    expect(hook).toContain("useAuthStore.subscribe(onUserReady)");
  });

  it("F-7：根布局只在「两边都有档案且 id 不同」时清缓存", () => {
    const layout = read("app/_layout.tsx");
    expect(layout).toContain("accountSwitched(prev.user?.id, state.user?.id)");
    expect(layout).not.toMatch(
      /switched = \(state\.user\?\.id \?\? null\) !== /,
    );
  });

  it("F-10：冷启动补拉时一台目标都没有，列表到位后再补拉一次（只补一次）", () => {
    expect(hook).toContain("coldResumeHadTargets = ids.length > 0;");
    const sub = hook.slice(hook.indexOf("getQueryCache().subscribe"));
    expect(sub).toContain("coldResumeHadTargets === false");
    expect(sub).toContain("resumedAfterListArrived = true;");
    expect(sub).toContain('"设备列表到位后补拉"');
  });
});
