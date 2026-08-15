import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
/** 标记接口跳过全局 JWT 守卫（health、auth 入口等）。 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
