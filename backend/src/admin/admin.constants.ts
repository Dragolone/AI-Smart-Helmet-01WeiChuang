import { Logger } from '@nestjs/common';

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
    if (secret === process.env.JWT_SECRET) {
      // 不在这里抛：守卫两侧都有 typ 双保险，误配不致越权；但必须让运维在启动日志里一眼看到
      new Logger('AdminModule').error(
        'ADMIN_JWT_SECRET 与 JWT_SECRET 相同：两套 token 失去密钥隔离，请立即改为不同的强随机值（deploy/.env.example）',
      );
    }
    return secret;
  },
};
