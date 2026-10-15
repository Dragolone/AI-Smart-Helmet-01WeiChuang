// 安全记录页把几顶头盔各自的列表合成一份（纯函数）。
// 接口是按头盔取的（API.md §6 / §7），各取一遍后在这里按时间合并；原则同安全页：
// 没拿到的不能当成「没有」。

/** 一顶头盔的一份列表（react-query 的结果里用得上的那几样） */
export type RecordSource<T> = {
  deviceId: string;
  data?: { items: T[]; total: number };
  isError: boolean;
  error: unknown;
};

export type MergedRecords<T> = {
  /**
   * loading = 一份都还没拿到；failed = 一份都没拿到且有失败的；
   * ready = 至少拿到一份（rows 可能为空）
   */
  status: "loading" | "failed" | "ready";
  /** 最新在前；每条带上它是哪顶头盔的 */
  rows: { deviceId: string; item: T }[];
  /** 已拿到的几份在服务端一共有多少条（大于 rows.length 时说明只显示了最近的一部分） */
  total: number;
  /** 还有更早的没取（某顶头盔拿到的条数少于它的总数）：页面给「加载更多」 */
  hasMore: boolean;
  /** 有头盔的列表没拿到（失败或还在拉）：rows 为空时不能说成「暂无记录」 */
  incomplete: boolean;
  /** 第一个失败的原因；没有失败的为 null */
  error: unknown;
};

const timeValue = (iso: string) => {
  const v = Date.parse(iso);
  return Number.isNaN(v) ? 0 : v;
};

export function mergeRecords<T>(
  sources: readonly RecordSource<T>[],
  timeOf: (x: T) => string,
): MergedRecords<T> {
  const failed = sources.find((s) => s.isError && s.data === undefined);
  const loaded = sources.filter((s) => s.data !== undefined);
  const error = sources.find((s) => s.isError)?.error ?? null;
  if (loaded.length === 0)
    return {
      status: failed ? "failed" : "loading",
      rows: [],
      total: 0,
      hasMore: false,
      incomplete: sources.length > 0,
      error,
    };
  // 截断线：某顶头盔还有更早的没取时，比它已取到的最早一条还早的记录先不显示——那段时间里它没取到的
  // 记录可能夹在中间，显示出来顺序就是错的。取了下一页，线自然往后挪（2026-10-15：1000 条只看得到最近 20 条，
  // 加「加载更多」时一并处理）。只有一顶头盔时线就是它自己最早那条，取到的全显示
  const partial = loaded.filter(
    (s) => s.data!.items.length > 0 && s.data!.items.length < s.data!.total,
  );
  const cut = partial.length
    ? Math.max(
        ...partial.map((s) =>
          Math.min(...s.data!.items.map((x) => timeValue(timeOf(x)))),
        ),
      )
    : null;
  const rows = loaded
    .flatMap((s) =>
      s.data!.items.map((item) => ({ deviceId: s.deviceId, item })),
    )
    .filter((r) => cut === null || timeValue(timeOf(r.item)) >= cut)
    // 认不出时间的排到最后，不丢
    .sort((a, b) => timeValue(timeOf(b.item)) - timeValue(timeOf(a.item)));
  return {
    status: "ready",
    rows,
    total: loaded.reduce((n, s) => n + s.data!.total, 0),
    hasMore: partial.length > 0,
    incomplete: loaded.length < sources.length,
    error,
  };
}

/** 一页的查询结果（react-query 里用得上的那几样） */
export type PageResult<T> = {
  data?: { items: T[]; total: number };
  isError: boolean;
  error: unknown;
};

/**
 * 同一顶头盔的第 1 页和后面几页拼成一份：只拼连续拿到的页（中间某页没到，后面的先不拼，免得跳着显示）。
 * 后面几页失败只算部分失败：已拿到的照常显示，错误交给页面提示。
 * @param keyOf 记录的唯一键。分页是按偏移取的：两页刷新之间来了一条新记录，第 1 页最后一条会被挤到第 2 页，
 *   两页一时都有它——同一条显示两遍、列表的 key 也撞了。给了 keyOf 就按它去重，留先出现（更靠前那页）的
 */
export function combinePages<T>(
  deviceId: string,
  first: PageResult<T>,
  rest: readonly PageResult<T>[],
  keyOf?: (item: T) => string,
): RecordSource<T> & { loadingMore: boolean } {
  if (!first.data)
    return {
      deviceId,
      isError: first.isError,
      error: first.error,
      loadingMore: false,
    };
  const items = [...first.data.items];
  const seen = keyOf ? new Set(items.map(keyOf)) : null;
  let loadingMore = false;
  for (const p of rest) {
    if (!p.data) {
      loadingMore = !p.isError;
      break;
    }
    for (const item of p.data.items) {
      if (seen && keyOf) {
        const k = keyOf(item);
        if (seen.has(k)) continue;
        seen.add(k);
      }
      items.push(item);
    }
  }
  const failedPage = rest.find((p) => p.isError);
  return {
    deviceId,
    data: { items, total: first.data.total },
    isError: first.isError || !!failedPage,
    error: first.isError ? first.error : (failedPage?.error ?? null),
    loadingMore,
  };
}

/**
 * 跨头盔合并的列表里一条记录的键。eventId 只在一顶头盔内唯一（决策 #54：服务端按 (deviceId, eventId) 幂等），
 * 两顶头盔可以各有一条同号事件——只拿 eventId 当 key，「全部头盔」里两行 key 相同，React 会把其中一行当成另一行复用
 *（点开的详情、进出场动画串到别的行上）。deviceId 只含字母数字、下划线、横线，冒号分隔不会有歧义。
 */
export const recordKeyOf = (deviceId: string, id: string): string =>
  `${deviceId}:${id}`;

/**
 * 详情接口只按 eventId 查（API.md §6 GET /events/{eventId}，服务端在本人名下所有头盔里找第一条），
 * 两顶头盔有同号事件时可能拿回另一顶的那条。点的是哪一顶的就只认哪一顶的，对不上不当成这一条显示。
 */
export function detailBelongsTo(
  detail: { deviceId: string } | null | undefined,
  target: { deviceId: string } | null | undefined,
): boolean {
  return !!detail && !!target && detail.deviceId === target.deviceId;
}
