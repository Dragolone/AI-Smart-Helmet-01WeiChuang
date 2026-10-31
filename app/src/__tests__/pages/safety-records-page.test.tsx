// 安全记录页：头盔列表的三种状态、两个分类、多顶头盔的筛选、按天分组、部分失败 / 全失败 / 空、加载更多、
// 进行中求救置顶、风险提醒详情弹层。底层 api() 按路径给数据，合并 / 分页用真的 services/safety-records。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { QueryClientProvider } from "@tanstack/react-query";
import type {
  AccidentListItem,
  DevicePublic,
  EventListItem,
} from "@helmet/shared";
import { Modal, RefreshControl } from "react-native";
import { act } from "react-test-renderer";
import { mockRouter, routerState } from "@/__tests__/helpers/native-mocks";
import {
  makeQueryClient,
  render,
  waitFor,
  type Rendered,
} from "@/__tests__/helpers/render";
import { ApiRequestError, SessionEndedError } from "@/api/client";
import { Tappable } from "@/components/tappable";
import { translate, useLocaleStore, type MessageKey } from "@/i18n";
import { shortTime } from "@/i18n/format";
import { useThemeStore } from "@/stores/theme-store";
import SafetyRecordsScreen from "@/app/safety-records";

jest.mock("@/global.css", () => ({}));
jest.mock("@expo/vector-icons", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .iconsMock(),
);
jest.mock("react-native-worklets", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .workletsMock(),
);
jest.mock("react-native-reanimated", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .reanimatedMock(),
);
jest.mock("@shopify/react-native-skia", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .skiaMock(),
);
jest.mock("expo-router", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .expoRouterMock(),
);
jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: "light" },
  NotificationFeedbackType: { Success: "success" },
}));
type Route = (path: string) => unknown;
const mockRoutes: { fn: Route } = { fn: () => ({ items: [], total: 0 }) };
jest.mock("@/api/client", () => ({
  ...jest.requireActual<typeof import("@/api/client")>("@/api/client"),
  api: async (path: string) => {
    const out = mockRoutes.fn(path);
    if (out instanceof Error) throw out;
    return out;
  },
  // 分页接口（事件 / SOS 记录）走 apiPage：真实现里调的是模块内部的 api，替身要单独接到同一张路由表
  apiPage: async (path: string) => {
    const out = mockRoutes.fn(path);
    if (out instanceof Error) throw out;
    return out;
  },
}));
const mockHelmets = {
  list: [] as DevicePublic[],
  known: true,
  stale: false,
  error: null as unknown,
  refetch: jest.fn(() => Promise.resolve()),
  links: {} as Record<string, string>,
  pending: [] as { sosId: string; deviceId: string }[],
};
jest.mock("@/hooks/use-safety", () => ({
  useHelmets: () => mockHelmets,
  useHelmetLinks: () => mockHelmets.links,
  usePendingSos: () => mockHelmets.pending,
}));

const tr = (key: MessageKey, params?: Record<string, string | number>) =>
  translate(key, params, "zh-CN");
const dev = (id: string, name: string | null = null) =>
  ({ deviceId: id, name }) as DevicePublic;
const ev = (id: string, type: string, iso: string): EventListItem =>
  ({
    eventId: id,
    eventType: type,
    timestamp: iso,
    deviceId: "h1",
  }) as EventListItem;
const acc = (
  id: string,
  over: Partial<AccidentListItem> = {},
): AccidentListItem =>
  ({
    sosId: id,
    deviceId: "h1",
    triggerType: "possible_fall",
    status: "cancelled",
    createdAt: new Date().toISOString(),
    ...over,
  }) as AccidentListItem;
const now = new Date();
const today = (h: number) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate(), h).toISOString();
const yesterday = (h: number) =>
  new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 1,
    h,
  ).toISOString();
const mount = () =>
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <SafetyRecordsScreen />
    </QueryClientProvider>,
  );
const tabOf = (r: Rendered, key: MessageKey) =>
  r.root.find(
    (n) =>
      n.type === Tappable &&
      n.props.accessibilityRole === "tab" &&
      n.findAll((c) => c.props.children === tr(key)).length > 0,
  );

