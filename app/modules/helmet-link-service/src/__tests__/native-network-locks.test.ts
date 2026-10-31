// 网络锁两把都要有上限：Wi-Fi 锁的 acquire 不带超时，放锁又只有上传成功这一条路。Kotlin 没有单测环境，这里钉源码
import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(
    __dirname,
    "../../android/src/main/java/com/lingyiweichuang/linkservice/HelmetLinkServiceModule.kt",
  ),
  "utf8",
);

const between = (start: string, end: string) => {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  return source.slice(from, source.indexOf(end, from));
};

describe("holdNetwork / releaseNetwork 的 Wi-Fi 锁", () => {
  it("持锁时排上到点放锁，重入先撤上一次", () => {
    const hold = between(
      'Function("holdNetwork")',
      'Function("releaseNetwork")',
    );
    expect(hold).toContain("networkHandler.removeCallbacks(wifiLockTimeout)");
    expect(hold).toContain(
      "networkHandler.postDelayed(wifiLockTimeout, timeout)",
    );
    expect(hold.indexOf("removeCallbacks")).toBeLessThan(
      hold.indexOf("postDelayed"),
    );
  });

  it("到点放的是 Wi-Fi 锁，放锁时撤掉定时", () => {
    expect(source).toContain(
      "private val wifiLockTimeout = Runnable { releaseWifiLock() }",
    );
    const release = between(
      "private fun releaseWifiLock()",
      "private fun startAlarm",
    );
    expect(release).toContain(
      "networkHandler.removeCallbacks(wifiLockTimeout)",
    );
    expect(release).toMatch(/if \(it\.isHeld\) it\.release\(\)/);
  });

  it("主动放锁和模块销毁都放两把锁", () => {
    expect(
      between('Function("releaseNetwork")', 'Function("start")'),
    ).toContain("releaseNetworkLocks()");
    expect(between("OnDestroy {", "/**")).toContain("releaseNetworkLocks()");
    const both = between(
      "private fun releaseNetworkLocks()",
      "private fun releaseWifiLock",
    );
    expect(both).toContain("wakeLock?.let");
    expect(both).toContain("releaseWifiLock()");
  });

  it("判断和放锁在同一把锁里：续期在 JS 线程、到点在主线程，多放一次会抛异常", () => {
    expect(
      between('Function("holdNetwork")', 'Function("releaseNetwork")'),
    ).toMatch(
      /synchronized\(wifiLockGuard\) \{[\s\S]*if \(!fl\.isHeld\) fl\.acquire\(\)/,
    );
    expect(
      between("private fun releaseWifiLock()", "private fun startAlarm"),
    ).toMatch(/synchronized\(wifiLockGuard\) \{[\s\S]*it\.release\(\)/);
  });
});
