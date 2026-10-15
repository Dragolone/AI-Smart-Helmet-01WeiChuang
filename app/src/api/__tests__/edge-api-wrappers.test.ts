// 各接口薄封装：路径（含 id 转义）、方法、是否带登录态、请求体、查询参数默认值。
// 只替换底层 api()，断言「发出去的请求长什么样」——路径拼错 / 漏转义 / 方法写错都会在这里暴露。
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { authApi, maskPhone } from "../auth";
import { channelsApi } from "../channels";
import { contactsApi } from "../contacts";
import { devicesApi } from "../devices";
import { eventsApi } from "../events";
import { buildRelayEnvelope, relayApi } from "../relay";
import { sosApi } from "../sos";

const mockApi = jest.fn(
  async (
    _path: string,
    _init?: Record<string, unknown>,
  ): Promise<unknown> => ({}),
);
let mockRefresh = "rt-1";
jest.mock("../client", () => ({
  api: (p: string, i?: Record<string, unknown>) => mockApi(p, i),
  currentRefreshToken: () => mockRefresh,
}));
jest.mock("@/services/server-clock", () => ({
  serverNow: () => Date.UTC(2026, 9, 16, 2, 0, 0),
}));

afterEach(() => {
  jest.clearAllMocks();
});

const last = () => {
  const [path, init] = mockApi.mock.calls[mockApi.mock.calls.length - 1];
  return { path, init: init ?? {} };
};
/** 带特殊字符的 id：斜杠、空格、问号都要被转义，不能拼出别的路径 */
const ODD = "a/b c?d";
const ENC = encodeURIComponent(ODD);

describe("maskPhone", () => {
  it("11 位中间四位打码；空值显示一横；其它长度原样", () => {
    expect(maskPhone("13900000042")).toBe("139****0042");
    expect(maskPhone(null)).toBe("—");
    expect(maskPhone(undefined)).toBe("—");
    expect(maskPhone("")).toBe("—");
    expect(maskPhone("+8613900000042")).toBe("+8613900000042");
    expect(maskPhone("12345")).toBe("12345");
  });
});

describe("authApi", () => {
  it("未登录也能调的四个接口不带登录态", async () => {
    await authApi.sendSmsCode({ phone: "139", purpose: "register" });
    expect(last()).toEqual({
      path: "/auth/sms-code",
      init: {
        method: "POST",
        body: { phone: "139", purpose: "register" },
        auth: false,
      },
    });
    await authApi.register({ phone: "p" } as never);
    expect(last().path).toBe("/auth/register");
    expect(last().init.auth).toBe(false);
    await authApi.login({ phone: "p", password: "x" } as never);
    expect(last().path).toBe("/auth/login");
    expect(last().init.auth).toBe(false);
    await authApi.resetPassword({ phone: "p" } as never);
    expect(last().path).toBe("/auth/reset-password");
    expect(last().init.auth).toBe(false);
    await authApi.logout("rt-9");
    expect(last()).toEqual({
      path: "/auth/logout",
      init: { method: "POST", body: { refreshToken: "rt-9" }, auth: false },
    });
  });

  it("改密码：请求体是函数，每次真正发出时现取本机 refresh token（重试时拿到的是轮换后的新 token）", async () => {
    await authApi.changePassword({ oldPassword: "o", newPassword: "n" });
    const { path, init } = last();
    expect(path).toBe("/auth/change-password");
    expect(init.method).toBe("POST");
    expect(init.auth).toBeUndefined();
    const body = init.body as () => unknown;
    expect(typeof body).toBe("function");
    expect(body()).toEqual({
      oldPassword: "o",
      newPassword: "n",
      refreshToken: "rt-1",
    });
    mockRefresh = "rt-2";
    expect(body()).toEqual({
      oldPassword: "o",
      newPassword: "n",
      refreshToken: "rt-2",
    });
    mockRefresh = "rt-1";
  });

  it("换手机号 / 注销 / 我的档案 / 改档案", async () => {
    await authApi.changePhone({ newPhone: "1", code: "2", password: "3" });
    expect(last()).toEqual({
      path: "/auth/change-phone",
      init: {
        method: "POST",
        body: { newPhone: "1", code: "2", password: "3" },
      },
    });
    await authApi.deleteMe({ password: "p" });
    expect(last()).toEqual({
      path: "/users/me",
      init: { method: "DELETE", body: { password: "p" } },
    });
    await authApi.me();
    expect(last()).toEqual({ path: "/users/me", init: {} });
    await authApi.updateMe({ nickname: "n" } as never);
    expect(last()).toEqual({
      path: "/users/me",
      init: { method: "PATCH", body: { nickname: "n" } },
    });
  });
});

