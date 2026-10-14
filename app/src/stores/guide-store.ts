// 设备页三步指引（绑定头盔 → 允许通知 → 紧急联系人）这一次走到哪了。
// 只在这次运行里记着，不落盘：指引从「账号下一台头盔都没有」开始，头盔绑上之后接着做后两件，
// 三件都处理完（做了或点了稍后）就结束，页面变成平常的设备页。中途杀掉 App 再进来，账号下已经有
// 头盔了，直接是设备页——没做完的那两件由「安全」那一格继续提醒，不再回到指引。
import { create } from "zustand";

import {
  GUIDE_FRESH,
  type GuideResult,
  type GuideState,
} from "@/services/device-guide";

type GuideStore = {
  /** 指引是给哪位用户开的；换了账号要重来 */
  userId: string | null;
  /** 指引进行中：设备页显示三张卡，而不是头盔大图 */
  active: boolean;
  state: GuideState;
  /** 这一次只有绑定头盔那一件（这个账号以前绑过头盔，三步已经走过了） */
  bindOnly: boolean;
  /**
   * 上一件事是什么时候处理完的（Date.now()）；0 = 还一件都没处理。
   * 页面用它算下一件的内容浮上来到位了没有：到位之后才开始画勾（components/device-guide）。
   */
  markedAt: number;
  begin: (userId: string, bindOnly?: boolean) => void;
  mark: (step: 1 | 2 | 3, result: Exclude<GuideResult, "">) => void;
  /**
   * 三件都处理完：页面变成设备页，同时播一段衔接（最后那张卡的边收成电量环，徽标回到环中间）。
   * from 是那张卡和徽标此刻在窗口里的位置；量不到就给 null，页面直接换过去、不播衔接。
   */
  finish: (from: GuideHandoverFrom | null) => void;
  /** 衔接正在播（components/splash/guide-handover 在画）；播完清掉 */
  handover: GuideHandoverFrom | null;
  /**
   * 三件刚处理完、还没换页面的那不到一秒：让衔接那一层先搭起来、把图读好，
   * 换页面的那一帧它才能立刻接上（否则徽标会空一两帧）。
   */
  armed: boolean;
  arm: () => void;
  /** 收尾被打断了（人离开了设备页）：先搭着的那一层撤掉，回来再搭 */
  disarm: () => void;
  endHandover: () => void;
  reset: () => void;
};

type Rect = { x: number; y: number; w: number; h: number };
export type GuideHandoverFrom = { card: Rect; emblem: Rect };

export const useGuideStore = create<GuideStore>((set, get) => ({
  userId: null,
  active: false,
  state: GUIDE_FRESH,
  bindOnly: false,
  markedAt: 0,
  begin: (userId, bindOnly = false) => {
    const cur = get();
    if (cur.active && cur.userId === userId) return;
    set({ userId, active: true, state: GUIDE_FRESH, bindOnly, markedAt: 0 });
  },
  mark: (step, result) => {
    const { state, active } = get();
    if (!active) return;
    const key = step === 1 ? "r1" : step === 2 ? "r2" : "r3";
    // 一件事只记一次：自己翻过去和手点「稍后」可能前后脚到
    if (state[key]) return;
    set({ state: { ...state, [key]: result }, markedAt: Date.now() });
  },
  handover: null,
  armed: false,
  arm: () => {
    if (get().active) set({ armed: true });
  },
  disarm: () => {
    // 衔接已经在播（handover 有值）就不归这里管
    if (get().armed && !get().handover) set({ armed: false });
  },
  finish: (from) =>
    set({
      active: false,
      state: GUIDE_FRESH,
      markedAt: 0,
      handover: from,
      armed: from !== null,
    }),
  endHandover: () => set({ handover: null, armed: false }),
  reset: () =>
    set({
      userId: null,
      active: false,
      state: GUIDE_FRESH,
      bindOnly: false,
      markedAt: 0,
      handover: null,
      armed: false,
    }),
}));
