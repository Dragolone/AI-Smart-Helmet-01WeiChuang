// 渲染测试的小工具：建树、取全部文字、按文字找可点的节点、按名字找图标。
// react-test-renderer 的 act/create；图标和 Skia 组件由 native-mocks 渲染成同名宿主元素。
import { afterEach } from "@jest/globals";
import { QueryClient } from "@tanstack/react-query";
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
  /** 找到最里层文字含 label 的 Text，按下它自己或最近的带 onPress 的祖先 */
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
  // 看得见的 Text：自己或祖先的样式里不透明度为 0 的不算（主按钮平时叠着一层透明的「已保存」）
  const hostTexts = () =>
    root().findAll((n) => isHost(n, "Text") && !hiddenByOpacity(n));
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
      // 取最里层那个含这段文字的 Text（嵌套 Text 里的链接要点到它自己，不是外层那行）；
      // 文字正好等于 label 的优先（「重试」不要点到「加载失败，请重试」那一行上）
      const inner = hostTexts()
        .filter((n) => textOf(n).includes(label))
        .filter(
          (n) =>
            !n.findAll(
              (c) => c !== n && isHost(c, "Text") && textOf(c).includes(label),
            ).length,
        );
      const hit =
        inner.find((n) => textOf(n) === label && pressable(n)) ??
        inner.find((n) => pressable(n)) ??
        inner[0];
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

/** 自己或某个祖先的样式不透明度为 0 */
function hiddenByOpacity(n: ReactTestInstance): boolean {
  let cur: ReactTestInstance | null = n;
  while (cur) {
    if (typeof cur.type === "string" && flat(cur.props.style).opacity === 0)
      return true;
    cur = cur.parent;
  }
  return false;
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

/**
 * 测试用的 QueryClient：不重试、不回收（gcTime 无穷大）——默认的 5 分钟回收计时器会让 jest 跑完不退出。
 * 每个用例结束清掉建过的客户端。
 */
const clients = new Set<QueryClient>();
afterEach(() => {
  clients.forEach((c) => c.clear());
  clients.clear();
});
export function makeQueryClient(): QueryClient {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  clients.add(qc);
  return qc;
}

/** 等到 check 不再抛错（每次让出一轮宏任务，查询 / Promise 有机会落地）；到次数还不行就把最后的错抛出来 */
export async function waitFor(check: () => void, tries = 50): Promise<void> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      check();
      return;
    } catch (e) {
      last = e;
      await act(async () => {
        await new Promise((res) => setTimeout(res, 0));
      });
    }
  }
  throw last;
}
