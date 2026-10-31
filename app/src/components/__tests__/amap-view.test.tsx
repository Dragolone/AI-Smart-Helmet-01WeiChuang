// 地图组件层（WebView + 高德 JS API 的唯一封装点）：命令在页内就绪前排队、就绪后按顺序冲刷，
// ready 重发多次只回调一次 onReady；重载后重新排队；拖动 / 错误消息转给调用方；语言切换只推文案不重挂载。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { createRef } from "react";
import { act } from "react-test-renderer";

import { runAmapPage } from "@/__tests__/helpers/amap-page";
import { isHost, render } from "@/__tests__/helpers/render";
import { translate, useLocaleStore } from "@/i18n";
import { AmapView, type AmapViewHandle } from "../map/amap-view";

jest.mock("@/global.css", () => ({}));
const mockWeb = { inject: jest.fn<(js: string) => void>(), reload: jest.fn() };
jest.mock("react-native-webview", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const WebView = React.forwardRef(function WebView(
    props: Record<string, unknown>,
    ref,
  ) {
    React.useImperativeHandle(ref, () => ({
      injectJavaScript: (js: string) => mockWeb.inject(js),
      reload: () => mockWeb.reload(),
    }));
    return React.createElement("WebView", props);
  });
  return { WebView };
});

/** 注入过的命令（window.__cmd(...) 里的 JSON） */
const cmds = () =>
  mockWeb.inject.mock.calls
    .map((c) => c[0])
    .filter((js) => js.startsWith("window.__cmd("))
    .map(
      (js) =>
        JSON.parse(js.slice("window.__cmd(".length, js.lastIndexOf(")"))) as {
          type: string;
        },
    );

beforeEach(() => {
  useLocaleStore.setState({ locale: "zh-CN" });
});
afterEach(() => {
  jest.clearAllMocks();
});

const mount = (props: Partial<Parameters<typeof AmapView>[0]> = {}) => {
  const ref = createRef<AmapViewHandle | null>() as {
    current: AmapViewHandle | null;
  };
  const onReady = jest.fn();
  const onError = jest.fn();
  const onUserPan = jest.fn();
  const r = render(
    <AmapView
      controllerRef={ref}
      onReady={onReady}
      onError={onError}
      onUserPan={onUserPan}
      {...props}
    />,
  );
  const web = () => r.root.find((n) => isHost(n, "WebView"));
  const message = (data: unknown) =>
    act(() => {
      (web().props.onMessage as (e: unknown) => void)({
        nativeEvent: {
          data: typeof data === "string" ? data : JSON.stringify(data),
        },
      });
    });
  return { r, ref, onReady, onError, onUserPan, web, message };
};

