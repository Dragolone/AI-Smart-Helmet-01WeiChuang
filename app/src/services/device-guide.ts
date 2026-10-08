// 设备页还没绑定头盔时的三步指引（纯函数）：绑定头盔并连上 → 允许通知 → 添加紧急联系人。
// 和「防护是否就绪」是同一套三项（services/safety-status 的 protectionStateOf），顺序先头盔后安全。
// 每张卡写什么、按钮做什么、哪张卡会自己打勾翻过去，都在这里；界面在 components/device-guide。
// 逻辑 2026-10-08 负责人确认（改版原型「设备页 · 未绑定」画板）。
//
// 三步只给从没绑过头盔的账号走一遍。绑过又解绑的（bindOnly）只有绑定那一张，绑上就是设备页——
// 负责人 2026-10-08：「解绑了头盔又重新开始未绑定页，应该判定是否为新用户第一次打开」。
// 「绑过没有」记在本机（stores/helmet-history-store）。
import type { MessageKey, Params } from "@/i18n";
import type { HelmetLink, NotifyPermission } from "@/services/safety-status";
import type { BleLinkPhase } from "@/stores/ble-store";

/** 一件事的结果："" 还没处理；done 做完了；skipped 点了「稍后」 */
export type GuideResult = "" | "done" | "skipped";
export type GuideState = { r1: GuideResult; r2: GuideResult; r3: GuideResult };
export const GUIDE_FRESH: GuideState = { r1: "", r2: "", r3: "" };

export type GuideFacts = {
  /** 当前头盔的连接结论；null = 还没绑定 */
  link: HelmetLink | null;
  /** 这台手机和它的蓝牙链路走到哪一步（搜索时的细分文案用） */
  phase?: BleLinkPhase;
  helmet?: { name: string; battery: number | null };
  /** 通知权限；null = 还没查到 */
  notify: NotifyPermission | null;
  /** 紧急联系人数量；null = 列表还没拿到 */
  contacts: number | null;
  /** 搜索头盔已经超过 SEARCH_SLOW_MS 还没连上 */
  slow: boolean;
};

export type GuideAction =
  | "scan"
  | "manual"
  | "openBluetooth"
  | "openAppSettings"
  | "askNotify"
  | "addContact"
  | "skip";

type Text = { key: MessageKey; params?: Params };
export type GuideCard = {
  step: 1 | 2 | 3;
  /** 卡片压在后面时露出来的那一行 */
  strip: MessageKey;
  chip: { text: Text; tone: "neutral" | "good" | "amber" };
  title: MessageKey;
  body: Text;
  /** 主按钮和状态条二选一 */
  primary?: {
    label: MessageKey;
    icon: "scan" | "bluetooth" | "bell" | "person";
    action: GuideAction;
  };
  status?: { text: Text; tone: "busy" | "ok" };
  link?: { label: MessageKey; action: GuideAction };
  /** 正在搜索头盔：徽标上有一圈圈往外扩的波纹 */
  ripple: boolean;
};

/** 搜索多久还没找到就换一句提示 */
export const SEARCH_SLOW_MS = 5000;
/** 一件事做完后，卡片停多久再翻到下一张 */
export const TICK_MS = 1000;
/** 三件都处理完后，停多久开始变成设备页 */
export const FINISH_MS = 760;

/** 现在轮到第几件；0 = 都处理完了。bindOnly：这一次只有绑定头盔那一件 */
export function guideCurrent(s: GuideState, bindOnly = false): 0 | 1 | 2 | 3 {
  if (!s.r1) return 1;
  if (bindOnly) return 0;
  if (!s.r2) return 2;
  if (!s.r3) return 3;
  return 0;
}

const linked = (link: HelmetLink | null) =>
  link === "connected" || link === "online";

/**
 * 轮到的那件事是不是已经具备了（会自己打勾翻过去）。
 * 通知、联系人只有查到了才算：还没查到（null）不能当成已经有。
 */
export function guideAutoDone(
  s: GuideState,
  f: GuideFacts,
  bindOnly = false,
): 0 | 1 | 2 | 3 {
  const cur = guideCurrent(s, bindOnly);
  if (cur === 1 && linked(f.link)) return 1;
  if (cur === 2 && f.notify === "granted") return 2;
  if (cur === 3 && f.contacts !== null && f.contacts >= 1) return 3;
  return 0;
}

