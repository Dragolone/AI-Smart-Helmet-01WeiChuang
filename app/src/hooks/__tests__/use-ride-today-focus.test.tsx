// 「今日骑行」在眼前才按分钟轮询：页面不在眼前（切到别的标签）时不再空轮询、也不跟着回前台去拉，
// 但第一次拉取照旧（启动时预取，第一次切过来不用等）。不传 focused 的老调用方式行为不变。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { devicesApi } from "@/api/devices";
import { useRideToday } from "../use-ride-today";

jest.mock("@/api/devices", () => ({
  devicesApi: { locationSummary: jest.fn() },
}));
const summaryMock = devicesApi.locationSummary as unknown as jest.Mock<
  () => Promise<unknown>
>;

let qc: QueryClient;
let tree: ReactTestRenderer | null = null;

function Probe({ focused }: { focused?: boolean }) {
  // 老调用方式：不传第二个参数
  const rest: [] | [boolean] = focused === undefined ? [] : [focused];
  useRideToday("h1", ...rest);
  return null;
}
const el = (focused?: boolean) => (
  <QueryClientProvider client={qc}>
    <Probe focused={focused} />
  </QueryClientProvider>
);
const advance = (ms: number) =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
const opts = () =>
  qc
    .getQueryCache()
    .find({ queryKey: ["ride-today", "h1"] })!
    .observers.map((o) => [
      o.options.refetchInterval,
      o.options.refetchOnWindowFocus,
    ]);

beforeEach(() => {
  jest.useFakeTimers();
  qc = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  summaryMock.mockReset();
  summaryMock.mockResolvedValue({ distanceMeters: 0, movingSeconds: 0 });
});
afterEach(async () => {
  await act(async () => tree?.unmount());
  tree = null;
  qc.clear();
  jest.useRealTimers();
});

describe("useRideToday 的 focused", () => {
  it("在眼前（含老调用方式不传参）：每分钟一轮", async () => {
    await act(async () => {
      tree = create(el());
    });
    expect(summaryMock).toHaveBeenCalledTimes(1);
    expect(opts()).toEqual([[60_000, true]]);
    await advance(61_000);
    expect(summaryMock).toHaveBeenCalledTimes(2);
    await advance(60_000);
    expect(summaryMock).toHaveBeenCalledTimes(3);
  });

  it("不在眼前：第一次照样拉，之后不轮询", async () => {
    await act(async () => {
      tree = create(el(false));
    });
    expect(summaryMock).toHaveBeenCalledTimes(1);
    expect(opts()).toEqual([[false, false]]);
    await advance(5 * 60_000);
    expect(summaryMock).toHaveBeenCalledTimes(1);
  });

  it("先在眼前后切走：轮询停；切回来恢复", async () => {
    await act(async () => {
      tree = create(el(true));
    });
    await advance(61_000);
    expect(summaryMock).toHaveBeenCalledTimes(2);
    await act(async () => tree!.update(el(false)));
    await advance(5 * 60_000);
    expect(summaryMock).toHaveBeenCalledTimes(2);
    await act(async () => tree!.update(el(true)));
    await advance(61_000);
    expect(summaryMock).toHaveBeenCalledTimes(3);
  });
});
