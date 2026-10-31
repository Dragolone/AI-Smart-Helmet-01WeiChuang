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

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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
    await tick(); // 高危入队时已自动起了一次提交：等它回来
    expect(onAccepted).not.toHaveBeenCalled();
    // 只有位置事件：不是高危，不回调
    push.mockResolvedValueOnce({ accepted: 1, duplicate: 0, invalid: 0 });
    up.enqueueRelayEvent(env("location_update", "helmet_x"));
    await up.flushRelayQueue();
    await tick(); // 高危入队时已自动起了一次提交：等它回来
    expect(onAccepted).not.toHaveBeenCalled();
    // 补传回 duplicate：第一次已到服务端、单子早建好了，同样要拉倒计时（10-14 代码审查）
    push.mockResolvedValueOnce({ accepted: 0, duplicate: 1, invalid: 0 });
    up.enqueueRelayEvent(env("possible_fall", "helmet_x"));
    await up.flushRelayQueue();
    await tick(); // 高危入队时已自动起了一次提交：等它回来
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(onAccepted).toHaveBeenCalledWith("helmet_x");
    push.mockResolvedValueOnce({ accepted: 2, duplicate: 0, invalid: 0 });
    up.enqueueRelayEvent(env("manual_sos", "helmet_x"));
    up.enqueueRelayEvent(env("location_update", "helmet_x"));
    await up.flushRelayQueue();
    await tick(); // 高危入队时已自动起了一次提交：等它回来
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
    await tick(); // 高危入队时已自动起了一次提交：等它回来
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
    // 满批成功后会在后台接着冲下一批：每次之间让微任务跑完，不靠数拍子
    for (let i = 0; i < 12; i += 1) {
      await up.flushRelayQueue();
      await tick();
    }
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
    // 满批成功后会在后台接着冲下一批：每次之间让微任务跑完，不靠数拍子
    for (let i = 0; i < 12; i += 1) {
      await up.flushRelayQueue();
      await tick();
    }
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

  it("积压 250 条：满批成功后不等 5 秒的定时器接着冲，一次触发就 100 / 100 / 50 三批传完（优化清单 7）", async () => {
    const { up, push } = load();
    push.mockResolvedValue({ accepted: 100, duplicate: 0, invalid: 0 });
    for (let i = 0; i < 250; i += 1)
      up.enqueueRelayEvent(env("location_update"));
    await up.flushRelayQueue();
    for (let i = 0; i < 5; i += 1) await tick();
    expect(sentIds(push).map((b) => b.length)).toEqual([100, 100, 50]);
    expect(up.relayBacklog().total).toBe(0);
  });

  it("不满的批传完就停、等下一轮；满批失败也不连发（留给下一轮，不打爆服务端）", async () => {
    const { up, push } = load();
    push.mockResolvedValue({ accepted: 5, duplicate: 0, invalid: 0 });
    for (let i = 0; i < 5; i += 1) up.enqueueRelayEvent(env("location_update"));
    await up.flushRelayQueue();
    for (let i = 0; i < 3; i += 1) await tick();
    expect(push).toHaveBeenCalledTimes(1);

    push.mockClear();
    push.mockRejectedValue(new Error("offline"));
    for (let i = 0; i < 250; i += 1)
      up.enqueueRelayEvent(env("location_update"));
    await up.flushRelayQueue();
    for (let i = 0; i < 3; i += 1) await tick();
    expect(push).toHaveBeenCalledTimes(1);
    expect(up.relayBacklog().total).toBe(250);
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
  it.each([
    [400, "VALIDATION_FAILED"],
    [403, "FORBIDDEN"],
  ])(
    "服务端回 %i %s 不可重试：这台设备的全部积压（含本批之外的）一次丢掉，另一台设备不受影响",
    async (status, code) => {
      const { up, push } = load();
      push.mockImplementation(async (body) => {
        if (body.deviceId === "helmet_bad")
          throw Object.assign(httpError(status), { code });
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

  it("服务端说这顶不归这个账号了：叫一次回调刷新目标；网关错误页不叫（11-01 审计）", async () => {
    const { up, push } = load();
    const rejected = jest.fn();
    up.setRelayRejectedHandler(rejected);
    push.mockRejectedValue(
      Object.assign(httpError(404), { code: "INTERNAL_ERROR" }),
    );
    up.enqueueRelayEvent(env("possible_fall"));
    await tick();
    await up.flushRelayQueue();
    await tick();
    expect(rejected).not.toHaveBeenCalled();
    push.mockRejectedValue(
      Object.assign(httpError(404), { code: "DEVICE_NOT_FOUND" }),
    );
    await up.flushRelayQueue();
    await tick();
    expect(rejected).toHaveBeenCalledTimes(1);
    up.setRelayRejectedHandler(null);
  });

  it("10-25 审查：网关 / 运营商回的 404 / 403 错误页（没有 JSON，码是 INTERNAL_ERROR）：不丢积压（含摔倒），留着下轮重发", async () => {
    const { up, push } = load();
    push.mockRejectedValue(
      Object.assign(httpError(404), { code: "INTERNAL_ERROR" }),
    );
    const fall = env("possible_fall", "helmet_bad");
    up.enqueueRelayEvent(fall);
    up.enqueueRelayEvent(env("location_update", "helmet_bad"));
    await up.flushRelayQueue();
    push.mockRejectedValue(
      Object.assign(httpError(403), { code: "INTERNAL_ERROR" }),
    );
    await up.flushRelayQueue();
    push.mockResolvedValue({ accepted: 2, duplicate: 0, invalid: 0 });
    await up.flushRelayQueue();
    expect(sentIds(push).at(-1)).toContain(fall.eventId);
  });

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

  it("求救被接受、紧接着的补拉还在跑：先不放锁，补拉结束才放（深睡的华为一放锁网络就挂起，10-25 审查）", async () => {
    const { up, push } = load();
    let finishResume!: () => void;
    up.setCriticalAcceptedHandler(
      () => new Promise<void>((r) => (finishResume = r)),
    );
    const hold = deferPush(push);
    up.enqueueRelayEvent(env("manual_sos"));
    hold.resolve({ accepted: 1, duplicate: 0, invalid: 0 });
    await tick();
    expect(mockRelease).not.toHaveBeenCalled();
    finishResume();
    await tick();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("10-25 审查：补拉还在跑时，满批重跑的下一批先回来——也不放锁，补拉结束才放", async () => {
    const { up, push } = load();
    let finishResume!: () => void;
    up.setCriticalAcceptedHandler(
      () => new Promise<void>((r) => (finishResume = r)),
    );
    push.mockImplementation(async (body) => ({
      accepted: body.envelopes.length,
      duplicate: 0,
      invalid: 0,
    }));
    for (let i = 0; i < 150; i += 1)
      up.enqueueRelayEvent(env("location_update"));
    up.enqueueRelayEvent(env("manual_sos")); // 第一批：求救 + 99 条位置（满批）→ 接着冲剩下的 51 条
    await tick();
    expect(push).toHaveBeenCalledTimes(2);
    expect(mockRelease).not.toHaveBeenCalled();
    finishResume();
    await tick();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("10-25 审查：提交卡住（安卓后台定时器不走、底层又不超时）：没到 20 s 不动；过了 20 s 下一个蓝牙事件进来就放弃这次、立刻重发；卡住那次后来才回来也不搅乱", async () => {
    jest.useFakeTimers();
    const { up, push } = load();
    const stuck = deferPush(push);
    const fall = env("possible_fall");
    up.enqueueRelayEvent(fall);
    await jest.advanceTimersByTimeAsync(0);
    expect(push).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(19_000);
    up.enqueueRelayEvent(env("location_update"));
    await jest.advanceTimersByTimeAsync(0);
    expect(push).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2_000);
    up.enqueueRelayEvent(env("location_update"));
    await jest.advanceTimersByTimeAsync(0);
    expect(push).toHaveBeenCalledTimes(2);
    expect(sentIds(push)[1][0]).toBe(fall.eventId);
    expect(up.relayBacklog().total).toBe(0);
    stuck.resolve({ accepted: 1, duplicate: 0, invalid: 0 });
    await jest.advanceTimersByTimeAsync(0);
    expect(up.relayBacklog().total).toBe(0);
    expect(push).toHaveBeenCalledTimes(2);
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

  // 2026-10-31：没信号时 lastFlushOkAt 一直不更新，原来每个位置包都续一次 20 s 锁，整段无信号期 CPU 不能休眠
  describe("没信号时的周期补偿窗口", () => {
    const min5 = 5 * 60_000;
    const t0 = 1_800_000_000_000;
    /** 超 5 分钟没成功、推送一直失败，第一个位置包把窗口打开的时刻 */
    const open = t0 + min5 + 1;
    const offline = () => {
      const now = jest.spyOn(Date, "now");
      now.mockReturnValue(t0);
      const { up, push } = load();
      push.mockRejectedValue(new Error("offline"));
      now.mockReturnValue(open);
      return { now, up, push };
    };

    it("失败后不再逐包续锁：整个窗口只拿一次 20 s 锁，窗口内每个位置包都重试", async () => {
      const { now, up, push } = offline();
      for (const dt of [0, 5_000, 10_000, 15_000]) {
        now.mockReturnValue(open + dt);
        up.enqueueRelayEvent(env("location_update"));
        await tick();
      }
      expect(mockHold.mock.calls).toEqual([[20_000]]);
      expect(push).toHaveBeenCalledTimes(4);
    });

    it("深睡刚醒首发失败、窗口内重试成功：放锁，且从成功那一刻重新算 5 分钟", async () => {
      const { now, up, push } = offline();
      up.enqueueRelayEvent(env("location_update"));
      await tick();
      expect(mockRelease).not.toHaveBeenCalled();
      push.mockResolvedValue({ accepted: 2, duplicate: 0, invalid: 0 });
      now.mockReturnValue(open + 5_000);
      up.enqueueRelayEvent(env("location_update"));
      await tick();
      expect(push).toHaveBeenCalledTimes(2);
      expect(mockRelease).toHaveBeenCalledTimes(1);
      mockHold.mockClear();
      push.mockClear();
      now.mockReturnValue(open + 5_000 + min5);
      up.enqueueRelayEvent(env("location_update"));
      await tick();
      expect(mockHold).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
      // 窗口是成功后重新算的，不用等上一个窗口的 5 分 20 秒
      now.mockReturnValue(open + 5_000 + min5 + 1);
      up.enqueueRelayEvent(env("location_update"));
      expect(mockHold).toHaveBeenCalledWith(20_000);
      await tick();
      expect(push).toHaveBeenCalledTimes(1);
    });

    it("窗口用完仍失败：不再提交也不再拿锁，放掉没有时限的 Wi-Fi 锁；再过 5 分钟开下一窗", async () => {
      const { now, up, push } = offline();
      up.enqueueRelayEvent(env("location_update"));
      await tick();
      expect(mockRelease).not.toHaveBeenCalled();
      mockHold.mockClear();
      push.mockClear();
      for (const dt of [20_000, 25_000, 20_000 + min5 - 1]) {
        now.mockReturnValue(open + dt);
        up.enqueueRelayEvent(env("location_update"));
        await tick();
      }
      expect(mockHold).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
      expect(mockRelease).toHaveBeenCalled();
      now.mockReturnValue(open + 20_000 + min5);
      up.enqueueRelayEvent(env("location_update"));
      expect(mockHold.mock.calls).toEqual([[20_000]]);
      await tick();
      expect(push).toHaveBeenCalledTimes(1);
    });

    it("定时 flush 也不续锁：窗口内重试不拿锁，窗口外照常提交（屏幕亮着时定时器还在走）但不拿锁", async () => {
      const { now, up, push } = offline();
      up.enqueueRelayEvent(env("location_update"));
      await tick();
      now.mockReturnValue(open + 10_000);
      await up.flushRelayQueue();
      now.mockReturnValue(open + 30_000);
      await up.flushRelayQueue();
      expect(mockHold.mock.calls).toEqual([[20_000]]);
      expect(push).toHaveBeenCalledTimes(3);
    });

    it("定时 flush 也能开窗：窗口外满 5 分钟后定时器先走到，同样只拿一次锁，之后的位置包不重复开窗", async () => {
      const { now, up } = offline();
      up.enqueueRelayEvent(env("location_update"));
      await tick();
      mockHold.mockClear();
      now.mockReturnValue(open + 20_000 + min5);
      await up.flushRelayQueue();
      expect(mockHold.mock.calls).toEqual([[20_000]]);
      now.mockReturnValue(open + 20_000 + min5 + 5_000);
      up.enqueueRelayEvent(env("location_update"));
      await tick();
      expect(mockHold.mock.calls).toEqual([[20_000]]);
    });

    it("高危不受窗口限制：窗口外到的摔倒当场拿 90 s 锁立刻提交，失败后下一个位置包再拿 90 s 锁重试，Wi-Fi 锁不放", async () => {
      const { now, up, push } = offline();
      up.enqueueRelayEvent(env("location_update"));
      await tick();
      mockHold.mockClear();
      mockRelease.mockClear();
      push.mockClear();
      now.mockReturnValue(open + 60_000);
      const fall = env("possible_fall");
      up.enqueueRelayEvent(fall);
      expect(mockHold).toHaveBeenCalledWith(90_000);
      await tick();
      expect(push).toHaveBeenCalledTimes(1);
      expect(sentIds(push)[0][0]).toBe(fall.eventId);
      mockHold.mockClear();
      now.mockReturnValue(open + 65_000);
      up.enqueueRelayEvent(env("location_update"));
      expect(mockHold).toHaveBeenCalledWith(90_000);
      await tick();
      expect(push).toHaveBeenCalledTimes(2);
      expect(sentIds(push)[1][0]).toBe(fall.eventId);
      expect(mockRelease).not.toHaveBeenCalled();
    });

    it("请求挂住（深睡常见）：挂着时位置包开不了窗，放弃那次之后由提交开头开窗，最多迟 20 s", async () => {
      const { now, up, push } = offline();
      push.mockImplementation(() => new Promise(() => undefined));
      up.enqueueRelayEvent(env("location_update"));
      await tick();
      expect(mockHold.mock.calls).toEqual([[20_000]]);
      expect(push).toHaveBeenCalledTimes(1);

      // 窗口内一直挂着：既不续锁也不并发第二个请求
      now.mockReturnValue(open + 5_000);
      up.enqueueRelayEvent(env("location_update"));
      await tick();
      expect(mockHold.mock.calls).toEqual([[20_000]]);
      expect(push).toHaveBeenCalledTimes(1);

      // 挂满 20 s：放弃重发，这时窗口已用完，重发不拿锁，放掉 Wi-Fi 锁
      now.mockReturnValue(open + 20_000);
      up.enqueueRelayEvent(env("location_update"));
      await tick();
      expect(push).toHaveBeenCalledTimes(2);
      expect(mockHold.mock.calls).toEqual([[20_000]]);
      expect(mockRelease).toHaveBeenCalled();

      // 该开下一窗时一个请求刚挂上 15 s（下一窗 = 上一窗结束后 5 min = open + 20 s + 5 min）：位置包走不到开窗
      const due = open + 20_000 + min5;
      now.mockReturnValue(due - 10_000);
      up.enqueueRelayEvent(env("location_update"));
      await tick();
      expect(push).toHaveBeenCalledTimes(3);
      now.mockReturnValue(due + 5_000);
      up.enqueueRelayEvent(env("location_update"));
      await tick();
      expect(mockHold.mock.calls).toEqual([[20_000]]);
      expect(push).toHaveBeenCalledTimes(3);

      // 它挂满 20 s 被放弃：重发那次开窗拿锁，这次传成功，窗口里积压全部送出
      push.mockResolvedValue({ accepted: 1, duplicate: 0, invalid: 0 });
      now.mockReturnValue(due + 10_000);
      up.enqueueRelayEvent(env("location_update"));
      await tick();
      expect(mockHold.mock.calls).toEqual([[20_000], [20_000]]);
      expect(push).toHaveBeenCalledTimes(4);
      expect(up.relayBacklog().total).toBe(0);
    });

    it("开窗之后时钟往回拨：窗口不会一直算「还没用完」，满 5 分钟能开下一窗", async () => {
      const { now, up, push } = offline();
      up.enqueueRelayEvent(env("location_update"));
      await tick();
      mockHold.mockClear();
      push.mockClear();
      // 回拨到开窗之前、但还在上次成功之后
      now.mockReturnValue(t0 + 60_000);
      up.enqueueRelayEvent(env("location_update"));
      await tick();
      expect(mockHold).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
      now.mockReturnValue(open);
      up.enqueueRelayEvent(env("location_update"));
      expect(mockHold.mock.calls).toEqual([[20_000]]);
      await tick();
      expect(push).toHaveBeenCalledTimes(1);
    });

    it("时钟往回拨到上次成功之前：基准拉回现在，5 分钟后能开窗，不用等到钟走回去", async () => {
      const { now, up, push } = offline();
      const back = t0 - 24 * 3600_000;
      now.mockReturnValue(back);
      up.enqueueRelayEvent(env("location_update"));
      await tick();
      expect(mockHold).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
      now.mockReturnValue(back + min5 + 1);
      up.enqueueRelayEvent(env("location_update"));
      expect(mockHold.mock.calls).toEqual([[20_000]]);
      await tick();
      expect(push).toHaveBeenCalledTimes(1);
    });
  });

  // 2026-10-31 交叉审：一批成功就放锁，后面几批在没有锁的情况下发，深睡里网络随即挂起，隧道 30 min 的积压只有前 100 条保证送得出去
  describe("积压超过一批时后续批次都在锁内", () => {
    const min5 = 5 * 60_000;
    const t0 = 1_800_000_000_000;
    /** 积压 n 条位置，距上次成功已超 5 分钟：最后一条把窗口打开并开始提交（还没 await） */
    const backlog = (n: number) => {
      const now = jest.spyOn(Date, "now");
      now.mockReturnValue(t0);
      const { up, push } = load();
      for (let i = 0; i < n - 1; i++)
        up.enqueueRelayEvent(env("location_update"));
      now.mockReturnValue(t0 + min5 + 1);
      return { now, up, push };
    };
    const ok = { accepted: 1, duplicate: 0, invalid: 0 };

    it("250 条分三批：每一批发出去时锁都没放、且已为它续过；全部冲完才放一次", async () => {
      const { up, push } = backlog(250);
      const atPush: { holds: number; releases: number }[] = [];
      push.mockImplementation(async () => {
        atPush.push({
          holds: mockHold.mock.calls.length,
          releases: mockRelease.mock.calls.length,
        });
        return ok;
      });
      up.enqueueRelayEvent(env("location_update"));
      await tick();
      expect(push.mock.calls.map((c) => c[0].envelopes.length)).toEqual([
        100, 100, 50,
      ]);
      expect(atPush).toEqual([
        { holds: 1, releases: 0 },
        { holds: 2, releases: 0 },
        { holds: 3, releases: 0 },
      ]);
      expect(mockHold.mock.calls.every((c) => c[0] === 20_000)).toBe(true);
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it("正好整批（积压刚好 100 条）：没有下一批，立刻放锁、不多续", async () => {
      const { up, push } = backlog(100);
      push.mockResolvedValue(ok);
      up.enqueueRelayEvent(env("location_update"));
      await tick();
      expect(push).toHaveBeenCalledTimes(1);
      expect(mockHold.mock.calls).toEqual([[20_000]]);
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it("冲到一半失败：这一轮到此为止，放锁，剩下的等下一窗；不连发", async () => {
      const { up, push } = backlog(250);
      push
        .mockResolvedValueOnce(ok)
        .mockRejectedValueOnce(new Error("offline"));
      up.enqueueRelayEvent(env("location_update"));
      await tick();
      expect(push).toHaveBeenCalledTimes(2);
      expect(mockRelease).toHaveBeenCalledTimes(1);
      expect(up.relayBacklog().total).toBe(150);
    });

    it("冲到一半 413：减半接着冲，锁不放", async () => {
      const { up, push } = backlog(150);
      const releasesAtPush: number[] = [];
      push.mockImplementation(async () => {
        releasesAtPush.push(mockRelease.mock.calls.length);
        if (releasesAtPush.length === 2) throw httpError(413);
        return ok;
      });
      up.enqueueRelayEvent(env("location_update"));
      await tick();
      expect(push.mock.calls.map((c) => c[0].envelopes.length)).toEqual([
        100, 50, 25, 25,
      ]);
      expect(releasesAtPush).toEqual([0, 0, 0, 0]);
      expect(mockRelease).toHaveBeenCalledTimes(1);
      expect(up.relayBacklog().total).toBe(0);
    });

    it("补拉先跑完、后面的批次还在路上：不放锁，等批次冲完才放", async () => {
      const { up, push } = backlog(150);
      up.startRelayUplink("user_A");
      await tick();
      const resume = deferred<void>();
      up.setCriticalAcceptedHandler(() => resume.promise);
      const second = deferred<Counts>();
      push.mockResolvedValueOnce(ok).mockReturnValueOnce(second.promise);
      up.enqueueRelayEvent(env("possible_fall"));
      await tick();
      expect(push).toHaveBeenCalledTimes(2);
      resume.resolve();
      await tick();
      expect(mockRelease).not.toHaveBeenCalled();
      second.resolve(ok);
      await tick();
      expect(mockRelease).toHaveBeenCalledTimes(1);
      up.setCriticalAcceptedHandler(null);
      up.stopRelayUplink();
    });

    it("冲到一半停链路（退出登录）：放锁，不把标记留给下一个账号", async () => {
      const { up, push } = backlog(250);
      const second = deferred<Counts>();
      push.mockResolvedValueOnce(ok).mockReturnValueOnce(second.promise);
      up.enqueueRelayEvent(env("location_update"));
      await tick();
      expect(mockRelease).not.toHaveBeenCalled();
      up.stopRelayUplink();
      expect(mockRelease).toHaveBeenCalledTimes(1);
      second.resolve(ok);
      await tick();
      expect(push).toHaveBeenCalledTimes(2);
    });
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
