// 几个小模块的边界补测（2026-10-16）：视频预览状态机的全组合不变式、截图路径、发言指示、提示音合成、
// 颜色小工具、隐私同意弹窗让路、法律文档地址、打开通知设置。只加测试、不改代码。
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { Linking, Platform } from "react-native";

import {
  consentModalVisible,
  legalOrigin,
  legalUrl,
  parseLegalDoc,
} from "@/constants/legal";
import {
  RISK_ALERT_TYPES,
  RISK_ALERT_TYPE_PARAM,
} from "@/constants/event-types";
import { mixHex, withAlpha } from "../color";
import { synthWav } from "../cue-synth";
import { openNotificationSettings } from "../notification-settings";
import {
  JOIN_TIMEOUT_MS,
  NO_PICTURE_HINT_MS,
  holdsHelmetWifi,
  initialPreviewState,
  previewReducer,
  showsPlayer,
  toFsPath,
  type PreviewAction,
  type PreviewPhase,
  type PreviewState,
} from "../video-preview";
import { sameSpeakers } from "../voice-volume";

const PHASES: PreviewPhase[] = [
  "joining",
  "manual",
  "connecting",
  "playing",
  "paused",
  "error",
];
const ACTIONS: PreviewAction[] = [
  { type: "retry" },
  { type: "joined" },
  { type: "joinFailed" },
  { type: "joinFailed", code: "MANUAL_REQUIRED" },
  { type: "joinFailed", code: "USER_DENIED" },
  { type: "joinFailed", code: "SOMETHING_NEW" },
  { type: "manualNoWifi" },
  { type: "firstFrame" },
  { type: "noPictureTimeout" },
  { type: "playerError" },
  { type: "streamEnded" },
  { type: "wifiLost" },
  { type: "suspend", reason: "background" },
  { type: "suspend", reason: "sos" },
  { type: "foreground" },
];
const stateIn = (
  phase: PreviewPhase,
  extra: Partial<PreviewState> = {},
): PreviewState => ({
  phase,
  attempt: 3,
  stalled: false,
  ...(phase === "paused" ? { pauseReason: "background" as const } : {}),
  ...extra,
});

