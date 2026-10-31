// 本机落盘失败时说一声（手测清单 O37，2026-10-31 安卓模拟器把存储填满实测）：
// 登录 / 退出 / 改设置都是先改内存再写 SecureStore，写不进去时当次运行照样生效，用户完全看不出来——
// 登录后重启又回到登录页；退出登录后重启却又登回去（删键同样要重写整个 SharedPreferences 文件）；
// 外观 / 语言重启还原。这里只负责提示，不改原来的「失败不抛、不阻塞」口径。
// 同一类失败 10 秒内只提示一次：开着存储满的手机连改几项设置不至于刷屏。
import { showToast } from "@/components/toast-bus";
import { translate } from "@/i18n";
import { devLog } from "@/services/dev-log";

export type PersistFailure = "login" | "logout" | "setting";

const MESSAGE = {
  login: "persist.loginNotSaved",
  logout: "persist.logoutIncomplete",
  setting: "persist.settingNotSaved",
} as const;

const QUIET_MS = 10_000;
const lastShownAt = new Map<PersistFailure, number>();

export function notePersistFailure(kind: PersistFailure, err: unknown): void {
  devLog("PERSIST", `本机落盘失败（${kind}）`, err);
  const now = Date.now();
  if (now - (lastShownAt.get(kind) ?? 0) < QUIET_MS) return;
  lastShownAt.set(kind, now);
  showToast(translate(MESSAGE[kind]));
}

/** 仅测试用 */
export function __resetPersistNoticeForTests(): void {
  lastShownAt.clear();
}
