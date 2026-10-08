// 设备页三步指引这一次走到哪了（只在这次运行里记着）
import { beforeEach, describe, expect, it } from "@jest/globals";

import { GUIDE_FRESH } from "@/services/device-guide";

import { useGuideStore } from "../guide-store";

const s = () => useGuideStore.getState();
const rect = { x: 0, y: 0, w: 10, h: 10 };

beforeEach(() => s().reset());

describe("三步指引的进度", () => {
  it("开始之后才记；一件事只记一次", () => {
    s().mark(1, "done");
    expect(s().state).toEqual(GUIDE_FRESH);

    s().begin("u1");
    expect(s().active).toBe(true);
    s().mark(1, "skipped");
    s().mark(1, "done");
    expect(s().state.r1).toBe("skipped");
  });

  it("绑过头盔的账号：这一次只有绑定那一件；同一位用户重复开始不改这个", () => {
    s().begin("u1", true);
    expect(s().bindOnly).toBe(true);
    s().begin("u1", false);
    expect(s().bindOnly).toBe(true);
    s().begin("u2");
    expect(s().bindOnly).toBe(false);
  });

  it("收尾被打断：先搭着的那一层撤掉；衔接已经在播就不撤", () => {
    s().begin("u1");
    s().arm();
    s().disarm();
    expect(s().armed).toBe(false);
    s().arm();
    s().finish({ card: rect, emblem: rect });
    s().disarm();
    expect(s().armed).toBe(true);
    expect(s().handover).not.toBeNull();
  });

  it("同一位用户重复开始不会把进度清掉；换了用户重来", () => {
    s().begin("u1");
    s().mark(1, "done");
    s().begin("u1");
    expect(s().state.r1).toBe("done");
    s().begin("u2");
    expect(s().userId).toBe("u2");
    expect(s().state).toEqual(GUIDE_FRESH);
  });

  it("三件处理完：指引结束，带着位置交给衔接动画；播完清掉", () => {
    s().begin("u1");
    s().arm();
    expect(s().armed).toBe(true);
    s().finish({ card: rect, emblem: rect });
    expect(s().active).toBe(false);
    expect(s().handover).toEqual({ card: rect, emblem: rect });
    expect(s().armed).toBe(true);
    s().endHandover();
    expect(s().handover).toBeNull();
    expect(s().armed).toBe(false);
  });

  it("量不到位置：直接结束，不留着衔接那一层", () => {
    s().begin("u1");
    s().arm();
    s().finish(null);
    expect(s().active).toBe(false);
    expect(s().handover).toBeNull();
    expect(s().armed).toBe(false);
  });

  it("指引没在进行时不会先把衔接那一层搭起来", () => {
    s().arm();
    expect(s().armed).toBe(false);
  });
});
