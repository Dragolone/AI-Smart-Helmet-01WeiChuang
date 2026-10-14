// 视频预览页的源码不变式（DEVICE_PROTOCOL §1.3 App 侧硬要求、决策 #49）。
// 页面层在本仓库 jest 里渲染不起来（见 docs/testing/2026-09-26/COVERAGE.md），
// 这几条靠读源码钉死：写错了真机上表现为「连上头盔后 App 整体断网」或「求救被卡住」。
import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "fs";
import { join } from "path";

const read = (rel: string): string =>
  readFileSync(join(__dirname, "..", "..", rel), "utf8");
const page = read("src/app/video-preview.tsx");
const kotlin = read(
  "modules/helmet-wifi/android/src/main/java/com/lingyiweichuang/helmetwifi/HelmetWifiModule.kt",
);
const swift = read("modules/helmet-wifi/ios/HelmetWifiModule.swift");

describe("预览页不发外网请求（手机此时在没有互联网的头盔热点上）", () => {
  it("不引用 API 客户端与 react-query", () => {
    expect(page).not.toMatch(/from ["']@\/api/);
    expect(page).not.toMatch(/@tanstack\/react-query/);
    expect(page).not.toMatch(/\bfetch\(/);
  });
});

describe("网络让位", () => {
  it("订阅求救入队并在回调里同步释放头盔 Wi-Fi", () => {
    expect(page).toMatch(/onSosRelayEvent\(/);
    const cb = page.slice(page.indexOf("onSosRelayEvent("));
    expect(cb.indexOf("releaseWifi()")).toBeGreaterThan(-1);
    expect(cb.indexOf("releaseWifi()")).toBeLessThan(
      cb.indexOf('reason: "sos"'),
    );
  });

  it("退后台释放、卸载释放", () => {
    expect(page).toMatch(/next === "background"[\s\S]{0,80}releaseWifi\(\)/);
    expect(page).toMatch(/useEffect\(\(\) => releaseWifi, \[releaseWifi\]\)/);
  });

  it("失焦释放（倒计时页盖上来时手机不能还绑在头盔热点上）；连接途中离开、结果迟到时也释放", () => {
    expect(page).toMatch(
      /useFocusEffect\([\s\S]{0,400}return \(\) => \{\s*releaseWifi\(\);\s*dispatch\(\{ type: "suspend", reason: "background" \}\)/,
    );
    expect(page).toMatch(
      /if \(cancelled\) \{[\s\S]{0,300}if \(!holdingWifi\.current\) HelmetWifi\.release\(\);/,
    );
  });

  it("释放后立即补传积压的中转事件", () => {
    expect(page).toMatch(
      /HelmetWifi\.release\(\);[\s\S]{0,120}flushRelayQueue\(\)/,
    );
  });
});

describe("原生侧", () => {
  it("Android 连上后绑进程，丢网与释放时解绑", () => {
    expect(kotlin).toMatch(/bindProcessToNetwork\(network\)/);
    expect(
      kotlin.match(/bindProcessToNetwork\(null\)/g)?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(kotlin).toMatch(
      /removeCapability\(NetworkCapabilities\.NET_CAPABILITY_INTERNET\)/,
    );
  });

  it("iOS 用 joinOnce（退后台 / 锁屏由系统自动断开），释放时删除配置", () => {
    expect(swift).toMatch(/joinOnce = true/);
    expect(swift).toMatch(/removeConfiguration\(forSSID:/);
  });
});
