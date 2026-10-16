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
    expect(src).toMatch(/if \(finished && !isDrill\) void clearSosAlert\(sosId\);/);
    expect(src).toContain('import { clearSosAlert } from "@/services/sos-alert";');
  });
});

describe("安全页 app/(tabs)/safety.tsx", () => {
  const src = read("app/(tabs)/safety.tsx");

  it("长按求救：一次长按一个 eventId，失败按原 eventId 进持久队列，成功立刻核对拉起倒计时页", () => {
    // 10-07 安全页改版后目标变量名是 sosTargetId（sosTarget 是设备对象）
    expect(src).toContain('buildRelayEnvelope(sosTargetId, "manual_sos", {})');
    expect(src).toMatch(/\.then\(\(\) => notifyCriticalAccepted\(sosTargetId\)\)/);
    expect(src).toMatch(/enqueueRelayEvent\(envelope as EventEnvelope<EventType>\)/);
    expect(src).not.toContain('pushEvent(sosTargetId, "manual_sos"');
  });

  it("30 s 轮询的 /sos/active 结果过终态守卫，迟到的 pending 不让卡片回潮", () => {
    // 10-07 安全页改版后轮询收进 hooks/use-safety.ts 的 usePendingSos；10-16 起经 fetchActiveFresh
    //（内部先过 guardActiveResult，再挡在途期间 WS 写入被迟到应答冲掉，单测见 services/__tests__/sos-sync.test.ts）
    const hook = read("hooks/use-safety.ts");
    expect(hook).toMatch(
      /fetchActiveFresh\(queryClient, id, sosApi\.active\)/,
    );
    expect(read("services/sos-sync.ts")).toMatch(
      /const result = guardActiveResult\(qc, await fetchActive\(deviceId\)\)/,
    );
  });
});
