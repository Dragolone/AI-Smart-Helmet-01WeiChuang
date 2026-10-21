import type { NextFunction, Request, Response } from 'express';

/**
 * 接口应答一律 `Cache-Control: no-store`（API.md §1；上线清单 B 线 22，10-22 夜测）：安卓 RN 的 OkHttp 带磁盘缓存，
 * 手机时间往回拨后会把旧应答当新鲜用——倒计时页拿到的是过期的求救状态；iOS 的 NSURLCache、管理后台的浏览器同理。
 * App 端 #381 已在请求上带 no-store，这里是服务端的另一半：没带那个头的旧包、浏览器、第三方都不缓存。
 * 在路由匹配之前就设头，所以 401 / 404 / 400 这些由守卫、过滤器写出的应答也带。
 */
export function noStoreMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader('Cache-Control', 'no-store');
  next();
}