describe("视频预览状态机：全组合不变式", () => {
  it("任何阶段收到任何动作都不抛，结果仍是六个阶段之一", () => {
    for (const phase of PHASES)
      for (const a of ACTIONS) {
        const next = previewReducer(stateIn(phase), a);
        expect(PHASES).toContain(next.phase);
      }
  });

  it("只有重试和从后台回来会开新的一次连接（attempt +1），其余动作不改 attempt", () => {
    for (const phase of PHASES)
      for (const a of ACTIONS) {
        const next = previewReducer(stateIn(phase), a);
        const restarted =
          a.type === "retry" || (a.type === "foreground" && phase === "paused");
        expect(next.attempt).toBe(restarted ? 4 : 3);
      }
  });

  it("求救让路：不管原来在哪个阶段都进「暂停 · 求救」，之后回前台也不自动重连", () => {
    for (const phase of PHASES) {
      const paused = previewReducer(stateIn(phase), {
        type: "suspend",
        reason: "sos",
      });
      expect(paused).toMatchObject({ phase: "paused", pauseReason: "sos" });
      expect(holdsHelmetWifi(paused.phase)).toBe(false);
      expect(previewReducer(paused, { type: "foreground" })).toBe(paused);
    }
  });

  it("退后台：只有占着头盔 Wi-Fi 的阶段才暂停；手动引导页 / 出错页退后台原样不动", () => {
    for (const phase of PHASES) {
      const s = stateIn(phase);
      const next = previewReducer(s, { type: "suspend", reason: "background" });
      if (holdsHelmetWifi(phase))
        expect(next).toMatchObject({
          phase: "paused",
          pauseReason: "background",
        });
      else expect(next).toBe(s);
    }
  });

  it("已因求救暂停后又退后台：仍记为求救（求救优先），回前台不重连", () => {
    const sos = previewReducer(stateIn("playing"), {
      type: "suspend",
      reason: "sos",
    });
    const bg = previewReducer(sos, { type: "suspend", reason: "background" });
    expect(bg.pauseReason).toBe("sos");
    expect(previewReducer(bg, { type: "foreground" }).phase).toBe("paused");
  });

  it("认不出的连热点错误码、没有错误码：都写「找不到头盔热点」", () => {
    for (const code of [undefined, "SOMETHING_NEW", ""]) {
      expect(
        previewReducer(stateIn("joining"), { type: "joinFailed", code })
          .errorKey,
      ).toBe("video.err.notFound");
    }
  });

  // 原来 JOIN_ERROR_KEYS[a.code] 是普通下标：码叫 toString 时取到原型上的函数，错误页文案一片空白
  it("错误码恰好是 Object.prototype 的成员名：按认不出的码写「找不到头盔热点」", () => {
    for (const code of [
      "toString",
      "constructor",
      "__proto__",
      "hasOwnProperty",
    ]) {
      expect(
        previewReducer(stateIn("joining"), { type: "joinFailed", code })
          .errorKey,
      ).toBe("video.err.notFound");
    }
    expect(
      previewReducer(stateIn("joining"), {
        type: "joinFailed",
        code: "USER_DENIED",
      }).errorKey,
    ).toBe("video.err.denied");
    expect(
      previewReducer(stateIn("joining"), {
        type: "joinFailed",
        code: "BIND_FAILED",
      }).errorKey,
    ).toBe("video.err.bind");
  });

  it("「没 Wi-Fi」提示只在手动引导页出现，且不改阶段", () => {
    for (const phase of PHASES) {
      const s = stateIn(phase);
      const next = previewReducer(s, { type: "manualNoWifi" });
      if (phase === "manual")
        expect(next).toMatchObject({
          phase: "manual",
          errorKey: "video.err.noWifi",
        });
      else expect(next).toBe(s);
    }
  });

  it("重试会清掉卡住提示、错误和暂停原因", () => {
    const s = stateIn("error", { stalled: true, errorKey: "video.err.stream" });
    expect(previewReducer(s, { type: "retry" })).toEqual({
      phase: "joining",
      attempt: 4,
      stalled: false,
    });
  });

  it("几个时长常量：首帧提示 5 秒、连热点最多等 30 秒", () => {
    expect(NO_PICTURE_HINT_MS).toBe(5_000);
    expect(JOIN_TIMEOUT_MS).toBe(30_000);
    expect(showsPlayer(initialPreviewState.phase)).toBe(false);
  });
});

describe("toFsPath：截图路径", () => {
  it("file:// 前缀去掉并解码空格 / 中文；不带前缀的原样", () => {
    expect(toFsPath("file:///data/user/0/cache/shot%201.jpg")).toBe(
      "/data/user/0/cache/shot 1.jpg",
    );
    expect(toFsPath("file:///var/%E6%88%AA%E5%9B%BE.jpg")).toBe(
      "/var/截图.jpg",
    );
    expect(toFsPath("/already/plain.jpg")).toBe("/already/plain.jpg");
    expect(toFsPath("content://media/1")).toBe("content://media/1");
  });

  it("编码过的斜杠（%2F）不解码成路径分隔符（decodeURI 的保留字符）", () => {
    expect(toFsPath("file:///a%2Fb.jpg")).toBe("/a%2Fb.jpg");
  });

  it("百分号后面不是合法编码：现状抛 URIError（路径由 expo-file-system 生成，不会出现）", () => {
    expect(() => toFsPath("file:///a%ZZ.jpg")).toThrow(URIError);
  });
});

describe("sameSpeakers：发言阈值的边", () => {
  it("阈值 0：所有人都算在发言，两张表的名单不同也算相同", () => {
    expect(sameSpeakers({ a: 0 }, { b: 0 }, 0)).toBe(true);
  });

  it("负数音量、NaN：按「没在说」算（NaN 与阈值比较为假）", () => {
    expect(sameSpeakers({ a: -5 }, {}, 10)).toBe(true);
    expect(sameSpeakers({ a: Number.NaN }, {}, 10)).toBe(true);
  });

  it("阈值以上的数值变化不算变化；跨过阈值才算", () => {
    expect(sameSpeakers({ a: 50 }, { a: 100 }, 20)).toBe(true);
    expect(sameSpeakers({ a: 19.99 }, { a: 20 }, 20)).toBe(false);
  });

  it("成员名是 __proto__ / constructor：照常比较，不取到原型上的东西", () => {
    const a = JSON.parse('{"__proto__": 30, "constructor": 5}') as Record<
      string,
      number
    >;
    expect(sameSpeakers(a, { constructor: 5 }, 20)).toBe(false);
    expect(sameSpeakers({}, {}, 20)).toBe(true);
  });
});

