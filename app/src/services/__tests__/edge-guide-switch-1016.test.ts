// 三步指引与「更换头盔提醒」的边界补测（2026-10-16）。
import { describe, expect, it } from "@jest/globals";

import {
  GUIDE_FRESH,
  TICK_LAST_MS,
  TICK_MS,
  guideAutoDone,
  guideBeat,
  guideCards,
  guideCurrent,
  guideDoneCount,
  guideSegments,
  guideTickMs,
  type GuideFacts,
  type GuideState,
} from "../device-guide";
import {
  FRESH_MS,
  MOVING_MPS,
  MOVING_MS,
  STILL_MS,
  nextMotion,
  switchCandidateOf,
  type Motion,
} from "../switch-reminder";

const facts = (over: Partial<GuideFacts> = {}): GuideFacts => ({
  link: null,
  notify: "undetermined",
  contacts: 0,
  slow: false,
  ...over,
});

describe("三步指引：轮到哪一件的边", () => {
  it("第一件没处理时，后面两件做没做都还是第一件（不能跳着走）", () => {
    expect(guideCurrent({ r1: "", r2: "done", r3: "done" })).toBe(1);
  });

  it("只绑定那一件（解绑过的老用户）：第一件处理了（做完或稍后）就结束", () => {
    expect(guideCurrent({ r1: "done", r2: "", r3: "" }, true)).toBe(0);
    expect(guideCurrent({ r1: "skipped", r2: "", r3: "" }, true)).toBe(0);
    expect(guideCurrent(GUIDE_FRESH, true)).toBe(1);
  });

  it("自动打勾：只绑定一件时，第一件处理完后不再替后面两件打勾", () => {
    const s: GuideState = { r1: "done", r2: "", r3: "" };
    expect(
      guideAutoDone(s, facts({ notify: "granted", contacts: 3 }), true),
    ).toBe(0);
  });

  it("自动打勾：联系人 0 个不算；通知「还没问过 / 查不了 / 没查到」都不算", () => {
    const at3: GuideState = { r1: "done", r2: "done", r3: "" };
    expect(guideAutoDone(at3, facts({ contacts: 0 }))).toBe(0);
    expect(guideAutoDone(at3, facts({ contacts: null }))).toBe(0);
    expect(guideAutoDone(at3, facts({ contacts: 5 }))).toBe(3);
    const at2: GuideState = { r1: "done", r2: "", r3: "" };
    for (const notify of ["undetermined", "unknown", "denied", null] as const) {
      expect(guideAutoDone(at2, facts({ notify }))).toBe(0);
    }
  });

  it("自动打勾：头盔只有已连接 / 在线才算，搜索中、待确认都不算", () => {
    for (const link of [
      "searching",
      "unknown",
      "offline",
      "disconnected",
      "mismatch",
    ] as const) {
      expect(guideAutoDone(GUIDE_FRESH, facts({ link }))).toBe(0);
    }
    expect(guideAutoDone(GUIDE_FRESH, facts({ link: "online" }))).toBe(1);
  });

  it("都处理完以后：不管事实怎样都不再打勾", () => {
    const done: GuideState = { r1: "done", r2: "skipped", r3: "done" };
    expect(
      guideAutoDone(
        done,
        facts({ link: "connected", notify: "granted", contacts: 1 }),
      ),
    ).toBe(0);
  });
});