function helmetCard(f: GuideFacts): GuideCard {
  const base = {
    step: 1 as const,
    strip: "guide.helmet.strip" as const,
    ripple: false,
  };
  if (f.link === null)
    return {
      ...base,
      chip: { text: { key: "guide.helmet.chipNo" }, tone: "neutral" },
      title: "guide.helmet.bindTitle",
      body: { key: "guide.helmet.bindBody" },
      primary: { label: "guide.helmet.scan", icon: "scan", action: "scan" },
      link: { label: "guide.helmet.manual", action: "manual" },
    };
  const chip = {
    text: { key: "guide.helmet.chipYes" as const },
    tone: "good" as const,
  };
  const later = {
    label: "guide.helmet.laterLink" as const,
    action: "skip" as const,
  };
  if (linked(f.link))
    return {
      ...base,
      chip,
      title: "guide.helmet.linkedTitle",
      body:
        f.helmet && f.helmet.battery !== null
          ? {
              key: "guide.helmet.linkedBody",
              params: { name: f.helmet.name, battery: f.helmet.battery },
            }
          : { key: "guide.helmet.linked" },
      status: { text: { key: "guide.helmet.linked" }, tone: "ok" },
    };
  // 手机蓝牙关着、没给权限，都是这张卡里的提示，不单独算一步
  if (f.link === "bluetoothOff")
    return {
      ...base,
      chip,
      title: "guide.helmet.btOffTitle",
      body: { key: "guide.helmet.btOffBody" },
      primary: {
        label: "guide.helmet.btOffAction",
        icon: "bluetooth",
        action: "openBluetooth",
      },
      link: later,
    };
  if (f.link === "bluetoothDenied")
    return {
      ...base,
      chip,
      title: "guide.helmet.btDeniedTitle",
      body: { key: "guide.helmet.btDeniedBody" },
      primary: {
        label: "guide.helmet.btDeniedAction",
        icon: "bluetooth",
        action: "openAppSettings",
      },
      link: later,
    };
  return {
    ...base,
    chip,
    title: "guide.helmet.searchTitle",
    body: {
      key:
        f.link === "mismatch"
          ? "guide.helmet.mismatchBody"
          : f.slow
            ? "guide.helmet.searchSlow"
            : "guide.helmet.searchBody",
    },
    status: {
      text: {
        key:
          f.phase === "connecting"
            ? "guide.helmet.connecting"
            : f.phase === "handshaking"
              ? "guide.helmet.handshaking"
              : "guide.helmet.searching",
      },
      tone: "busy",
    },
    link: later,
    ripple: true,
  };
}

function notifyCard(f: GuideFacts): GuideCard {
  const base = {
    step: 2 as const,
    strip: "guide.notify.strip" as const,
    title: "guide.notify.title" as const,
    ripple: false,
  };
  const later = { label: "guide.later" as const, action: "skip" as const };
  if (f.notify === "granted")
    return {
      ...base,
      chip: { text: { key: "guide.notify.chipYes" }, tone: "good" },
      body: { key: "guide.notify.body" },
      status: { text: { key: "guide.notify.on" }, tone: "ok" },
    };
  // 之前拒绝过：系统不会再弹窗，只能去设置里开
  if (f.notify === "denied")
    return {
      ...base,
      chip: { text: { key: "guide.notify.chipOff" }, tone: "amber" },
      body: { key: "guide.notify.deniedBody" },
      primary: {
        label: "guide.notify.openSettings",
        icon: "bell",
        action: "openAppSettings",
      },
      link: later,
    };
  return {
    ...base,
    chip: { text: { key: "guide.notify.chipNo" }, tone: "neutral" },
    body: { key: "guide.notify.body" },
    primary: { label: "guide.notify.allow", icon: "bell", action: "askNotify" },
    link: later,
  };
}

function contactCard(f: GuideFacts): GuideCard {
  const base = {
    step: 3 as const,
    strip: "guide.contact.strip" as const,
    title: "guide.contact.title" as const,
    body: { key: "guide.contact.body" as const },
    ripple: false,
  };
  if (f.contacts !== null && f.contacts >= 1)
    return {
      ...base,
      chip: {
        text: { key: "guide.contact.chipYes", params: { n: f.contacts } },
        tone: "good",
      },
      status: {
        text: { key: "guide.contact.have", params: { n: f.contacts } },
        tone: "ok",
      },
    };
  return {
    ...base,
    chip: { text: { key: "guide.contact.chipNo" }, tone: "neutral" },
    primary: {
      label: "guide.contact.add",
      icon: "person",
      action: "addContact",
    },
    link: { label: "guide.later", action: "skip" },
  };
}

export function guideCards(f: GuideFacts): [GuideCard, GuideCard, GuideCard] {
  return [helmetCard(f), notifyCard(f), contactCard(f)];
}

export type GuideSegment = {
  label: MessageKey;
  tone: "done" | "skipped" | "current" | "todo";
};
/** 下面那条进度：一件事一格 */
export function guideSegments(s: GuideState): GuideSegment[] {
  const cur = guideCurrent(s);
  const labels: MessageKey[] = [
    "guide.seg.helmet",
    "guide.seg.notify",
    "guide.seg.contact",
  ];
  return [s.r1, s.r2, s.r3].map((r, i) => ({
    label: labels[i],
    tone:
      r === "done"
        ? "done"
        : r === "skipped"
          ? "skipped"
          : cur === i + 1
            ? "current"
            : "todo",
  }));
}

export const guideDoneCount = (s: GuideState) =>
  [s.r1, s.r2, s.r3].filter((r) => r === "done").length;
