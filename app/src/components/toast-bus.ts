// 轻提示的「发」这一半：模块级 showToast() 和宿主的订阅。和 <ToastHost/> 分开放是为了让不渲染界面的
// 服务 / store（会话、外观、语言的落盘失败提示，O37）也能发提示，而不把主题常量、样式表这些界面依赖
// 一起拖进 i18n / store 的模块图（jest 下会因为 global.css 解析不了而整片挂掉）。
import { whenSplashGone } from "@/components/splash/covering";

type Listener = (message: string) => void;
let listener: Listener | null = null;

/**
 * 任意位置调用;Host 未挂载时静默丢弃(不阻塞业务)。
 * 冷启动开屏还盖着时先压着、等它让开再出:安卓上这条带 elevation,会叠在开屏上;
 * iOS 上被开屏挡住,2 秒后自己消失,等于没提示过(冷启动时到的低电量提醒就会落在这一段,2026-10-21)
 */
export function showToast(message: string): void {
  whenSplashGone(() => listener?.(message));
}

/** 宿主挂上时订阅；返回的函数用来在卸载时退订。同一时刻只有一个宿主 */
export function onToast(next: Listener): () => void {
  listener = next;
  return () => {
    if (listener === next) listener = null;
  };
}
