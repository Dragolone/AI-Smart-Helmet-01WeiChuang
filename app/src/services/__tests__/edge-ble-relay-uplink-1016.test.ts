// 上行中转队列的边界补测（2026-10-16）。保命链路：只断言现状，不改行为。
// 三条发现记在 src/__tests__/EDGE_FINDINGS_1016.md：A6（档案晚到时匿名分区里的事件被丢下）、
// A7（413 每轮重发同一批，这台头盔永远卡住）、A8（2xx 响应体为 null 时漏掉「高危已接受」回调）。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { Mock } from "jest-mock";
import type { EventEnvelope, EventType } from "@helmet/shared";

type Uplink = typeof import("../ble-relay-uplink");
type RelayApi = typeof import("@/api/relay");
type Counts = { accepted: number; duplicate: number; invalid: number };

const mockFiles = new Map<string, string>();
const mockHold = jest.fn((_ms: number) => undefined);
const mockRelease = jest.fn(() => undefined);

jest.mock("expo-file-system", () => ({
  Paths: { document: "/mock/documents" },
  File: class MockFile {
    private readonly name: string;
    constructor(_dir: string, name: string) {
      this.name = name;
    }
    get exists(): boolean {
      return mockFiles.has(this.name);
    }
    textSync(): string {
      return mockFiles.get(this.name) ?? "";
    }
    write(s: string): void {
      mockFiles.set(this.name, s);
    }
    moveSync(dest: { name: string }): void {
      mockFiles.set(dest.name, mockFiles.get(this.name) ?? "");
      mockFiles.delete(this.name);
    }
  },
}));
jest.mock("@/api/relay", () => ({
  relayApi: { push: jest.fn(), ack: jest.fn() },
}));
jest.mock("helmet-link-service", () => ({
  HelmetLinkService: {
    holdNetwork: (ms: number) => mockHold(ms),
    releaseNetwork: () => mockRelease(),
  },
}));
jest.mock("@/services/dev-log", () => ({ devLog: jest.fn() }));

let seq = 0;
const env = (
  eventType: EventType | string,
  deviceId = "helmet_a",
  eventId?: string,
): EventEnvelope<EventType> =>
  ({
    schemaVersion: 1,
    eventId: eventId ?? `e1016-${++seq}`,
    deviceId,
    eventType,
    timestamp: "2026-10-16T00:00:00.000Z",
    firmwareVersion: "1.0.0",
    payload: {},
  }) as EventEnvelope<EventType>;