beforeEach(() => {
  useThemeStore.setState({ mode: "dark" });
  useLocaleStore.setState({ locale: "zh-CN" });
  routerState.params = {};
  Object.assign(mockHelmets, {
    list: [dev("h1", "通勤")],
    known: true,
    stale: false,
    error: null,
    links: {},
    pending: [],
  });
  mockRoutes.fn = () => ({ items: [], total: 0 });
});
afterEach(() => {
  jest.clearAllMocks();
});

describe("头盔列表的三种状态", () => {
  it("还没拿到：骨架；拿不到：失败空态可重试；一顶都没绑：说明绑定后才有", async () => {
    Object.assign(mockHelmets, { known: false, stale: false });
    let r = mount();
    expect(r.texts()).toEqual([]);
    Object.assign(mockHelmets, {
      known: false,
      stale: true,
      error: new TypeError("Network request failed"),
    });
    r = mount();
    expect(r.allText()).toContain(tr("records.loadFailed"));
    expect(r.allText()).toContain(tr("error.network"));
    r.press(tr("safety.action.retry"));
    expect(mockHelmets.refetch).toHaveBeenCalled();
    Object.assign(mockHelmets, { known: true, stale: false, list: [] });
    r = mount();
    expect(r.allText()).toContain(tr("safety.state.noHelmet"));
    expect(r.allText()).toContain(tr("records.noHelmetBody"));
  });

  it("头盔列表还没拿到时，进行中的求救照样置顶，名字先用编号", () => {
    Object.assign(mockHelmets, { known: false, stale: false, list: [] });
    mockHelmets.pending = [{ sosId: "s9", deviceId: "h9" }];
    const r = mount();
    expect(r.allText()).toContain(tr("records.pending", { device: "h9" }));
  });
});

