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
      incomplete: sources.length > 0,
      error,
    };
  const rows = loaded
    .flatMap((s) =>
      s.data!.items.map((item) => ({ deviceId: s.deviceId, item })),
    )
    // 认不出时间的排到最后，不丢
    .sort((a, b) => timeValue(timeOf(b.item)) - timeValue(timeOf(a.item)));
  return {
    status: "ready",
    rows,
    total: loaded.reduce((n, s) => n + s.data!.total, 0),
    incomplete: loaded.length < sources.length,
    error,
  };
}
