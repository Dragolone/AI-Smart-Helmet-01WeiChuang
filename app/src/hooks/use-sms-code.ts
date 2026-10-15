// 短信验证码的「发送 + 重发倒计时」：注册 / 找回密码 / 换手机号三页共用（2026-10-07 合并，此前各写一份）。
// 页面只管校验手机号、把错误落到字段上；这里只管发请求和限频读秒。
import { useEffect, useState } from "react";

import { authApi, type SmsCodePurpose } from "@/api/auth";

/** 与后端 SMS_CODE_RESEND_INTERVAL_SECONDS 默认一致；超前点击由服务端 429 兜底 */
export const RESEND_SECONDS = 60;
/** 大陆手机号：1 开头、第二位 3–9、共 11 位 */
export const PHONE_PATTERN = /^1[3-9]\d{9}$/;
export const isValidPhone = (value: string): boolean =>
  PHONE_PATTERN.test(value.trim());

/** 号码里可以直接去掉的分隔符：空白、各种横线（半角 / 全角 / 连字符 / 破折号 / 减号）、半角与全角括号 */
const PHONE_SEPARATORS = /[\s\-\u2010-\u2015\u2212\uFF0D()（）]/g;
/**
 * 复制时夹带的看不见的字符：iOS 通讯录复制号码会在首尾带方向标记（U+202D … U+202C），
 * 聊天软件里常夹零宽空格 / BOM
 */
const PHONE_INVISIBLE =
  /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

/**
 * 从通讯录 / 聊天里复制来的号码常带空格、横线、括号或 +86 / 0086 前缀（「+86 138-0000-0000」）：
 * 去掉这些再交给 isValidPhone。只认大陆手机号，去掉前缀后不是 11 位就原样留着（照样不合法）。
 * 中文输入法全角状态下打出的数字和加号（「１３８…」「＋８６」）先换成半角。
 */
export function normalizePhone(value: string): string {
  const digits = value
    .replace(/[\uFF10-\uFF19\uFF0B]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0),
    )
    .replace(PHONE_INVISIBLE, "")
    .replace(PHONE_SEPARATORS, "");
  const m = /^(?:\+86|0086|86)(\d{11})$/.exec(digits);
  return m ? m[1] : digits;
}

/**
 * 重发还要等几秒（截止时间戳 − 此刻，向上取整，不为负）。
 * 比一整轮还长只可能是发完之后手机时间被往回拨了：读秒作废，不然「重发」要灰到时间追回来（拨回一小时就灰一小时），
 * 提前点了由服务端 429 兜底
 */
export const resendCooldown = (cooldownUntil: number, now: number): number => {
  const left = Math.ceil((cooldownUntil - now) / 1000);
  return left > RESEND_SECONDS ? 0 : Math.max(0, left);
};

export function useSmsCode(purpose: SmsCodePurpose): {
  /** 请求在途 */
  sending: boolean;
  /** 还要等几秒才能重发；0 = 可发 */
  cooldown: number;
  /** 发送按钮该不该禁用 */
  disabled: boolean;
  /** 发一条；手机号由调用方先校验。失败直接抛，由页面决定落到哪个字段 */
  send: (phone: string) => Promise<void>;
} {
  const [sending, setSending] = useState(false);
  /** 重发限频用截止时间戳 + 墙钟计算剩余——递减 state 在 App 退后台时定时器
   *  被 iOS 暂停,回前台倒计时冻在原地(2026-09-10 真机实证);按墙钟算则
   *  回前台首个 tick 即校准。同 sos-active 倒计时的口径。 */
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const cooldown = resendCooldown(cooldownUntil, now);

  useEffect(() => {
    if (resendCooldown(cooldownUntil, now) === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [cooldownUntil, now]);

  const send = async (phone: string): Promise<void> => {
    setSending(true);
    try {
      await authApi.sendSmsCode({ phone: phone.trim(), purpose });
      const sentAt = Date.now();
      setNow(sentAt);
      setCooldownUntil(sentAt + RESEND_SECONDS * 1000);
    } finally {
      setSending(false);
    }
  };

  return { sending, cooldown, disabled: sending || cooldown > 0, send };
}