describe("一顶头盔", () => {
  it("风险提醒按天分组：今天 / 昨天；不写头盔名；没有筛选那一排；点一条打开详情", async () => {
    mockRoutes.fn = (p) =>
      p.startsWith("/devices/h1/events")
        ? {
            items: [
              ev("e1", "collision_risk", today(9)),
              ev("e2", "risk_cleared", yesterday(20)),
              ev("e3", "weird_type", yesterday(8)),
            ],
            total: 3,
          }
        : p === "/events/e1"
          ? {
              eventId: "e1",
              eventType: "collision_risk",
              deviceId: "h1",
              timestamp: today(9),
              payload: { riskLevel: "high" },
              media: [],
            }
          : { items: [], total: 0 };
    const r = mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("events.type.collision_risk")),
    );
    const text = r.allText();
    expect(text).toContain(tr("common.today"));
    expect(text).toContain(tr("common.yesterday"));
    expect(text).toContain(tr("events.type.risk_cleared"));
    expect(text).toContain("weird_type");
    expect(r.texts()).toContain(shortTime(today(9), "zh-CN"));
    expect(text).not.toContain(tr("records.allHelmets"));
    r.press(tr("events.type.collision_risk"));
    await waitFor(() =>
      expect(r.allText()).toContain(tr("records.detail.time")),
    );
    const detail = r.allText();
    expect(detail).toContain(tr("safety.level.high"));
    expect(detail).toContain(tr("records.detail.helmet"));
    expect(detail).toContain("通勤");
    expect(detail).toContain(tr("events.mediaNone"));
    expect(detail).toContain(tr("records.detail.note"));
    r.press(tr("events.viewOnMap"));
    expect(mockRouter.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { deviceId: "h1", at: today(9) } }),
    );
    expect(r.root.findByType(Modal).props.visible).toBe(false);
  });

  it("SOS 记录自己每 30 秒轮询（和安全页同一份缓存；安全页被盖住失焦后不再替它轮询）", async () => {
    const qc = makeQueryClient();
    const r = render(
      <QueryClientProvider client={qc}>
        <SafetyRecordsScreen />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(r.allText()).toContain(tr("records.alertsEmpty")),
    );
    const observers = qc
      .getQueryCache()
      .find({ queryKey: ["accidents", "h1"] })!.observers;
    expect(observers.map((o) => o.options.refetchInterval)).toEqual([30_000]);
  });

  it("详情拉不到：标题写失败并说明原因；关掉按钮", async () => {
    mockRoutes.fn = (p) =>
      p.startsWith("/devices/h1/events")
        ? { items: [ev("e1", "obstacle_risk", today(9))], total: 1 }
        : p.startsWith("/events/")
          ? new ApiRequestError(404, { code: "NOT_FOUND" })
          : { items: [], total: 0 };
    const r = mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("events.type.obstacle_risk")),
    );
    r.press(tr("events.type.obstacle_risk"));
    await waitFor(
      () => expect(r.allText()).toContain(tr("records.detail.failed")),
      200,
    );
    expect(r.allText()).toContain(tr("error.notFound"));
    act(() =>
      r.root
        .find(
          (n) =>
            n.type === Tappable &&
            n.props.accessibilityLabel === tr("common.close"),
        )
        .props.onPress(),
    );
    expect(r.root.findByType(Modal).props.visible).toBe(false);
  });

  it("SOS 记录：带 tab=sos 进来直接看；手动 / 摔倒、三种状态；点一条去详情；底部说明", async () => {
    routerState.params = { tab: "sos" };
    mockRoutes.fn = (p) =>
      p.startsWith("/devices/h1/accidents")
        ? {
            items: [
              acc("s1", {
                triggerType: "manual_sos",
                status: "pending",
                createdAt: today(10),
              }),
              acc("s2", { status: "notified", createdAt: today(9) }),
              acc("s3", { status: "cancelled", createdAt: yesterday(9) }),
            ],
            total: 3,
          }
        : { items: [], total: 0 };
    const r = mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("records.sos.manual")),
    );
    const text = r.allText();
    expect(text).toContain(tr("records.sos.fall"));
    expect(text).toContain(tr("safety.status.pending"));
    expect(text).toContain(tr("safety.status.notified"));
    expect(text).toContain(tr("safety.status.cancelled"));
    expect(text).toContain(tr("records.sosNote"));
    r.press(tr("records.sos.manual"));
    expect(mockRouter.navigate).toHaveBeenCalledWith("/accident/s1");
  });

  it("空：一顶头盔时说「这顶头盔暂无」；没连着时多一句收不到新事件", async () => {
    mockHelmets.links = { h1: "searching" };
    const r = mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("records.alertsEmpty")),
    );
    act(() => tabOf(r, "records.tab.sos").props.onPress());
    await waitFor(() => expect(r.allText()).toContain(tr("records.sosEmpty")));
    act(() => tabOf(r, "records.tab.alerts").props.onPress());
    // 有记录时才在列表下面说明连接断开
    mockRoutes.fn = (p) =>
      p.startsWith("/devices/h1/events")
        ? { items: [ev("e1", "collision_risk", today(9))], total: 1 }
        : { items: [], total: 0 };
    const r2 = mount();
    await waitFor(() =>
      expect(r2.allText()).toContain(tr("records.linkDownNote")),
    );
  });

  it("全失败：失败空态可重试；只显示了最近的一部分时写共多少条，并可加载更多", async () => {
    mockRoutes.fn = (p) =>
      p.startsWith("/devices/h1/events")
        ? new ApiRequestError(500, { code: "INTERNAL_ERROR" })
        : { items: [], total: 0 };
    let r = mount();
    await waitFor(
      () => expect(r.allText()).toContain(tr("records.loadFailed")),
      200,
    );
    expect(r.allText()).toContain(tr("error.internal"));
    const pages: string[] = [];
    mockRoutes.fn = (p) => {
      if (!p.startsWith("/devices/h1/events")) return { items: [], total: 0 };
      pages.push(p);
      const page = Number(new URL(`http://x${p}`).searchParams.get("page"));
      return page === 1
        ? { items: [ev("e1", "collision_risk", today(9))], total: 60 }
        : { items: [ev("e2", "obstacle_risk", yesterday(9))], total: 60 };
    };
    r = mount();
    await waitFor(() =>
      expect(r.allText()).toContain(
        tr("records.truncated", { n: 1, total: 60 }),
      ),
    );
    r.press(tr("records.loadMore"));
    await waitFor(() =>
      expect(r.allText()).toContain(tr("events.type.obstacle_risk")),
    );
    expect(pages.some((p) => p.includes("page=2"))).toBe(true);
  });

  // 分页按偏移量取：第 1 页来了新记录，原来排在页尾的那条挤到第 2 页。原来轮询和下拉只重取第 1 页，
  // 被挤走的那条就从列表里消失了（10-17 评审）
  describe("分页之后的刷新", () => {
    const pagedRoute =
      (total: () => number, pages: string[]) => (p: string) => {
        if (!p.startsWith("/devices/h1/events")) return { items: [], total: 0 };
        pages.push(p);
        const page = Number(new URL(`http://x${p}`).searchParams.get("page"));
        return page === 1
          ? { items: [ev("e1", "collision_risk", today(9))], total: total() }
          : {
              items: [ev("e2", "obstacle_risk", yesterday(9))],
              total: total(),
            };
      };
    const page2 = (pages: string[]) =>
      pages.filter((p) => p.includes("page=2")).length;

    it("下拉刷新：已经取过的第 2 页也一起重取", async () => {
      const pages: string[] = [];
      mockRoutes.fn = pagedRoute(() => 60, pages);
      const r = mount();
      await waitFor(() =>
        expect(r.allText()).toContain(tr("records.loadMore")),
      );
      r.press(tr("records.loadMore"));
      await waitFor(() =>
        expect(r.allText()).toContain(tr("events.type.obstacle_risk")),
      );
      expect(page2(pages)).toBe(1);
      const rc = r.root.findByType(RefreshControl);
      await act(async () => {
        rc.props.onRefresh();
        await Promise.resolve();
      });
      await waitFor(() => expect(page2(pages)).toBe(2));
    });

    it("第 1 页的总数变了（轮询拿到新记录）：第 2 页跟着重取；总数没变不重取", async () => {
      const pages: string[] = [];
      let total = 60;
      mockRoutes.fn = pagedRoute(() => total, pages);
      const qc = makeQueryClient();
      const r = render(
        <QueryClientProvider client={qc}>
          <SafetyRecordsScreen />
        </QueryClientProvider>,
      );
      await waitFor(() =>
        expect(r.allText()).toContain(tr("records.loadMore")),
      );
      r.press(tr("records.loadMore"));
      await waitFor(() =>
        expect(r.allText()).toContain(tr("events.type.obstacle_risk")),
      );
      expect(page2(pages)).toBe(1);
      const firstPage = (q: { queryKey: readonly unknown[] }) =>
        q.queryKey[0] === "events" && q.queryKey.length === 4;
      // 总数没变：只有第 1 页自己重取
      await act(async () => {
        await qc.refetchQueries({ predicate: firstPage });
      });
      await act(async () => {
        await new Promise((res) => setTimeout(res, 0));
      });
      expect(page2(pages)).toBe(1);
      // 来了一条新的：第 2 页跟着重取
      total = 61;
      await act(async () => {
        await qc.refetchQueries({ predicate: firstPage });
      });
      await waitFor(() => expect(page2(pages)).toBe(2));
    });
  });

  it("认不出时间的记录：排在最后、单独一组，组标题和时间都写 —，不丢", async () => {
    mockRoutes.fn = (p) =>
      p.startsWith("/devices/h1/events")
        ? {
            items: [
              ev("e2", "obstacle_risk", "not-a-time"),
              ev("e1", "collision_risk", today(9)),
            ],
            total: 2,
          }
        : { items: [], total: 0 };
    const r = mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("events.type.obstacle_risk")),
    );
    const texts = r.texts();
    expect(texts.filter((x) => x === "—")).toHaveLength(2);
    expect(texts.indexOf(tr("events.type.obstacle_risk"))).toBeGreaterThan(
      texts.indexOf(tr("events.type.collision_risk")),
    );
  });

  it("更早的日子：今年的只写月日，往年的带上年份", async () => {
    // 只钉住「现在」：查询和 waitFor 还要靠真的计时器往前走
    jest.useFakeTimers({
      now: new Date(2026, 5, 15, 12),
      doNotFake: [
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "requestIdleCallback",
        "cancelIdleCallback",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
      ],
    });
    try {
      mockRoutes.fn = (p) =>
        p.startsWith("/devices/h1/events")
          ? {
              items: [
                ev(
                  "e1",
                  "collision_risk",
                  new Date(2026, 5, 10, 9).toISOString(),
                ),
                ev(
                  "e2",
                  "obstacle_risk",
                  new Date(2025, 11, 31, 9).toISOString(),
                ),
              ],
              total: 2,
            }
          : { items: [], total: 0 };
      const r = mount();
      await waitFor(() =>
        expect(r.allText()).toContain(tr("events.type.obstacle_risk")),
      );
      expect(r.texts()).toContain("6月10日");
      expect(r.texts()).toContain("2025年12月31日");
      expect(r.allText()).not.toContain(tr("common.today"));
      expect(r.allText()).not.toContain(tr("common.yesterday"));
    } finally {
      jest.useRealTimers();
    }
  });

  it("SOS 记录也能加载更多：按每页 20 条取第 2 页，接在后面", async () => {
    routerState.params = { tab: "sos" };
    const pages: string[] = [];
    mockRoutes.fn = (p) => {
      if (!p.startsWith("/devices/h1/accidents"))
        return { items: [], total: 0 };
      pages.push(p);
      return p.includes("page=2")
        ? {
            items: [
              acc("s2", { triggerType: "manual_sos", createdAt: yesterday(9) }),
            ],
            total: 25,
          }
        : { items: [acc("s1", { createdAt: today(9) })], total: 25 };
    };
    const r = mount();
    await waitFor(() =>
      expect(r.allText()).toContain(
        tr("records.truncated", { n: 1, total: 25 }),
      ),
    );
    expect(r.allText()).not.toContain(tr("records.sos.manual"));
    r.press(tr("records.loadMore"));
    await waitFor(() =>
      expect(r.allText()).toContain(tr("records.sos.manual")),
    );
    expect(pages).toContain("/devices/h1/accidents?page=2&pageSize=20");
  });

  it("连点两次加载更多：第 2、3 页按页序接在后面", async () => {
    const twoDaysAgo = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 2,
      9,
    ).toISOString();
    mockRoutes.fn = (p) => {
      if (!p.startsWith("/devices/h1/events")) return { items: [], total: 0 };
      const page = Number(new URL(`http://x${p}`).searchParams.get("page"));
      const items =
        page === 1
          ? [ev("e1", "collision_risk", today(9))]
          : page === 2
            ? [ev("e2", "obstacle_risk", yesterday(9))]
            : [ev("e3", "risk_cleared", twoDaysAgo)];
      return { items, total: 150 };
    };
    const r = mount();
    await waitFor(() => expect(r.allText()).toContain(tr("records.loadMore")));
    r.press(tr("records.loadMore"));
    await waitFor(() =>
      expect(r.allText()).toContain(tr("events.type.obstacle_risk")),
    );
    r.press(tr("records.loadMore"));
    await waitFor(() =>
      expect(r.allText()).toContain(tr("events.type.risk_cleared")),
    );
    const texts = r.texts();
    expect(texts.indexOf(tr("events.type.obstacle_risk"))).toBeLessThan(
      texts.indexOf(tr("events.type.risk_cleared")),
    );
  });

  it("SOS 记录拉取失败：点重试按 SOS 的列表重取，拿到了就显示", async () => {
    routerState.params = { tab: "sos" };
    mockRoutes.fn = (p) =>
      p.startsWith("/devices/h1/accidents")
        ? new ApiRequestError(500, { code: "INTERNAL_ERROR" })
        : { items: [], total: 0 };
    const r = mount();
    await waitFor(
      () => expect(r.allText()).toContain(tr("records.loadFailed")),
      200,
    );
    mockRoutes.fn = (p) =>
      p.startsWith("/devices/h1/accidents")
        ? { items: [acc("s1", { createdAt: today(9) })], total: 1 }
        : { items: [], total: 0 };
    r.press(tr("safety.action.retry"));
    await waitFor(() => expect(r.allText()).toContain(tr("records.sos.fall")));
    expect(r.allText()).not.toContain(tr("records.loadFailed"));
  });

  it("详情：不认识的类型标题直接写类型名，有视频片段时写几段，不加风险提醒那句说明", async () => {
    mockRoutes.fn = (p) =>
      p.startsWith("/devices/h1/events")
        ? { items: [ev("e3", "weird_type", today(9))], total: 1 }
        : p === "/events/e3"
          ? {
              eventId: "e3",
              eventType: "weird_type",
              deviceId: "h1",
              timestamp: today(9),
              payload: {},
              media: [
                { mediaId: "m1", status: "ready", duration: 12 },
                { mediaId: "m2", status: "ready", duration: 8 },
              ],
            }
          : { items: [], total: 0 };
    const r = mount();
    await waitFor(() => expect(r.allText()).toContain("weird_type"));
    r.press("weird_type");
    await waitFor(() =>
      expect(r.allText()).toContain(tr("records.detail.time")),
    );
    expect(r.allText()).toContain(tr("events.mediaCount", { n: 2 }));
    expect(r.allText()).not.toContain(tr("records.detail.note"));
    // 列表里那一行和弹层标题各一处
    expect(r.texts().filter((x) => x === "weird_type")).toHaveLength(2);
  });

  it("详情弹层：点卡片本身不关，点外面的遮罩才关", async () => {
    mockRoutes.fn = (p) =>
      p.startsWith("/devices/h1/events")
        ? { items: [ev("e1", "collision_risk", today(9))], total: 1 }
        : p === "/events/e1"
          ? {
              eventId: "e1",
              eventType: "collision_risk",
              deviceId: "h1",
              timestamp: today(9),
              payload: {},
              media: [],
            }
          : { items: [], total: 0 };
    const r = mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("events.type.collision_risk")),
    );
    r.press(tr("events.type.collision_risk"));
    await waitFor(() =>
      expect(r.allText()).toContain(tr("records.detail.time")),
    );
    const modal = r.root.findByType(Modal);
    const card = modal.findAll(
      (n) =>
        typeof n.type !== "string" &&
        n.props.accessibilityViewIsModal === true &&
        typeof n.props.onPress === "function",
    )[0];
    const mask = modal.findAll(
      (n) =>
        typeof n.type !== "string" &&
        n.props.accessible === false &&
        n.props.accessibilityViewIsModal !== true &&
        typeof n.props.onPress === "function",
    )[0];
    act(() => card.props.onPress());
    expect(r.root.findByType(Modal).props.visible).toBe(true);
    act(() => mask.props.onPress());
    expect(r.root.findByType(Modal).props.visible).toBe(false);
  });

  it("下拉刷新：重新拉头盔列表和当前分类", async () => {
    const r = mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("records.alertsEmpty")),
    );
    const rc = r.root.findByType(RefreshControl);
    await act(async () => {
      rc.props.onRefresh();
      await Promise.resolve();
    });
    expect(mockHelmets.refetch).toHaveBeenCalled();
  });
});

