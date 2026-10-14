// 实时视频预览状态机（决策 #37/#49，DEVICE_PROTOCOL §1.3）
import { describe, expect, it } from "@jest/globals";

import {
  HELMET_HOTSPOT,
  VLC_INIT_OPTIONS,
  holdsHelmetWifi,
  initialPreviewState,
  previewReducer,
  showsPlayer,
  toFsPath,
  type PreviewAction,
  type PreviewState,
} from "../video-preview";

const run = (...actions: PreviewAction[]): PreviewState =>
  actions.reduce(previewReducer, initialPreviewState);

describe("§1.3 约定", () => {
  it("拉流地址、热点名与强制 TCP", () => {
    expect(HELMET_HOTSPOT.streamUrl).toBe("rtsp://192.168.176.1:8554/ch0");
    expect(HELMET_HOTSPOT.ssid).toBe("X821cam");
    expect(VLC_INIT_OPTIONS).toContain("--rtsp-tcp");
    expect(VLC_INIT_OPTIONS).toContain("--no-audio");
  });
});

describe("previewReducer 主路径", () => {
  it("连热点 → 等首帧 → 播放", () => {
    expect(initialPreviewState.phase).toBe("joining");
    const s = run({ type: "joined" }, { type: "firstFrame" });
    expect(s.phase).toBe("playing");
    expect(s.stalled).toBe(false);
  });

  it("首帧前超时只提示、不中断（播放器继续尝试）", () => {
    const s = run({ type: "joined" }, { type: "noPictureTimeout" });
    expect(s.phase).toBe("connecting");
    expect(s.stalled).toBe(true);
    expect(
      run(
        { type: "joined" },
        { type: "noPictureTimeout" },
        { type: "firstFrame" },
      ).stalled,
    ).toBe(false);
  });

  it("超时提示只在等首帧时出现", () => {
    expect(run({ type: "noPictureTimeout" }).stalled).toBe(false);
    expect(
      run(
        { type: "joined" },
        { type: "firstFrame" },
        { type: "noPictureTimeout" },
      ).stalled,
    ).toBe(false);
  });

  it("重试是一次全新的连接：attempt +1，清掉错误", () => {
    const failed = run({ type: "joinFailed", code: "UNAVAILABLE" });
    const s = previewReducer(failed, { type: "retry" });
    expect(s).toEqual({ phase: "joining", attempt: 2, stalled: false });
  });
});

describe("连热点失败", () => {
  it.each([
    ["USER_DENIED", "video.err.denied"],
    ["UNAVAILABLE", "video.err.notFound"],
    ["BIND_FAILED", "video.err.bind"],
    [undefined, "video.err.notFound"],
    ["SOMETHING_NEW", "video.err.notFound"],
  ])("%s → %s", (code, key) => {
    const s = run({ type: "joinFailed", code });
    expect(s.phase).toBe("error");
    expect(s.errorKey).toBe(key);
  });

  it("Android 8/9 转手动引导；手动连好后继续进等首帧", () => {
    const manual = run({ type: "joinFailed", code: "MANUAL_REQUIRED" });
    expect(manual.phase).toBe("manual");
    expect(previewReducer(manual, { type: "manualNoWifi" }).errorKey).toBe(
      "video.err.noWifi",
    );
    expect(previewReducer(manual, { type: "joined" }).phase).toBe("connecting");
  });

  it("迟到的失败回调不覆盖已经在播的状态", () => {
    const playing = run({ type: "joined" }, { type: "firstFrame" });
    expect(
      previewReducer(playing, { type: "joinFailed", code: "UNAVAILABLE" }),
    ).toBe(playing);
  });
});

describe("播放中出问题", () => {
  it("播放器报错 / 流结束 / Wi-Fi 断开都进错误态", () => {
    const playing = run({ type: "joined" }, { type: "firstFrame" });
    expect(previewReducer(playing, { type: "playerError" }).errorKey).toBe(
      "video.err.stream",
    );
    expect(previewReducer(playing, { type: "streamEnded" }).errorKey).toBe(
      "video.err.streamEnded",
    );
    expect(previewReducer(playing, { type: "wifiLost" }).errorKey).toBe(
      "video.err.wifiLost",
    );
  });

  it("等首帧时流结束回调不当作中断（VLC 连接阶段也可能报 stopped）", () => {
    const connecting = run({ type: "joined" });
    expect(previewReducer(connecting, { type: "streamEnded" })).toBe(
      connecting,
    );
  });
});

describe("让出网络：退后台与求救", () => {
  it("退后台暂停、回前台自动重连", () => {
    const paused = run(
      { type: "joined" },
      { type: "firstFrame" },
      { type: "suspend", reason: "background" },
    );
    expect(paused.phase).toBe("paused");
    expect(holdsHelmetWifi(paused.phase)).toBe(false);
    const back = previewReducer(paused, { type: "foreground" });
    expect(back.phase).toBe("joining");
    expect(back.attempt).toBe(2);
  });

  it("求救暂停后回前台不自动重连，由用户决定", () => {
    const sos = run(
      { type: "joined" },
      { type: "firstFrame" },
      { type: "suspend", reason: "sos" },
    );
    expect(sos.pauseReason).toBe("sos");
    expect(previewReducer(sos, { type: "foreground" })).toBe(sos);
  });

  it("已因退后台暂停时来了求救，改记为求救（回前台不再自动连回头盔）", () => {
    const s = run(
      { type: "suspend", reason: "background" },
      { type: "suspend", reason: "sos" },
    );
    expect(s.pauseReason).toBe("sos");
    expect(previewReducer(s, { type: "foreground" }).phase).toBe("paused");
  });

  it("出错后退后台不改状态（没有占着 Wi-Fi）", () => {
    const err = run({ type: "joinFailed", code: "UNAVAILABLE" });
    expect(previewReducer(err, { type: "suspend", reason: "background" })).toBe(
      err,
    );
  });
});

describe("阶段谓词", () => {
  it("占用头盔 Wi-Fi 的只有连接中与播放中", () => {
    expect(
      ["joining", "connecting", "playing"].every((p) =>
        holdsHelmetWifi(p as never),
      ),
    ).toBe(true);
    expect(
      ["manual", "paused", "error"].some((p) => holdsHelmetWifi(p as never)),
    ).toBe(false);
  });
  it("播放器只在等首帧与播放中挂载", () => {
    expect(showsPlayer("connecting")).toBe(true);
    expect(showsPlayer("playing")).toBe(true);
    expect(showsPlayer("joining")).toBe(false);
    expect(showsPlayer("error")).toBe(false);
  });
});

describe("toFsPath", () => {
  it("去掉 file:// 并解码（原生截图接口不认 URI）", () => {
    expect(toFsPath("file:///data/user/0/cache/helmet-shot-1.png")).toBe(
      "/data/user/0/cache/helmet-shot-1.png",
    );
    expect(toFsPath("file:///var/Mobile%20Documents/a.png")).toBe(
      "/var/Mobile Documents/a.png",
    );
    expect(toFsPath("/already/plain.png")).toBe("/already/plain.png");
  });
});
