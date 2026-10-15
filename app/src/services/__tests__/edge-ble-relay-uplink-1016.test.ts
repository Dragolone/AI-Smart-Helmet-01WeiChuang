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
  it.each([400, 403, 404])(
    "%s：这台头盔的全部积压（不只这一批）都丢掉，别的头盔照常",
    async (status) => {
      const { up, push } = load();
      push.mockRejectedValue(new Error("offline"));
      for (let i = 0; i < 120; i += 1)
        up.enqueueRelayEvent(env("location_update", "helmet_bad"));
      up.enqueueRelayEvent(env("device_status", "helmet_good", "good-1"));
      await tick();
      push.mockReset();
      push.mockImplementation(async (b) => {
        if (b.deviceId === "helmet_bad") throw httpError(status);
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

  it("现状（A7）：413（请求体超 100 KB）每轮重发同一批——排在批首的摔倒永远送不出去", async () => {
    const { up, push } = load();
    push.mockImplementation(async (b) => {
      if (b.deviceId === "helmet_big") throw httpError(413);
      return { accepted: b.envelopes.length, duplicate: 0, invalid: 0 };
    });
    up.enqueueRelayEvent(env("possible_fall", "helmet_big", "fall-big"));
    await tick();
    for (let i = 0; i < 5; i += 1) await up.flushRelayQueue();
    const bigBatches = sent(push).filter((b) => b.deviceId === "helmet_big");
    expect(bigBatches.length).toBeGreaterThanOrEqual(5);
    for (const b of bigBatches) expect(b.ids[0]).toBe("fall-big");
    expect(savedIds("anonymous")).toEqual(["fall-big"]);
  });
});

describe("2xx 但响应体异常", () => {
  it("现状（A8）：响应体是 null 时这一批已出队，但「高危已接受」回调没走、网络锁没放", async () => {
    const { up, push } = load();
    const accepted = jest.fn();
    up.setCriticalAcceptedHandler(accepted);
    push.mockResolvedValueOnce(null as unknown as Counts);
    up.enqueueRelayEvent(env("possible_fall", "helmet_a", "fall-null"));
    await tick();
    expect(savedIds("anonymous")).toEqual([]);
    expect(accepted).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
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
  it("现状（A6）：匿名期间收到的摔倒首发失败，换到本人分区后不再补传——它留在匿名文件里，而头盔那边已因 ACK 擦除", async () => {
    const { up, push } = load();
    push.mockRejectedValueOnce(new Error("offline"));
    up.startRelayUplink(undefined); // 钥匙串里只有 token、档案还没回来
    await tick();
    up.enqueueRelayEvent(env("possible_fall", "helmet_mine", "fall-anon"));
    await tick();
    // /users/me 回来：use-realtime 先 stop 再按 uid start
    up.stopRelayUplink();
    up.startRelayUplink("user_1");
    await tick();
    push.mockClear();
    await up.flushRelayQueue();
    up.stopRelayUplink();
    expect(push).not.toHaveBeenCalled();
    expect(savedIds("anonymous")).toEqual(["fall-anon"]);
    expect(savedIds("user_1")).toEqual([]);
  });
});