describe("多顶头盔", () => {
  beforeEach(() => {
    mockHelmets.list = [dev("h1", "通勤"), dev("h2")];
  });

  it("每条写明是哪一顶；筛选只看一顶；一顶失败时其余照常显示并提示部分失败", async () => {
    mockRoutes.fn = (p) =>
      p.startsWith("/devices/h1/events")
        ? { items: [ev("e1", "collision_risk", today(9))], total: 1 }
        : p.startsWith("/devices/h2/events")
          ? new ApiRequestError(503, { code: "INTERNAL_ERROR" })
          : { items: [], total: 0 };
    const r = mount();
    // 头盔名单独一段（太长时截断），时间跟在后面
    await waitFor(() =>
      expect(r.texts()).toContain(` · ${shortTime(today(9), "zh-CN")}`),
    );
    expect(r.texts()).toContain("通勤");
    // 名字太长截中间：默认名都是「helmet_」开头，后几位才分得出是哪一顶（10-17 英文 360dp 宽只剩「helmet_q…」）
    const name = r.root.findAll(
      (n) => n.props.ellipsizeMode === "middle" && n.props.children === "通勤",
    );
    expect(name.length).toBeGreaterThan(0);
    await waitFor(
      () =>
        expect(r.allText()).toContain(
          tr("records.partialFailed", { reason: tr("error.internal") }),
        ),
      200,
    );
    expect(r.allText()).toContain(tr("records.allHelmets"));
    // 只看 h2：它的列表没拿到，不说「暂无」，显示失败
    r.press("h2");
    await waitFor(() =>
      expect(r.allText()).toContain(tr("records.loadFailed")),
    );
    r.press(tr("records.allHelmets"));
    await waitFor(() =>
      expect(r.allText()).toContain(tr("events.type.collision_risk")),
    );
  });

  it("一顶拿到了是空的、另一顶失败：不说「暂无」，显示失败可重试；另一顶还在拉：先放骨架", async () => {
    mockRoutes.fn = (p) =>
      p.startsWith("/devices/h2/events")
        ? new ApiRequestError(503, { code: "INTERNAL_ERROR" })
        : { items: [], total: 0 };
    let r = mount();
    await waitFor(
      () => expect(r.allText()).toContain(tr("records.loadFailed")),
      200,
    );
    expect(r.allText()).not.toContain(tr("records.alertsEmptyAll"));
    expect(r.allText()).toContain(tr("safety.action.retry"));
    r.unmount();

    mockRoutes.fn = (p) =>
      p.startsWith("/devices/h2/events")
        ? new Promise(() => undefined)
        : { items: [], total: 0 };
    const qc = makeQueryClient();
    r = render(
      <QueryClientProvider client={qc}>
        <SafetyRecordsScreen />
      </QueryClientProvider>,
    );
    // h1 那份（空的）已经到了，h2 还在路上
    await waitFor(() =>
      expect(
        qc
          .getQueriesData({ queryKey: ["events", "h1"] })
          .some(([, data]) => data !== undefined),
      ).toBe(true),
    );
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
    });
    expect(r.allText()).not.toContain(tr("records.alertsEmptyAll"));
    expect(r.allText()).not.toContain(tr("records.loadFailed"));
    expect(r.allText()).toContain(tr("records.allHelmets"));
  });

  it("两顶有同号事件、详情接口拿回的是另一顶那条：不显示别人的内容，标题写打不开并说明", async () => {
    mockRoutes.fn = (p) =>
      p.startsWith("/devices/h1/events")
        ? { items: [ev("e1", "collision_risk", today(9))], total: 1 }
        : p.startsWith("/devices/h2/events")
          ? { items: [ev("e1", "obstacle_risk", today(8))], total: 1 }
          : p === "/events/e1"
            ? {
                eventId: "e1",
                eventType: "collision_risk",
                deviceId: "h1",
                timestamp: today(9),
                payload: { riskLevel: "high" },
                media: [],
              }
            : { items: [], total: 0 };
    const r = mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("events.type.obstacle_risk")),
    );
    r.press(tr("events.type.obstacle_risk"));
    await waitFor(() =>
      expect(r.allText()).toContain(tr("records.detail.mismatch")),
    );
    expect(r.allText()).toContain(tr("records.detail.failed"));
    expect(r.allText()).not.toContain(tr("records.detail.time"));
    expect(r.allText()).not.toContain(tr("safety.level.high"));
  });

  it("全部都空：写「暂无」不带「这顶头盔」", async () => {
    const r = mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("records.alertsEmptyAll")),
    );
    act(() => tabOf(r, "records.tab.sos").props.onPress());
    await waitFor(() =>
      expect(r.allText()).toContain(tr("records.sosEmptyAll")),
    );
  });

  it("进行中的求救置顶（不受筛选影响），点了去倒计时页", async () => {
    mockHelmets.pending = [{ sosId: "s9", deviceId: "h2" }];
    const r = mount();
    expect(r.allText()).toContain(tr("records.pending", { device: "h2" }));
    r.press(tr("records.pending", { device: "h2" }));
    expect(mockRouter.navigate).toHaveBeenCalledWith(
      "/sos-active?sosId=s9&deviceId=h2",
    );
  });
});

