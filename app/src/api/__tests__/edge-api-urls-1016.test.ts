// 接口地址拼接的边界（2026-10-16）：路径里的编号与查询参数一律编码；.env 里地址写法的容错。
// 编号来自链接 / 推送 / 服务端，都当外部输入：带 / ? # & 空格 中文 % 的都不能把请求打到别的接口上。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { Mock } from "jest-mock";

import { channelsApi } from "../channels";
import { attachSession } from "../client";
import { contactsApi } from "../contacts";
import { devicesApi } from "../devices";
import { eventsApi } from "../events";
import { relayApi } from "../relay";
import { sosApi } from "../sos";

type FetchMock = Mock<(url: string, init?: RequestInit) => Promise<unknown>>;
let fetchMock: FetchMock;

const ok = (body: unknown = {}) => ({
  ok: true,
  status: 200,
  json: async () => body,
});
const lastUrl = () => fetchMock.mock.calls.at(-1)![0];
const pathOf = (url: string) => new URL(url).pathname;
const queryOf = (url: string) => new URL(url).searchParams;

const WEIRD = "a/b?c#d&e %41 中";
const ENC = encodeURIComponent(WEIRD);

beforeEach(() => {
  fetchMock = jest.fn(async () => ok({ sos: null, items: [], total: 0 }));
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  attachSession({
    getTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    setTokens: async () => undefined,
    clearSession: async () => undefined,
  });
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("路径里的编号一律编码", () => {
  it.each([
    ["detail", () => devicesApi.detail(WEIRD), `/devices/${ENC}`],
    ["status", () => devicesApi.status(WEIRD), `/devices/${ENC}/status`],
    ["unbind", () => devicesApi.unbind(WEIRD), `/devices/${ENC}/binding`],
    ["settings", () => devicesApi.settings(WEIRD), `/devices/${ENC}/settings`],
    [
      "latestLocation",
      () => devicesApi.latestLocation(WEIRD),
      `/devices/${ENC}/locations/latest`,
    ],
    [
      "batteryHistory",
      () => devicesApi.batteryHistory(WEIRD),
      `/devices/${ENC}/battery-history`,
    ],
    ["sos.active", () => sosApi.active(WEIRD), `/devices/${ENC}/sos/active`],
    ["sos.cancel", () => sosApi.cancel(WEIRD), `/sos/${ENC}/cancel`],
    ["sos.confirm", () => sosApi.confirm(WEIRD), `/sos/${ENC}/confirm`],
    ["accidentDetail", () => sosApi.accidentDetail(WEIRD), `/accidents/${ENC}`],
    ["accidents", () => sosApi.accidents(WEIRD), `/devices/${ENC}/accidents`],
    ["events.detail", () => eventsApi.detail(WEIRD), `/events/${ENC}`],
    ["events.list", () => eventsApi.list(WEIRD), `/devices/${ENC}/events`],
    [
      "channels.leave",
      () => channelsApi.leave(WEIRD),
      `/voice/channels/${ENC}/membership`,
    ],
    [
      "channels.members",
      () => channelsApi.members(WEIRD),
      `/voice/channels/${ENC}/members`,
    ],
    [
      "channels.token",
      () => channelsApi.token(WEIRD),
      `/voice/channels/${ENC}/token`,
    ],
    [
      "contacts.remove",
      () => contactsApi.remove(WEIRD),
      `/users/me/emergency-contacts/${ENC}`,
    ],
  ])(
    "%s：编号整体占一段路径，不会多出层级或变成查询参数",
    async (_name, call, expected) => {
      await call();
      const url = lastUrl();
      expect(url.endsWith(expected) || url.includes(`${expected}?`)).toBe(true);
      expect(pathOf(url).split("/")).toContain(ENC);
      expect(new URL(url).hash).toBe("");
    },
  );

  it("命令回执：设备号和命令号各自编码", async () => {
    await relayApi.ack(WEIRD, "cmd/1?x", { stage: "delivered" });
    expect(pathOf(lastUrl())).toBe(
      `/api/v1/devices/${ENC}/commands/${encodeURIComponent("cmd/1?x")}/relay-ack`,
    );
  });

  it("编号是空串：路径里留出空段（接口回 404），不会落到列表接口上", async () => {
    await devicesApi.detail("");
    expect(pathOf(lastUrl())).toBe("/api/v1/devices/");
    await sosApi.cancel("");
    expect(pathOf(lastUrl())).toBe("/api/v1/sos//cancel");
  });

  it("超长编号（600 个字符）原样编码进路径，不截断、不抛", async () => {
    const long = "x".repeat(600);
    await devicesApi.detail(long);
    expect(pathOf(lastUrl())).toBe(`/api/v1/devices/${long}`);
  });
});

describe("查询参数编码", () => {
  it("时间带 + 号时区偏移：编码成 %2B，不会被服务端读成空格", async () => {
    const from = "2026-10-16T00:00:00+08:00";
    const to = "2026-10-17T00:00:00+08:00";
    await devicesApi.rides("h1", from, to);
    expect(lastUrl()).toContain(`from=${encodeURIComponent(from)}`);
    expect(queryOf(lastUrl()).get("from")).toBe(from);
    await devicesApi.locationSummary("h1", from, to);
    expect(queryOf(lastUrl()).get("to")).toBe(to);
    await devicesApi.track("h1", from, to);
    expect(queryOf(lastUrl()).get("maxPoints")).toBe("1000");
    await devicesApi.locations("h1", from, to, 2, 100);
    expect(queryOf(lastUrl()).get("page")).toBe("2");
  });

  it("事件列表：多个类型逗号分隔原样带上；可选参数不传就不出现；页码 / 条数缺省 1 / 20", async () => {
    await eventsApi.list("h1", { type: "collision_risk,obstacle_risk" });
    const q = queryOf(lastUrl());
    expect(q.get("type")).toBe("collision_risk,obstacle_risk");
    expect(q.has("from")).toBe(false);
    expect(q.get("page")).toBe("1");
    expect(q.get("pageSize")).toBe("20");
  });

  it("事件列表：类型 / 时间里带 & = # 也不会串成别的参数", async () => {
    await eventsApi.list("h1", { type: "a&page=99#x", from: "x=y", page: 3 });
    const q = queryOf(lastUrl());
    expect(q.get("type")).toBe("a&page=99#x");
    expect(q.get("from")).toBe("x=y");
    expect(q.get("page")).toBe("3");
    expect(q.getAll("page")).toHaveLength(1);
  });

  it("页码 0 / 条数 0：照传 0（不当成缺省），由服务端校验回 400", async () => {
    await eventsApi.list("h1", { page: 0, pageSize: 0 });
    const q = queryOf(lastUrl());
    expect(q.get("page")).toBe("0");
    expect(q.get("pageSize")).toBe("0");
  });

  it("账号级进行中求救：页码 / 条数缺省 1 / 100（多于 100 单时调用方靠 total 知道列表不全）；传了就照传", async () => {
    await sosApi.activeForAccount();
    expect(pathOf(lastUrl())).toBe("/api/v1/users/me/sos/active");
    let q = queryOf(lastUrl());
    expect(q.get("page")).toBe("1");
    expect(q.get("pageSize")).toBe("100");
    await sosApi.activeForAccount(2, 50);
    q = queryOf(lastUrl());
    expect(q.get("page")).toBe("2");
    expect(q.get("pageSize")).toBe("50");
  });
});

describe(".env 里接口地址的写法", () => {
  type ApiConst = typeof import("@/constants/api");
  type Realtime = typeof import("../realtime");
  const withEnv = <T>(value: string | undefined, load: () => T): T => {
    const prev = process.env.EXPO_PUBLIC_API_URL;
    if (value === undefined) delete process.env.EXPO_PUBLIC_API_URL;
    else process.env.EXPO_PUBLIC_API_URL = value;
    try {
      let out!: T;
      jest.isolateModules(() => {
        out = load();
      });
      return out;
    } finally {
      if (prev === undefined) delete process.env.EXPO_PUBLIC_API_URL;
      else process.env.EXPO_PUBLIC_API_URL = prev;
    }
  };
  const baseOf = (value: string | undefined) =>
    withEnv(
      value,
      () => jest.requireActual<ApiConst>("@/constants/api").API_BASE_URL,
    );

  // 原来结尾带斜杠时 REST 拼出 …/api/v1//devices（全部 404），实时通道却正常
  it("结尾带一个或几个斜杠、首尾带空白：都规整成不带斜杠的写法", () => {
    expect(baseOf("https://dev-api.example.com/api/v1/")).toBe(
      "https://dev-api.example.com/api/v1",
    );
    expect(baseOf("https://dev-api.example.com/api/v1///")).toBe(
      "https://dev-api.example.com/api/v1",
    );
    expect(baseOf("  http://192.168.1.2:3000/api/v1 \n")).toBe(
      "http://192.168.1.2:3000/api/v1",
    );
  });

  it("没配或配成空串：用本机后端", () => {
    expect(baseOf(undefined)).toBe("http://localhost:3000/api/v1");
    expect(baseOf("")).toBe("http://localhost:3000/api/v1");
  });

  it("结尾带斜杠时 REST 请求地址里没有双斜杠", async () => {
    const api = withEnv("https://dev-api.example.com/api/v1/", () =>
      jest.requireActual<typeof import("../client")>("../client"),
    );
    await api.api("/devices", { auth: false });
    expect(lastUrl()).toBe("https://dev-api.example.com/api/v1/devices");
  });

  it("实时通道地址：http → ws、https → wss，/api/v1 换成 /ws（带不带结尾斜杠都一样）", () => {
    for (const [env, ws] of [
      ["https://dev-api.example.com/api/v1/", "wss://dev-api.example.com/ws"],
      ["http://192.168.1.2:3000/api/v1", "ws://192.168.1.2:3000/ws"],
    ] as const) {
      const sockets: string[] = [];
      const realtime = withEnv(env, () =>
        jest.requireActual<Realtime>("../realtime"),
      );
      const prevWs = (globalThis as { WebSocket?: unknown }).WebSocket;
      (globalThis as { WebSocket?: unknown }).WebSocket = class {
        onopen: unknown;
        onclose: unknown;
        onmessage: unknown;
        onerror: unknown;
        constructor(url: string) {
          sockets.push(url);
        }
        close() {}
      };
      try {
        realtime.realtimeClient.start({
          getAccessToken: () => "tok",
          triggerTokenRefresh: async () => "stale" as const,
        });
        realtime.realtimeClient.stop();
      } finally {
        (globalThis as { WebSocket?: unknown }).WebSocket = prevWs;
      }
      expect(sockets[0]?.startsWith(`${ws}?`)).toBe(true);
    }
  });
});