describe("synthWav：提示音合成的边", () => {
  const dataBytes = (b: Uint8Array) =>
    new DataView(b.buffer).getUint32(40, true);

  it("没有音：只有 44 字节的头，大小字段都对", () => {
    const w = synthWav([]);
    expect(w.length).toBe(44);
    expect(dataBytes(w)).toBe(0);
    expect(new DataView(w.buffer).getUint32(4, true)).toBe(36);
  });

  it("0 毫秒的音、只有停顿：不出 NaN，停顿是全静音", () => {
    const w = synthWav([{ hz: 440, ms: 0, gapMs: 10 }], 8_000);
    expect(dataBytes(w)).toBe(80 * 2);
    expect(Array.from(w.slice(44)).every((x) => x === 0)).toBe(true);
  });

  it("只有 1 个采样的音：不除以 0，采样是有限值", () => {
    const w = synthWav([{ hz: 440, ms: 0.1 }], 8_000);
    expect(dataBytes(w)).toBe(2);
    expect(Number.isFinite(new DataView(w.buffer).getInt16(44, true))).toBe(
      true,
    );
  });

  it("任何频率、任何采样率下峰值都不超过满幅的 35%（垫在通话声音下面）", () => {
    for (const rate of [8_000, 22_050, 44_100]) {
      for (const hz of [50, 440, 3_000, 11_025]) {
        const w = synthWav([{ hz, ms: 50 }], rate);
        const v = new DataView(w.buffer);
        let peak = 0;
        for (let at = 44; at < w.length; at += 2)
          peak = Math.max(peak, Math.abs(v.getInt16(at, true)));
        expect(peak).toBeLessThanOrEqual(Math.round(0.35 * 32_767));
      }
    }
  });

  it("采样率写进头里：每秒字节数 = 采样率 × 2", () => {
    const v = new DataView(synthWav([{ hz: 440, ms: 10 }], 16_000).buffer);
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint32(28, true)).toBe(32_000);
  });

  it("毫秒带小数按采样四舍五入", () => {
    expect(dataBytes(synthWav([{ hz: 440, ms: 1.06 }], 1_000))).toBe(2);
    expect(dataBytes(synthWav([{ hz: 440, ms: 1.4 }], 1_000))).toBe(2);
    expect(dataBytes(synthWav([{ hz: 440, ms: 1.5 }], 1_000))).toBe(4);
  });
});

