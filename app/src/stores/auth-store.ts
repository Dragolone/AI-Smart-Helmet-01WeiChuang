// 会话 store（Zustand）：内存态 + SecureStore 持久化（token 属敏感凭据，不进 AsyncStorage）
import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';
import type { AuthResponse, AuthTokens, UserProfile } from '@helmet/shared';
import { attachSession } from '@/api/client';
import { authApi } from '@/api/auth';

const TOKEN_KEY = 'helmet.session.tokens';
const USER_KEY = 'helmet.session.user';

type AuthState = {
  /** SecureStore 读取完成前为 false，路由门控需等它 */
  hydrated: boolean;
  tokens: AuthTokens | null;
  user: UserProfile | null;
  hydrate: () => Promise<void>;
  signIn: (auth: AuthResponse) => Promise<void>;
  signOut: () => Promise<void>;
  setUser: (user: UserProfile) => Promise<void>;
};

export const useAuthStore = create<AuthState>((set, get) => ({
  hydrated: false,
  tokens: null,
  user: null,

  hydrate: async () => {
    try {
      const [rawTokens, rawUser] = await Promise.all([
        SecureStore.getItemAsync(TOKEN_KEY),
        SecureStore.getItemAsync(USER_KEY),
      ]);
      set({
        tokens: rawTokens ? (JSON.parse(rawTokens) as AuthTokens) : null,
        user: rawUser ? (JSON.parse(rawUser) as UserProfile) : null,
        hydrated: true,
      });
    } catch {
      // 存储损坏按未登录处理，不阻塞启动
      set({ tokens: null, user: null, hydrated: true });
    }
  },

  signIn: async (auth) => {
    set({
      tokens: { accessToken: auth.accessToken, refreshToken: auth.refreshToken },
      user: auth.user,
    });
    await Promise.all([
      SecureStore.setItemAsync(
        TOKEN_KEY,
        JSON.stringify({
          accessToken: auth.accessToken,
          refreshToken: auth.refreshToken,
        }),
      ),
      SecureStore.setItemAsync(USER_KEY, JSON.stringify(auth.user)),
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
    set({ tokens: null, user: null });
    await Promise.all([
      SecureStore.deleteItemAsync(TOKEN_KEY),
      SecureStore.deleteItemAsync(USER_KEY),
    ]);
  },

  setUser: async (user) => {
    set({ user });
    await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
  },
}));

// api 层回调注入：token 读取、刷新轮换后的持久化、会话失效清理
attachSession({
  getTokens: () => useAuthStore.getState().tokens,
  setTokens: async (tokens) => {
    useAuthStore.setState({ tokens });
    await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(tokens));
  },
  clearSession: async () => {
    useAuthStore.setState({ tokens: null, user: null });
    await Promise.all([
      SecureStore.deleteItemAsync(TOKEN_KEY),
      SecureStore.deleteItemAsync(USER_KEY),
    ]);
  },
});
