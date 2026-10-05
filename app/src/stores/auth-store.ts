// 会话 store（Zustand）：内存态 + SecureStore 持久化（token 属敏感凭据，不进 AsyncStorage）
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import type { AuthResponse, AuthTokens, UserProfile } from "@helmet/shared";
import { attachSession } from "@/api/client";
import { authApi } from "@/api/auth";

const TOKEN_KEY = "helmet.session.tokens";
/** 钥匙串可访问性：默认 WHEN_UNLOCKED 在锁屏时写入会抛 "User interaction is not allowed"
 *  （2026-09-16 iPhone 锁屏 BLE 中转实测：后台刷新 token 后持久化失败，冷启动即掉登录）。
 *  改为首次解锁后即可读写，后台/锁屏期间的 token 轮换才能落盘。 */
const KEYCHAIN = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };
const USER_KEY = "helmet.session.user";

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
  hydrate: () => Promise<void>;
  signIn: (auth: AuthResponse) => Promise<void>;
  signOut: () => Promise<void>;
  /** 只清本地会话，不通知服务端——账号已注销 / 服务端已作废会话时用 */
  dropSession: () => Promise<void>;
  setUser: (user: UserProfile) => Promise<void>;
};

export const useAuthStore = create<AuthState>((set, get) => ({
  hydrated: false,
  tokens: null,
  user: null,
  sessionExpired: false,

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
    });
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
    const tokens = get().tokens;
    // 尽力作废服务端 refreshToken；失败（如离线）不阻塞本地登出
    if (tokens) {
      try {
        await authApi.logout(tokens.refreshToken);
      } catch {
        /* 离线登出允许 */
      }
    }
    await get().dropSession();
  },

  dropSession: async () => {
    set({ tokens: null, user: null, sessionExpired: false });
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
}));

// api 层回调注入：token 读取、刷新轮换后的持久化、会话失效清理
attachSession({
  getTokens: () => useAuthStore.getState().tokens,
  setTokens: async (tokens) => {
    useAuthStore.setState({ tokens });
    await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(tokens), KEYCHAIN);
  },
  clearSession: async () => {
    // 原本登录着才算「被动登出」；本来就没登录时收到的 401 不算
    const wasSignedIn = useAuthStore.getState().tokens !== null;
    useAuthStore.setState({
      tokens: null,
      user: null,
      ...(wasSignedIn ? { sessionExpired: true } : {}),
    });
    await Promise.all([
      SecureStore.deleteItemAsync(TOKEN_KEY),
      SecureStore.deleteItemAsync(USER_KEY),
    ]);
  },
});
