// 三步指引的推导（services/device-guide）：轮到哪件、哪件会自己翻过去、卡片上写什么
import { describe, expect, it } from "@jest/globals";

import {
  GUIDE_FRESH,
  guideAutoDone,
  guideCards,
  guideCurrent,
  guideDoneCount,
  guideSegments,
  type GuideFacts,
} from "../device-guide";

const facts = (over: Partial<GuideFacts> = {}): GuideFacts => ({
  link: null,
  notify: "undetermined",
  contacts: 0,
  slow: false,
  ...over,
});

describe("三步指引：轮到哪一件", () => {
  it("按头盔、通知、联系人的顺序；都处理完是 0", () => {
    expect(guideCurrent(GUIDE_FRESH)).toBe(1);
    expect(guideCurrent({ r1: "done", r2: "", r3: "" })).toBe(2);
    expect(guideCurrent({ r1: "skipped", r2: "done", r3: "" })).toBe(3);
    expect(guideCurrent({ r1: "done", r2: "skipped", r3: "skipped" })).toBe(0);
  });

  it("点了稍后也算处理过，但不算做完", () => {
    const s = { r1: "done", r2: "skipped", r3: "done" } as const;
    expect(guideDoneCount(s)).toBe(2);
    expect(guideSegments(s).map((g) => g.tone)).toEqual([
      "done",
      "skipped",
      "done",
    ]);
  });

  it("进度条上只有轮到的那一格是「当前」", () => {
    expect(
      guideSegments({ r1: "done", r2: "", r3: "" }).map((g) => g.tone),
    ).toEqual(["done", "current", "todo"]);
  });
});

describe("三步指引：已经具备的自己打勾翻过去", () => {
  it("头盔连上了（蓝牙连着或服务端在线）才算第一件做完", () => {
    expect(guideAutoDone(GUIDE_FRESH, facts({ link: "connected" }))).toBe(1);
    expect(guideAutoDone(GUIDE_FRESH, facts({ link: "online" }))).toBe(1);
    expect(guideAutoDone(GUIDE_FRESH, facts({ link: "searching" }))).toBe(0);
    expect(guideAutoDone(GUIDE_FRESH, facts({ link: null }))).toBe(0);
  });

  it("只看轮到的那一件：没绑头盔时通知已开也不会跳过第一件", () => {
    expect(
      guideAutoDone(GUIDE_FRESH, facts({ notify: "granted", contacts: 2 })),
    ).toBe(0);
    const second = { r1: "done", r2: "", r3: "" } as const;
    expect(guideAutoDone(second, facts({ notify: "granted" }))).toBe(2);
    expect(guideAutoDone(second, facts({ notify: "denied" }))).toBe(0);
  });

  it("还没查到的不当成已经有", () => {
    const second = { r1: "done", r2: "", r3: "" } as const;
    expect(guideAutoDone(second, facts({ notify: null }))).toBe(0);
    expect(guideAutoDone(second, facts({ notify: "unknown" }))).toBe(0);
    const third = { r1: "done", r2: "done", r3: "" } as const;
    expect(guideAutoDone(third, facts({ contacts: null }))).toBe(0);
    expect(guideAutoDone(third, facts({ contacts: 1 }))).toBe(3);
  });
});

