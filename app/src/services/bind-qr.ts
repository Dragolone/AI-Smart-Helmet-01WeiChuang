// 绑定二维码解析（DEVICE_PROTOCOL §11）：头盔/说明卡印的码，扫到后预填设备号 + 绑定码。
// 三种形式都认：① https://01weichuang.com/bind?d=<deviceId>&c=<code>（微信/系统相机扫也能落网页）
// ② helmet://bind?d=&c=  ③ 裸 deviceId（旧批次只印编号，绑定码手输）。deviceId 规则同 DEVICE_PROTOCOL。
export interface BindQr {
  deviceId: string;
  bindCode: string | null;
}

const DEVICE_ID_RE = /^[a-z0-9_-]{4,64}$/i;
const CODE_RE = /^\d{8}$/;

export function parseBindQr(raw: string): BindQr | null {
  const text = raw.trim();
  if (!text) return null;
  // bind 后面允许多一个斜杠：出码脚本的 --qr-base 是可配的，写成 …/bind/ 时整批码都是 …/bind/?d=…，
  // 原来一张都扫不出来（只能手输）
  const m =
    /^(?:https?:\/\/[^/]*01weichuang\.com\/bind|helmet:\/\/bind)\/?\??(.*)$/i.exec(
      text,
    );
  if (m) {
    const params = new URLSearchParams(m[1]);
    const deviceId = (params.get("d") ?? params.get("deviceId") ?? "").trim();
    const code = (params.get("c") ?? params.get("code") ?? "").trim();
    if (!DEVICE_ID_RE.test(deviceId)) return null;
    return { deviceId, bindCode: CODE_RE.test(code) ? code : null };
  }
  if (DEVICE_ID_RE.test(text)) return { deviceId: text, bindCode: null };
  return null;
}

/** 扫到一个码之后该怎么办（绑定页用） */
export type ScanOutcome =
  /** 设备号、绑定码都在码里：直接绑 */
  | { kind: "bind"; deviceId: string; bindCode: string }
  /** 旧批次只印了设备号：绑定码要手输 */
  | { kind: "needCode"; deviceId: string }
  /** 这次进绑定页刚绑上的那一顶，码还留在镜头里 */
  | { kind: "alreadyBound"; deviceId: string }
  /** 不是绑定二维码 */
  | { kind: "notBindCode" };

/**
 * @param boundThisVisit 这次进绑定页已经绑上的设备号。只认这一小撮，不拿设备列表来挡：
 *   列表可能是旧的（在别的手机上解绑了），绑不绑得上以服务器的回答为准。
 */
export function classifyScan(
  raw: string,
  boundThisVisit: ReadonlySet<string>,
): ScanOutcome {
  const parsed = parseBindQr(raw);
  if (!parsed) return { kind: "notBindCode" };
  if (boundThisVisit.has(parsed.deviceId)) {
    return { kind: "alreadyBound", deviceId: parsed.deviceId };
  }
  return parsed.bindCode
    ? { kind: "bind", deviceId: parsed.deviceId, bindCode: parsed.bindCode }
    : { kind: "needCode", deviceId: parsed.deviceId };
}

/**
 * 手动输入框里粘进来的是一条绑定链接（微信 / 系统相机扫码会落到网页，用户把那条链接复制过来）时，
 * 把里面的设备号和绑定码拆出来；粘的不是链接（就是设备号本身、或别的文字）返回 null，输入框照原样显示。
 */
export function bindLinkInManualInput(raw: string): BindQr | null {
  if (!/^\s*(?:https?:\/\/|helmet:\/\/)/i.test(raw)) return null;
  return parseBindQr(raw);
}

/** 全角 ASCII（中文输入法全角状态打出的字母、数字、下划线、横线）换成半角 */
const toHalfWidth = (s: string) =>
  s.replace(/[\uFF01-\uFF5E]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0),
  );
/** 复制时夹带的看不见的字符：零宽空格 / 连接符、方向标记与嵌入、BOM */
const COPIED_INVISIBLE =
  /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

/**
 * 手输的设备号：全角换半角、去掉看不见的字符、去掉首尾空白。
 * 中文输入法全角状态打出的「ｈｅｌｍｅｔ＿００１」、从聊天里复制夹带零宽字符的设备号，
 * 原来原样提交，服务端判「deviceId 格式不正确」，用户只看到「输入格式不正确」。
 */
export function normalizeManualDeviceId(raw: string): string {
  return toHalfWidth(raw).replace(COPIED_INVISIBLE, "").trim();
}

/**
 * 手输的绑定码：全角数字换半角，去掉空白、横线和看不见的字符。
 * 说明卡上 8 位码常按「1234 5678」分组印、复制来的带横线，原来输入框卡 8 位，粘进来被截成「1234 567」，
 * 提交后是「绑定码不正确」——还白占一次限频（同 IP 10 次 / 分）。
 */
export function normalizeManualBindCode(raw: string): string {
  return toHalfWidth(raw)
    .replace(COPIED_INVISIBLE, "")
    .replace(/[\s\-\u2010-\u2015\u2212]/g, "");
}

/** 绑定码输入框的长度上限：8 位码加分组用的空格 / 横线（「1234 5678」「12 34 56 78」）留到 12 */
export const BIND_CODE_INPUT_MAX = 12;
