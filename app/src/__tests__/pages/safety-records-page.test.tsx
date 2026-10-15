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
import { ApiRequestError } from "@/api/client";
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
