// 边界补测（2026-10-03）：ble-relay-uplink 现有用例没碰到的角落。
// 与 audit-ble-uplink 的差别：假文件系统按「文件名」分开存（原假件只有一份内容，
// 验不出「B 登录后把 A 的分区文件覆盖掉」这类退化），并且把 helmet-link-service 的持锁调用也接出来断言。
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
const mockFsFail = { move: false, del: false };
const mockFsMoves: string[] = [];
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
    moveSync(dest: { name: string }, _o?: unknown): void {
      if (mockFsFail.move) throw new Error("mock: rename failed");
      mockFsMoves.push(`${this.name} -> ${dest.name}`);
      mockFiles.set(dest.name, mockFiles.get(this.name) ?? "");
      mockFiles.delete(this.name);
    }
    delete(): void {
      if (mockFsFail.del) throw new Error("mock: delete failed");
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

const fileOf = (owner: string) =>
  `ble-relay-queue.${encodeURIComponent(owner)}.json`;
const savedIds = (owner: string): string[] =>
  (
    JSON.parse(mockFiles.get(fileOf(owner)) ?? '{"events":[]}') as {
      events: EventEnvelope[];
    }
  ).events.map((e) => e.eventId);

let seq = 0;
const env = (
  eventType: EventType,
  deviceId = "helmet_edge_a",
): EventEnvelope<EventType> => ({
  schemaVersion: 1,
  eventId: `edge-evt-${++seq}`,
  deviceId,
  eventType,
  timestamp: "2026-10-03T00:00:00.000Z",
  firmwareVersion: "edge",
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
const sentIds = (push: Mock<RelayApi["relayApi"]["push"]>): string[][] =>
  push.mock.calls.map((c) =>
    (c[0].envelopes as EventEnvelope[]).map((e) => e.eventId),
  );
const httpError = (status: number | undefined) =>
  Object.assign(new Error(`http ${status}`), { status, code: "X" });

/** 让一次 push 挂起，由用例决定何时成功/失败 */
function deferPush(push: Mock<RelayApi["relayApi"]["push"]>): {
  resolve: (c: Counts) => void;
  reject: (e: unknown) => void;
} {
  const handle = {
    resolve: (_c: Counts): void => undefined,
    reject: (_e: unknown): void => undefined,
  };
  push.mockImplementationOnce(
    () =>
      new Promise<Counts>((resolve, reject) => {
        handle.resolve = resolve;
        handle.reject = reject;
      }),
  );
  return handle;
}

beforeEach(() => {
  mockFiles.clear();
  mockHold.mockClear();
  mockRelease.mockClear();
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe("按账号分区：文件名层面的隔离", () => {
  it("B 登录期间的入队/出队只写 B 的文件，A 的分区原封不动；A 再登录按原 eventId 补传", async () => {
    const { up, push } = load();
    push.mockRejectedValue(new Error("offline"));
    up.startRelayUplink("user_A");
    const a1 = env("location_update", "helmet_of_A");
    up.enqueueRelayEvent(a1);
    up.stopRelayUplink();
    // 积压还没读进内存就停：等读完合并再落盘（10-21），所以文件晚一拍才写
    await tick();
    const aFileBefore = mockFiles.get(fileOf("user_A"));
    expect(savedIds("user_A")).toEqual([a1.eventId]);

    up.startRelayUplink("user_B");
    await tick();
    const b1 = env("location_update", "helmet_of_B");
    up.enqueueRelayEvent(b1);
    push.mockResolvedValue({ accepted: 1, duplicate: 0, invalid: 0 });
    await up.flushRelayQueue();
    up.stopRelayUplink();
    expect(sentIds(push)).toEqual([[b1.eventId]]);
    expect(mockFiles.get(fileOf("user_A"))).toBe(aFileBefore);
    expect(savedIds("user_B")).toEqual([]);

    up.startRelayUplink("user_A");
    await tick();
    await up.flushRelayQueue();
    up.stopRelayUplink();
    expect(sentIds(push)).toEqual([[b1.eventId], [a1.eventId]]);
  });

  it("归属键含路径分隔符时做 URI 编码，文件名不会逃出文档目录", async () => {
    const { up } = load();
    up.startRelayUplink("../a/b");
    up.enqueueRelayEvent(env("device_status"));
    up.stopRelayUplink();
    await tick();
    expect([...mockFiles.keys()]).toEqual(["ble-relay-queue...%2Fa%2Fb.json"]);
  });

  it("A 的积压还没从文件恢复完就退出、换 B 登录：A 的事件不并进 B 的会话", async () => {
    mockFiles.set(
      fileOf("user_A"),
      JSON.stringify({
        v: 2,
        owner: "user_A",
        events: [env("possible_fall", "helmet_of_A")],
      }),
    );
    const { up, push } = load();
    up.startRelayUplink("user_A");
    up.stopRelayUplink();
    up.startRelayUplink("user_B");
    await tick();
    await up.flushRelayQueue();
    up.stopRelayUplink();
    expect(push.mock.calls.map((c) => c[0].deviceId)).not.toContain(
      "helmet_of_A",
    );
  });

  it("认领（匿名 → 本人）途中就退出登录：从本人分区读出的积压不留在内存里，下一个登录的人带不走", async () => {
    mockFiles.set(
      fileOf("user_1"),
      JSON.stringify({
        v: 2,
        owner: "user_1",
        events: [env("location_update", "helmet_of_1")],
      }),
    );
    const { up, push } = load();
    up.startRelayUplink();
    await tick();
    up.adoptRelayUplinkOwner("user_1");
    up.stopRelayUplink();
    await tick();
    up.startRelayUplink("user_2");
    await tick();
    await up.flushRelayQueue();
    up.stopRelayUplink();
    expect(push.mock.calls.map((c) => c[0].deviceId)).not.toContain(
      "helmet_of_1",
    );
  });

  it("未登录（匿名分区）积压的事件不会被随后登录的真实账号带走", async () => {
    const { up, push } = load();
    push.mockRejectedValue(new Error("offline"));
    up.startRelayUplink();
    up.enqueueRelayEvent(env("possible_fall", "helmet_x"));
    up.stopRelayUplink();
    push.mockClear();
    push.mockResolvedValue({ accepted: 1, duplicate: 0, invalid: 0 });
    up.startRelayUplink("user_A");
    await tick();
    await up.flushRelayQueue();
    up.stopRelayUplink();
    expect(push).not.toHaveBeenCalled();
    expect(savedIds("anonymous")).toHaveLength(1);
  });
});

describe("持久化：先写临时文件再原子改名（10-06 不变式评审 F-6）", () => {
  beforeEach(() => {
    mockFsFail.move = false;
    mockFsMoves.length = 0;
  });

  it("每次落盘都是「写 .tmp → 改名覆盖正式文件」，正式文件从不被直接覆盖写", async () => {
    const { up } = load();
    up.startRelayUplink("user_A");
    await tick();
    up.enqueueRelayEvent(env("possible_fall"));
    expect(mockFsMoves.at(-1)).toBe(
      `${fileOf("user_A")}.tmp -> ${fileOf("user_A")}`,
    );
    expect(mockFiles.has(`${fileOf("user_A")}.tmp`)).toBe(false);
    expect(savedIds("user_A")).toHaveLength(1);
  });

  it("写完 .tmp、改名前进程被杀：下次启动从完整的 .tmp 恢复（它才是最近一次落盘）", async () => {
    const fall = env("possible_fall");
    mockFiles.set(
      fileOf("user_A"),
      JSON.stringify({ v: 2, owner: "user_A", events: [] }),
    );
    mockFiles.set(
      `${fileOf("user_A")}.tmp`,
      JSON.stringify({ v: 2, owner: "user_A", events: [fall] }),
    );
    const { up, push } = load();
    push.mockResolvedValue({ accepted: 1, duplicate: 0, invalid: 0 });
    up.startRelayUplink("user_A");
    await tick();
    await up.flushRelayQueue();
    expect(push).toHaveBeenCalledTimes(1);
    expect(
      (push.mock.calls[0][0].envelopes as EventEnvelope[]).map(
        (e) => e.eventId,
      ),
    ).toEqual([fall.eventId]);
  });

  it(".tmp 写到一半被杀（残缺 JSON）：忽略它，从正式文件恢复", async () => {
    const fall = env("possible_fall");
    mockFiles.set(
      fileOf("user_A"),
      JSON.stringify({ v: 2, owner: "user_A", events: [fall] }),
    );
    mockFiles.set(
      `${fileOf("user_A")}.tmp`,
      '{"v":2,"owner":"user_A","events":[{"ev',
    );
    const { up, push } = load();
    push.mockResolvedValue({ accepted: 1, duplicate: 0, invalid: 0 });
    up.startRelayUplink("user_A");
    await tick();
    await up.flushRelayQueue();
    expect(
      (push.mock.calls[0][0].envelopes as EventEnvelope[]).map(
        (e) => e.eventId,
      ),
    ).toEqual([fall.eventId]);
  });

  it("改名失败：不抛、队列仍在内存里，下一次落盘再试", async () => {
    mockFsFail.move = true;
    const { up, push } = load();
    push.mockResolvedValue({ accepted: 1, duplicate: 0, invalid: 0 });
    up.startRelayUplink("user_A");
    await tick();
    const fall = env("possible_fall");
    up.enqueueRelayEvent(fall);
    mockFsFail.move = false;
    await up.flushRelayQueue();
    expect(
      (push.mock.calls[0][0].envelopes as EventEnvelope[]).map(
        (e) => e.eventId,
      ),
    ).toEqual([fall.eventId]);
  });
});

describe("高危事件被服务端接受后的回调（10-06 不变式评审 F-1）", () => {
  it("批次含摔倒 / 求救且 accepted+duplicate>0 → 回调一次并带设备号；全是 invalid 或只有位置事件 → 不回调", async () => {
    const { up, push } = load();
    const onAccepted = jest.fn((_deviceId: string) => undefined);
    up.setCriticalAcceptedHandler(onAccepted);
    up.startRelayUplink("user_A");
    await tick();
    // 全是 invalid：服务端没建单，不回调
    push.mockResolvedValueOnce({ accepted: 0, duplicate: 0, invalid: 1 });
    up.enqueueRelayEvent(env("possible_fall", "helmet_x"));
    await up.flushRelayQueue();
    expect(onAccepted).not.toHaveBeenCalled();
    // 只有位置事件：不是高危，不回调
    push.mockResolvedValueOnce({ accepted: 1, duplicate: 0, invalid: 0 });
    up.enqueueRelayEvent(env("location_update", "helmet_x"));
    await up.flushRelayQueue();
    expect(onAccepted).not.toHaveBeenCalled();
    // 补传回 duplicate：第一次已到服务端、单子早建好了，同样要拉倒计时（10-14 代码审查）
    push.mockResolvedValueOnce({ accepted: 0, duplicate: 1, invalid: 0 });
    up.enqueueRelayEvent(env("possible_fall", "helmet_x"));
    await up.flushRelayQueue();
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(onAccepted).toHaveBeenCalledWith("helmet_x");
    push.mockResolvedValueOnce({ accepted: 2, duplicate: 0, invalid: 0 });
    up.enqueueRelayEvent(env("manual_sos", "helmet_x"));
    up.enqueueRelayEvent(env("location_update", "helmet_x"));
    await up.flushRelayQueue();
    expect(onAccepted).toHaveBeenCalledTimes(2);
    expect(onAccepted).toHaveBeenLastCalledWith("helmet_x");
    up.setCriticalAcceptedHandler(null);
  });

  it("回调抛错不影响出队与落盘", async () => {
    const { up, push } = load();
    up.setCriticalAcceptedHandler(() => {
      throw new Error("boom");
    });
    up.startRelayUplink("user_A");
    await tick();
    push.mockResolvedValueOnce({ accepted: 1, duplicate: 0, invalid: 0 });
    up.enqueueRelayEvent(env("possible_fall"));
    await expect(up.flushRelayQueue()).resolves.toBeUndefined();
    expect(savedIds("user_A")).toEqual([]);
    up.setCriticalAcceptedHandler(null);
  });
});

describe("持久化文件部分损坏", () => {
  it("events 里混入 null / 缺字段 / 类型不对的项：只恢复合法 envelope，顺序不变", async () => {
    const ok1 = env("possible_fall");
    const ok2 = env("location_update");
    mockFiles.set(
      fileOf("user_A"),
      JSON.stringify({
        v: 2,
        owner: "user_A",
        events: [
          null,
          ok1,
          "str",
          42,
          { eventId: "no-device", eventType: "possible_fall" },
          { eventId: 7, deviceId: "d", eventType: "possible_fall" },
          ok2,
          [],
        ],
      }),
    );
    const { up, push } = load();
    up.startRelayUplink("user_A");
    await tick();
    await up.flushRelayQueue();
    up.stopRelayUplink();
    expect(sentIds(push)).toEqual([[ok1.eventId, ok2.eventId]]);
  });

  it.each([
    ["旧版本号", { v: 1, owner: "user_A" }],
    ["缺版本号", { owner: "user_A" }],
    ["events 不是数组", { v: 2, owner: "user_A", events: { length: 1 } }],
  ])("%s：整份不认，从空队列开始", async (_label, head) => {
    mockFiles.set(
      fileOf("user_A"),
      JSON.stringify({ events: [env("possible_fall")], ...head }),
    );
    const { up, push } = load();
    up.startRelayUplink("user_A");
    await tick();
    await up.flushRelayQueue();
    up.stopRelayUplink();
    expect(push).not.toHaveBeenCalled();
  });
});

describe("溢出与批内次序的极端情况", () => {
  it("整队 1000 条都是高危：再来一条高危才丢最旧的那条高危", async () => {
    const { up, push } = load();
    push.mockRejectedValue(new Error("offline"));
    const first = env("possible_fall");
    up.enqueueRelayEvent(first);
    const second = env("collision_risk");
    up.enqueueRelayEvent(second);
    for (let i = 0; i < 999; i += 1) up.enqueueRelayEvent(env("obstacle_risk"));
    await tick();
    push.mockClear();
    push.mockResolvedValue({ accepted: 100, duplicate: 0, invalid: 0 });
    for (let i = 0; i < 12; i += 1) await up.flushRelayQueue();
    const all = sentIds(push).flat();
    expect(all).toHaveLength(1000);
    expect(all).not.toContain(first.eventId);
    expect(all[0]).toBe(second.eventId);
  });

  it("整队都是高危时新来的周期事件自己被丢，不挤掉任何高危", async () => {
    const { up, push } = load();
    push.mockRejectedValue(new Error("offline"));
    for (let i = 0; i < 1000; i += 1) up.enqueueRelayEvent(env("manual_sos"));
    const periodic = env("location_update");
    up.enqueueRelayEvent(periodic);
    await tick();
    push.mockClear();
    push.mockResolvedValue({ accepted: 100, duplicate: 0, invalid: 0 });
    for (let i = 0; i < 12; i += 1) await up.flushRelayQueue();
    const all = sentIds(push).flat();
    expect(all).toHaveLength(1000);
    expect(all).not.toContain(periodic.eventId);
  });

  it("同一台设备积压 120 条位置后才来的摔倒：排在下一批第一条，其余位置保持先后", async () => {
    const { up, push } = load();
    const locs = Array.from({ length: 120 }, () => env("location_update"));
    for (const e of locs) up.enqueueRelayEvent(e);
    const fall = env("possible_fall");
    up.enqueueRelayEvent(fall); // 入队即触发一次 flush
    await tick();
    await up.flushRelayQueue();
    const [b1, b2] = sentIds(push);
    expect(b1).toHaveLength(100);
    expect(b1[0]).toBe(fall.eventId);
    expect(b1.slice(1)).toEqual(locs.slice(0, 99).map((e) => e.eventId));
    expect(b2).toEqual(locs.slice(99).map((e) => e.eventId));
  });

  it("同一 eventId 入队两次（跨会话重发帧）：队列不去重，两条同批提交，靠服务端幂等计 duplicate", async () => {
    const { up, push } = load();
    const e = env("device_status");
    up.enqueueRelayEvent(e);
    up.enqueueRelayEvent({ ...e });
    push.mockResolvedValueOnce({ accepted: 1, duplicate: 1, invalid: 0 });
    await up.flushRelayQueue();
    await up.flushRelayQueue();
    expect(sentIds(push)).toEqual([[e.eventId, e.eventId]]);
  });
});

describe("提交失败的状态码分流", () => {
  it.each([400, 403])(
    "%i 不可重试：这台设备的全部积压（含本批之外的）一次丢掉，另一台设备不受影响",
    async (status) => {
      const { up, push } = load();
      push.mockImplementation(async (body) => {
        if (body.deviceId === "helmet_bad") throw httpError(status);
        return { accepted: body.envelopes.length, duplicate: 0, invalid: 0 };
      });
      for (let i = 0; i < 130; i += 1)
        up.enqueueRelayEvent(env("location_update", "helmet_bad"));
      const good = env("device_status", "helmet_good");
      up.enqueueRelayEvent(good);
      for (let i = 0; i < 6; i += 1) await up.flushRelayQueue();
      const calls = push.mock.calls.map((c) => c[0].deviceId);
      expect(calls.filter((d) => d === "helmet_bad")).toHaveLength(1);
      expect(sentIds(push)).toContainEqual([good.eventId]);
      expect(savedIds("anonymous")).toEqual([]);
    },
  );

  it("413（请求体太大）且这一批不止一条：批量减半立即重试，一条都不丢（2026-10-16 A7）", async () => {
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    const { up, push } = load();
    const e1 = env("location_update");
    const e2 = env("device_status");
    up.enqueueRelayEvent(e1);
    up.enqueueRelayEvent(e2);
    push.mockRejectedValueOnce(httpError(413));
    await up.flushRelayQueue();
    await tick();
    await up.flushRelayQueue();
    await tick();
    expect(sentIds(push)).toEqual([
      [e1.eventId, e2.eventId],
      [e1.eventId],
      [e2.eventId],
    ]);
    expect(savedIds("anonymous")).toEqual([]);
  });

  it.each([401, 408, 429, 500, 503, undefined])(
    "%s 可能恢复：整批保留，下轮同一批按原 eventId 重发",
    async (status) => {
      const { up, push } = load();
      const e1 = env("location_update");
      const e2 = env("device_status");
      up.enqueueRelayEvent(e1);
      up.enqueueRelayEvent(e2);
      push.mockRejectedValueOnce(httpError(status));
      await up.flushRelayQueue();
      expect(savedIds("anonymous")).toEqual([e1.eventId, e2.eventId]);
      await up.flushRelayQueue();
      expect(sentIds(push)).toEqual([
        [e1.eventId, e2.eventId],
        [e1.eventId, e2.eventId],
      ]);
    },
  );

  it.each([undefined, null])(
    "2xx 但响应体是 %s（网关吞了响应体）：按已消化出队，不抛、不重发",
    async (body) => {
      const { up, push } = load();
      up.enqueueRelayEvent(env("location_update"));
      push.mockResolvedValueOnce(body as unknown as Counts);
      await expect(up.flushRelayQueue()).resolves.toBeUndefined();
      await up.flushRelayQueue();
      expect(push).toHaveBeenCalledTimes(1);
    },
  );
});

describe("在途提交 × 换账号", () => {
  it("A 的批次在途时换成 B：A 的结果（成功）不动 B 的队列，也不写 B 的文件", async () => {
    const { up, push } = load();
    const inflightPush = deferPush(push);
    up.startRelayUplink("user_A");
    up.enqueueRelayEvent(env("location_update", "helmet_of_A"));
    const inflight = up.flushRelayQueue();
    up.stopRelayUplink();
    up.startRelayUplink("user_B");
    await tick();
    const b1 = env("location_update", "helmet_of_B");
    up.enqueueRelayEvent(b1);
    const bFile = mockFiles.get(fileOf("user_B"));
    inflightPush.resolve({ accepted: 1, duplicate: 0, invalid: 0 });
    await inflight;
    expect(mockFiles.get(fileOf("user_B"))).toBe(bFile);
    expect(savedIds("user_B")).toEqual([b1.eventId]);
    await up.flushRelayQueue();
    up.stopRelayUplink();
    expect(push.mock.calls.map((c) => c[0].deviceId)).toEqual([
      "helmet_of_A",
      "helmet_of_B",
    ]);
  });

  it("A 的批次在途时换成 B，随后 A 的批次被 404 拒绝：只作废 A 那批，B 的事件照常送出", async () => {
    const { up, push } = load();
    const inflightPush = deferPush(push);
    up.startRelayUplink("user_A");
    up.enqueueRelayEvent(env("location_update", "helmet_shared"));
    const inflight = up.flushRelayQueue();
    up.stopRelayUplink();
    up.startRelayUplink("user_B");
    await tick();
    // 同一台头盔转手给了 B：deviceId 相同也不能被 A 的失败连坐
    const b1 = env("possible_fall", "helmet_shared");
    up.enqueueRelayEvent(b1);
    inflightPush.reject(httpError(404));
    await inflight;
    await up.flushRelayQueue();
    up.stopRelayUplink();
    expect(sentIds(push).at(-1)).toEqual([b1.eventId]);
  });

  it("A 的批次在途时退出登录：结果回来时归属已是匿名分区，不落盘——匿名分区里原有的积压不被一个空队列盖掉", async () => {
    // 换成 B 时照写也只是把 B 自己的队列再写一遍，看不出差别；落回匿名时照写会拿空队列覆盖匿名文件
    const anonFall = env("possible_fall", "helmet_x");
    mockFiles.set(
      fileOf("anonymous"),
      JSON.stringify({ v: 2, owner: "anonymous", events: [anonFall] }),
    );
    const { up, push } = load();
    const inflightPush = deferPush(push);
    up.startRelayUplink("user_A");
    up.enqueueRelayEvent(env("location_update", "helmet_of_A"));
    const inflight = up.flushRelayQueue();
    up.stopRelayUplink();
    inflightPush.resolve({ accepted: 1, duplicate: 0, invalid: 0 });
    await inflight;
    expect(savedIds("anonymous")).toEqual([anonFall.eventId]);
  });

  it("同一账号退出再登录时上一批还在途：文件恢复出的副本下轮按原 eventId 再发一次，不丢", async () => {
    const { up, push } = load();
    const inflightPush = deferPush(push);
    up.startRelayUplink("user_A");
    const a1 = env("possible_fall", "helmet_of_A");
    up.enqueueRelayEvent(a1); // 高危入队即发起首发（在途）
    await tick();
    up.stopRelayUplink();
    up.startRelayUplink("user_A");
    await tick();
    inflightPush.resolve({ accepted: 1, duplicate: 0, invalid: 0 });
    await tick();
    await up.flushRelayQueue();
    await up.flushRelayQueue();
    up.stopRelayUplink();
    // 第二次是恢复副本（对象身份不同，出队时认不出），服务端按 eventId 记 duplicate
    expect(sentIds(push)).toEqual([[a1.eventId], [a1.eventId]]);
    expect(savedIds("user_A")).toEqual([]);
  });
});

describe("深睡持锁（Android holdNetwork / releaseNetwork）", () => {
  it("高危入队持 90 s 锁；送达且队列里不再有高危才释放", async () => {
    const { up, push } = load();
    const hold = deferPush(push);
    up.enqueueRelayEvent(env("manual_sos"));
    expect(mockHold).toHaveBeenCalledWith(90_000);
    expect(mockRelease).not.toHaveBeenCalled();
    hold.resolve({ accepted: 1, duplicate: 0, invalid: 0 });
    await tick();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("另一台设备的高危还没送出：这一轮成功也不释放锁", async () => {
    const { up, push } = load();
    let cReachable = false;
    push.mockImplementation(async (body) => {
      if (body.deviceId === "helmet_c" && !cReachable)
        throw new Error("offline");
      return { accepted: body.envelopes.length, duplicate: 0, invalid: 0 };
    });
    up.enqueueRelayEvent(env("possible_fall", "helmet_c")); // 首发失败
    await tick();
    up.enqueueRelayEvent(env("location_update", "helmet_a")); // 高危待发 → 立刻重试，轮到的仍是 c，再失败
    await tick();
    await up.flushRelayQueue(); // 轮到 helmet_a，成功
    expect(push.mock.calls.map((c) => c[0].deviceId)).toEqual([
      "helmet_c",
      "helmet_c",
      "helmet_a",
    ]);
    expect(mockRelease).not.toHaveBeenCalled();
    cReachable = true;
    await up.flushRelayQueue();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("提交失败不释放锁；高危仍在队里时，下一条周期事件到达就立刻带着 90 s 锁重试", async () => {
    const { up, push } = load();
    push.mockRejectedValueOnce(new Error("SSL read error"));
    const fall = env("possible_fall");
    up.enqueueRelayEvent(fall);
    await tick();
    expect(mockRelease).not.toHaveBeenCalled();
    mockHold.mockClear();
    up.enqueueRelayEvent(env("location_update"));
    expect(mockHold).toHaveBeenCalledWith(90_000);
    await tick();
    expect(push).toHaveBeenCalledTimes(2);
    expect(sentIds(push)[1][0]).toBe(fall.eventId);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("周期事件：距上次成功上传不足 5 分钟不持锁也不抢发；超过 5 分钟持 20 s 锁立刻冲一次", async () => {
    const now = jest.spyOn(Date, "now");
    const t0 = 1_800_000_000_000;
    now.mockReturnValue(t0);
    const { up, push } = load();
    now.mockReturnValue(t0 + 5 * 60_000);
    up.enqueueRelayEvent(env("location_update"));
    await tick();
    expect(mockHold).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    now.mockReturnValue(t0 + 5 * 60_000 + 1);
    up.enqueueRelayEvent(env("location_update"));
    expect(mockHold).toHaveBeenCalledWith(20_000);
    await tick();
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].envelopes).toHaveLength(2);
  });

  it("摔倒到达时正有一批位置在途：入队当下就持 90 s 锁（在途期间入队不会再起上传，锁只能在这一刻拿）", async () => {
    const { up, push } = load();
    const inflight = deferPush(push);
    up.enqueueRelayEvent(env("location_update"));
    const flushing = up.flushRelayQueue();
    mockHold.mockClear();
    up.enqueueRelayEvent(env("possible_fall"));
    expect(mockHold).toHaveBeenCalledWith(90_000);
    inflight.resolve({ accepted: 1, duplicate: 0, invalid: 0 });
    await flushing;
    await tick();
  });

  it("定时 flush 时距上次成功上传已超过 5 分钟：先持 20 s 锁再送（深睡里定时器停着，醒来后的第一次 flush 要把上传窗口撑开）", async () => {
    const now = jest.spyOn(Date, "now");
    const t0 = 1_800_000_000_000;
    now.mockReturnValue(t0);
    const { up, push } = load();
    up.enqueueRelayEvent(env("location_update"));
    expect(mockHold).not.toHaveBeenCalled();
    now.mockReturnValue(t0 + 6 * 60_000);
    await up.flushRelayQueue();
    expect(mockHold).toHaveBeenCalledWith(20_000);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("成功上传后重新计时：紧接着（不到 5 分钟）的周期事件不再持锁抢发", async () => {
    const now = jest.spyOn(Date, "now");
    const t0 = 1_800_000_000_000;
    now.mockReturnValue(t0);
    const { up, push } = load();
    now.mockReturnValue(t0 + 10 * 60_000);
    up.enqueueRelayEvent(env("location_update"));
    await tick();
    expect(push).toHaveBeenCalledTimes(1);
    mockHold.mockClear();
    now.mockReturnValue(t0 + 11 * 60_000);
    up.enqueueRelayEvent(env("location_update"));
    await tick();
    expect(mockHold).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("手机时钟被往回拨：周期补偿不触发也不抛，事件照常留在队里等定时 flush", async () => {
    const now = jest.spyOn(Date, "now");
    const t0 = 1_800_000_000_000;
    now.mockReturnValue(t0);
    const { up, push } = load();
    now.mockReturnValue(t0 - 24 * 3600_000);
    up.enqueueRelayEvent(env("device_status"));
    await tick();
    expect(mockHold).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    await up.flushRelayQueue();
    expect(push).toHaveBeenCalledTimes(1);
  });
});

// 注销账号之后（account/delete，2026-10-17）：这个账号分区的积压再也送不出去（头盔已全部解绑），
// 文件不能一直留在手机上；注销后链路停下来时的那次落盘也不能把它写回来。别的账号的分区不动。
describe("discardRelayQueue：注销账号后丢掉这个账号的积压", () => {
  it("删掉正式文件和临时文件、清掉内存里的；之后停链路也不再为它落盘；别人的分区原样", async () => {
    const { up, push } = load();
    push.mockRejectedValue(new Error("offline"));
    up.startRelayUplink("user_B");
    up.enqueueRelayEvent(env("location_update", "helmet_of_B"));
    up.stopRelayUplink();
    await tick();
    expect(savedIds("user_B")).toHaveLength(1);

    up.startRelayUplink("user_A");
    await tick();
    up.enqueueRelayEvent(env("location_update", "helmet_of_A"));
    await tick();
    expect(savedIds("user_A")).toHaveLength(1);
    mockFiles.set(`${fileOf("user_A")}.tmp`, "{}");

    up.discardRelayQueue("user_A");
    expect(mockFiles.has(fileOf("user_A"))).toBe(false);
    expect(mockFiles.has(`${fileOf("user_A")}.tmp`)).toBe(false);
    // 清会话 → use-realtime 停链路：原来这里会把队列再写回 user_A 的文件
    up.stopRelayUplink();
    expect(mockFiles.has(fileOf("user_A"))).toBe(false);
    expect(savedIds("user_B")).toHaveLength(1);

    // 下一个登录的人（新账号）照常用自己的分区，不会带上 A 的积压
    push.mockReset();
    push.mockResolvedValue({ accepted: 1, duplicate: 0, invalid: 0 });
    up.startRelayUplink("user_C");
    up.enqueueRelayEvent(env("location_update", "helmet_of_C"));
    await up.flushRelayQueue();
    expect(push.mock.calls.map((c) => c[0].deviceId)).toEqual(["helmet_of_C"]);
    up.stopRelayUplink();
    expect(savedIds("user_C")).toEqual([]);
  });

  it("没有文件 / 删文件抛错：不抛给注销流程，内存里的照样清掉", async () => {
    const { up, push } = load();
    expect(() => up.discardRelayQueue("nobody")).not.toThrow();
    push.mockRejectedValue(new Error("offline"));
    up.startRelayUplink("user_D");
    up.enqueueRelayEvent(env("location_update", "helmet_of_D"));
    await tick();
    mockFsFail.del = true;
    try {
      expect(() => up.discardRelayQueue("user_D")).not.toThrow();
    } finally {
      mockFsFail.del = false;
    }
    push.mockReset();
    await up.flushRelayQueue();
    expect(push).not.toHaveBeenCalled();
    up.stopRelayUplink();
  });
});