describe("sosApi", () => {
  it("进行中 / 取消 / 立即求救：id 转义、方法正确", async () => {
    await sosApi.active(ODD);
    expect(last()).toEqual({ path: `/devices/${ENC}/sos/active`, init: {} });
    await sosApi.cancel(ODD);
    expect(last()).toEqual({
      path: `/sos/${ENC}/cancel`,
      init: { method: "POST" },
    });
    await sosApi.confirm("s1");
    expect(last()).toEqual({
      path: "/sos/s1/confirm",
      init: { method: "POST" },
    });
  });

  it("事故列表默认第 1 页 20 条；详情 id 转义", async () => {
    await sosApi.accidents("d1");
    expect(last().path).toBe("/devices/d1/accidents?page=1&pageSize=20");
    await sosApi.accidents("d1", 3, 50);
    expect(last().path).toBe("/devices/d1/accidents?page=3&pageSize=50");
    await sosApi.accidentDetail(ODD);
    expect(last().path).toBe(`/accidents/${ENC}`);
  });
});

describe("eventsApi", () => {
  it("列表：只带给了的筛选项，页码 / 条数有默认值", async () => {
    await eventsApi.list("d1");
    expect(last().path).toBe("/devices/d1/events?page=1&pageSize=20");
    await eventsApi.list(ODD, {
      type: "possible_fall,manual_sos",
      from: "2026-10-16T00:00:00.000Z",
      to: "2026-10-16T23:59:59.999Z",
      page: 2,
      pageSize: 50,
    });
    const url = new URL(`http://x${last().path}`);
    expect(url.pathname).toBe(`/devices/${ENC}/events`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      type: "possible_fall,manual_sos",
      from: "2026-10-16T00:00:00.000Z",
      to: "2026-10-16T23:59:59.999Z",
      page: "2",
      pageSize: "50",
    });
  });

  it("详情 id 转义", async () => {
    await eventsApi.detail(ODD);
    expect(last().path).toBe(`/events/${ENC}`);
  });
});

