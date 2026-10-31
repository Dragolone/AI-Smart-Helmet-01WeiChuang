// 本机落盘失败时说一声（手测清单 O37，2026-10-31 安卓模拟器把存储填满实测）：
// 登录 / 退出 / 改设置都是先改内存再写 SecureStore，写不进去时当次运行照样生效，用户完全看不出来——
// 登录后重启又回到登录页；退出登录后重启却又登回去（删键同样要重写整个 SharedPreferences 文件）；
// 外观 / 语言重启还原。这里只负责提示，不改原来的「失败不抛、不阻塞」口径。
// 同一类失败 10 秒内只提示一次：开着存储满的手机连改几项设置不至于刷屏。
//
// 安卓上 expo-secure-store 的**写失败不抛**（SharedPreferences commit() 的返回值被丢掉，只有删失败会抛
// DeleteException；10-31 读 57.0.1 的 SecureStoreModule.kt 坐实），所以写这一侧抓不到异常，只能在写完后
// 看一眼剩余空间：少于 64 MB 就按「可能没存上」提示——模拟器实测写不进时 df 报的「可用」是 16–45 MB，
// 系统自动清缓存后恢复到 190 MB 以上才写得进。
import { showToast } from "@/components/toast-bus";
import { translate, type Params } from "@/i18n";
import { devLog } from "@/services/dev-log";

export type PersistFailure = "login" | "logout" | "setting";
type Notice = PersistFailure | "lowSpaceLogin" | "lowSpaceSetting";

const MESSAGE = {
  login: "persist.loginNotSaved",
  logout: "persist.logoutIncomplete",
  setting: "persist.settingNotSaved",
  lowSpaceLogin: "persist.lowSpaceLogin",
  lowSpaceSetting: "persist.lowSpaceSetting",
} as const;

const QUIET_MS = 10_000;
/** 低于它就当「可能写不进去」（字节） */
export const LOW_DISK_BYTES = 64 * 1024 * 1024;
const lastShownAt = new Map<Notice, number>();

function notify(kind: Notice, params?: Params): void {
  const now = Date.now();
  if (now - (lastShownAt.get(kind) ?? 0) < QUIET_MS) return;
  lastShownAt.set(kind, now);
  showToast(translate(MESSAGE[kind], params));
}

export function notePersistFailure(kind: PersistFailure, err: unknown): void {
  devLog("PERSIST", `本机落盘失败（${kind}）`, err);
  notify(kind);
}

/**
 * 写成功返回之后调用：剩余空间太少就提示「可能没存上」。
 * 用 require 而不是顶层 import：这个模块被 i18n / store 带进几乎所有页面，不让 expo-file-system 这个原生依赖进静态模块图；
 * 也不用 import()——jest 下原生动态 import 绕过模块注册表、测不到
 */
export function warnIfDiskLow(kind: "login" | "setting"): void {
  let free: number;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 见上
    const fs = require("expo-file-system") as typeof import("expo-file-system");
    free = fs.Paths.availableDiskSpace;
  } catch {
    return;
  }
  if (!Number.isFinite(free) || free >= LOW_DISK_BYTES) return;
  const mb = Math.max(0, Math.round(free / 1048576));
  devLog("PERSIST", `剩余空间只有 ${mb} MB（${kind}）`);
  notify(kind === "login" ? "lowSpaceLogin" : "lowSpaceSetting", { mb });
}

/** 仅测试用 */
export function __resetPersistNoticeForTests(): void {
  lastShownAt.clear();
}