describe("三步指引：卡片上写什么", () => {
  it("没绑定：扫码是主按钮，手动输入是次要入口，不能跳过", () => {
    const [one] = guideCards(facts());
    expect(one.primary?.action).toBe("scan");
    expect(one.link?.action).toBe("manual");
    expect(one.chip.tone).toBe("neutral");
  });

  it("绑定后蓝牙关着 / 没给权限：是这张卡里的提示，可以稍后再连", () => {
    const [off] = guideCards(facts({ link: "bluetoothOff" }));
    expect(off.primary?.action).toBe("openBluetooth");
    expect(off.link?.action).toBe("skip");
    const [denied] = guideCards(facts({ link: "bluetoothDenied" }));
    expect(denied.primary?.action).toBe("openAppSettings");
    expect(denied.chip.tone).toBe("good");
  });

  it("搜索中：没有主按钮，状态条跟着蓝牙走到哪一步变，久了换一句提示", () => {
    const [a] = guideCards(facts({ link: "searching", phase: "scanning" }));
    expect(a.primary).toBeUndefined();
    expect(a.status).toEqual({
      text: { key: "guide.helmet.searching" },
      tone: "busy",
    });
    expect(a.ripple).toBe(true);
    expect(a.body.key).toBe("guide.helmet.searchBody");
    const [b] = guideCards(
      facts({ link: "searching", phase: "handshaking", slow: true }),
    );
    expect(b.status?.text.key).toBe("guide.helmet.handshaking");
    expect(b.body.key).toBe("guide.helmet.searchSlow");
  });

  it("头盔关机 / 掉线 / 状态拿不到，都按「去打开头盔电源」处理", () => {
    for (const link of ["offline", "disconnected", "unknown"] as const) {
      const [c] = guideCards(facts({ link }));
      expect(c.title).toBe("guide.helmet.searchTitle");
      expect(c.link?.action).toBe("skip");
    }
  });

  it("连上了：写头盔名和电量；没有电量数据时不写电量", () => {
    const [c] = guideCards(
      facts({ link: "connected", helmet: { name: "通勤头盔", battery: 78 } }),
    );
    expect(c.status?.tone).toBe("ok");
    expect(c.body).toEqual({
      key: "guide.helmet.linkedBody",
      params: { name: "通勤头盔", battery: 78 },
    });
    const [d] = guideCards(
      facts({ link: "online", helmet: { name: "通勤头盔", battery: null } }),
    );
    expect(d.body).toEqual({ key: "guide.helmet.linked" });
  });

  it("通知：没问过就请求，拒绝过只能去设置，都可以稍后", () => {
    const [, ask] = guideCards(facts({ notify: "undetermined" }));
    expect(ask.primary?.action).toBe("askNotify");
    expect(ask.link?.action).toBe("skip");
    const [, denied] = guideCards(facts({ notify: "denied" }));
    expect(denied.primary?.action).toBe("openAppSettings");
    expect(denied.chip.tone).toBe("amber");
    const [, on] = guideCards(facts({ notify: "granted" }));
    expect(on.primary).toBeUndefined();
    expect(on.status?.tone).toBe("ok");
  });

  it("联系人：有一位就算，卡片上写几位", () => {
    const [, , none] = guideCards(facts({ contacts: 0 }));
    expect(none.primary?.action).toBe("addContact");
    const [, , two] = guideCards(facts({ contacts: 2 }));
    expect(two.chip.text).toEqual({
      key: "guide.contact.chipYes",
      params: { n: 2 },
    });
    expect(two.status?.tone).toBe("ok");
  });
});

describe("绑过头盔的账号（只有绑定那一件）", () => {
  it("没绑上是第一件；绑上或点了稍后就算完，不再轮到通知和联系人", () => {
    expect(guideCurrent(GUIDE_FRESH, true)).toBe(1);
    expect(guideCurrent({ r1: "done", r2: "", r3: "" }, true)).toBe(0);
    expect(guideCurrent({ r1: "skipped", r2: "", r3: "" }, true)).toBe(0);
  });

  it("头盔连上会自己打勾；之后通知、联系人已经具备也不会再去打勾", () => {
    expect(guideAutoDone(GUIDE_FRESH, facts({ link: "connected" }), true)).toBe(
      1,
    );
    expect(guideAutoDone(GUIDE_FRESH, facts({ link: "searching" }), true)).toBe(
      0,
    );
    expect(
      guideAutoDone(
        { r1: "done", r2: "", r3: "" },
        facts({ link: "connected", notify: "granted", contacts: 2 }),
        true,
      ),
    ).toBe(0);
  });
});
