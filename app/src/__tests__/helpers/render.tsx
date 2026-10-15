// 渲染测试的小工具：建树、取全部文字、按文字找可点的节点、按名字找图标。
// react-test-renderer 的 act/create；图标和 Skia 组件由 native-mocks 渲染成同名宿主元素。
import { afterEach } from "@jest/globals";
import type { ReactElement } from "react";
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from "react-test-renderer";

// 每个用例结束卸掉它建的树：不然上一个用例的树还挂在 store 上，下一个用例改 store 会触发 act 警告
const mounted = new Set<ReactTestRenderer>();
afterEach(() => {
  act(() => {
    mounted.forEach((t) => t.unmount());
  });
  mounted.clear();
});

export type Rendered = {
  tree: ReactTestRenderer;
  root: ReactTestInstance;
  /** 树里所有宿主 Text 的文字（嵌套的拼在一起） */
  texts: () => string[];
  /** 全部文字连成一串，断言「有没有出现过」用 */
  allText: () => string;
  /** 名字为 name 的图标（宿主元素 "Ionicons"） */
  icons: () => string[];
  /** 找到第一个「自己或祖先带 onPress」且文字含 label 的节点并按下 */
  press: (label: string) => void;
  /** 带 accessibilityLabel 的第一个可点节点 */
  byLabel: (label: string) => ReactTestInstance;
  rerender: (el: ReactElement) => void;
  unmount: () => void;
};

function textOf(node: ReactTestInstance | string): string {
  if (typeof node === "string") return node;
  return node.children
    .map((c) => textOf(c as ReactTestInstance | string))
    .join("");
}

export function render(el: ReactElement): Rendered {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(el);
  });
  mounted.add(tree);
  const root = () => tree.root;
  const hostTexts = () => root().findAll((n) => isHost(n, "Text"));
  const pressable = (n: ReactTestInstance | null): ReactTestInstance | null => {
    let cur: ReactTestInstance | null = n;
    while (cur) {
      if (typeof cur.props.onPress === "function") return cur;
      cur = cur.parent;
    }
    return null;
  };
  return {
    tree,
    get root() {
      return root();
    },
    texts: () => hostTexts().map((n) => textOf(n)),
    allText: () =>
      hostTexts()
        .map((n) => textOf(n))
        .join("|"),
    icons: () =>
      root()
        .findAll((n) => isHost(n, "Ionicons"))
        .map((n) => String(n.props.name)),
    press: (label) => {
      const hit = hostTexts().find((n) => textOf(n).includes(label));
      if (!hit) throw new Error(`没有文字含「${label}」的节点`);
      const p = pressable(hit);
      if (!p) throw new Error(`「${label}」不可点`);
      act(() => {
        p.props.onPress({ nativeEvent: {} });
      });
    },
    byLabel: (label) => {
      const hit = root().findAll(
        (n) =>
          n.props.accessibilityLabel === label && typeof n.type === "string",
      );
      if (!hit.length)
        throw new Error(`没有 accessibilityLabel=「${label}」的节点`);
      return hit[0];
    },
    rerender: (next) => {
      act(() => {
        tree.update(next);
      });
    },
    unmount: () => {
      act(() => {
        tree.unmount();
      });
      mounted.delete(tree);
    },
  };
}

/** 是不是名为 name 的宿主元素（替身渲染出的 "Ionicons"、"SkiaPath" 也算） */
export function isHost(n: ReactTestInstance, name: string): boolean {
  return (n.type as unknown) === name;
}

/** 树根的宿主节点（toJSON 的单根形式） */
export function rootJson(r: Rendered): {
  type: string;
  props: Record<string, unknown>;
} {
  return r.tree.toJSON() as unknown as {
    type: string;
    props: Record<string, unknown>;
  };
}

/** 拍平 RN 的 style（数组 / false / null 嵌套） */
export function flat(style: unknown): Record<string, unknown> {
  if (!style) return {};
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flat));
  if (typeof style === "object") return style as Record<string, unknown>;
  return {};
}
