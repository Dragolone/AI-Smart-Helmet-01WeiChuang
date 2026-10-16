// 数据展示类组件：24 小时电量柱状图、地图页的行程列表 / 月历、「看哪台头盔」面板。
// 时间相关的期望一律用同一套格式化函数算出来（测试机时区不固定），只断言组件选了哪条分支、拼成什么样。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type {
  BatteryHistoryPoint,
  DevicePublic,
  RideSummary,
} from "@helmet/shared";
import { Modal, StyleSheet, Text } from "react-native";
import { act } from "react-test-renderer";

import {
  flat,
  isHost,
  render,
  type Rendered,
} from "@/__tests__/helpers/render";
import { Colors } from "@/constants/theme";
import { translate, useLocaleStore, type MessageKey } from "@/i18n";
import {
  dayTitle,
  formatKm,
  monthTitle,
  relativeTime,
  shortTime,
} from "@/i18n/format";
import { dayKeyIn, type RideDay } from "@/services/rides";
import { useThemeStore } from "@/stores/theme-store";
import { BatteryChart } from "../battery-chart";
import { HelmetPicker } from "../map/helmet-picker";
import { RideCalendar } from "../map/ride-calendar";
import {
  RideList,
  durationText,
  endTimeLabel,
  rideTimeRange,
} from "../map/ride-list";
import { Tappable } from "../tappable";

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
jest.mock("react-native-safe-area-context", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .safeAreaMock(),
);
jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: "light" },
  NotificationFeedbackType: { Success: "success" },
}));
jest.mock("expo-image", () => {
  const { createElement: h } =
    jest.requireActual<typeof import("react")>("react");
  return { Image: (props: Record<string, unknown>) => h("ExpoImage", props) };
});

const dark = Colors.dark;
const tr = (key: MessageKey, params?: Record<string, string | number>) =>
  translate(key, params, "zh-CN");
const t = (key: MessageKey, params?: Record<string, string | number>) =>
  tr(key, params);

beforeEach(() => {
  useThemeStore.setState({ mode: "dark" });
  useLocaleStore.setState({ locale: "zh-CN" });
});
afterEach(() => {
  jest.clearAllMocks();
});

describe("BatteryChart", () => {
  const TO = "2026-10-16T12:00:00.000Z";
  const at = (hoursAgo: number) =>
    new Date(Date.parse(TO) - hoursAgo * 3_600_000).toISOString();
  const labels = {
    title: "电量",
    window: "近 24 小时",
    charging: "充电中",
    empty: "暂无数据",
  };
  const bars = (r: Rendered) =>
    r.root
      .findAll(
        (n) =>
          typeof n.type === "string" &&
          typeof flat(n.props.style).height === "string" &&
          flat(n.props.style).borderRadius === 2,
      )
      .map((n) => flat(n.props.style));

  it("没有点：空态文字、中间显示一横、不写 %", () => {
    const r = render(
      <BatteryChart
        points={[]}
        to={TO}
        current={null}
        charging={null}
        labels={labels}
      />,
    );
    expect(r.texts()).toContain("暂无数据");
    expect(r.texts()).toContain("—");
    expect(r.texts()).not.toContain("%");
    expect(bars(r)).toHaveLength(0);
  });

  it("按小时归桶：同一小时取最后一个，窗口外的丢掉；充电中黄；与首页同一套三档（≤10 红、≤20 黄）、其余品牌色；最低画 3%", () => {
    const points: BatteryHistoryPoint[] = [
      { timestamp: at(23.5), battery: 90, charging: false },
      { timestamp: at(10.6), battery: 50, charging: false },
      { timestamp: at(10.2), battery: 48, charging: true },
      { timestamp: at(2.5), battery: 15, charging: false },
      { timestamp: at(0.5), battery: 0, charging: false },
      { timestamp: at(30), battery: 99, charging: false },
      { timestamp: at(-1), battery: 99, charging: false },
    ] as BatteryHistoryPoint[];
    const r = render(
      <BatteryChart
        points={points}
        to={TO}
        current={15}
        charging
        labels={labels}
      />,
    );
    const b = bars(r);
    expect(b.map((s) => s.height)).toEqual(["90%", "48%", "15%", "3%"]);
    expect(b.map((s) => s.backgroundColor)).toEqual([
      dark.brand,
      dark.warning,
      dark.warning,
      dark.danger,
    ]);
    expect(r.texts()).not.toContain("暂无数据");
    // 当前电量 15：低电量那一档，数字黄色（不是红色）、写充电中
    const value = r.root
      .findAllByType(Text)
      .find((x) => x.props.children === 15)!;
    expect(flat(value.props.style).color).toBe(dark.warning);
    expect(r.texts()).toContain("充电中");
    expect(r.texts()).toContain("%");
  });

  it("当前电量 ≤10%：数字和环都是红色", () => {
    const r = render(
      <BatteryChart
        points={[]}
        to={TO}
        current={8}
        charging={false}
        labels={labels}
      />,
    );
    const value = r.root
      .findAllByType(Text)
      .find((x) => x.props.children === 8)!;
    expect(flat(value.props.style).color).toBe(dark.danger);
  });

  it("坐标轴三个刻度：24 / 12 / 0 小时前的整点", () => {
    const r = render(
      <BatteryChart
        points={[]}
        to={TO}
        current={80}
        charging={false}
        labels={labels}
      />,
    );
    const h = new Date(TO).getHours();
    const tick = (off: number) =>
      `${((h - off + 72) % 24).toString().padStart(2, "0")}:00`;
    const texts = r.texts();
    expect(texts.slice(-3)).toEqual([tick(24), tick(12), tick(0)]);
    const value = r.root
      .findAllByType(Text)
      .find((x) => x.props.children === 80)!;
    expect(flat(value.props.style).color).toBe(dark.brand);
  });

  it("没给窗口右端：用挂载时刻", () => {
    const now = Date.now();
    const r = render(
      <BatteryChart
        points={[
          {
            timestamp: new Date(now - 30 * 60_000).toISOString(),
            battery: 60,
            charging: false,
          } as BatteryHistoryPoint,
        ]}
        current={60}
        charging={false}
        labels={labels}
      />,
    );
    expect(bars(r).map((s) => s.height)).toEqual(["60%"]);
  });
});