describe("会话已失效（正被送回登录页）：不再单独提示，登录页自有说明", () => {
  const settle = () =>
    act(async () => {
      await new Promise((res) => setTimeout(res, 0));
    });

  it("头盔列表没拿到是因为会话已失效：失败态不写「登录已失效」", () => {
    Object.assign(mockHelmets, {
      known: false,
      stale: true,
      error: new SessionEndedError(),
    });
    const r = mount();
    expect(r.allText()).not.toContain(tr("error.sessionEnded"));
  });

  it("记录列表、部分头盔、详情拉取时会话已失效：都不写「登录已失效」", async () => {
    mockHelmets.list = [dev("h1", "通勤"), dev("h2")];
    mockRoutes.fn = (p) =>
      p.startsWith("/devices/h1/events")
        ? { items: [ev("e1", "collision_risk", today(9))], total: 1 }
        : p.startsWith("/devices/h2/events") || p.startsWith("/events/")
          ? new SessionEndedError()
          : { items: [], total: 0 };
    const r = mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("events.type.collision_risk")),
    );
    await settle();
    expect(r.allText()).not.toContain(tr("error.sessionEnded"));
    // 只看 h2：整张列表都没拿到
    r.press("h2");
    await settle();
    expect(r.allText()).not.toContain(tr("error.sessionEnded"));
    r.press(tr("records.allHelmets"));
    await waitFor(() =>
      expect(r.allText()).toContain(tr("events.type.collision_risk")),
    );
    r.press(tr("events.type.collision_risk"));
    await settle();
    await settle();
    expect(r.allText()).not.toContain(tr("error.sessionEnded"));
  });
});
