// 第二轮（2026-10-16）在保命链路里看到、按约定没改的几处，测试只断言现状（EDGE_FINDINGS_1016.md A12–A14）。
// A13 用上行队列的同一套假件（照抄 edge-ble-relay-uplink-1016）。
import { readFileSync } from "fs";
import { join } from "path";

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
const queueFile = (owner: string) =>
  `ble-relay-queue.${encodeURIComponent(owner)}.json`;

beforeEach(() => {
  mockFiles.clear();
  mockHold.mockClear();
  mockRelease.mockClear();
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("改后（10-16 A13）：恢复持久队列按 头盔号:事件号 去重", () => {
  const writeSaved = (owner: string, events: EventEnvelope[]) =>
    mockFiles.set(queueFile(owner), JSON.stringify({ v: 2, owner, events }));
  const savedPairs = (owner: string): string[] =>
    (
      JSON.parse(mockFiles.get(queueFile(owner)) ?? '{"events":[]}') as {
        events: EventEnvelope[];
      }
    ).events.map((e) => `${e.deviceId}:${e.eventId}`);

  it("持久队列里 helmet_b 的 same-1 与内存里 helmet_a 的 same-1 同号：两条都保留", async () => {
    // 决策 #54：eventId 只在一顶头盔内唯一。今天 BLE 的 eventId = UUID v5(命名空间, deviceId:序号)，
    // 两顶头盔不会撞号，所以这条只是纵深防御
    writeSaved("user_1", [env("possible_fall", "helmet_b", "same-1")]);
    const { up, push } = load();
    push.mockRejectedValue(new Error("offline"));
    up.startRelayUplink("user_1");
    up.enqueueRelayEvent(env("possible_fall", "helmet_a", "same-1"));
    await tick();
    up.stopRelayUplink();
    expect(savedPairs("user_1").sort()).toEqual([
      "helmet_a:same-1",
      "helmet_b:same-1",
    ]);
  });

  it("同一顶头盔同一编号：仍然只留一条", async () => {
    writeSaved("user_1", [env("possible_fall", "helmet_a", "same-1")]);
    const { up, push } = load();
    push.mockRejectedValue(new Error("offline"));
    up.startRelayUplink("user_1");
    up.enqueueRelayEvent(env("possible_fall", "helmet_a", "same-1"));
    await tick();
    up.stopRelayUplink();
    expect(savedPairs("user_1")).toEqual(["helmet_a:same-1"]);
  });

  it("对照：编号不同时两条都恢复", async () => {
    writeSaved("user_1", [env("possible_fall", "helmet_b", "b-1")]);
    const { up, push } = load();
    push.mockRejectedValue(new Error("offline"));
    up.startRelayUplink("user_1");
    up.enqueueRelayEvent(env("possible_fall", "helmet_a", "a-1"));
    await tick();
    up.stopRelayUplink();
    expect(savedPairs("user_1").sort()).toEqual([
      "helmet_a:a-1",
      "helmet_b:b-1",
    ]);
  });
});

describe("改后（10-16 A12 / A14）：保命页面里的显示口径", () => {
  const read = (...p: string[]) =>
    readFileSync(join(__dirname, "..", "..", ...p), "utf8");

  it("A12：倒计时页的联系人名走 contactNameOf（零宽名显示「未命名」、换行名合成一行），头像首字走 initialOf", () => {
    const src = read("app", "sos-active.tsx");
    expect(src).not.toMatch(/\{c\.name\}/);
    expect(src).toContain("contactNameOf(c)");
    expect(src).toContain("initialOf(contactNameOf(c))");
  });

  it("A14：锁屏求救提醒的「补传」说明括号跟界面语言走（sosAlert.lateSuffix），不写死全角括号", () => {
    const src = read("services", "sos-alert.ts");
    expect(src).not.toContain("`（${late}）`");
    expect(src).toContain('translate("sosAlert.lateSuffix", { note: late })');
  });
});
