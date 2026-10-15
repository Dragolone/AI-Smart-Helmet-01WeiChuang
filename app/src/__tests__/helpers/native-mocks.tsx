// 渲染测试共用的原生库替身（只给 jest.mock 的工厂函数用，不是测试本身）。
// 用法（工厂里不能引用外层变量，所以在工厂里用 jest.requireActual 取这个文件）：
//   jest.mock("react-native-worklets", () => jest.requireActual("react-native-worklets/src/mock"));
//   jest.mock("react-native-reanimated", () =>
//     jest.requireActual<typeof import("@/__tests__/helpers/native-mocks")>("@/__tests__/helpers/native-mocks").reanimatedMock());
//   skiaMock() / iconsMock() 同理。
// 图标、Skia 组件都渲染成同名的宿主元素（"Ionicons"、"SkiaPath"…），测试里按类型找、断言 props。
import { jest } from "@jest/globals";
import { createElement, useEffect, useState, type ReactNode } from "react";

type AnyProps = Record<string, unknown> & { children?: ReactNode };

/** 测试里切换「系统减弱动态效果」：flags.reducedMotion = true */
export const mockFlags = {
  reducedMotion: false,
  /** Skia.Path.MakeFromSVGString 返回 null（走组件的兜底分支） */
  skiaPathNull: false,
};

/**
 * react-native-worklets：官方替身的 scheduleOnRN / runOnJS 走微任务，测试里要 await 才看得到；
 * 这里改成当场调用（UI 线程和 JS 线程在测试里本来就是同一个）。
 */
export function workletsMock() {
  const real = jest.requireActual<Record<string, unknown>>(
    "react-native-worklets/src/mock",
  );
  type Fn = (...args: unknown[]) => unknown;
  return {
    ...real,
    scheduleOnRN: (fn: Fn, ...args: unknown[]) => {
      fn(...args);
    },
    scheduleOnUI: (fn: Fn, ...args: unknown[]) => {
      fn(...args);
    },
    runOnJS:
      (fn: Fn) =>
      (...args: unknown[]) =>
        fn(...args),
    runOnUI:
      (fn: Fn) =>
      (...args: unknown[]) =>
        fn(...args),
  };
}

/** 共享值：get / set / value，set 也接受函数 */
function makeShared<T>(init: T) {
  const box = { value: init };
  return {
    get value() {
      return box.value;
    },
    set value(v: T) {
      box.value = v;
    },
    get: () => box.value,
    set: (v: T | ((cur: T) => T)) => {
      box.value = typeof v === "function" ? (v as (cur: T) => T)(box.value) : v;
    },
    modify: (fn: (cur: T) => T) => {
      box.value = fn(box.value);
    },
  };
}

/**
 * reanimated 官方 jest 替身缺几样本项目用到的东西：useReducedMotion、LayoutAnimationConfig、
 * useFrameCallback；补上。
 * 官方替身的 useSharedValue 每次渲染都新建一个、回到初值；这里改成跨渲染保留（和真的一样），
 * withTiming / withSpring 直接给终值——所以「effect 里 set 过之后再渲染一次」看到的就是动画走完的样子。
 * set 本身不触发重渲染（和真的一样），测试里用 rerender 再渲染一次。
 */
export function reanimatedMock() {
  const real = jest.requireActual<Record<string, unknown>>(
    "react-native-reanimated/mock",
  );
  const Animated = real.default as Record<string, unknown>;
  const LayoutAnimationConfig = ({ children }: AnyProps) => children ?? null;
  return {
    ...real,
    useSharedValue: <T,>(init: T) => useState(() => makeShared(init))[0],
    // 官方替身的 withSequence 给 0；这里给最后一段的终值（序列走完停在哪就是哪）
    withSequence: (...steps: unknown[]) => steps[steps.length - 1],
    // 官方替身里是空函数；这里每次渲染都把 prepare 的结果交给 react（UI 线程上的同步写共享值）
    useAnimatedReaction: <T,>(
      prepare: () => T,
      react: (cur: T, prev: T | null) => void,
    ) => {
      react(prepare(), null);
    },
    makeMutable: <T,>(init: T) => makeShared(init),
    useReducedMotion: () => mockFlags.reducedMotion,
    LayoutAnimationConfig,
    useFrameCallback: () => ({
      setActive: () => undefined,
      isActive: false,
      callbackId: 0,
    }),
    default: { ...Animated, createAnimatedComponent: (c: unknown) => c },
  };
}

