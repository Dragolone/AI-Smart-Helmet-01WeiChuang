// 轻量 i18n（2026-09-10）：不引 i18next（新增大依赖需双人同意，且这里只要三语字典 + 插值）。
// 用法：const t = useT(); t('devices.title'); t('devices.count', { n: 3 })
// 字典按页面分文件（messages/*.ts），每页自己维护自己的 key，避免多人同时改一个大文件。
import { useCallback } from "react";

import { common } from "./messages/common";
import { devices } from "./messages/devices";
import { intercom } from "./messages/intercom";
import { map } from "./messages/map";
import { profile } from "./messages/profile";
import { device } from "./messages/device";
import { events } from "./messages/events";
import { auth } from "./messages/auth";
import { errors } from "./messages/errors";
import { accident } from "./messages/accident";
import { safety } from "./messages/safety";
import { legal } from "./messages/legal";
import { help } from "./messages/help";
import { video } from "./messages/video";
import { useLocaleStore, type Locale } from "./locale-store";

export { useLocaleStore, LOCALES, type Locale } from "./locale-store";

const zhCN = {
  ...common["zh-CN"],
  ...devices["zh-CN"],
  ...map["zh-CN"],
  ...safety["zh-CN"],
  ...intercom["zh-CN"],
  ...profile["zh-CN"],
  ...device["zh-CN"],
  ...events["zh-CN"],
  ...auth["zh-CN"],
  ...errors["zh-CN"],
  ...accident["zh-CN"],
  ...legal["zh-CN"],
  ...help["zh-CN"],
  ...video["zh-CN"],
};
export type MessageKey = keyof typeof zhCN;

const dictionaries: Record<Locale, Partial<Record<MessageKey, string>>> = {
  "zh-CN": zhCN,
  "zh-TW": {
    ...common["zh-TW"],
    ...devices["zh-TW"],
    ...map["zh-TW"],
    ...safety["zh-TW"],
    ...intercom["zh-TW"],
    ...profile["zh-TW"],
    ...device["zh-TW"],
    ...events["zh-TW"],
    ...auth["zh-TW"],
    ...errors["zh-TW"],
    ...accident["zh-TW"],
    ...legal["zh-TW"],
    ...help["zh-TW"],
    ...video["zh-TW"],
  },
  en: {
    ...common.en,
    ...devices.en,
    ...map.en,
    ...safety.en,
    ...intercom.en,
    ...profile.en,
    ...device.en,
    ...events.en,
    ...auth.en,
    ...errors.en,
    ...accident.en,
    ...legal.en,
    ...help.en,
    ...video.en,
  },
};

export type Params = Record<string, string | number>;

/** 非组件环境（Alert 文案、Share 文案）直接调用；组件内用 useT() 以便切换语言即时刷新 */
export function translate(
  key: MessageKey,
  params?: Params,
  locale?: Locale,
): string {
  const loc = locale ?? useLocaleStore.getState().locale;
  // 缺译时回落简体，绝不显示 key
  const raw = dictionaries[loc][key] ?? zhCN[key];
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in params ? String(params[name]) : `{${name}}`,
  );
}

export function useT(): (key: MessageKey, params?: Params) => string {
  const locale = useLocaleStore((s) => s.locale);
  return useCallback(
    (key: MessageKey, params?: Params) => translate(key, params, locale),
    [locale],
  );
}

export function useLocale(): Locale {
  return useLocaleStore((s) => s.locale);
}

/** 语言的自称（语言选择器里永远用该语言自己的写法） */
export const LOCALE_NAMES: Record<Locale, string> = {
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  en: "English",
};

/** Intl 用的标签（日期/数字格式） */
export const LOCALE_TAGS: Record<Locale, string> = {
  "zh-CN": "zh-CN",
  "zh-TW": "zh-TW",
  en: "en-US",
};