describe("行程列表的文字", () => {
  const ride = (over: Partial<RideSummary>): RideSummary => ({
    startAt: "2026-10-16T10:05:00.000Z",
    endAt: "2026-10-16T10:41:00.000Z",
    distanceMeters: 8300,
    movingSeconds: 2000,
    maxSpeed: 9.5,
    ongoing: false,
    ...over,
  });

  it("时长：不到一小时写分钟，否则写小时和分", () => {
    expect(durationText(36 * 60, t)).toBe(tr("map.rides.durMin", { m: 36 }));
    expect(durationText(106 * 60, t)).toBe(
      tr("map.rides.durHour", { h: 1, m: 46 }),
    );
  });

  it("时间段：同一天只写钟点；进行中写「现在」；跨零点加「次日」", () => {
    const r1 = ride({});
    expect(rideTimeRange(r1, "zh-CN", t)).toBe(
      `${shortTime(r1.startAt, "zh-CN")} – ${shortTime(r1.endAt, "zh-CN")}`,
    );
    expect(rideTimeRange(ride({ ongoing: true }), "zh-CN", t)).toBe(
      `${shortTime(r1.startAt, "zh-CN")} – ${tr("map.rides.now")}`,
    );
    const s = new Date(2026, 9, 16, 23, 30).toISOString();
    const e = new Date(2026, 9, 17, 0, 20).toISOString();
    expect(endTimeLabel(s, e, "zh-CN", t)).toBe(
      tr("map.rides.nextDay", { time: shortTime(e, "zh-CN") }),
    );
  });
});

