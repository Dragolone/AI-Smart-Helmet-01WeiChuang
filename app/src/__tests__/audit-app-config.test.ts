// app.json 是 CNG 的唯一真相：ios/ 与 android/ 都是 prebuild 产物、不进 Git，
// 所以权限用途说明写错在单测里是看不见的，只有真机跑到那个功能才会闪退。
// 2026-09-17 就真出过：给 expo-camera 配了 microphonePermission: false，
// 把 NSMicrophoneUsageDescription 删掉，进语音频道直接崩（commit 3c0892f 修）。
// 这里把「每个用到的系统能力都必须有中文用途说明」钉成断言。
import { describe, expect, it } from "@jest/globals";

import appJson from "../../app.json";

type PluginEntry = string | [string, Record<string, unknown>?];
const expo = appJson.expo as unknown as {
  platforms?: string[];
  plugins: PluginEntry[];
  ios?: { infoPlist?: Record<string, unknown>; bundleIdentifier?: string };
  android?: { permissions?: string[]; package?: string };
};

const pluginConfig = (name: string): Record<string, unknown> | null => {
  for (const p of expo.plugins) {
    if (Array.isArray(p) && p[0] === name)
      return (p[1] ?? {}) as Record<string, unknown>;
    if (p === name) return {};
  }
  return null;
};

/** 用途说明必须是给用户看的中文句子，不能是 false / 空串 / 占位符 */
const expectPurposeString = (label: string, v: unknown) => {
  expect(
    typeof v === "string" ? v : `${label} 不是字符串：${String(v)}`,
  ).toEqual(expect.any(String));
  const s = String(v);
  expect(s.length).toBeGreaterThanOrEqual(8);
  expect(s).toMatch(/[一-龥]/); // 至少含中文
  expect(s).not.toMatch(/TODO|占位|xxx/i);
};

describe("app.json 权限用途说明（CNG 唯一真相）", () => {
  it("相机：扫码绑定要用", () => {
    expectPurposeString(
      "cameraPermission",
      pluginConfig("expo-camera")?.cameraPermission,
    );
  });

  it("麦克风：对讲要用——插件与 infoPlist 至少一处给出，且都不能是 false", () => {
    const cam = pluginConfig("expo-camera") ?? {};
    const fromPlugin = cam.microphonePermission;
    const fromPlist = expo.ios?.infoPlist?.NSMicrophoneUsageDescription;
    // 关键断言：插件不得把麦克风用途说明关掉（false 会从 Info.plist 里删掉该键）
    expect(fromPlugin).not.toBe(false);
    expectPurposeString("麦克风用途说明", fromPlugin ?? fromPlist);
  });

  it("定位：地图与轨迹要用", () => {
    expectPurposeString(
      "locationWhenInUsePermission",
      pluginConfig("expo-location")?.locationWhenInUsePermission,
    );
  });

  it("蓝牙：BLE 是唯一真机数据链路（决策 #35）", () => {
    const ble = pluginConfig("react-native-ble-plx");
    expect(ble).not.toBeNull();
    expectPurposeString(
      "bluetoothAlwaysPermission",
      ble?.bluetoothAlwaysPermission,
    );
    // 后台中转（决策 #41）依赖 central 后台模式
    expect(ble?.isBackgroundEnabled).toBe(true);
    expect(ble?.modes).toContain("central");
  });

  it("相册：设置头像要用", () => {
    expectPurposeString(
      "photosPermission",
      pluginConfig("expo-image-picker")?.photosPermission,
    );
  });

  it("Android 对讲权限齐全", () => {
    const perms = expo.android?.permissions ?? [];
    expect(perms).toContain("android.permission.RECORD_AUDIO");
    expect(perms).toContain("android.permission.MODIFY_AUDIO_SETTINGS");
  });

  it("包名与 Bundle ID 是定稿的 com.lingyiweichuang.app（汤总 2026-09-10 拍板）", () => {
    expect(expo.ios?.bundleIdentifier).toBe("com.lingyiweichuang.app");
    expect(expo.android?.package).toBe("com.lingyiweichuang.app");
  });

  it("只发双端：web 不在 MVP 范围（CLAUDE.md Platform Policy）", () => {
    expect(expo.platforms).toEqual(["ios", "android"]);
  });

  it("高德跳转需要 iosamap 在查询白名单里（否则 canOpenURL 永远 false）", () => {
    expect(expo.ios?.infoPlist?.LSApplicationQueriesSchemes).toContain(
      "iosamap",
    );
  });
});

describe("app.json 推送接入（极光，决策 #10 / #48）", () => {
  const e = appJson.expo as unknown as {
    plugins: PluginEntry[];
    extra?: { jpush?: { appKey?: string; channel?: string } };
    android?: { blockedPermissions?: string[] };
  };

  it("AppKey 是公开值，放 extra.jpush 供 JS 与原生插件共用", () => {
    expect(e.extra?.jpush?.appKey).toMatch(/^[0-9a-f]{24}$/);
  });

  it("挂了本地 config plugin（Android 占位符 + iOS AppDelegate 补丁）", () => {
    const names = e.plugins.map((p) => (Array.isArray(p) ? p[0] : p));
    expect(names).toContain("./plugins/with-jpush.js");
  });

  it("极光 SDK 顺带申请的超范围权限一律屏蔽（商店合规高频扣分项）", () => {
    const blocked = e.android?.blockedPermissions ?? [];
    for (const p of [
      "android.permission.READ_PHONE_STATE",
      "android.permission.GET_TASKS",
      "android.permission.WRITE_EXTERNAL_STORAGE",
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.ACCESS_BACKGROUND_LOCATION",
    ]) {
      expect(blocked).toContain(p);
    }
  });
});

describe("app.json 实时视频预览（决策 #37 / #49，DEVICE_PROTOCOL §1.3）", () => {
  const e = appJson.expo as unknown as {
    plugins: PluginEntry[];
    ios?: {
      infoPlist?: Record<string, unknown>;
      entitlements?: Record<string, unknown>;
    };
  };

  it("Android minSdk 26：libvlc-all 3.6.3 的硬门槛（决策 #49 接受放弃 7.x）", () => {
    const android = pluginConfig("expo-build-properties")?.android as
      { minSdkVersion?: number } | undefined;
    expect(android?.minSdkVersion).toBe(26);
  });

  it("iOS 程序化连头盔热点需要 Hotspot Configuration entitlement", () => {
    expect(
      e.ios?.entitlements?.[
        "com.apple.developer.networking.HotspotConfiguration"
      ],
    ).toBe(true);
  });

  it("iOS 本地网络与存截图都有中文用途说明（缺了连头盔会被系统静默拒绝）", () => {
    expectPurposeString(
      "NSLocalNetworkUsageDescription",
      e.ios?.infoPlist?.NSLocalNetworkUsageDescription,
    );
    expectPurposeString(
      "NSPhotoLibraryAddUsageDescription",
      e.ios?.infoPlist?.NSPhotoLibraryAddUsageDescription,
    );
  });
});
