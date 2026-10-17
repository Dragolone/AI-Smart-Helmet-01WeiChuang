// 实时桥（hooks/use-realtime）挂在根布局上，跟界面同生共死；它管的连接却要跟登录态同生共死。
// 安卓从多任务划掉 App 时，进程被极光的推送服务撑着并没有死，React 树却卸载了：原来清理一律按登出处理，
// 划掉后 WS、蓝牙链路、上行队列、推送别名、求救提醒全停，来单什么提醒都没有（10-18 模拟器实测）。
// 负责人 10-18 定：划掉后继续跑到退出登录。界面被拆而人还登录着时，这一次的订阅和连接都留着（「孤儿」），
// 下次界面起来时由新的一次接手；这期间退出登录（会话过期）就全部拆掉。不碰 React，便于单测。

export type BridgeSession = {
  /** 这一次挂上的订阅：WS 消息、连接状态、AppState、缓存、账号变化 */
  detach: () => void;
  /** 进程级共享的东西：WS、上行队列、蓝牙链路、推送别名、求救提醒…… */
  stopShared: () => void;
};

/** 界面在不在。不在时不能跳页：导航器没挂着，router.push 会抛错（锁屏提醒照弹，界面回来后补拉再拉起倒计时页） */
export const bridgeUi = { attached: false };

let orphan: { session: BridgeSession; unwatch: () => void } | null = null;

/**
 * 界面起来时调用。上一个界面被拆时留下了孤儿：拆掉它的订阅（新的一次马上重挂），共享连接不停、接着用。
 * 返回有没有接手孤儿——有的话，上一个界面拉起过的倒计时页已经不在了，调用方要把「拉起过」的登记清掉
 */
export function attachBridgeUi(): boolean {
  bridgeUi.attached = true;
  if (!orphan) return false;
  const { session, unwatch } = orphan;
  orphan = null;
  unwatch();
  session.detach();
  return true;
}

/**
 * 界面被拆、人还登录着：订阅和连接都留着。watchLogout 订阅「退出登录」，回调里把孤儿整个拆掉
 * （订阅 + 共享连接），返回取消订阅的函数
 */
export function orphanBridge(
  session: BridgeSession,
  watchLogout: (onLogout: () => void) => () => void,
): void {
  bridgeUi.attached = false;
  if (orphan) {
    // 不该出现（每次界面起来都会先接手）；万一有，旧的订阅先拆，免得两份订阅一起处理同一条消息
    orphan.unwatch();
    orphan.session.detach();
  }
  const entry = {
    session,
    unwatch: () => {},
  };
  entry.unwatch = watchLogout(() => {
    if (orphan !== entry) return;
    orphan = null;
    entry.unwatch();
    session.detach();
    session.stopShared();
  });
  orphan = entry;
}

/** 仅测试用 */
export function __resetBridgeLifecycleForTests(): void {
  orphan = null;
  bridgeUi.attached = false;
}
