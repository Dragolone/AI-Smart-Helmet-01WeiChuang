// 审计 2026-09-13 §5：ble-relay-uplink 行为测试（通过项）。
// 模块级队列状态 → 每个用例用 jest.isolateModules 取全新模块实例；
// expo-file-system 用可控内存假件模拟（损坏 JSON / 写失败 / 恢复顺序）。
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

const mockFs = {
  content: null as string | null,
  throwOnWrite: false,
  throwOnConstruct: false,
  writes: [] as string[],
  reset() {
    this.content = null;
    this.throwOnWrite = false;
    this.throwOnConstruct = false;
    this.writes = [];
  },
};

jest.mock("expo-file-system", () => ({
  Paths: { document: "/mock/documents" },
  File: class MockFile {
    constructor() {
      if (mockFs.throwOnConstruct) throw new Error("mock: File ctor failed");
    }
    get exists(): boolean {
      return mockFs.content !== null;
    }
    textSync(): string {
      return mockFs.content ?? "";
    }
    write(s: string): void {
      if (mockFs.throwOnWrite) throw new Error("mock: ENOSPC");
      mockFs.content = s;
      mockFs.writes.push(s);
    }
  },
}));

jest.mock("@/api/relay", () => ({
  relayApi: { push: jest.fn(), ack: jest.fn() },
}));

let seq = 0;
const env = (
  eventType: EventType,
  deviceId = "helmet_audit_a",
): EventEnvelope<EventType> => ({
  schemaVersion: 1,
  eventId: `audit-evt-${++seq}`,
  deviceId,
  eventType,
  timestamp: new Date().toISOString(),
  firmwareVersion: "audit",
  payload: {},
});

