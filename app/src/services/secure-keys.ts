// App 存进 SecureStore（iOS 钥匙串 / 安卓加密存储）的全部条目，键名只在这里写。
// 为什么集中：iOS 删 App 不删钥匙串，重装后第一次打开要把上一次安装留下的条目全部清掉（services/fresh-install，
// 负责人 2026-10-17 定）；注销账号也要清掉这个账号的条目（account/delete）。键散在各处时，新加一条很容易漏清。
// 新加条目一律登记在这里：不分账号的进 SECURE_KEYS，按账号的写成函数并加进 accountSecureKeysOf。
// 守护测试 audit-secure-keys 会查有没有别处自己写键名。SecureStore 的键只允许字母数字和 . - _。

/** 不分账号的条目。legacy 是当初没带可访问性选项（钥匙串默认 WHEN_UNLOCKED、锁屏读不到）时的旧条目，留着给老版本搬家 */
export const SECURE_KEYS = {
  /** 登录凭证（stores/auth-store） */
  sessionTokens: "helmet.session.tokens",
  /** 登录账号的最小档案（stores/auth-store） */
  sessionUser: "helmet.session.user",
  /** 登录页预填的手机号：登出保留，注销删掉 */
  lastLoginPhone: "last_login_phone",
  /** 已同意的隐私政策版本（stores/consent-store） */
  privacyAccepted: "helmet.privacy.accepted.v2",
  privacyAcceptedLegacy: "helmet.privacy.accepted",
  /** App 语言（i18n/locale-store） */
  locale: "helmet.locale.v2",
  localeLegacy: "helmet.locale",
  /** 外观（stores/theme-store） */
  theme: "helmet.theme.v2",
  themeLegacy: "helmet.theme",
  /** 上次启动时账号下有没有头盔：开屏收尾用（stores/launch-memory-store） */
  launchMemory: "helmet.launchMemory",
  /** 有过头盔的账号：没头盔时走不走三步指引（stores/helmet-history-store） */
  everHadHelmet: "helmet.everHadHelmet",
  /** 保活设置提示弹过没有（components/keepalive-tip） */
  keepaliveTipShown: "keepalive_tip_shown",
  /** 蓝牙首连引导关掉过没有（components/ble-onboarding） */
  bleOnboardingDismissed: "ble_onboarding_dismissed",
  /** 华为「应用启动管理」那一步去过设置没有（components/ble-onboarding）：系统不给查，去过就算做过 */
  launchSettingsAcked: "helmet.launchSettings.acked",
} as const;

/** 已绑头盔的缓存，冷启动先用它把蓝牙链路拉起来（services/ble-targets）。用户 id 里键不允许的字符换成 _ */
export const bleTargetsKeyOf = (userId: string) =>
  `helmet.ble.targets.${userId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
/** 「设为当前」的选择（stores/current-helmet-store）。用户 id 是 cuid，满足键的字符要求，下同 */
export const currentHelmetKeyOf = (userId: string) =>
  `helmet.currentHelmet.v2.${userId}`;
export const currentHelmetLegacyKeyOf = (userId: string) =>
  `helmet.currentHelmet.${userId}`;
/** 打开过 SOS 演练没有（stores/drill-store） */
export const drillSeenKeyOf = (userId: string) =>
  `helmet.sosDrillSeen.${userId}`;
/** 「一直开麦」的说明看过没有（stores/intercom-store） */
export const openMicSeenKeyOf = (userId: string) =>
  `helmet.intercomOpenMicSeen.${userId}`;
/** 更换头盔提醒开关（stores/switch-reminder-store） */
export const switchReminderKeyOf = (userId: string) =>
  `helmet.switchReminder.${userId}`;

/** 一个账号在本机存过的全部条目：注销账号、重装后清理都按它删 */
export const accountSecureKeysOf = (userId: string): string[] => [
  bleTargetsKeyOf(userId),
  currentHelmetKeyOf(userId),
  currentHelmetLegacyKeyOf(userId),
  drillSeenKeyOf(userId),
  openMicSeenKeyOf(userId),
  switchReminderKeyOf(userId),
];