/** 「会反应」的替身里记下的一条 useAnimatedReaction */
type Reaction = {
  prepare: () => unknown;
  react: (now: unknown, prev: unknown) => void;
  prev: unknown;
};
/** 挂着的组件登记的反应；pumpReactions() 逐条看 prepare 的结果变没变 */
export const reactions = new Set<Reaction>();
/** 像 UI 线程那样过一遍反应：prepare 的结果和上次不同才调 react(现在, 上次) */
export function pumpReactions(): void {
  for (const r of [...reactions]) {
    const now = r.prepare();
    if (Object.is(now, r.prev)) continue;
    const prev = r.prev;
    r.prev = now;
    r.react(now, prev);
  }
}
/** useFrameCallback 记下的逐帧回调与开关；测试自己喊 cb 来走一帧 */
export const frameClock: {
  cb:
    | ((info: {
        timestamp: number;
        timeSincePreviousFrame: number | null;
      }) => void)
    | null;
  active: boolean;
} = { cb: null, active: false };
/**
 * 逐帧驱动的组件（开屏）用的 reanimated 替身：在 reanimatedMock 上改两样——
 * useAnimatedReaction 不再每次渲染都喊，而是登记下来，挂上时喊一次（上次为 null），之后由 pumpReactions() 按值变化喊；
 * useFrameCallback 记下回调，setActive 只改 frameClock.active。
 */
export function reactiveReanimatedMock() {
  return {
    ...reanimatedMock(),
    useAnimatedReaction: (
      prepare: () => unknown,
      react: (now: unknown, prev: unknown) => void,
    ) => {
      const [entry] = useState<Reaction>(() => ({
        prepare,
        react,
        prev: null,
      }));
      entry.prepare = prepare;
      entry.react = react;
      useEffect(() => {
        reactions.add(entry);
        const now = entry.prepare();
        entry.prev = now;
        entry.react(now, null);
        return () => {
          reactions.delete(entry);
        };
      }, [entry]);
    },
    useFrameCallback: (
      cb: NonNullable<(typeof frameClock)["cb"]>,
      autostart = true,
    ) => {
      const [handle] = useState(() => ({
        setActive: (on: boolean) => {
          frameClock.active = on;
        },
        callbackId: 1,
      }));
      frameClock.cb = cb;
      useEffect(() => {
        frameClock.active = autostart;
        return () => {
          frameClock.cb = null;
          frameClock.active = false;
        };
      }, [autostart]);
      return handle;
    },
  };
}

/** 万能替身：任何属性、任何调用都给回一个替身；参与算术时当 0（不当成 thenable） */
export function anyStub(): unknown {
  const fn = function () {};
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === "then") return undefined;
      return anyStub();
    },
    apply() {
      return anyStub();
    },
  });
}

/** Skia：组件渲染成宿主元素 Skia<名字>；Skia.Path 等工厂返回能被组件当成「有路径」的普通对象 */
export function skiaMock() {
  const host = (name: string) => {
    const C = ({ children, ...props }: AnyProps) =>
      createElement(`Skia${name}`, props, children as ReactNode);
    C.displayName = `Skia${name}`;
    return C;
  };
  const path = () => ({
    kind: "path",
    copy: () => path(),
    getBounds: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
  const known: Record<string, unknown> = {
    Path: {
      MakeFromSVGString: (svg: string) =>
        mockFlags.skiaPathNull ? null : { ...path(), svg },
      Make: () => path(),
    },
    Color: (c: string) => c,
    XYWHRect: (x: number, y: number, width: number, height: number) => ({
      x,
      y,
      width,
      height,
    }),
  };
  // 其余的工厂（PictureRecorder / PathBuilder / Paint / MaskFilter …）给一个万能替身：
  // 什么属性都有、调用什么都返回替身，录图的代码能原样跑完（画出来什么不在这里断言）
  const Skia = new Proxy(known, {
    get(target, prop: string) {
      return prop in target ? target[prop] : anyStub();
    },
  });
  const base: Record<string, unknown> = {
    Skia,
    __esModule: true,
    // 录一张图：把替身画布交给回调跑一遍，交回一个占位的图
    createPicture: (cb: (canvas: unknown) => void) => {
      cb(anyStub());
      return { kind: "picture" };
    },
  };
  return new Proxy(base, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (typeof prop !== "string") return undefined;
      if (prop.startsWith("use")) return () => ({ value: 0, get: () => 0 });
      if (/^[A-Z]/.test(prop)) {
        target[prop] = host(prop);
        return target[prop];
      }
      return undefined;
    },
  });
}

/** @expo/vector-icons：渲染成宿主元素 "Ionicons"（name / color / size 都在 props 上） */
export function iconsMock() {
  const Ionicons = (props: AnyProps) => createElement("Ionicons", props);
  Ionicons.glyphMap = {};
  return {
    Ionicons,
    MaterialIcons: Ionicons,
    MaterialCommunityIcons: Ionicons,
  };
}

