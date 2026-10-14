// 「通知按钮取消」在途状态（2026-10-07 iPhone 实测负责人反馈）。
// 被杀状态下点通知上的「我没事，取消」：取消请求在 JS 一起来就发出，但启动动画要走两三秒，之后倒计时页
// 才拿到终态——这期间用户看到的是一个还在倒数的页面，不知道刚才那一下有没有算数，很可能再按、或者慌。
// 倒计时页据此把按钮直接显示成「取消中…」、不响警报；启动动画在这种拉起下也缩短。
import { create } from "zustand";

type SosCancelState = {
  /** 正在向服务端提交取消的 sosId */
  inFlight: Record<string, true>;
  begin: (sosId: string) => void;
  end: (sosId: string) => void;
};

export const useSosCancelStore = create<SosCancelState>((set) => ({
  inFlight: {},
  begin: (sosId) =>
    set((s) =>
      s.inFlight[sosId] ? s : { inFlight: { ...s.inFlight, [sosId]: true } },
    ),
  end: (sosId) =>
    set((s) => {
      if (!s.inFlight[sosId]) return s;
      const next = { ...s.inFlight };
      delete next[sosId];
      return { inFlight: next };
    }),
}));
