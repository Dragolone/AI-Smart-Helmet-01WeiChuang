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
  const m =
    /^(?:https?:\/\/[^/]*01weichuang\.com\/bind|helmet:\/\/bind)\??(.*)$/i.exec(
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
