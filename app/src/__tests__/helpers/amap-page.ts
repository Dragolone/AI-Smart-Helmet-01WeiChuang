// 把地图 HTML 里的页内脚本跑在替身 AMap / document 上，验证页内逻辑（调了高德的哪个接口），不是比对脚本文字。
import { jest } from "@jest/globals";

const element = () => ({
  id: "",
  parentNode: null as unknown,
  style: { background: "", setProperty: jest.fn() },
  classList: { add: jest.fn() },
  addEventListener: jest.fn(),
  appendChild: jest.fn(),
});

export function runAmapPage(html: string, userAgent: string) {
  const handlers: Record<string, () => void> = {};
  const map = {
    on: (event: string, cb: () => void) => {
      handlers[event] = cb;
    },
    setMapStyle: jest.fn(),
    panTo: jest.fn(),
    setCenter: jest.fn(),
  };
  const AMap = {
    Map: function () {
      return map;
    },
    Marker: function () {
      return {
        setPosition: jest.fn(),
        setMap: jest.fn(),
        setContent: jest.fn(),
      };
    },
    Pixel: function () {},
    LngLat: function (this: object, lng: number, lat: number) {
      Object.assign(this, { lng, lat });
    },
  };
  const layers = element();
  const document = {
    documentElement: element(),
    body: element(),
    createElement: element,
    getElementById: () => element(),
    querySelector: () => layers,
  };
  const CSS = { supports: () => true };
  const messages: string[] = [];
  const window = {
    ReactNativeWebView: { postMessage: (m: string) => messages.push(m) },
    CSS,
    __I18N: { init: "{msg}", cmd: "{msg}" },
    __cmd: undefined as unknown as (cmd: object) => void,
  };
  const timeouts: (() => void)[] = [];
  // 没带 src 的两段 <script>：工具函数 + 主脚本
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .join("\n");
  new Function(
    "window",
    "document",
    "navigator",
    "AMap",
    "CSS",
    "setInterval",
    "clearInterval",
    "setTimeout",
    script,
  )(
    window,
    document,
    { userAgent },
    AMap,
    CSS,
    () => 0,
    () => undefined,
    (cb: () => void) => timeouts.push(cb),
  );
  // 页内 try/catch 把异常转成 error 消息：替身没配齐时别让用例错到别处去
  const failed = messages.find((m) => m.includes('"error"'));
  if (failed) throw new Error(`地图页内脚本出错：${failed}`);
  return {
    map,
    layers,
    cmd: (cmd: object) => window.__cmd(cmd),
    fire: (event: string) => handlers[event](),
    runTimeouts: () => timeouts.splice(0).forEach((cb) => cb()),
    posted: () => messages.map((m) => JSON.parse(m) as object),
  };
}
