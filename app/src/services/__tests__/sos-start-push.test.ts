// 安卓上极光那条「SOS 倒计时已开始」按编号精确撤（O12）：编号靠 patches/jpush-react-native 带上来。
import { afterEach, describe, expect, it } from "@jest/globals";

import {
  SOS_START_PUSH_TITLE,
  __resetSosStartPushForTests,
  clearSosStartPush,
  noteSosStartPush,
  setJPushNotificationClearer,
} from "../sos-start-push";

afterEach(() => __resetSosStartPushForTests());

describe("sos-start-push", () => {
  it("只记「倒计时已开始」的标题，结果通知不记；同一单首投重试到了两条都撤；撤过一次就忘掉", () => {
    const cleared: number[] = [];
    setJPushNotificationClearer((id) => cleared.push(id));
    noteSosStartPush("s1", SOS_START_PUSH_TITLE, 501);
    noteSosStartPush("s1", SOS_START_PUSH_TITLE, 502);
    noteSosStartPush("s1", SOS_START_PUSH_TITLE, 502);
    noteSosStartPush("s1", "已通知紧急联系人", 503);
    noteSosStartPush("s9", SOS_START_PUSH_TITLE, 900);
    clearSosStartPush("s1");
    expect(cleared).toEqual([501, 502]);
    clearSosStartPush("s1");
    expect(cleared).toEqual([501, 502]);
    clearSosStartPush("s9");
    expect(cleared).toEqual([501, 502, 900]);
  });

  it("没打补丁的旧原生包不带编号（undefined / 字符串 / 小数）：不记、不撤", () => {
    const cleared: number[] = [];
    setJPushNotificationClearer((id) => cleared.push(id));
    noteSosStartPush("s1", SOS_START_PUSH_TITLE, undefined);
    noteSosStartPush("s1", SOS_START_PUSH_TITLE, "501");
    noteSosStartPush("s1", SOS_START_PUSH_TITLE, 1.5);
    clearSosStartPush("s1");
    expect(cleared).toEqual([]);
  });

  it("极光还没初始化（没装撤的函数）：不抛；撤的时候原生抛错也不影响别的编号", () => {
    noteSosStartPush("s1", SOS_START_PUSH_TITLE, 1);
    expect(() => clearSosStartPush("s1")).not.toThrow();
    const cleared: number[] = [];
    setJPushNotificationClearer((id) => {
      if (id === 2) throw new Error("gone");
      cleared.push(id);
    });
    noteSosStartPush("s2", SOS_START_PUSH_TITLE, 2);
    noteSosStartPush("s2", SOS_START_PUSH_TITLE, 3);
    clearSosStartPush("s2");
    expect(cleared).toEqual([3]);
  });
});