describe("relayApi", () => {
  it("中转批量提交 / 命令回执（两个 id 都转义）", async () => {
    await relayApi.push({ deviceId: "d1", envelopes: [] } as never);
    expect(last()).toEqual({
      path: "/ingest/app-relay",
      init: { method: "POST", body: { deviceId: "d1", envelopes: [] } },
    });
    await relayApi.ack(ODD, "c/1", { result: "success" } as never);
    expect(last()).toEqual({
      path: `/devices/${ENC}/commands/c%2F1/relay-ack`,
      init: { method: "POST", body: { result: "success" } },
    });
  });

  it("pushEvent：包一条合规 envelope（服务端时间、v4 eventId、默认空载荷）", async () => {
    await relayApi.pushEvent("d1", "manual_sos");
    const body = last().init.body as {
      deviceId: string;
      envelopes: ReturnType<typeof buildRelayEnvelope>[];
    };
    expect(body.deviceId).toBe("d1");
    expect(body.envelopes).toHaveLength(1);
    const env = body.envelopes[0];
    expect(env).toMatchObject({
      schemaVersion: 1,
      deviceId: "d1",
      eventType: "manual_sos",
      timestamp: "2026-10-16T02:00:00.000Z",
      firmwareVersion: "app-relay-dev",
      payload: {},
    });
    expect(env.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("channelsApi", () => {
  it("列表 / 创建 / 加入 / 退出 / 成员 / 进房凭证", async () => {
    await channelsApi.list();
    expect(last()).toEqual({ path: "/voice/channels", init: {} });
    await channelsApi.create({ name: "车队" } as never);
    expect(last()).toEqual({
      path: "/voice/channels",
      init: { method: "POST", body: { name: "车队" } },
    });
    await channelsApi.join({ inviteCode: "ABC" } as never);
    expect(last()).toEqual({
      path: "/voice/channels/join",
      init: { method: "POST", body: { inviteCode: "ABC" } },
    });
    await channelsApi.leave(ODD);
    expect(last()).toEqual({
      path: `/voice/channels/${ENC}/membership`,
      init: { method: "DELETE" },
    });
    await channelsApi.members(ODD);
    expect(last().path).toBe(`/voice/channels/${ENC}/members`);
    await channelsApi.token("c1");
    expect(last()).toEqual({
      path: "/voice/channels/c1/token",
      init: { method: "POST" },
    });
  });
});

describe("contactsApi", () => {
  it("列表 / 新增 / 修改 / 删除", async () => {
    await contactsApi.list();
    expect(last().path).toBe("/users/me/emergency-contacts");
    await contactsApi.create({ name: "妈妈", phone: "1" } as never);
    expect(last().init).toEqual({
      method: "POST",
      body: { name: "妈妈", phone: "1" },
    });
    await contactsApi.update(ODD, { name: "爸爸" } as never);
    expect(last()).toEqual({
      path: `/users/me/emergency-contacts/${ENC}`,
      init: { method: "PATCH", body: { name: "爸爸" } },
    });
    await contactsApi.remove("c1");
    expect(last()).toEqual({
      path: "/users/me/emergency-contacts/c1",
      init: { method: "DELETE" },
    });
  });
});

describe("devicesApi", () => {
  it("绑定 / 列表 / 详情 / 状态 / 改名 / 解绑", async () => {
    await devicesApi.bind({ deviceId: "d1", bindCode: "x" } as never);
    expect(last()).toEqual({
      path: "/devices/bind",
      init: { method: "POST", body: { deviceId: "d1", bindCode: "x" } },
    });
    await devicesApi.list();
    expect(last().path).toBe("/devices");
    await devicesApi.detail(ODD);
    expect(last().path).toBe(`/devices/${ENC}`);
    await devicesApi.status(ODD);
    expect(last().path).toBe(`/devices/${ENC}/status`);
    await devicesApi.rename(ODD, { name: null });
    expect(last()).toEqual({
      path: `/devices/${ENC}`,
      init: { method: "PATCH", body: { name: null } },
    });
    await devicesApi.unbind(ODD);
    expect(last()).toEqual({
      path: `/devices/${ENC}/binding`,
      init: { method: "DELETE" },
    });
  });

  it("电量历史默认 24 小时；位置 / 设置读写", async () => {
    await devicesApi.batteryHistory("d1");
    expect(last().path).toBe("/devices/d1/battery-history?hours=24");
    await devicesApi.batteryHistory("d1", 6);
    expect(last().path).toBe("/devices/d1/battery-history?hours=6");
    await devicesApi.latestLocation(ODD);
    expect(last().path).toBe(`/devices/${ENC}/locations/latest`);
    await devicesApi.settings("d1");
    expect(last().path).toBe("/devices/d1/settings");
    await devicesApi.putSettings("d1", { settings: { light: 1 } });
    expect(last()).toEqual({
      path: "/devices/d1/settings",
      init: { method: "PUT", body: { settings: { light: 1 } } },
    });
    await devicesApi.reportSettings("d1", { settings: { light: 0 } });
    expect(last()).toEqual({
      path: "/devices/d1/settings/reported",
      init: { method: "POST", body: { settings: { light: 0 } } },
    });
  });

  it("时间区间类接口：from / to 带时区偏移也要转义（+ 号不能被当成空格）", async () => {
    const from = "2026-10-16T00:00:00+08:00";
    const to = "2026-10-16T23:59:59+08:00";
    const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    await devicesApi.locationSummary("d1", from, to);
    expect(last().path).toBe(`/devices/d1/locations/summary?${q}`);
    expect(last().path).toContain("%2B08%3A00");
    await devicesApi.rides("d1", from, to);
    expect(last().path).toBe(`/devices/d1/rides?${q}`);
    await devicesApi.track("d1", from, to);
    expect(last().path).toBe(`/devices/d1/locations/track?${q}&maxPoints=1000`);
    await devicesApi.track("d1", from, to, 200);
    expect(last().path).toBe(`/devices/d1/locations/track?${q}&maxPoints=200`);
    await devicesApi.locations("d1", from, to, 2, 100);
    expect(last().path).toBe(`/devices/d1/locations?${q}&page=2&pageSize=100`);
  });
});
