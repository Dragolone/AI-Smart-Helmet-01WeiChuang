// iOS 删 App 不删钥匙串：重装后一打开还是上一次安装时的登录状态、隐私同意、「绑过头盔」等记录——自动登录、
// 不弹同意、不走三步指引，和安卓（卸载即清）不一致（2026-10-16 iPhone 回归发现，10-17 模拟器实测坐实）。
// 负责人 2026-10-17 定：iOS 装好后第一次打开时，把上一次安装留在钥匙串里的条目全部清掉，和安卓一致。
//
// 怎么认出「这次安装第一次打开」：App 自己的文档目录里放一个标记文件——卸载时它和 App 一起被删，钥匙串却留着。
// 标记不在就是新装；从没有这个标记的旧版本升级上来也会被当成新装、登出一次（只影响内部测试包，负责人已知）。
// 先写标记、写成了才清：标记写不进去（存储满了）时宁可这次不清，也不能每次打开都把人登出。
// 系统的「卸载 App 但保留数据」（Offload）文档目录还在，不算新装。
//
// 读钥匙串的地方都要排在这之后：根布局（会话 / 语言 / 外观 / 同意）和开屏（启动记录）先等它；
// 其余条目都在路由挂载之后才读，而路由要等前面那几样读完。
import { File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import { authApi } from "@/api/auth";
import { devLog } from "@/services/dev-log";
import { accountSecureKeysOf, SECURE_KEYS } from "@/services/secure-keys";

/** 文档目录里的标记文件名（内容是写下它的时间，只为排查时看得懂） */
export const INSTALL_MARKER = "install-marker";

let pending: Promise<void> | null = null;

/**
 * 重装后第一次打开时清掉上一次安装留在钥匙串里的条目（只 iOS）。
 * 一个进程只做一次：重复调用拿到同一个结果；不会失败（出错就当这次不清）。
 */
export function clearIfFreshInstall(): Promise<void> {
  pending ??= run().catch((e: unknown) => {
    devLog("INSTALL", "重装检查出错，这次不清", e);
  });
  return pending;
}

async function run(): Promise<void> {
  // 安卓卸载即清：expo-secure-store 的条目不进系统备份，重装后不会被还原
  if (Platform.OS !== "ios") return;
  const marker = new File(Paths.document, INSTALL_MARKER);
  if (marker.exists) return;
  try {
    marker.write(new Date().toISOString());
  } catch (e) {
    devLog("INSTALL", "写不进安装标记，这次不清", e);
    return;
  }
  const read = (key: string) => SecureStore.getItemAsync(key).catch(() => null);
  const [tokens, user, launch, history] = await Promise.all([
    read(SECURE_KEYS.sessionTokens),
    read(SECURE_KEYS.sessionUser),
    read(SECURE_KEYS.launchMemory),
    read(SECURE_KEYS.everHadHelmet),
  ]);
  revokeLeftoverSession(tokens);
  const accounts = accountsIn(user, launch, history);
  const keys = [
    ...Object.values(SECURE_KEYS),
    ...accounts.flatMap(accountSecureKeysOf),
  ];
  devLog(
    "INSTALL",
    `这次安装第一次打开：清掉上一次安装留下的钥匙串条目（${accounts.length} 个账号）`,
  );
  await Promise.all(
    keys.map((key) => SecureStore.deleteItemAsync(key).catch(() => undefined)),
  );
}

const parse = (raw: string | null): unknown => {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined;

/**
 * 上一次安装在本机用过的账号：当时登录着的、最后一次启动的、有过头盔的。
 * 只登过、没绑过头盔、又退出了的账号找不到，它那几条按账号的提示记录（演练入口、开麦说明、换头盔提醒开关）会留下，
 * 只影响这些提示再不再出现。
 */
export function accountsIn(
  rawUser: string | null,
  rawLaunch: string | null,
  rawHistory: string | null,
): string[] {
  const ids: unknown[] = [
    field(parse(rawUser), "id"),
    field(parse(rawLaunch), "userId"),
  ];
  const history = parse(rawHistory);
  if (Array.isArray(history)) ids.push(...(history as unknown[]));
  return [
    ...new Set(
      ids.filter((id): id is string => typeof id === "string" && id !== ""),
    ),
  ];
}

/** 照登出的做法尽力作废上一次安装的 refresh token（不等结果），免得它在服务端再活 30 天 */
function revokeLeftoverSession(rawTokens: string | null): void {
  const refreshToken = field(parse(rawTokens), "refreshToken");
  if (typeof refreshToken !== "string" || refreshToken === "") return;
  try {
    void authApi.logout(refreshToken).catch(() => undefined);
  } catch {
    // 离线也照样清本机
  }
}