describe("AmapView", () => {
  it("页内就绪前的命令排队（含挂载时的头像），ready 后按顺序冲刷；之后的命令直接注入", () => {
    const { ref, message, onReady } = mount({ avatarUrl: "https://x/a.jpg" });
    ref.current!.setHelmet(
      { longitude: 113.9, latitude: 22.5 },
      { follow: true },
    );
    ref.current!.setCenter({ longitude: 114, latitude: 22.6 }, 15);
    expect(cmds()).toEqual([]);
    message({ type: "ready" });
    expect(cmds()).toEqual([
      { type: "avatar", url: "https://x/a.jpg" },
      { type: "helmet", lng: 113.9, lat: 22.5, follow: true },
      { type: "center", lng: 114, lat: 22.6, zoom: 15 },
    ]);
    expect(onReady).toHaveBeenCalledTimes(1);
    ref.current!.clearTrack();
    expect(cmds().pop()).toEqual({ type: "clearTrack" });
  });

  it("ready 会重发多次：每次都冲刷（幂等），onReady 只回调一次", () => {
    const { message, onReady } = mount();
    message({ type: "ready" });
    message({ type: "ready" });
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(cmds().filter((c) => c.type === "avatar")).toHaveLength(1);
  });

  it("各命令的形状：轨迹默认收进视野、四边让 70；标记没给文字时为空串；在线 / 回放状态", () => {
    const { ref, message } = mount();
    message({ type: "ready" });
    const h = ref.current!;
    h.setTrack([
      { longitude: 1, latitude: 2 },
      { longitude: 3, latitude: 4 },
    ]);
    h.setTrack([{ longitude: 1, latitude: 2 }], {
      fit: false,
      pad: [1, 2, 3, 4],
    });
    h.setMarks([
      { longitude: 1, latitude: 2, kind: "start" },
      { longitude: 3, latitude: 4, kind: "event", label: "3", danger: true },
    ]);
    h.setHelmetOnline(false);
    h.setHelmetReplay(true);
    h.setHelmet({ longitude: 5, latitude: 6 });
    expect(cmds().slice(1)).toEqual([
      {
        type: "track",
        path: [
          [1, 2],
          [3, 4],
        ],
        fit: true,
        pad: [70, 70, 70, 70],
      },
      { type: "track", path: [[1, 2]], fit: false, pad: [1, 2, 3, 4] },
      {
        type: "marks",
        items: [
          { lng: 1, lat: 2, kind: "start", danger: false, label: "" },
          { lng: 3, lat: 4, kind: "event", danger: true, label: "3" },
        ],
      },
      { type: "helmetState", online: false },
      { type: "helmetReplay", replay: true },
      { type: "helmet", lng: 5, lat: 6, follow: false },
    ]);
  });

  it("重载：就绪标志复位、整页重载，期间的命令排队等新的 ready；新页面 ready 后再回调一次 onReady（调用方重推状态），头像重新推", () => {
    const { ref, message, onReady } = mount({ avatarUrl: "https://x/a.jpg" });
    message({ type: "ready" });
    ref.current!.reload();
    expect(mockWeb.reload).toHaveBeenCalled();
    const before = cmds().length;
    ref.current!.setHelmetOnline(true);
    expect(cmds()).toHaveLength(before);
    message({ type: "ready" });
    expect(cmds().slice(before)).toEqual([
      { type: "avatar", url: "https://x/a.jpg" },
      { type: "helmetState", online: true },
    ]);
    expect(onReady).toHaveBeenCalledTimes(2);
    // 新页面的 ready 也会重发多次：只算一次
    message({ type: "ready" });
    expect(onReady).toHaveBeenCalledTimes(2);
  });

  it("用户拖动 / 页内报错转给调用方；报错没带文字用「未知错误」；不是 JSON 的消息不理", () => {
    const { message, onUserPan, onError } = mount();
    message({ type: "userpan" });
    expect(onUserPan).toHaveBeenCalled();
    message({ type: "error", message: "脚本加载失败" });
    expect(onError).toHaveBeenLastCalledWith("脚本加载失败");
    message({ type: "error" });
    expect(onError).toHaveBeenLastCalledWith(
      translate("map.err.unknown", undefined, "zh-CN"),
    );
    expect(() => message("not json")).not.toThrow();
    message({ type: "other" });
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("WebView 自己出错：带上描述交给调用方", () => {
    const { web, onError } = mount();
    act(() =>
      (web().props.onError as (e: unknown) => void)({
        nativeEvent: { description: "net::ERR" },
      }),
    );
    expect(onError).toHaveBeenCalledWith(
      translate("map.err.webview", { msg: "net::ERR" }, "zh-CN"),
    );
  });

  it("浅色外观和错误文案在页面加载前注入；切换语言只推新文案，不重挂载", () => {
    const { web, r } = mount({ light: true });
    const pre = web().props.injectedJavaScriptBeforeContentLoaded as string;
    expect(pre).toContain("window.__LIGHT=true");
    expect(pre).toContain(translate("map.err.init", undefined, "zh-CN"));
    expect(mount().web().props.injectedJavaScriptBeforeContentLoaded).toContain(
      "window.__LIGHT=false",
    );
    mockWeb.inject.mockClear();
    act(() => useLocaleStore.setState({ locale: "en" }));
    const i18n = mockWeb.inject.mock.calls
      .map((c) => c[0])
      .filter((js) => js.startsWith("window.__I18N="));
    expect(i18n.length).toBeGreaterThan(0);
    expect(i18n[0]).toContain(translate("map.err.init", undefined, "en"));
    expect(r.root.findAll((n) => isHost(n, "WebView"))).toHaveLength(1);
  });

  it("就绪前同一样东西的命令只留最后一条（头盔显示 / 收起同槽、轨迹画 / 清同槽），留下的保持先后；就绪后照常逐条注入", () => {
    const { ref, message } = mount({ avatarUrl: "https://x/a.jpg" });
    const h = ref.current!;
    h.setHelmet({ longitude: 1, latitude: 1 });
    h.setCenter({ longitude: 9, latitude: 9 }, 14);
    h.setHelmet({ longitude: 2, latitude: 2 }, { follow: true });
    h.hideHelmet();
    h.setTrack([
      { longitude: 1, latitude: 1 },
      { longitude: 2, latitude: 2 },
    ]);
    h.clearTrack();
    h.setTrack([{ longitude: 3, latitude: 3 }], { fit: false });
    h.setHelmetOnline(false);
    h.setMarks([]);
    h.setHelmetOnline(true);
    h.setHelmetReplay(true);
    expect(cmds()).toEqual([]);
    message({ type: "ready" });
    expect(cmds()).toEqual([
      { type: "avatar", url: "https://x/a.jpg" },
      { type: "center", lng: 9, lat: 9, zoom: 14 },
      { type: "hideHelmet" },
      { type: "track", path: [[3, 3]], fit: false, pad: [70, 70, 70, 70] },
      { type: "marks", items: [] },
      { type: "helmetState", online: true },
      { type: "helmetReplay", replay: true },
    ]);
    const before = cmds().length;
    h.setHelmet({ longitude: 4, latitude: 4 });
    h.setHelmet({ longitude: 5, latitude: 5 });
    expect(cmds().slice(before)).toEqual([
      { type: "helmet", lng: 4, lat: 4, follow: false },
      { type: "helmet", lng: 5, lat: 5, follow: false },
    ]);
  });

  it("内容进程被系统杀掉（iOS onContentProcessDidTerminate / Android onRenderProcessGone）：换一个新的 WebView，命令排队到新页面 ready，再回调 onReady", () => {
    const { ref, message, onReady, web } = mount({
      avatarUrl: "https://x/a.jpg",
    });
    message({ type: "ready" });
    expect(onReady).toHaveBeenCalledTimes(1);
    const first = web();
    act(() => {
      (first.props.onContentProcessDidTerminate as () => void)();
    });
    expect(web()).not.toBe(first);
    const before = cmds().length;
    ref.current!.hideHelmet();
    expect(cmds()).toHaveLength(before);
    message({ type: "ready" });
    expect(cmds().slice(before)).toEqual([
      { type: "avatar", url: "https://x/a.jpg" },
      { type: "hideHelmet" },
    ]);
    expect(onReady).toHaveBeenCalledTimes(2);

    const second = web();
    act(() => {
      (second.props.onRenderProcessGone as () => void)();
    });
    expect(web()).not.toBe(second);
    ref.current!.setHelmetOnline(false);
    message({ type: "ready" });
    expect(cmds().pop()).toEqual({ type: "helmetState", online: false });
    expect(onReady).toHaveBeenCalledTimes(3);
  });

  it("用户缩放 / 旋转单独报 userzoom（不当成拖动）；页内脚本认 hideHelmet，缩放只在手指刚碰过地图时上报", () => {
    const onUserZoom = jest.fn();
    const { message, onUserPan, web } = mount({ onUserZoom });
    message({ type: "userzoom" });
    expect(onUserZoom).toHaveBeenCalledTimes(1);
    expect(onUserPan).not.toHaveBeenCalled();
    const html = (web().props.source as { html: string }).html;
    expect(html).toContain("cmd.type === 'hideHelmet'");
    expect(html).toContain("map.on('zoomstart', userZoom)");
    expect(html).toMatch(
      /Date\.now\(\) - lastTouchAt < \d+\) post\(\{ type: 'userzoom' \}\)/,
    );
  });

  it("页面加载后第一次跟随直接到位（不从默认中心横扫过去），之后照旧平滑移动；页面重载后重新算第一次", () => {
    const html = (mount().web().props.source as { html: string }).html;
    const page = runAmapPage(html, "Mozilla/5.0 (Linux; Android 14)");
    const helmet = (lng: number, follow: boolean) =>
      page.cmd({ type: "helmet", lng, lat: 39.9, follow });

    // 不跟随的（回放走这条）不动镜头，也不占掉「第一次」
    helmet(116.3, false);
    expect(page.map.setCenter).not.toHaveBeenCalled();
    expect(page.map.panTo).not.toHaveBeenCalled();

    helmet(116.4, true);
    expect(page.map.setCenter).toHaveBeenCalledTimes(1);
    expect(page.map.setCenter).toHaveBeenCalledWith(
      expect.objectContaining({ lng: 116.4 }),
      true,
    );
    expect(page.map.panTo).not.toHaveBeenCalled();

    helmet(116.5, true);
    expect(page.map.setCenter).toHaveBeenCalledTimes(1);
    expect(page.map.panTo).toHaveBeenCalledTimes(1);
    expect(page.map.panTo).toHaveBeenCalledWith(
      expect.objectContaining({ lng: 116.5 }),
    );

    const reloaded = runAmapPage(html, "Mozilla/5.0 (Linux; Android 14)");
    reloaded.cmd({ type: "helmet", lng: 116.6, lat: 39.9, follow: true });
    expect(reloaded.map.setCenter).toHaveBeenCalledTimes(1);
    expect(reloaded.map.panTo).not.toHaveBeenCalled();
  });

  it("卸载时清掉命令句柄", () => {
    const { ref, r } = mount();
    expect(ref.current).not.toBeNull();
    r.unmount();
    expect(ref.current).toBeNull();
  });
});