function load(): { up: Uplink; push: Mock<RelayApi["relayApi"]["push"]> } {
  let up!: Uplink;
  let relay!: RelayApi;
  jest.isolateModules(() => {
    up = jest.requireActual<Uplink>("../ble-relay-uplink");
    relay = jest.requireMock<RelayApi>("@/api/relay");
  });
  const push = relay.relayApi.push as unknown as Mock<
    RelayApi["relayApi"]["push"]
  >;
  push.mockReset();
  push.mockImplementation(async (body) => ({
    accepted: body.envelopes.length,
    duplicate: 0,
    invalid: 0,
  }));
  return { up, push };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const sent = (push: Mock<RelayApi["relayApi"]["push"]>) =>
  push.mock.calls.map((c) => ({
    deviceId: c[0].deviceId,
    ids: (c[0].envelopes as EventEnvelope[]).map((e) => e.eventId),
    types: (c[0].envelopes as EventEnvelope[]).map((e) => e.eventType),
  }));
const httpError = (status: number) =>
  Object.assign(new Error(`http ${status}`), { status, code: "X" });
const queueFile = (owner: string) =>
  `ble-relay-queue.${encodeURIComponent(owner)}.json`;
const savedIds = (owner: string): string[] =>
  (
    JSON.parse(mockFiles.get(queueFile(owner)) ?? '{"events":[]}') as {
      events: EventEnvelope[];
    }
  ).events.map((e) => e.eventId);

beforeEach(() => {
  mockFiles.clear();
  mockHold.mockClear();
  mockRelease.mockClear();
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("入队范围与去重", () => {
  it.each([
    "sleep_entered",
    "sleep_exited",
    "bluetooth_lost",
    "video_ready",
    "_invalid",
    "",
  ])("范围外的事件类型「%s」本地丢弃，不进队列、不持锁", async (type) => {
    const { up, push } = load();
    up.enqueueRelayEvent(env(type));
    await up.flushRelayQueue();
    expect(push).not.toHaveBeenCalled();
    expect(mockHold).not.toHaveBeenCalled();
  });

  it("同一 eventId 入队两次（头盔重发、App 漏判）：队列里两份、同一批里一起送，由服务端按 eventId 记 duplicate（现状）", async () => {
    const { up, push } = load();
    up.enqueueRelayEvent(env("location_update", "helmet_a", "dup-1"));
    up.enqueueRelayEvent(env("location_update", "helmet_a", "dup-1"));
    await up.flushRelayQueue();
    expect(sent(push)).toEqual([
      {
        deviceId: "helmet_a",
        ids: ["dup-1", "dup-1"],
        types: ["location_update", "location_update"],
      },
    ]);
  });
});

describe("批次组成", () => {
  it("同一台头盔：高危的排前面、各自保持先后，周期事件排后", async () => {
    const { up, push } = load();
    push.mockRejectedValueOnce(new Error("offline"));
    up.enqueueRelayEvent(env("location_update", "helmet_a", "p1"));
    up.enqueueRelayEvent(env("collision_risk", "helmet_a", "c1"));
    up.enqueueRelayEvent(env("device_status", "helmet_a", "p2"));
    up.enqueueRelayEvent(env("possible_fall", "helmet_a", "c2"));
    await tick();
    push.mockClear();
    await up.flushRelayQueue();
    expect(sent(push)[0].ids).toEqual(["c1", "c2", "p1", "p2"]);
  });

  it("一台头盔 150 条高危：第一批正好 100 条高危，剩下 50 条下一批", async () => {
    const { up, push } = load();
    push.mockRejectedValue(new Error("offline"));
    for (let i = 0; i < 150; i += 1) up.enqueueRelayEvent(env("obstacle_risk"));
    await tick();
    push.mockReset();
    push.mockImplementation(async (b) => ({
      accepted: b.envelopes.length,
      duplicate: 0,
      invalid: 0,
    }));
    await up.flushRelayQueue();
    await up.flushRelayQueue();
    expect(sent(push).map((b) => b.ids.length)).toEqual([100, 50]);
  });
});

describe("溢出（上限 1000）", () => {
  it("1000 条全是高危时再来一条周期事件：丢的是刚来的这条周期事件，高危一条不少", async () => {
    const { up, push } = load();
    push.mockRejectedValue(new Error("offline"));
    for (let i = 0; i < 1000; i += 1)
      up.enqueueRelayEvent(env("collision_risk", "helmet_a", `c${i}`));
    up.enqueueRelayEvent(env("location_update", "helmet_a", "late-periodic"));
    await tick();
    const ids = savedIds("anonymous");
    expect(ids).toHaveLength(1000);
    expect(ids).not.toContain("late-periodic");
    expect(ids[0]).toBe("c0");
  });

  it("1000 条全是周期事件时来一条摔倒：丢最旧的周期事件，摔倒留下", async () => {
    const { up, push } = load();
    push.mockRejectedValue(new Error("offline"));
    for (let i = 0; i < 1000; i += 1)
      up.enqueueRelayEvent(env("location_update", "helmet_a", `p${i}`));
    up.enqueueRelayEvent(env("possible_fall", "helmet_a", "fall"));
    await tick();
    const ids = savedIds("anonymous");
    expect(ids).toHaveLength(1000);
    expect(ids).not.toContain("p0");
    expect(ids).toContain("fall");
  });

  it("1000 条全是高危时再来一条高危：丢最旧的那条高危（整队都是高危时才这样）", async () => {
    const { up, push } = load();
    push.mockRejectedValue(new Error("offline"));
    for (let i = 0; i < 1000; i += 1)
      up.enqueueRelayEvent(env("possible_fall", "helmet_a", `f${i}`));
    up.enqueueRelayEvent(env("manual_sos", "helmet_a", "newest"));
    await tick();
    const ids = savedIds("anonymous");
    expect(ids[0]).toBe("f1");
    expect(ids.at(-1)).toBe("newest");
  });
});

describe("服务端拒收的几种状态码", () => {
  it.each([
    [400, "VALIDATION_FAILED"],
    [403, "FORBIDDEN"],
    [404, "DEVICE_NOT_FOUND"],
  ])(
    "服务端回 %s %s：这台头盔的全部积压（不只这一批）都丢掉，别的头盔照常",
    async (status, code) => {
      const { up, push } = load();
      push.mockRejectedValue(new Error("offline"));
      for (let i = 0; i < 120; i += 1)
        up.enqueueRelayEvent(env("location_update", "helmet_bad"));
      up.enqueueRelayEvent(env("device_status", "helmet_good", "good-1"));
      await tick();
      push.mockReset();
      push.mockImplementation(async (b) => {
        if (b.deviceId === "helmet_bad")
          throw Object.assign(httpError(status), { code });
        return { accepted: b.envelopes.length, duplicate: 0, invalid: 0 };
      });
      await up.flushRelayQueue();
      await up.flushRelayQueue();
      await up.flushRelayQueue();
      expect(
        sent(push).filter((b) => b.deviceId === "helmet_bad"),
      ).toHaveLength(1);
      expect(sent(push).some((b) => b.ids.includes("good-1"))).toBe(true);
      expect(savedIds("anonymous")).toEqual([]);
    },
  );

  it("改后（10-16 A7）：413（请求体超 100 KB）把批量减半立即重试，减到能过为止——积压里的摔倒不再被同一批拖住", async () => {
    const { up, push } = load();
    push.mockImplementation(async (b) => {
      if (b.deviceId === "helmet_big" && b.envelopes.length > 2)
        throw httpError(413);
      return { accepted: b.envelopes.length, duplicate: 0, invalid: 0 };
    });
    up.enqueueRelayEvent(env("location_update", "helmet_big", "loc-1"));
    up.enqueueRelayEvent(env("location_update", "helmet_big", "loc-2"));
    up.enqueueRelayEvent(env("possible_fall", "helmet_big", "fall-big"));
    await tick();
    for (let i = 0; i < 3; i += 1) {
      await up.flushRelayQueue();
      await tick();
    }
    const bigBatches = sent(push)
      .filter((b) => b.deviceId === "helmet_big")
      .map((b) => b.ids);
    // 摔倒本来就排到批首；整批 3 条 413 → 减到 1 条立即补跑（摔倒单独送出）→ 过了就翻倍回 2 条
    expect(bigBatches).toEqual([
      ["fall-big", "loc-1", "loc-2"],
      ["fall-big"],
      ["loc-1", "loc-2"],
    ]);
    expect(savedIds("anonymous")).toEqual([]);
  });

  it("只有一条还 413：减不了，整批保留下轮重发（单条 100 KB 不会出现在 BLE 事件里）", async () => {
    const { up, push } = load();
    push.mockRejectedValue(httpError(413));
    up.enqueueRelayEvent(env("location_update", "helmet_big", "loc-only"));
    await up.flushRelayQueue();
    await up.flushRelayQueue();
    expect(savedIds("anonymous")).toEqual(["loc-only"]);
  });
});

describe("2xx 但响应体异常", () => {
  it("改后（10-16 A8）：响应体是 null（网关吞了响应体）：2xx 就按整批已接受——「高危已接受」回调照走、网络锁照放", async () => {
    const { up, push } = load();
    const accepted = jest.fn();
    up.setCriticalAcceptedHandler(accepted);
    push.mockResolvedValueOnce(null as unknown as Counts);
    up.enqueueRelayEvent(env("possible_fall", "helmet_a", "fall-null"));
    await tick();
    expect(savedIds("anonymous")).toEqual([]);
    expect(accepted).toHaveBeenCalledWith("helmet_a");
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("正常的 202：摔倒被接受后回调带上设备号，锁释放", async () => {
    const { up } = load();
    const accepted = jest.fn();
    up.setCriticalAcceptedHandler(accepted);
    up.enqueueRelayEvent(env("manual_sos", "helmet_a"));
    await tick();
    expect(accepted).toHaveBeenCalledWith("helmet_a");
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("「高危已接受」回调自己抛错：吞掉，不影响出队与落盘", async () => {
    const { up } = load();
    up.setCriticalAcceptedHandler(() => {
      throw new Error("handler bug");
    });
    up.enqueueRelayEvent(env("possible_fall", "helmet_a", "fall-ok"));
    await tick();
    expect(savedIds("anonymous")).toEqual([]);
  });
});

describe("档案晚到：先落匿名分区、user.id 到了再换（use-realtime onUserReady 的顺序）", () => {
  it("改后（10-16 A6）：匿名期间收到的摔倒首发失败，档案到了用 adoptRelayUplinkOwner 认领——队列整个带到本人分区补传，匿名文件清空", async () => {
    const { up, push } = load();
    push.mockRejectedValueOnce(new Error("offline"));
    up.startRelayUplink(undefined); // 钥匙串里只有 token、档案还没回来
    await tick();
    up.enqueueRelayEvent(env("possible_fall", "helmet_mine", "fall-anon"));
    await tick();
    // /users/me 回来：use-realtime 认领，不是 stop 再 start
    expect(up.adoptRelayUplinkOwner("user_1")).toBe(true);
    await tick();
    expect(savedIds("anonymous")).toEqual([]);
    expect(savedIds("user_1")).toEqual(["fall-anon"]);
    push.mockClear();
    await up.flushRelayQueue();
    expect(sent(push).map((b) => b.ids)).toEqual([["fall-anon"]]);
    up.stopRelayUplink();
    expect(savedIds("user_1")).toEqual([]);
  });

  it("认领时本人分区里还有上次没送完的：合并进来、按 头盔号:事件号 去重", async () => {
    mockFiles.set(
      queueFile("user_1"),
      JSON.stringify({
        v: 2,
        owner: "user_1",
        events: [
          env("location_update", "helmet_mine", "old-1"),
          env("possible_fall", "helmet_mine", "fall-anon"),
        ],
      }),
    );
    const { up, push } = load();
    push.mockRejectedValue(new Error("offline"));
    up.startRelayUplink(undefined);
    await tick();
    up.enqueueRelayEvent(env("possible_fall", "helmet_mine", "fall-anon"));
    await tick();
    up.adoptRelayUplinkOwner("user_1");
    await tick();
    up.stopRelayUplink();
    expect(savedIds("user_1").sort()).toEqual(["fall-anon", "old-1"]);
  });

  it("已经是本人名下（不是匿名）再认领：返回 false、什么都不动", async () => {
    const { up } = load();
    up.startRelayUplink("user_1");
    await tick();
    expect(up.adoptRelayUplinkOwner("user_2")).toBe(false);
    up.enqueueRelayEvent(env("location_update", "helmet_mine", "l-1"));
    up.stopRelayUplink();
    expect(savedIds("user_1")).toEqual(["l-1"]);
    expect(savedIds("user_2")).toEqual([]);
  });
});

describe("积压还没读进内存时的落盘（10-21 修：原来会用缺了积压的内存那份盖掉文件）", () => {
  const seedUser1 = () =>
    mockFiles.set(
      queueFile("user_1"),
      JSON.stringify({
        v: 2,
        owner: "user_1",
        events: [env("possible_fall", "helmet_mine", "old-fall")],
      }),
    );

  it("链路刚起、积压还没并进内存就停了（冷启动时登录过期被强制登出）：文件里的摔倒不被空队列盖掉，读完和内存合并写回", async () => {
    seedUser1();
    const { up, push } = load();
    push.mockRejectedValue(new Error("offline"));
    up.startRelayUplink("user_1");
    up.enqueueRelayEvent(env("possible_fall", "helmet_mine", "new-fall"));
    up.stopRelayUplink();
    // 同一时刻：文件还是原来那份，没被写成只有新事件 / 空
    expect(savedIds("user_1")).toEqual(["old-fall"]);
    await tick();
    expect(savedIds("user_1").sort()).toEqual(["new-fall", "old-fall"]);
    // 再登录同一个账号：两条都在，按序补传
    push.mockReset();
    push.mockImplementation(async (body) => ({
      accepted: body.envelopes.length,
      duplicate: 0,
      invalid: 0,
    }));
    up.startRelayUplink("user_1");
    await tick();
    await up.flushRelayQueue();
    expect(
      sent(push)
        .flatMap((b) => b.ids)
        .sort(),
    ).toEqual(["new-fall", "old-fall"]);
    up.stopRelayUplink();
  });

  it("积压还没并进内存时来了新事件：先不落盘，读完合并后一起落盘", async () => {
    seedUser1();
    const { up, push } = load();
    push.mockRejectedValue(new Error("offline"));
    up.startRelayUplink("user_1");
    up.enqueueRelayEvent(env("location_update", "helmet_mine", "loc-1"));
    expect(savedIds("user_1")).toEqual(["old-fall"]);
    await tick();
    expect(savedIds("user_1").sort()).toEqual(["loc-1", "old-fall"]);
    up.stopRelayUplink();
    expect(savedIds("user_1").sort()).toEqual(["loc-1", "old-fall"]);
  });

  it("没有积压文件时照常：停的时候内存里的照写", async () => {
    const { up, push } = load();
    push.mockRejectedValue(new Error("offline"));
    up.startRelayUplink("user_2");
    await tick();
    up.enqueueRelayEvent(env("possible_fall", "helmet_mine", "f-2"));
    up.stopRelayUplink();
    expect(savedIds("user_2")).toEqual(["f-2"]);
  });
});

describe("退出登录前尽力送完积压（O21）", () => {
  it("relayBacklog：总数和其中摔倒 / 求救的条数", async () => {
    const { up, push } = load();
    push.mockRejectedValue(new Error("offline"));
    up.startRelayUplink("user_1");
    await tick();
    up.enqueueRelayEvent(env("location_update", "helmet_mine", "l-1"));
    up.enqueueRelayEvent(env("possible_fall", "helmet_mine", "f-1"));
    expect(up.relayBacklog()).toEqual({ total: 2, sos: 1 });
    up.stopRelayUplink();
  });

  it("网络好：一轮轮送完、返回 0；断网：一轮送不出去就停、返回剩下的，不空转到时限", async () => {
    const { up, push } = load();
    push.mockRejectedValue(new Error("offline"));
    up.startRelayUplink("user_1");
    await tick();
    up.enqueueRelayEvent(env("possible_fall", "helmet_a", "f-a"));
    up.enqueueRelayEvent(env("location_update", "helmet_b", "l-b"));
    await tick();
    const started = Date.now();
    expect(await up.drainRelayQueue(5_000)).toEqual({ total: 2, sos: 1 });
    expect(Date.now() - started).toBeLessThan(1_000);
    push.mockReset();
    push.mockImplementation(async (body) => ({
      accepted: body.envelopes.length,
      duplicate: 0,
      invalid: 0,
    }));
    expect(await up.drainRelayQueue(5_000)).toEqual({ total: 0, sos: 0 });
    // 两台头盔各一批
    expect(push).toHaveBeenCalledTimes(2);
    up.stopRelayUplink();
  });
});
