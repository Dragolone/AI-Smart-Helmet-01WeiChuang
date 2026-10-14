// 开屏（和引导页变成设备页的那段衔接）要画设备页大图的替身时，从这里拿它现在的样子。
import { useSyncExternalStore } from "react";
import type { DevicePublic } from "@helmet/shared";

import { useColorScheme } from "@/hooks/use-color-scheme";
import { useCurrentHelmetChoice, useHelmetLinks } from "@/hooks/use-safety";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";
import { currentHelmetOf } from "@/services/safety-status";

import { getAnchorData, subscribeAnchorData } from "./bus";
import { heroSplashOf, type HeroSplash } from "./hero-splash";

/**
 * 开屏用：当前头盔那块大图现在该是什么样。页面上的大图搭好之后以页面给的为准（SplashAnchor 的 data）；
 * 那之前（开屏放行页面内容之后、页面还没搭完的那一小会儿）先照同一套规则从设备列表算，替身才能按时画出来。
 * @param list 设备列表；还没回来给 undefined
 * @param fresh 最近一次拉取是否成功
 */
export function useHeroSplash(
  list: readonly DevicePublic[] | undefined,
  fresh: boolean,
): HeroSplash | undefined {
  const fromPage = useSyncExternalStore(subscribeAnchorData, () =>
    getAnchorData<HeroSplash>("hero"),
  );
  const theme = useTheme();
  const dark = useColorScheme() === "dark";
  const t = useT();
  const choice = useCurrentHelmetChoice();
  const devices = list ?? [];
  const links = useHelmetLinks(devices, fresh);
  if (fromPage) return fromPage;
  if (!choice.ready) return undefined;
  const device = currentHelmetOf(devices, choice.chosenId);
  if (!device) return undefined;
  return heroSplashOf({
    device,
    link: links[device.deviceId],
    theme,
    dark,
    t,
    glowRadius: null,
  });
}
