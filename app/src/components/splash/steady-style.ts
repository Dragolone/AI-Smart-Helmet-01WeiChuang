// 动画样式没变时，把上一次交出去的那个对象原样再交一次。
//
// 为什么：Reanimated 判断「这一帧样式变没变」是逐项比引用（它的 hook/utils 里的 shallowEqual）。样式里只要有
// transform——每次求值都是新建的数组——它就认为变了，把整份样式推给原生，走一遍界面树的提交。开屏那四秒里
// 故事时间每帧都在变，跟着它的样式每帧都要求值；页面上十几二十个这样的元素大多数时候其实没动，却每帧都在推。
// 这一项在模拟器上每帧约 3 毫秒，华为 P30 Pro 上十来毫秒，成标之后的落位因此每次要掉十几帧（2026-10-08 实测）。
//
// 用法：useAnimatedStyle(() => steady(id, { opacity, transform: [...] }))。id 在整个 App 里要唯一
// （同一个组件会出现多份的，用 use-steady-id.ts 的 useSteadyId()）。

type Kept = {
  /** 上一次交出去的对象。Reanimated 会就地改它（把颜色换成数字之类），所以比较用的是下面那份副本 */
  out: object;
  /** 交出去那一刻的样子 */
  was: unknown;
};
type Store = { __steadyStyles?: Record<string, Kept> };

function same(a: unknown, b: unknown): boolean {
  "worklet";
  if (a === b) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  )
    return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
    return true;
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  if (keys.length !== Object.keys(y).length) return false;
  for (let i = 0; i < keys.length; i++)
    if (!same(x[keys[i]], y[keys[i]])) return false;
  return true;
}

function copy(v: unknown): unknown {
  "worklet";
  if (typeof v !== "object" || v === null) return v;
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (let i = 0; i < v.length; i++) out.push(copy(v[i]));
    return out;
  }
  const src = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const keys = Object.keys(src);
  for (let i = 0; i < keys.length; i++) out[keys[i]] = copy(src[keys[i]]);
  return out;
}

export function steady<T extends object>(id: string, next: T): T {
  "worklet";
  const g = globalThis as unknown as Store;
  const all = g.__steadyStyles ?? (g.__steadyStyles = {});
  const kept = all[id];
  if (kept !== undefined && same(kept.was, next)) return kept.out as T;
  all[id] = { out: next, was: copy(next) };
  return next;
}

/** 把某个 id 记着的那份样式清掉（组件卸掉时） */
export function forgetSteady(id: string): void {
  "worklet";
  const all = (globalThis as unknown as Store).__steadyStyles;
  if (all) delete all[id];
}