describe("颜色小工具的边", () => {
  it("大小写十六进制结果一样；透明度原样写进去", () => {
    expect(withAlpha("#4ade80", 1)).toBe(withAlpha("#4ADE80", 1));
    expect(withAlpha("#000000", 0.5)).toBe("rgba(0, 0, 0, 0.5)");
    expect(withAlpha("#FFFFFF", 0)).toBe("rgba(255, 255, 255, 0)");
  });

  it("mixHex：t 取 0.5 时各通道取中间、四舍五入；结果始终是 7 个字符的实色", () => {
    expect(mixHex("#000000", "#FFFFFF", 0.5)).toBe("#808080");
    expect(mixHex("#123456", "#123456", 0.37)).toBe("#123456");
    for (const t of [0, 0.1, 0.33, 0.5, 0.99, 1])
      expect(mixHex("#0B0C0E", "#B9E600", t)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("现状：只认 #RRGGBB；t 超出 0–1 会算出超过 255 的通道、拼出非法颜色（调用方都传 0–1 的常数）", () => {
    expect(mixHex("#000000", "#FFFFFF", 1.5)).toBe("#17f17f17f");
    expect(withAlpha("#FFF", 1)).toBe("rgba(0, 15, 255, 1)");
  });
});

describe("隐私同意弹窗让路 / 法律文档", () => {
  const base = { authed: true, hydrated: true, accepted: false };

  it("没登录、还没读到同意标记、已同意：都不弹", () => {
    expect(consentModalVisible({ ...base, authed: false, pathname: "/" })).toBe(
      false,
    );
    expect(
      consentModalVisible({ ...base, hydrated: false, pathname: "/" }),
    ).toBe(false);
    expect(
      consentModalVisible({ ...base, accepted: true, pathname: "/" }),
    ).toBe(false);
  });

  it("在法律文档页、求救倒计时页让路；别的页面照弹", () => {
    expect(consentModalVisible({ ...base, pathname: "/legal/privacy" })).toBe(
      false,
    );
    expect(consentModalVisible({ ...base, pathname: "/sos-active" })).toBe(
      false,
    );
    expect(
      consentModalVisible({ ...base, pathname: "/sos-active?sosId=x" }),
    ).toBe(false);
    expect(consentModalVisible({ ...base, pathname: "/device/helmet_1" })).toBe(
      true,
    );
    // 「/legal」本身不是文档页（文档都在 /legal/<doc>）
    expect(consentModalVisible({ ...base, pathname: "/legal" })).toBe(true);
  });

  it("文档名：大小写不同、带空格、数组、undefined 都回落隐私政策", () => {
    for (const bad of ["PRIVACY", " terms", ["terms"], undefined, null, 1]) {
      expect(parseLegalDoc(bad)).toBe("privacy");
    }
  });

  it("站点根：带端口、带路径、带结尾斜杠都只取 origin；不是 URL 给空串", () => {
    expect(legalOrigin("http://192.168.1.2:3000/api/v1/")).toBe(
      "http://192.168.1.2:3000",
    );
    expect(legalOrigin("not a url")).toBe("");
    expect(legalUrl("sharing", "https://a.example.com/api/v1")).toBe(
      "https://a.example.com/legal/sharing",
    );
  });
});

describe("风险提醒类型", () => {
  it("只有两类雷达提醒和解除；摔倒 / 求救不在里面（它们在 SOS 记录里）", () => {
    expect([...RISK_ALERT_TYPES]).toEqual([
      "collision_risk",
      "obstacle_risk",
      "risk_cleared",
    ]);
    expect(RISK_ALERT_TYPE_PARAM).toBe(
      "collision_risk,obstacle_risk,risk_cleared",
    );
    expect(RISK_ALERT_TYPE_PARAM).not.toMatch(/fall|sos/);
  });
});

describe("打开通知设置", () => {
  // jest 的 react-native 预设里 Linking 的方法本身就是 jest.fn，spyOn 拿到的是同一个，调用记录跨用例累积
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("Android：直接进本 App 的通知页，带上包名", async () => {
    const os = jest.replaceProperty(Platform, "OS", "android");
    const send = jest.spyOn(Linking, "sendIntent").mockResolvedValue(undefined);
    const open = jest
      .spyOn(Linking, "openSettings")
      .mockResolvedValue(undefined);
    await openNotificationSettings();
    expect(send).toHaveBeenCalledWith(
      "android.settings.APP_NOTIFICATION_SETTINGS",
      [
        {
          key: "android.provider.extra.APP_PACKAGE",
          value: "com.lingyiweichuang.app",
        },
      ],
    );
    expect(open).not.toHaveBeenCalled();
    os.restore();
    jest.restoreAllMocks();
  });

  it("Android 个别 ROM 发不出这个 intent：退回应用设置页", async () => {
    const os = jest.replaceProperty(Platform, "OS", "android");
    jest
      .spyOn(Linking, "sendIntent")
      .mockRejectedValue(new Error("No Activity found"));
    const open = jest
      .spyOn(Linking, "openSettings")
      .mockResolvedValue(undefined);
    await openNotificationSettings();
    expect(open).toHaveBeenCalledTimes(1);
    os.restore();
    jest.restoreAllMocks();
  });

  it("iOS：没有分页，直接开 App 的设置页，不发 intent", async () => {
    const os = jest.replaceProperty(Platform, "OS", "ios");
    const send = jest.spyOn(Linking, "sendIntent").mockResolvedValue(undefined);
    const open = jest
      .spyOn(Linking, "openSettings")
      .mockResolvedValue(undefined);
    await openNotificationSettings();
    expect(send).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
    os.restore();
    jest.restoreAllMocks();
  });
});