describe("RideList", () => {
  const ride = (h: number, over: Partial<RideSummary> = {}): RideSummary => ({
    startAt: new Date(2026, 9, 16, h, 0).toISOString(),
    endAt: new Date(2026, 9, 16, h, 36).toISOString(),
    distanceMeters: 8300,
    movingSeconds: 2000,
    maxSpeed: 9.5,
    ongoing: false,
    ...over,
  });
  const day = (rides: RideSummary[]): RideDay => ({
    key: "2026-10-16",
    at: rides[0].startAt,
    rides,
    distanceMeters: rides.reduce((a, r) => a + r.distanceMeters, 0),
  });
  const base = {
    height: 400,
    days: [] as RideDay[],
    onRetry: jest.fn(),
    onPick: jest.fn(),
    older: null,
    loadingOlder: false,
    olderFailed: false,
    onLoadOlder: jest.fn(),
  };

  it("加载中：骨架，读屏念「加载中」", () => {
    const r = render(<RideList {...base} status="loading" />);
    expect(
      r.root.find(
        (n) =>
          typeof n.type === "string" &&
          n.props.accessibilityLabel === tr("map.rides.loading"),
      ),
    ).toBeTruthy();
    expect(r.texts()).toEqual([]);
  });

  it("加载失败：提醒色图标 + 重试；确实没有：说明怎样才有行程，没有按钮", () => {
    const onRetry = jest.fn();
    let r = render(<RideList {...base} status="error" onRetry={onRetry} />);
    expect(r.texts()).toEqual([
      tr("map.rides.errorTitle"),
      tr("map.rides.errorBody"),
      tr("map.retry"),
    ]);
    expect(r.icons()).toEqual(["alert-circle-outline"]);
    r.press(tr("map.retry"));
    expect(onRetry).toHaveBeenCalled();
    r = render(<RideList {...base} status="empty" />);
    expect(r.texts()).toEqual([
      tr("map.rides.emptyTitle"),
      tr("map.rides.emptyBody"),
    ]);
    expect(r.icons()).toEqual(["trail-sign-outline"]);
  });

  it("按日期看却没有：标题换成「这段时间没有」，给「查看全部行程」", () => {
    const onShowAll = jest.fn();
    const r = render(
      <RideList {...base} status="empty" onShowAll={onShowAll} />,
    );
    expect(r.texts()).toEqual([
      tr("map.rides.filterEmptyTitle"),
      tr("map.rides.showAll"),
    ]);
    r.press(tr("map.rides.showAll"));
    expect(onShowAll).toHaveBeenCalled();
  });

  it("有数据：按天分组、每趟一行（最高时速换成 km/h、进行中的写已骑多久）；点一行回调那一趟", () => {
    const live = ride(19, {
      ongoing: true,
      maxSpeed: null,
      distanceMeters: 1200,
    });
    const done = ride(8);
    const noMax = ride(12, { maxSpeed: null });
    const onPick = jest.fn();
    const r = render(
      <RideList
        {...base}
        status="ready"
        days={[day([live, done, noMax])]}
        onPick={onPick}
      />,
    );
    const text = r.allText();
    expect(text).toContain(dayTitle(live.startAt, "zh-CN"));
    expect(text).toContain(
      tr("map.rides.daySum", { n: 3, km: formatKm(1200 + 8300 + 8300) }),
    );
    expect(text).toContain(
      tr("map.rides.live", { dur: tr("map.rides.durMin", { m: 36 }) }),
    );
    expect(text).toContain(
      tr("map.rides.rowMax", {
        dur: tr("map.rides.durMin", { m: 36 }),
        max: 34,
      }),
    );
    expect(r.texts()).toContain(tr("map.rides.durMin", { m: 36 }));
    expect(text).toContain(tr("map.rides.end"));
    const rows = r.root.findAll(
      (n) => n.type === Tappable && n.props.accessibilityRole === "button",
    );
    expect(rows).toHaveLength(3);
    act(() => rows[1].props.onPress());
    expect(onPick).toHaveBeenCalledWith(done);
  });

  it("还有更早的月：加载更早；加载中按钮变「正在加载」；上次失败多一行提醒", () => {
    const onLoadOlder = jest.fn();
    const days = [day([ride(8)])];
    let r = render(
      <RideList
        {...base}
        status="ready"
        days={days}
        older={{ year: 2026, month: 8 }}
        onLoadOlder={onLoadOlder}
      />,
    );
    r.press(tr("map.rides.loadOlder"));
    expect(onLoadOlder).toHaveBeenCalled();
    r = render(
      <RideList
        {...base}
        status="ready"
        days={days}
        older={{ year: 2026, month: 8 }}
        olderFailed
        loadingOlder
      />,
    );
    expect(r.allText()).toContain(tr("map.rides.moreFailed"));
    expect(r.allText()).not.toContain(tr("map.rides.loadOlder"));
    // 按日期看时底部换成「查看全部行程」，不往更早翻
    r = render(
      <RideList
        {...base}
        status="ready"
        days={days}
        older={{ year: 2026, month: 8 }}
        onShowAll={jest.fn()}
      />,
    );
    expect(r.allText()).toContain(tr("map.rides.showAll"));
    expect(r.allText()).not.toContain(tr("map.rides.loadOlder"));
  });
});

