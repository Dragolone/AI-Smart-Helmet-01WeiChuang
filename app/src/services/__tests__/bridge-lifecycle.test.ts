// 实时桥的界面 / 登录态两套生命周期（10-18 负责人定：划掉 App 后连接继续跑到退出登录）
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import {
  __resetBridgeLifecycleForTests,
  attachBridgeUi,
  bridgeUi,
  orphanBridge,
} from "../bridge-lifecycle";

const session = () => ({ detach: jest.fn(), stopShared: jest.fn() });
/** 记下 watchLogout 拿到的回调，测试里手动触发「退出登录」 */
const logoutWatcher = () => {
  const w = {
    fire: () => {},
    unwatch: jest.fn(),
    watch: (onLogout: () => void) => {
      w.fire = onLogout;
      return w.unwatch;
    },
  };
  return w;
};

beforeEach(() => {
  __resetBridgeLifecycleForTests();
});

describe("bridge-lifecycle", () => {
  it("界面第一次起来：没有孤儿可接手，标记界面在", () => {
    expect(attachBridgeUi()).toBe(false);
    expect(bridgeUi.attached).toBe(true);
  });

  it("界面被拆、仍登录：标记界面不在，订阅和共享连接都不动", () => {
    attachBridgeUi();
    const s = session();
    orphanBridge(s, logoutWatcher().watch);
    expect(bridgeUi.attached).toBe(false);
    expect(s.detach).not.toHaveBeenCalled();
    expect(s.stopShared).not.toHaveBeenCalled();
  });

  it("界面回来：接手孤儿——拆它的订阅、不停共享连接、不再盯退出登录；返回 true", () => {
    const s = session();
    const w = logoutWatcher();
    orphanBridge(s, w.watch);
    expect(attachBridgeUi()).toBe(true);
    expect(bridgeUi.attached).toBe(true);
    expect(s.detach).toHaveBeenCalledTimes(1);
    expect(s.stopShared).not.toHaveBeenCalled();
    expect(w.unwatch).toHaveBeenCalledTimes(1);
    // 接手过一次就没了
    expect(attachBridgeUi()).toBe(false);
  });

  it("孤儿期间退出登录（会话过期）：订阅和共享连接全部拆掉，之后界面回来没有孤儿可接", () => {
    const s = session();
    const w = logoutWatcher();
    orphanBridge(s, w.watch);
    w.fire();
    expect(s.detach).toHaveBeenCalledTimes(1);
    expect(s.stopShared).toHaveBeenCalledTimes(1);
    expect(w.unwatch).toHaveBeenCalledTimes(1);
    expect(attachBridgeUi()).toBe(false);
  });

  it("已被接手的孤儿，迟到的退出登录回调不再拆东西", () => {
    const s = session();
    const w = logoutWatcher();
    orphanBridge(s, w.watch);
    attachBridgeUi();
    w.fire();
    expect(s.detach).toHaveBeenCalledTimes(1);
    expect(s.stopShared).not.toHaveBeenCalled();
  });

  it("又来一个孤儿（不该出现）：旧的订阅先拆，免得两份订阅一起处理同一条消息", () => {
    const a = session();
    const wa = logoutWatcher();
    orphanBridge(a, wa.watch);
    const b = session();
    orphanBridge(b, logoutWatcher().watch);
    expect(a.detach).toHaveBeenCalledTimes(1);
    expect(wa.unwatch).toHaveBeenCalledTimes(1);
    expect(a.stopShared).not.toHaveBeenCalled();
    expect(attachBridgeUi()).toBe(true);
    expect(b.detach).toHaveBeenCalledTimes(1);
  });
});
