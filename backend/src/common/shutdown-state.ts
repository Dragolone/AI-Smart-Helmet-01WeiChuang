/**
 * 进程级「正在关闭」标记（审计 DBOPS-07）：收到 SIGTERM 后先把 /health 切到 503，
 * 让网关/拨测在排空期内把流量摘走，再真正 app.close()。纯内存、单实例部署（模块化单体）。
 */
let draining = false;

export const shutdownState = {
  isDraining: (): boolean => draining,
  markDraining: (): void => {
    draining = true;
  },
  /** 仅测试用：同一进程内多次构建 app 时复位 */
  reset: (): void => {
    draining = false;
  },
};