describe("RideCalendar", () => {
  const month = { year: 2026, month: 9 }; // 2026 年 10 月
  const base = {
    height: 420,
    month,
    min: { year: 2026, month: 0 },
    max: { year: 2026, month: 9 },
    todayKey: "2026-10-16",
    status: "ready" as const,
    stats: new Map([
      ["2026-10-03", { rides: 2, distanceMeters: 5000 }],
      ["2026-10-16", { rides: 1, distanceMeters: 2500 }],
    ]),
    selectedDayKey: null as string | null,
    filtered: false,
    onMonth: jest.fn(),
    onPickDay: jest.fn(),
    onPickMonth: jest.fn(),
    onShowAll: jest.fn(),
    onRetry: jest.fn(),
  };
  const nav = (r: Rendered, key: MessageKey) =>
    r.root.find(
      (n) => n.type === Tappable && n.props.accessibilityLabel === tr(key),
    );
  const dayLabel = (d: number) =>
    dayTitle(new Date(2026, 9, d, 12).toISOString(), "zh-CN");

  it("标题是月份；31 天都在；有行程的日子可点，没有的只能念「没有行程」", () => {
    const r = render(<RideCalendar {...base} />);
    expect(r.texts()).toContain(monthTitle(2026, 9, "zh-CN"));
    for (let d = 1; d <= 31; d++) expect(r.texts()).toContain(String(d));
    const tappable = r.root.findAll(
      (n) =>
        n.type === Tappable &&
        n.props.accessibilityState?.selected !== undefined,
    );
    expect(tappable).toHaveLength(2);
    expect(tappable[0].props.accessibilityLabel).toBe(
      tr("map.rides.dayA11y", { date: dayLabel(3), n: 2, km: formatKm(5000) }),
    );
    act(() => tappable[0].props.onPress());
    expect(base.onPickDay).toHaveBeenCalledWith(dayKeyIn(month, 3));
    const none = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        n.props.accessibilityLabel ===
          tr("map.rides.dayNoneA11y", { date: dayLabel(4) }),
    );
    expect(none).toBeTruthy();
  });

  it("翻月：最早 / 最晚的月不能再翻；能翻时回调相邻月", () => {
    let r = render(<RideCalendar {...base} />);
    expect(nav(r, "map.rides.nextMonth").props.disabled).toBe(true);
    expect(nav(r, "map.rides.prevMonth").props.disabled).toBe(false);
    act(() => nav(r, "map.rides.prevMonth").props.onPress());
    expect(base.onMonth).toHaveBeenCalledWith({ year: 2026, month: 8 });
    r = render(
      <RideCalendar
        {...base}
        month={{ year: 2026, month: 0 }}
        stats={new Map()}
      />,
    );
    expect(nav(r, "map.rides.prevMonth").props.disabled).toBe(true);
    act(() => nav(r, "map.rides.nextMonth").props.onPress());
    expect(base.onMonth).toHaveBeenLastCalledWith({ year: 2026, month: 1 });
  });

  it("底部：合计 + 查看整月；没有行程写没有；加载中骨架；失败可重试", () => {
    let r = render(<RideCalendar {...base} />);
    expect(r.allText()).toContain(
      tr("map.rides.monthSum", { n: 3, km: formatKm(7500) }),
    );
    r.press(tr("map.rides.monthAll"));
    expect(base.onPickMonth).toHaveBeenCalled();
    r = render(<RideCalendar {...base} stats={new Map()} />);
    expect(r.allText()).toContain(tr("map.rides.monthNone"));
    r = render(<RideCalendar {...base} status="loading" />);
    expect(
      r.root.find(
        (n) =>
          typeof n.type === "string" &&
          n.props.accessibilityLabel === tr("map.rides.monthLoading"),
      ),
    ).toBeTruthy();
    r = render(<RideCalendar {...base} status="error" />);
    expect(r.allText()).toContain(tr("map.rides.monthFailed"));
    r.press(tr("map.retry"));
    expect(base.onRetry).toHaveBeenCalled();
  });

  it("选中的那天用品牌色底、上面的点隐掉；按日期看时多一个「查看全部行程」", () => {
    const r = render(
      <RideCalendar {...base} selectedDayKey="2026-10-16" filtered />,
    );
    const sel = r.root.find(
      (n) =>
        n.type === Tappable && n.props.accessibilityState?.selected === true,
    );
    const disc = sel.findAll(
      (n) =>
        typeof n.type === "string" &&
        flat(n.props.style).backgroundColor === dark.brand,
    );
    expect(disc.length).toBeGreaterThan(0);
    r.press(tr("map.rides.showAll"));
    expect(base.onShowAll).toHaveBeenCalled();
  });
});

