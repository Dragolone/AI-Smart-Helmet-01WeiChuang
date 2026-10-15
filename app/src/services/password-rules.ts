// 密码长度上限的口径（与后端 auth.dto 同一条线）：bcrypt 只看前 72 **字节**，后端按 UTF-8 字节数挡，超出回 400。
// App 原来注册 / 找回密码页不查上限、改密码页按字符数查——中文或长口令在本地过了检查，提交后只得到一句笼统的
// 「输入格式不正确」。这里按字节算，和服务端同口径。

export const PASSWORD_MAX_BYTES = 72;

/** 字符串按 UTF-8 编码的字节数（不依赖 TextEncoder：按码点直接数） */
export function utf8ByteLength(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

/** 新密码是否超过服务端上限（72 字节） */
export const isPasswordTooLong = (password: string): boolean =>
  utf8ByteLength(password) > PASSWORD_MAX_BYTES;
