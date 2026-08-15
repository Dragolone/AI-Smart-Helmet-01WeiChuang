/**
 * Admin JWT 与 App 用户 JWT 用不同密钥（API.md §10：独立于 App 用户体系）。
 * 密钥隔离使两套 token 互不可用，无需在守卫里做角色分支。
 */
export const ADMIN_JWT_SECRET = 'ADMIN_JWT_SECRET';

/** admin token 12 小时；后台无 refresh，过期重新登录（API.md §10 定稿） */
export const ADMIN_TOKEN_TTL = '12h';

export const adminJwtSecretProvider = {
  provide: ADMIN_JWT_SECRET,
  useFactory: (): string => {
    const secret = process.env.ADMIN_JWT_SECRET;
    if (!secret) {
      throw new Error(
        'ADMIN_JWT_SECRET 未设置：请检查 backend/.env（参照 backend/.env.example）',
      );
    }
    return secret;
  },
};