describe("HelmetPicker", () => {
  const dev = (id: string, over: Partial<DevicePublic> = {}) =>
    ({
      deviceId: id,
      name: null,
      battery: 70,
      lastSeenAt: "2026-10-16T01:00:00.000Z",
      ...over,
    }) as DevicePublic;
  const devices = [dev("h1", { name: "通勤" }), dev("h2", { battery: null })];

  it("列出各顶：名字（没起名用编号）、当前头盔标签、电量；在看的那顶打勾", () => {
    const r = render(
      <HelmetPicker
        visible
        devices={devices}
        links={{ h1: "connected" }}
        viewedId="h2"
        currentId="h1"
        onPick={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    const text = r.allText();
    expect(text).toContain(tr("map.picker.title"));
    expect(text).toContain("通勤");
    expect(
      r.texts().filter((x) => x === tr("map.picker.currentTag")),
    ).toHaveLength(1);
    expect(text).toContain(`h1 · ${tr("map.picker.battery", { n: 70 })}`);
    expect(r.texts()).toContain("h2");
    const rows = r.root.findAll(
      (n) =>
        n.type === Tappable &&
        n.props.accessibilityState?.selected !== undefined,
    );
    expect(rows.map((x) => x.props.accessibilityState.selected)).toEqual([
      false,
      true,
    ]);
    expect(r.root.findAll((n) => isHost(n, "ExpoImage"))).toHaveLength(2);
  });

  it("连着的写连接状态，没连的写离线多久了", () => {
    const r = render(
      <HelmetPicker
        visible
        devices={devices}
        links={{ h1: "connected", h2: "offline" }}
        viewedId="h1"
        currentId={undefined}
        onPick={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    expect(r.allText()).toContain(
      `${tr("common.offline")} · ${relativeTime(devices[1].lastSeenAt, "zh-CN")}`,
    );
    expect(
      r.texts().filter((x) => x === tr("map.picker.currentTag")),
    ).toHaveLength(0);
  });

  it("点一顶回调它；关闭按钮 / 点遮罩 / 返回键都关", () => {
    const onPick = jest.fn();
    const onClose = jest.fn();
    const r = render(
      <HelmetPicker
        visible
        devices={devices}
        links={{}}
        viewedId="h1"
        currentId="h1"
        onPick={onPick}
        onClose={onClose}
      />,
    );
    const rows = r.root.findAll(
      (n) =>
        n.type === Tappable &&
        n.props.accessibilityState?.selected !== undefined,
    );
    act(() => rows[1].props.onPress());
    expect(onPick).toHaveBeenCalledWith("h2");
    act(() =>
      r.root
        .find(
          (n) =>
            n.type === Tappable &&
            n.props.accessibilityLabel === tr("common.close"),
        )
        .props.onPress(),
    );
    act(() => r.root.findByType(Modal).props.onRequestClose());
    // 遮罩：铺满整个面板外面的那个可点区域
    const mask = r.root.find(
      (n) =>
        typeof n.type !== "string" &&
        n.props.style === StyleSheet.absoluteFill &&
        typeof n.props.onPress === "function",
    );
    act(() => mask.props.onPress());
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("不可见时什么都不渲染", () => {
    const r = render(
      <HelmetPicker
        visible={false}
        devices={devices}
        links={{}}
        viewedId="h1"
        currentId="h1"
        onPick={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    expect(r.allText()).toBe("");
  });
});
