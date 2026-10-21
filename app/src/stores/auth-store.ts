// 会话 store（Zustand）：内存态 + SecureStore 持久化（token 属敏感凭据，不进 AsyncStorage）
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import type { AuthResponse, AuthTokens, UserProfile } from "@helmet/shared";
import { attachSession } from "@/api/client";
import { authApi } from "@/api/auth";
import { countdownHoldUntil } from "@/services/countdown-hold";
import { SECURE_KEYS } from "@/services/secure-keys";

const TOKEN_KEY = SECURE_KEYS.sessionTokens;
/** 钥匙串可访问性：默认 WHEN_UNLOCKED 在锁屏时写入会抛 "User interaction is not allowed"
 *  （2026-09-16 iPhone 锁屏 BLE 中转实测：后台刷新 token 后持久化失败，冷启动即掉登录）。
 *  改为首次解锁后即可读写，后台/锁屏期间的 token 轮换才能落盘。 */
const KEYCHAIN = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };
const USER_KEY = SECURE_KEYS.sessionUser;

/** SecureStore 只存最小档案:iOS 钥匙串单值上限 2KB,data-URI 头像(≈20KB)绝不能入;
 *  完整档案(含头像)启动后由 /users/me 拉取进内存。 */
const toPersistable = (user: UserProfile): UserProfile => ({
  ...user,
  avatarUrl: null,
});

type AuthState = {
  /** SecureStore 读取完成前为 false，路由门控需等它 */
  hydrated: boolean;
  tokens: AuthTokens | null;
  user: UserProfile | null;
  /**
   * 会话是被服务端否定而结束的（不是用户自己退出）：登录页据此说明原因，_layout 据此发本地通知。
   * 只在内存里，重新登录即清。见 services/session-notice.ts。
   */
  sessionExpired: boolean;
  /**
   * 会话已被服务端否定，但倒计时页在屏、这单还在倒数，先不登出（O19-A）：到这一刻（本机时钟）再真正清会话。
   * 期间接口在本地直接按「会话已结束」拒掉，不再去刷新；倒计时页据此把取消改成「重新登录后取消」
   */
  sessionDeadUntil: number | null;
  /** 真正登出时倒计时已经走完（O19-A）：登录页多说一句「如果没在别处取消，紧急联系人已收到通知」 */
  expiredDuringSos: boolean;
  /** 倒计时页上点「重新登录后取消」：不等倒数结束，现在就回登录页 */
  endDeadSession: () => Promise<void>;
  hydrate: () => Promise<void>;
  signIn: (auth: AuthResponse) => Promise<void>;
  signOut: () => Promise<void>;
  /** 只清本地会话，不通知服务端——账号已注销 / 服务端已作废会话时用 */
  dropSession: () => Promise<void>;
  setUser: (user: UserProfile) => Promise<void>;
  /**
   * 重新拉一次本人档案。会话里的 user 原来只在冷启动时补拉一次：别的手机改了昵称 / 头像，
   * 这台一直显示旧的，编辑资料时还拿旧值当初值（2026-10-16 华为实测）。失败静默（401 由 api 层处理）。
   */
  refreshUser: () => Promise<void>;
};