describe("三步指引：卡片内容的边", () => {
  it("连上了、电量 0%：写名字和 0%（0 不当成没有电量）", () => {
    const [helmet] = guideCards(
      facts({ link: "connected", helmet: { name: "我的头盔", battery: 0 } }),
    );
    expect(helmet.body).toEqual({
      key: "guide.helmet.linkedBody",
      params: { name: "我的头盔", battery: 0 },
    });
  });

  it("连上了、但还没拿到这顶头盔的信息：只写「已连接」", () => {
    const [helmet] = guideCards(facts({ link: "online" }));
    expect(helmet.body).toEqual({ key: "guide.helmet.linked" });
    expect(helmet.primary).toBeUndefined();
  });

  it("身份不符时说身份不符，压过「找了很久」", () => {
    const [helmet] = guideCards(facts({ link: "mismatch", slow: true }));
    expect(helmet.body.key).toBe("guide.helmet.mismatchBody");
    expect(helmet.ripple).toBe(true);
  });

  it("搜索中的状态条跟着链路走：连接中 / 握手中 / 其余一律「正在搜索」", () => {
    const statusOf = (phase: GuideFacts["phase"]) =>
      guideCards(facts({ link: "searching", phase }))[0].status?.text.key;
    expect(statusOf("connecting")).toBe("guide.helmet.connecting");
    expect(statusOf("handshaking")).toBe("guide.helmet.handshaking");
    for (const phase of [
      undefined,
      "idle",
      "scanning",
      "disconnected",
      "error",
    ] as const) {
      expect(statusOf(phase)).toBe("guide.helmet.searching");
    }
  });

  it("通知「查不了 / 没查到」和「还没问过」一样给「允许通知」按钮", () => {
    for (const notify of ["undetermined", "unknown", null] as const) {
      const [, card] = guideCards(facts({ notify }));
      expect(card.primary?.action).toBe("askNotify");
    }
  });

  it("联系人数写进状态条：1 个、5 个；null 和 0 一样给「添加」", () => {
    expect(guideCards(facts({ contacts: 1 }))[2].status?.text).toEqual({
      key: "guide.contact.have",
      params: { n: 1 },
    });
    expect(guideCards(facts({ contacts: 5 }))[2].chip.text.params).toEqual({
      n: 5,
    });
    for (const contacts of [null, 0]) {
      expect(guideCards(facts({ contacts }))[2].primary?.action).toBe(
        "addContact",
      );
    }
  });

  it("每张卡要么有主按钮、要么有状态条，不会两样都没有", () => {
    const combos: GuideFacts[] = [];
    for (const link of [
      null,
      "connected",
      "online",
      "searching",
      "bluetoothOff",
      "bluetoothDenied",
      "mismatch",
      "offline",
      "unknown",
    ] as const)
      for (const notify of [
        "granted",
        "denied",
        "undetermined",
        "unknown",
        null,
      ] as const)
        for (const contacts of [null, 0, 2])
          combos.push(
            facts({
              link,
              notify,
              contacts,
              helmet: { name: "h", battery: 50 },
            }),
          );
    for (const f of combos) {
      for (const card of guideCards(f)) {
        expect(card.primary !== undefined || card.status !== undefined).toBe(
          true,
        );
      }
    }
  });
});

describe("三步指引：换下一件的演法与进度条", () => {
  it("最后一件做完：没有下一件，光不往外走", () => {
    const s: GuideState = { r1: "done", r2: "done", r3: "" };
    const beat = guideBeat(s, 3, "done", guideCards(facts()));
    expect(beat).toEqual({ next: 0, home: true, out: false });
  });

  it("第一件点了稍后：光不回徽标；下一件已经具备（通知已开，没有按钮）时也不往外走", () => {
    const beat = guideBeat(
      GUIDE_FRESH,
      1,
      "skipped",
      guideCards(facts({ notify: "granted" })),
    );
    expect(beat).toEqual({ next: 2, home: false, out: false });
  });

  it("只绑定一件：做完就结束", () => {
    expect(
      guideBeat(GUIDE_FRESH, 1, "done", guideCards(facts()), true),
    ).toEqual({
      next: 0,
      home: true,
      out: false,
    });
  });

  it("进度条：稍后的格子是 skipped 不是 done，做完的计数不算稍后", () => {
    const s: GuideState = { r1: "skipped", r2: "done", r3: "" };
    expect(guideSegments(s).map((x) => x.tone)).toEqual([
      "skipped",
      "done",
      "current",
    ]);
    expect(guideDoneCount(s)).toBe(1);
    expect(
      guideDoneCount({ r1: "skipped", r2: "skipped", r3: "skipped" }),
    ).toBe(0);
    expect(
      guideSegments({ r1: "done", r2: "done", r3: "done" }).map((x) => x.tone),
    ).toEqual(["done", "done", "done"]);
  });

  it("打勾后停多久：第三件和只绑定那一件短一点", () => {
    expect([1, 2, 3].map((s) => guideTickMs(s as 1 | 2 | 3))).toEqual([
      TICK_MS,
      TICK_MS,
      TICK_LAST_MS,
    ]);
    expect(guideTickMs(1, true)).toBe(TICK_LAST_MS);
  });
});

describe("更换头盔提醒：运动记录的边", () => {
  it("速度正好 1 m/s 不算在动；1.01 算", () => {
    expect(nextMotion(undefined, MOVING_MPS, 100)).toEqual({
      movingSince: null,
      lastMovingAt: null,
    });
    expect(nextMotion(undefined, MOVING_MPS + 0.01, 100)).toEqual({
      movingSince: 100,
      lastMovingAt: 100,
    });
  });

  it("速度是负数（定位模组的「未知」）或 NaN：不算在动，也不清掉上次动的时间", () => {
    const prev: Motion = { movingSince: 50, lastMovingAt: 90 };
    expect(nextMotion(prev, -1, 100)).toEqual({
      movingSince: null,
      lastMovingAt: 90,
    });
    expect(nextMotion(prev, Number.NaN, 100)).toEqual({
      movingSince: null,
      lastMovingAt: 90,
    });
  });

  it("停一下再动：连续运动的起点从重新动起来那一刻算", () => {
    let m = nextMotion(undefined, 5, 0);
    m = nextMotion(m, 0, 10_000);
    m = nextMotion(m, 5, 20_000);
    expect(m).toEqual({ movingSince: 20_000, lastMovingAt: 20_000 });
  });
});