function load(): { up: Uplink; push: Mock<RelayApi["relayApi"]["push"]> } {
  let up!: Uplink;
  let relay!: RelayApi;
  jest.isolateModules(() => {
    up = require("../ble-relay-uplink") as Uplink;
    relay = require("@/api/relay") as RelayApi;
  });
  const push = relay.relayApi.push as unknown as Mock<
    RelayApi["relayApi"]["push"]
  >;
  push.mockResolvedValue({ accepted: 1, duplicate: 0, invalid: 0 });
  return { up, push };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  mockFs.reset();
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe("分批：0/1/99/100/101 条（API.md §12.1 单批 ≤100）", () => {
  it.each([0, 1, 99, 100])(
    "%i 条 → 一次 flush 提交全部（0 条不发请求）",
    async (n) => {
      const { up, push } = load();
      for (let i = 0; i < n; i += 1)
        up.enqueueRelayEvent(env("location_update"));
      await up.flushRelayQueue();
      if (n === 0) {
        expect(push).not.toHaveBeenCalled();
      } else {
        expect(push).toHaveBeenCalledTimes(1);
        expect(push.mock.calls[0][0].envelopes).toHaveLength(n);
      }
      await up.flushRelayQueue();
      expect(push).toHaveBeenCalledTimes(n === 0 ? 0 : 1);
    },
  );

  it("101 条 → 100 + 1 两批，eventId 不重不漏", async () => {
    const { up, push } = load();
    const ids: string[] = [];
    for (let i = 0; i < 101; i += 1) {
      const e = env("location_update");
      ids.push(e.eventId);
      up.enqueueRelayEvent(e);
    }
    await up.flushRelayQueue();
    await up.flushRelayQueue();
    await up.flushRelayQueue();
    expect(push).toHaveBeenCalledTimes(2);
    expect(push.mock.calls[0][0].envelopes).toHaveLength(100);
    expect(push.mock.calls[1][0].envelopes).toHaveLength(1);
    const sent = push.mock.calls.flatMap((c) =>
      (c[0].envelopes as EventEnvelope[]).map((e) => e.eventId),
    );
    expect(sent).toEqual(ids);
  });
});

describe("毒事件与服务端计数", () => {
  it("服务端 202 且 invalid>0（毒事件留档）→ 整批出队，不阻塞后续", async () => {
    const { up, push } = load();
    up.enqueueRelayEvent(env("location_update"));
    up.enqueueRelayEvent(env("possible_fall"));
    push.mockResolvedValueOnce({ accepted: 1, duplicate: 0, invalid: 1 });
    await up.flushRelayQueue();
    await up.flushRelayQueue();
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("全 duplicate（补传重复）也视为消化 → 出队", async () => {
    const { up, push } = load();
    up.enqueueRelayEvent(env("manual_sos"));
    push.mockResolvedValueOnce({ accepted: 0, duplicate: 1, invalid: 0 });
    await up.flushRelayQueue();
    await up.flushRelayQueue();
    expect(push).toHaveBeenCalledTimes(1);
  });
});

describe("持久化：写失败 / 损坏文件 / 恢复顺序", () => {
  it("File.write 抛错（磁盘满）→ 入队与提交照常，保命链路不受阻", async () => {
    const { up, push } = load();
    mockFs.throwOnWrite = true;
    expect(() => up.enqueueRelayEvent(env("possible_fall"))).not.toThrow();
    await up.flushRelayQueue();
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].envelopes[0]).toMatchObject({
      eventType: "possible_fall",
    });
  });

  it("File 构造抛错（目录不可用）→ load/save 都被吞掉，不影响内存队列", async () => {
    const { up, push } = load();
    mockFs.throwOnConstruct = true;
    up.startRelayUplink();
    await tick();
    up.enqueueRelayEvent(env("manual_sos"));
    await up.flushRelayQueue();
    expect(push).toHaveBeenCalledTimes(1);
    up.stopRelayUplink();
  });

  it("损坏 JSON（截断文件）→ 从空队列开始且不抛错", async () => {
    const { up, push } = load();
    mockFs.content = '[{"eventId":"x","deviceId":"d"'; // 截断
    up.startRelayUplink();
    await tick();
    await up.flushRelayQueue();
    expect(push).not.toHaveBeenCalled();
    up.stopRelayUplink();
  });

  it("文件内容为对象而非数组（{}）→ 视作空，不抛错", async () => {
    const { up, push } = load();
    mockFs.content = "{}";
    up.startRelayUplink();
    await tick();
    await up.flushRelayQueue();
    expect(push).not.toHaveBeenCalled();
    up.stopRelayUplink();
  });

  it("杀 App 后恢复：持久化的旧事件排在新入队之前，且按原 eventId 补传", async () => {
    const saved = [env("possible_fall"), env("location_update")];
    // 文件带归属标记（修复 BLE-06 后的格式）；未登录归属为 anonymous
    mockFs.content = JSON.stringify({
      v: 2,
      owner: "anonymous",
      events: saved,
    });
    const { up, push } = load();
    up.startRelayUplink();
    const fresh = env("location_update");
    up.enqueueRelayEvent(fresh);
    await tick();
    await up.flushRelayQueue();
    const ids = (push.mock.calls[0][0].envelopes as EventEnvelope[]).map(
      (e) => e.eventId,
    );
    expect(ids).toEqual([saved[0].eventId, saved[1].eventId, fresh.eventId]);
    up.stopRelayUplink();
  });

  it("每次入队/出队都把整个队列快照写盘（写盘为同步调用，enqueue 返回前已落盘）", async () => {
    const { up } = load();
    const e = env("possible_fall");
    up.enqueueRelayEvent(e);
    expect(mockFs.writes).toHaveLength(1);
    expect(JSON.parse(mockFs.writes[0])).toEqual({
      v: 2,
      owner: "anonymous",
      events: [e],
    });
    await up.flushRelayQueue();
    expect(mockFs.writes).toHaveLength(2);
    expect(JSON.parse(mockFs.writes[1]).events).toEqual([]);
  });
});

describe("flush 与 enqueue 竞态 / start-stop 生命周期", () => {
  it("flush 进行中入队的新事件不会被误出队；在途结束后自动补跑一批，不用等下个 tick（10-06 并发评审 F5）", async () => {
    const { up, push } = load();
    let resolve!: (v: {
      accepted: number;
      duplicate: number;
      invalid: number;
    }) => void;
    push.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    up.enqueueRelayEvent(env("location_update"));
    const inflight = up.flushRelayQueue();
    const late = env("possible_fall");
    up.enqueueRelayEvent(late);
    // flush 重入保护：进行中再次调用直接返回
    await up.flushRelayQueue();
    expect(push).toHaveBeenCalledTimes(1);
    resolve({ accepted: 1, duplicate: 0, invalid: 0 });
    await inflight;
    await new Promise((r) => setTimeout(r, 0)); // 补跑在 finally 里排队
    expect(push).toHaveBeenCalledTimes(2);
    expect(push.mock.calls[1][0].envelopes).toEqual([late]);
  });

  it("重复 start 只起一个定时器；重复 stop 不抛错", async () => {
    jest.useFakeTimers();
    const { up, push } = load();
    up.startRelayUplink();
    up.startRelayUplink();
    up.enqueueRelayEvent(env("device_status"));
    await jest.advanceTimersByTimeAsync(5_000);
    expect(push).toHaveBeenCalledTimes(1);
    up.stopRelayUplink();
    up.stopRelayUplink();
    up.enqueueRelayEvent(env("device_status"));
    await jest.advanceTimersByTimeAsync(20_000);
    expect(push).toHaveBeenCalledTimes(1); // stop 后不再周期提交
  });

  it("stop 不取消进行中的请求：请求完成后仍写回队列与文件（in-flight 写回口径）", async () => {
    const { up, push } = load();
    let resolve!: (v: {
      accepted: number;
      duplicate: number;
      invalid: number;
    }) => void;
    push.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    up.startRelayUplink();
    up.enqueueRelayEvent(env("location_update"));
    const inflight = up.flushRelayQueue();
    up.stopRelayUplink();
    const writesBefore = mockFs.writes.length;
    resolve({ accepted: 1, duplicate: 0, invalid: 0 });
    await inflight;
    // 请求完成后仍写回。这里 stop 发生在积压读进内存之前，stop 自己还会补写一次合并后的（10-21），所以不止一次
    expect(mockFs.writes.length).toBeGreaterThan(writesBefore);
    expect(JSON.parse(mockFs.content ?? "{}").events).toEqual([]);
  });
});