export const useAuthStore = create<AuthState>((set, get) => ({
  hydrated: false,
  tokens: null,
  user: null,
  sessionExpired: false,
  sessionDeadUntil: null,
  expiredDuringSos: false,

  endDeadSession: async () => {
    if (get().sessionDeadUntil === null) return;
    await clearLocalSession({ duringSos: false });
  },

  hydrate: async () => {
    try {
      const [rawTokens, rawUser] = await Promise.all([
        SecureStore.getItemAsync(TOKEN_KEY),
        SecureStore.getItemAsync(USER_KEY),
      ]);
      const tokens = rawTokens ? (JSON.parse(rawTokens) as AuthTokens) : null;
      set({
        tokens,
        user: rawUser ? (JSON.parse(rawUser) as UserProfile) : null,
        hydrated: true,
      });
      // 后台补拉全量档案(含头像);失败不影响启动,401 由 api 层刷新/清理
      if (tokens) {
        authApi
          .me()
          .then((full) => {
            // 请求在途时会话可能已经没了或换了人（登出、登出后登录另一个账号）：
            // 这份档案属于发起请求时的那个会话，落下去就是 token 是 B 的、user 是 A 的
            const now = get();
            if (!now.tokens) return;
            if (now.user && now.user.id !== full.id) return;
            set({ user: full });
          })
          .catch(() => undefined);
      }
    } catch {
      // 存储损坏按未登录处理，不阻塞启动
      set({ tokens: null, user: null, hydrated: true });
    }
  },

  signIn: async (auth) => {
    set({
      tokens: {
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
      },
      user: auth.user,
      sessionExpired: false,
      sessionDeadUntil: null,
      expiredDuringSos: false,
    });
    cancelDeadTimer();
    await Promise.all([
      SecureStore.setItemAsync(
        TOKEN_KEY,
        JSON.stringify({
          accessToken: auth.accessToken,
          refreshToken: auth.refreshToken,
        }),
        KEYCHAIN,
      ),
      SecureStore.setItemAsync(
        USER_KEY,
        JSON.stringify(toPersistable(auth.user)),
        KEYCHAIN,
      ),
    ]);
  },

  signOut: async () => {
    const refreshToken = get().tokens?.refreshToken;
    // 尽力作废服务端 refreshToken，但不等它：/auth/logout 是公开接口（不带 access token），不需要本地会话还在。
    // 原来先 await 作废请求再清本地，服务端连不上时要等请求超时（约 19 秒）才回到登录页（2026-10-16 模拟器）
    if (refreshToken) {
      try {
        void authApi.logout(refreshToken).catch(() => undefined);
      } catch {
        /* 离线登出允许 */
      }
    }
    await get().dropSession();
  },

  dropSession: async () => {
    cancelDeadTimer();
    set({
      tokens: null,
      user: null,
      sessionExpired: false,
      sessionDeadUntil: null,
      expiredDuringSos: false,
    });
    await Promise.all([
      SecureStore.deleteItemAsync(TOKEN_KEY),
      SecureStore.deleteItemAsync(USER_KEY),
    ]);
  },

  setUser: async (user) => {
    set({ user });
    await SecureStore.setItemAsync(
      USER_KEY,
      JSON.stringify(toPersistable(user)),
      KEYCHAIN,
    );
  },

  refreshUser: async () => {
    if (!get().tokens) return;
    let full: UserProfile;
    try {
      full = await authApi.me();
    } catch {
      return;
    }
    // 同 hydrate：请求在途时登出了、或换成了另一个账号，这份档案就不落
    const now = get();
    if (!now.tokens) return;
    if (now.user && now.user.id !== full.id) return;
    await get()
      .setUser(full)
      .catch(() => undefined);
  },
}));

/**
 * 两个相邻状态之间是不是「换了一个账号」：两边都有用户档案且 id 不同。
 * 档案从无到有（冷启动只有 token、/users/me 之后才有 user）不算——那时清缓存会把刚拉好的设备列表等全丢掉。
 */
export function accountSwitched(
  prevUserId: string | undefined,
  nextUserId: string | undefined,
): boolean {
  return (
    prevUserId !== undefined &&
    nextUserId !== undefined &&
    prevUserId !== nextUserId
  );
}

// api 层回调注入：token 读取、刷新轮换后的持久化、会话失效清理
/** 倒数结束后再真正登出的定时器（O19-A） */
let deadTimer: ReturnType<typeof setTimeout> | null = null;
const cancelDeadTimer = (): void => {
  if (deadTimer) clearTimeout(deadTimer);
  deadTimer = null;
};
/** 倒数结束后多留几秒：服务端到点终态化、页面最后一次刷新都在这几秒里 */
const DEAD_SESSION_GRACE_MS = 3_000;

/** 真正清掉本地会话（被动登出）。duringSos：倒计时走完才清的，登录页多说一句 */
async function clearLocalSession(opts: { duringSos: boolean }): Promise<void> {
  cancelDeadTimer();
  // 原本登录着才算「被动登出」；本来就没登录时收到的 401 不算
  const wasSignedIn = useAuthStore.getState().tokens !== null;
  useAuthStore.setState({
    tokens: null,
    user: null,
    sessionDeadUntil: null,
    expiredDuringSos: wasSignedIn && opts.duringSos,
    ...(wasSignedIn ? { sessionExpired: true } : {}),
  });
  await Promise.all([
    SecureStore.deleteItemAsync(TOKEN_KEY),
    SecureStore.deleteItemAsync(USER_KEY),
  ]);
}

attachSession({
  getTokens: () => useAuthStore.getState().tokens,
  isDead: () => useAuthStore.getState().sessionDeadUntil !== null,
  setTokens: async (tokens) => {
    useAuthStore.setState({ tokens });
    await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(tokens), KEYCHAIN);
  },
  clearSession: async () => {
    const state = useAuthStore.getState();
    // 倒计时页在屏、这单还在倒数：先不登出，倒数结束（多留几秒）再清（负责人 10-21 定，O19-A）。
    // 已经在等的再来一次（实时通道、轮询各撞一次 401）：什么都不用做
    if (state.sessionDeadUntil !== null) return;
    const until = state.tokens !== null ? countdownHoldUntil() : null;
    if (until !== null) {
      useAuthStore.setState({ sessionDeadUntil: until });
      deadTimer = setTimeout(
        () => void clearLocalSession({ duringSos: true }),
        until - Date.now() + DEAD_SESSION_GRACE_MS,
      );
      return;
    }
    await clearLocalSession({ duringSos: false });
  },
});