describe("更换头盔提醒：该不该问的临界", () => {
  const T0 = 10_000_000;
  const base = {
    currentId: "cur",
    onlineIds: ["cur", "other"],
    watchingSince: T0 - STILL_MS * 10,
  };

  it("当前头盔停了正好 2 分钟就问；差 1 毫秒不问", () => {
    const other: Motion = { movingSince: T0 - MOVING_MS, lastMovingAt: T0 };
    const cur: Motion = { movingSince: null, lastMovingAt: T0 - STILL_MS };
    expect(
      switchCandidateOf({ ...base, motions: { cur, other }, now: T0 }),
    ).toBe("other");
    const curLate: Motion = {
      movingSince: null,
      lastMovingAt: T0 - STILL_MS + 1,
    };
    expect(
      switchCandidateOf({ ...base, motions: { cur: curLate, other }, now: T0 }),
    ).toBeNull();
  });

  it("另一台连续动了正好 30 秒就算；差 1 毫秒不算", () => {
    const cur: Motion = { movingSince: null, lastMovingAt: null };
    expect(
      switchCandidateOf({
        ...base,
        motions: {
          cur,
          other: { movingSince: T0 - MOVING_MS, lastMovingAt: T0 },
        },
        now: T0,
      }),
    ).toBe("other");
    expect(
      switchCandidateOf({
        ...base,
        motions: {
          cur,
          other: { movingSince: T0 - MOVING_MS + 1, lastMovingAt: T0 },
        },
        now: T0,
      }),
    ).toBeNull();
  });

  it("另一台最近一次上报正好 20 秒前还算在动；20 秒零 1 毫秒不算", () => {
    const cur: Motion = { movingSince: null, lastMovingAt: null };
    const since = T0 - MOVING_MS * 10;
    expect(
      switchCandidateOf({
        ...base,
        motions: {
          cur,
          other: { movingSince: since, lastMovingAt: T0 - FRESH_MS },
        },
        now: T0,
      }),
    ).toBe("other");
    expect(
      switchCandidateOf({
        ...base,
        motions: {
          cur,
          other: { movingSince: since, lastMovingAt: T0 - FRESH_MS - 1 },
        },
        now: T0,
      }),
    ).toBeNull();
  });

  it("从没见过当前头盔动：开始观察满 2 分钟才算停着；手机时间往回拨（now 早于开始观察）不问", () => {
    const other: Motion = { movingSince: T0 - MOVING_MS, lastMovingAt: T0 };
    expect(
      switchCandidateOf({
        ...base,
        watchingSince: T0 - STILL_MS,
        motions: { other },
        now: T0,
      }),
    ).toBe("other");
    expect(
      switchCandidateOf({
        ...base,
        watchingSince: T0 - STILL_MS + 1,
        motions: { other },
        now: T0,
      }),
    ).toBeNull();
    expect(
      switchCandidateOf({
        ...base,
        watchingSince: T0 + 60_000,
        motions: { other },
        now: T0,
      }),
    ).toBeNull();
  });

  it("只有当前头盔在线、或在线列表为空：不问", () => {
    const other: Motion = { movingSince: T0 - MOVING_MS, lastMovingAt: T0 };
    expect(
      switchCandidateOf({
        ...base,
        onlineIds: ["cur"],
        motions: { other },
        now: T0,
      }),
    ).toBeNull();
    expect(
      switchCandidateOf({
        ...base,
        onlineIds: [],
        motions: { other },
        now: T0,
      }),
    ).toBeNull();
  });

  it("在线列表里当前头盔出现两次：不会建议换成它自己", () => {
    const cur: Motion = { movingSince: T0 - MOVING_MS, lastMovingAt: T0 };
    expect(
      switchCandidateOf({
        ...base,
        onlineIds: ["cur", "cur"],
        motions: { cur },
        now: T0 + STILL_MS * 2,
      }),
    ).toBeNull();
  });

  it("另一台的记录不完整（只有起点没有最近一次）：不算在动", () => {
    const broken = {
      movingSince: T0 - MOVING_MS,
      lastMovingAt: null,
    } as Motion;
    expect(
      switchCandidateOf({ ...base, motions: { other: broken }, now: T0 }),
    ).toBeNull();
  });
});
