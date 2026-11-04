// 倒计时页 / 安全页的接线（页面层没有渲染测试，用源码不变式钉住，10-06 评审 F-4 / F6 / F-5）
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@jest/globals";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("倒计时页 app/sos-active.tsx", () => {
  const src = read("app/sos-active.tsx");

  it("倒计时中拦下 Android 实体返回键：不能把这页关进「什么都没有」", () => {
    expect(src).toMatch(
      /if \(!counting\) return;\s*const sub = BackHandler\.addEventListener\(\s*"hardwareBackPress",\s*\(\) => true,?\s*\);/,
    );
  });

  it("本页取消 / 确认成功后撤掉锁屏提醒与预排的刷新，不等 WS 推终态", () => {
    expect(src).toMatch(
      /if \(finished && !isDrill\) void clearSosAlert\(sosId\);/,
    );
    expect(src).toMatch(
      /import \{[^}]*\bclearSosAlert\b[^}]*\} from "@\/services\/sos-alert";/,
    );
  });

  it("倒数中取消 / 立即求救没成功不弹系统提示框（会盖住还在走的倒计时），走页内提示条（O7，10-20）", () => {
    expect(src).not.toContain('showNotice(t("common.failed")');
    expect(src).toMatch(/AccessibilityInfo\.announceForAccessibility\(/);
  });
});

describe("锁屏通知按钮的取消 services/sos-alert.ts", () => {
  it("后台重试链路显式用全局超时，不跟倒计时页的 8 s（O7，10-20：前三次重试没人看着，每次都给足时间）", () => {
    const src = read("services/sos-alert.ts");
    expect(src).toContain(
      "sosApi.cancel(sosId, { timeoutMs: REQUEST_TIMEOUT_MS })",
    );
    expect(src).toContain('import { REQUEST_TIMEOUT_MS } from "@/api/client";');
  });
});

describe("安全页 app/(tabs)/safety.tsx", () => {
  const src = read("app/(tabs)/safety.tsx");

  it("长按求救：一次长按一个 eventId，失败按原 eventId 进持久队列，成功立刻核对拉起倒计时页", () => {
    // 10-07 安全页改版后目标变量名是 sosTargetId（sosTarget 是设备对象）
    expect(src).toContain('buildRelayEnvelope(sosTargetId, "manual_sos", {})');
    expect(src).toMatch(
      /\.then\(\(\) => notifyCriticalAccepted\(sosTargetId\)\)/,
    );
    expect(src).toMatch(
      /enqueueRelayEvent\(envelope as EventEnvelope<EventType>\)/,
    );
    expect(src).not.toContain('pushEvent(sosTargetId, "manual_sos"');
  });

  it("30 s 轮询走账号级接口一次拿全，写回时过终态守卫（迟到的 pending 不让卡片回潮）和在途守卫", () => {
    // 10-07 安全页改版后轮询收进 hooks/use-safety.ts 的 usePendingSos；10-17 起是账号级接口（B 线第 12 项），
    // 写回逻辑在 services/sos-queue 的 applyAccountActive（单测见 services/__tests__/sos-queue.test.ts）
    const hook = read("hooks/use-safety.ts");
    expect(hook).toMatch(
      /pollAccountActive\(queryClient, deviceIds, \(\) =>\s*sosApi\.activeForAccount\(\)/,
    );
    expect(hook).not.toMatch(/sosApi\.active\(/);
    const queue = read("services/sos-queue.ts");
    expect(queue).toMatch(/guardActiveResult\(qc, \{ sos: s \}\)/);
    expect(queue).toMatch(/state\.dataUpdatedAt >= startedAt/);
  });
});