/** react-native-safe-area-context：固定的安全区（上 47、下 34） */
export const mockInsets = { top: 47, bottom: 34, left: 0, right: 0 };
export function safeAreaMock() {
  const Pass = ({ children, ...props }: AnyProps) =>
    createElement("SafeAreaView", props, children as ReactNode);
  return {
    useSafeAreaInsets: () => mockInsets,
    SafeAreaView: Pass,
    SafeAreaProvider: ({ children }: AnyProps) => children ?? null,
    initialWindowMetrics: {
      insets: mockInsets,
      frame: { x: 0, y: 0, width: 390, height: 844 },
    },
  };
}

/**
 * react-native-gesture-handler：Gesture.Pan() / Tap() 返回能链式调用的记录器，
 * 把 onBegin / onStart / onUpdate / onEnd / onFinalize 存在 handlers 里、其余配置存在 config 里；
 * GestureDetector 渲染成宿主元素 "GestureDetector"，props.gesture 就是记录器——测试里取出来直接调回调。
 */
export type RecordedGesture = {
  kind: string;
  handlers: Record<string, (...args: unknown[]) => void>;
  config: Record<string, unknown[]>;
  gestures?: RecordedGesture[];
};
export function gestureMock() {
  const builder = (kind: string): RecordedGesture => {
    const rec: RecordedGesture = { kind, handlers: {}, config: {} };
    const proxy: RecordedGesture = new Proxy(rec, {
      get(target, prop: string) {
        if (prop in target) return target[prop as keyof RecordedGesture];
        return (...args: unknown[]) => {
          if (prop.startsWith("on") && typeof args[0] === "function")
            target.handlers[prop] = args[0] as (...a: unknown[]) => void;
          else target.config[prop] = args;
          return proxy;
        };
      },
    });
    return proxy;
  };
  const compose =
    (kind: string) =>
    (...gestures: RecordedGesture[]): RecordedGesture => ({
      kind,
      handlers: {},
      config: {},
      gestures,
    });
  const GestureDetector = ({ gesture, children }: AnyProps) =>
    createElement("GestureDetector", { gesture }, children as ReactNode);
  return {
    Gesture: {
      Pan: () => builder("pan"),
      Tap: () => builder("tap"),
      LongPress: () => builder("longPress"),
      Exclusive: compose("exclusive"),
      Simultaneous: compose("simultaneous"),
      Race: compose("race"),
    },
    GestureDetector,
    GestureHandlerRootView: ({ children, ...props }: AnyProps) =>
      createElement("GestureHandlerRootView", props, children as ReactNode),
  };
}

/** expo-router：路由动作都是 jest.fn；路径 / 参数 / 是否在前台由测试改 routerState */
export const routerState: {
  pathname: string;
  params: Record<string, string | string[] | undefined>;
  focused: boolean;
} = { pathname: "/", params: {}, focused: true };
export const mockRouter = {
  navigate: jest.fn(),
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
  dismiss: jest.fn(),
  dismissTo: jest.fn(),
  dismissAll: jest.fn(),
  setParams: jest.fn(),
  canGoBack: jest.fn(() => true),
  canDismiss: jest.fn(() => false),
};
export const mockNavigation = {
  setOptions: jest.fn(),
  addListener: jest.fn(() => () => undefined),
  goBack: jest.fn(),
  isFocused: () => routerState.focused,
};
export function expoRouterMock() {
  const Screen = (props: AnyProps) => createElement("StackScreen", props);
  const Stack = Object.assign(
    ({ children }: AnyProps) =>
      createElement("Stack", null, children as ReactNode),
    { Screen, Protected: ({ children }: AnyProps) => children ?? null },
  );
  return {
    router: mockRouter,
    useRouter: () => mockRouter,
    useNavigation: () => mockNavigation,
    usePathname: () => routerState.pathname,
    useSegments: () => routerState.pathname.split("/").filter(Boolean),
    useLocalSearchParams: () => routerState.params,
    useGlobalSearchParams: () => routerState.params,
    useIsFocused: () => routerState.focused,
    // 跟着 routerState.focused 走：改成 false 再渲染一次 = 失焦（跑上一次的清理），改回 true = 重新聚焦
    useFocusEffect: (cb: () => void | (() => void)) => {
      const focused = routerState.focused;
      useEffect(() => (focused ? cb() : undefined), [cb, focused]);
    },
    Stack,
    Link: ({ children, ...props }: AnyProps) =>
      createElement("Link", props, children as ReactNode),
    Redirect: (props: AnyProps) => createElement("Redirect", props),
  };
}
