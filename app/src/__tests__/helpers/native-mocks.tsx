// 渲染测试共用的原生库替身（只给 jest.mock 的工厂函数用，不是测试本身）。
// 用法（工厂里不能引用外层变量，所以在工厂里用 jest.requireActual 取这个文件）：
//   jest.mock("react-native-worklets", () => jest.requireActual("react-native-worklets/src/mock"));
//   jest.mock("react-native-reanimated", () =>
//     jest.requireActual<typeof import("@/__tests__/helpers/native-mocks")>("@/__tests__/helpers/native-mocks").reanimatedMock());
//   skiaMock() / iconsMock() 同理。
// 图标、Skia 组件都渲染成同名的宿主元素（"Ionicons"、"SkiaPath"…），测试里按类型找、断言 props。
import { jest } from "@jest/globals";
import { createElement, useState, type ReactNode } from "react";

type AnyProps = Record<string, unknown> & { children?: ReactNode };

/** 测试里切换「系统减弱动态效果」：flags.reducedMotion = true */
export const mockFlags = {
  reducedMotion: false,
  /** Skia.Path.MakeFromSVGString 返回 null（走组件的兜底分支） */
  skiaPathNull: false,
};

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
  const Skia = {
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
  return new Proxy({ Skia, __esModule: true } as Record<string, unknown>, {
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
  return { Ionicons, MaterialCommunityIcons: Ionicons };
}
