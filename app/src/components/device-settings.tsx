// 设备设置项（BLE v0.6 内存表 0x20–0x2D，清单在 @helmet/shared DEVICE_SETTINGS，决策 #43）。
// 这里只负责「怎么显示 + 发什么值」，取值范围一律取自清单，不再自己写一份。
// 暴露哪些项给终端用户由产品定（当前：安全相关全给，心跳/定位周期这类工程参数不给）。
// 2026-10-06 设备详情页改版后分三处显示（keys 传子集）：详情首页放前照灯，其余在
// 「安全检测与预警」「提醒方式」两个分类页；回执就地显示在被改的那一项下面（CommandFeedback）。
// 选项是圆角分段控件（Segmented）。开关项也用「开 / 关」两段而不是拨动开关：高亮的是头盔确认过的值，
// 点了之后要等回执才会变——拨动开关一点就翻过去，等于把还没生效的值显示成已生效。
import { Ionicons } from "@expo/vector-icons";
import {
  DEVICE_SETTINGS,
  type CommandPublic,
  type DeviceSettingKey,
  type DeviceSettingSpec,
} from "@helmet/shared";
import { useEffect, useRef } from "react";
import { AccessibilityInfo, Platform, StyleSheet, View } from "react-native";

import { helmetErrorText } from "@/api/error-messages";
import { CheckDraw } from "@/components/check-draw";
import { FluidSegmented } from "@/components/fluid-segmented";
import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/hooks/use-theme";
import { useLocale, useT, type MessageKey } from "@/i18n";
import { timeWithDateIfNotToday } from "@/i18n/format";
import { commandTouches } from "@/services/device-view";

/** 档位型整数设置的档位文案（0 起或 1 起按清单 min） */
const LEVEL_LABELS: Partial<Record<DeviceSettingKey, MessageKey[]>> = {
  light: [
    "device.level.off",
    "device.level.lightLow",
    "device.level.lightHigh",
    "device.level.lightFlash",
  ],
  vibration: [
    "device.level.off",
    "device.level.weak",
    "device.level.medium",
    "device.level.strong",
  ],
  fallSensitivity: [
    "device.level.senLow",
    "device.level.senStd",
    "device.level.senHigh",
  ],
};

/** 档位型设置某个取值的文案 key（摘要里用，如「振动：中」）；不是档位型或越界时没有 */
export function levelLabelKey(
  key: DeviceSettingKey,
  value: unknown,
): MessageKey | null {
  const labels = LEVEL_LABELS[key];
  if (!labels || typeof value !== "number") return null;
  const min = (DEVICE_SETTINGS[key] as DeviceSettingSpec).min ?? 0;
  return labels[value - min] ?? null;
}

/** 展示顺序：先「出事时管不管用」，再「平时吵不吵」 */
export const EXPOSED_SETTINGS: DeviceSettingKey[] = [
  "fallDetect",
  "fallSensitivity",
  "sosButton",
  "radar",
  "radarDistance",
  "obstacleWarn",
  "light",
  "vibration",
  "buzzer",
  "disconnectBeep",
];

const LABEL: Record<DeviceSettingKey, MessageKey> = {
  heartbeatPeriod: "device.set.heartbeatPeriod",
  locationPeriodMoving: "device.set.locationPeriodMoving",
  locationPeriodStill: "device.set.locationPeriodStill",
  buzzer: "device.set.buzzer",
  volume: "device.set.volume",
  vibration: "device.set.vibration",
  light: "device.set.light",
  fallDetect: "device.set.fallDetect",
  fallSensitivity: "device.set.fallSensitivity",
  radar: "device.set.radar",
  radarDistance: "device.set.radarDistance",
  obstacleWarn: "device.set.obstacleWarn",
  sosButton: "device.set.sosButton",
  disconnectBeep: "device.set.disconnectBeep",
};

/** 只有少数项需要一句解释，其余键名自明 */
const HINT: Partial<Record<DeviceSettingKey, MessageKey>> = {
  sosButton: "device.hint.sosButton",
  light: "device.hint.light",
  fallSensitivity: "device.hint.fallSensitivity",
};

export type SettingValue = number | boolean;

/** 云端历史上存过 light: true（决策 #43 前），按低亮档显示，下发一次后自愈 */
const normalize = (key: DeviceSettingKey, v: unknown): SettingValue | null => {
  const spec: DeviceSettingSpec = DEVICE_SETTINGS[key];
  if (spec.kind === "bool") return typeof v === "boolean" ? v : null;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return null;
};

/** 认得的错误码说人话；不认得的码只在括号里出现一次，前面写「执行失败」，不把码原样念两遍 */
function failureText(code: string, t: ReturnType<typeof useT>): string {
  const human = helmetErrorText(code, t);
  return human === code ? t("device.cmd.failed") : human;
}

const inFlightStatus = (status: CommandPublic["status"] | undefined) =>
  status === "pending" || status === "delivered";

/**
 * 某一项设置旁边的回执：最近一条命令改了这一项才显示（下发中 / 已送达等回执 / 已生效 / 失败 / 离线未送达）。
 * 文案与颜色沿用改版前页面底部那一行「最近下发」，只是挪到了对应的项旁边；每档有各自的图标，不只靠颜色。
 */
export function CommandFeedback({
  command,
  settingKey,
  online = false,
  confirmed,
}: {
  command: CommandPublic | null;
  settingKey: string;
  /** 头盔此刻在线：离线时没送达的那条不再说「头盔离线」，改说上次没送达、可以再试（10-16 iPhone） */
  online?: boolean;
  /**
   * 这一项头盔确认过的当前值（没有时传 null）。传了才比对：已生效那条命令写的值和它对不上了
   * （之后头盔自己上报改过，比如大灯掉电回到关），就不再挂「已生效」——那句话说的已经不是现在的值
   */
  confirmed?: unknown;
}) {
  const theme = useTheme();
  const t = useT();
  const locale = useLocale();
  const touched = !!command && commandTouches(command, settingKey);
  const stale =
    command?.status === "success" &&
    confirmed !== undefined &&
    command.params[settingKey] !== confirmed;
  const view: {
    text: string;
    color: string;
    /** null = 已生效：勾是画出来的（CheckDraw），不是现成图标 */
    icon: keyof typeof Ionicons.glyphMap | null;
  } | null =
    !command || !touched || stale
      ? null
      : command.status === "pending"
        ? {
            text: t("device.cmd.pending"),
            color: theme.warning,
            icon: "time-outline",
          }
        : command.status === "delivered"
          ? {
              text: t("device.cmd.delivered"),
              color: theme.warning,
              icon: "time-outline",
            }
          : command.status === "success"
            ? {
                text: command.executedAt
                  ? t("device.cmd.successAt", {
                      time: timeWithDateIfNotToday(command.executedAt, locale),
                    })
                  : t("device.cmd.success"),
                color: theme.success,
                icon: null,
              }
            : command.status === "failed"
              ? {
                  // 正文说人话，原始码留在括号里给技术支持看
                  text: command.errorCode
                    ? `${failureText(command.errorCode, t)}（${command.errorCode}）`
                    : t("device.cmd.failed"),
                  color: theme.danger,
                  icon: "close-circle-outline",
                }
              : {
                  // 离线未送达：绝不显示为已生效。头盔已经回来了就别再说它离线
                  text: t(
                    online ? "device.cmd.expiredRetry" : "device.cmd.offline",
                  ),
                  color: theme.textSecondary,
                  icon: "cloud-offline-outline",
                };

  // iOS 读屏不认 accessibilityLiveRegion（只有 Android 有）：回执变了主动念一句。
  // 挂上时已经在的不念；从「没有任何命令」变成有，多半是设置刚拉回来、带出一条旧回执，
  // 只有还在路上的（刚点的那条）才念
  const cmdKey = command ? `${command.commandId}:${command.status}` : null;
  const fresh = inFlightStatus(command?.status);
  const sayText = view?.text ?? null;
  const said = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prev = said.current;
    said.current = cmdKey;
    if (Platform.OS !== "ios" || prev === undefined || prev === cmdKey) return;
    if (!sayText || (prev === null && !fresh)) return;
    AccessibilityInfo.announceForAccessibility(sayText);
  }, [cmdKey, fresh, sayText]);

  if (!view) return null;
  return (
    <View accessibilityLiveRegion="polite" style={styles.feedback}>
      {view.icon ? (
        <Ionicons name={view.icon} size={14} color={view.color} />
      ) : (
        // 回执变成 success 的那一刻挂上来、从头画一遍；和主按钮成功态是同一个勾
        <CheckDraw
          size={14}
          strokeWidth={2.8}
          ringOpacity={0.6}
          color={view.color}
        />
      )}
      <ThemedText
        type="small"
        style={[styles.feedbackText, { color: view.color }]}
      >
        {view.text}
      </ThemedText>
    </View>
  );
}

export function DeviceSettingList({
  settings,
  disabled,
  onChange,
  keys = EXPOSED_SETTINGS,
  lastCommand = null,
  icons,
  online = false,
}: {
  settings: Record<string, unknown> | undefined;
  disabled: boolean;
  onChange: (key: DeviceSettingKey, value: SettingValue) => void;
  /** 只显示这几项（分类页 / 详情首页各取一部分）；不传 = 全部 */
  keys?: readonly DeviceSettingKey[];
  /** 最近一条下发命令：改了哪一项，回执就显示在哪一项下面 */
  lastCommand?: CommandPublic | null;
  /** 行首图标（只有详情首页的常用控制带） */
  icons?: Partial<Record<DeviceSettingKey, keyof typeof Ionicons.glyphMap>>;
  /** 头盔此刻在线（服务端口径），给下发回执用 */
  online?: boolean;
}) {
  const theme = useTheme();
  const t = useT();
  // settings 为 undefined = 还在拉（或没拉到）：不知道头盔上是什么，不能当成「从没上报过」去描出厂默认
  const loaded = settings !== undefined;
  return (
    <>
      {keys.map((key, index) => {
        const spec = DEVICE_SETTINGS[key];
        const current = normalize(key, settings?.[key]);
        // 「待确认」的那一档：刚点过、回执还没回来的值；或者头盔从没上报过（拉到了但没有这一项）时的出厂默认——
        // 只描边不填色，和「头盔确认过」的实心高亮分得开，不把没生效的值显示成已生效（决策 #27③ / #45）
        const inFlight =
          lastCommand &&
          commandTouches(lastCommand, key) &&
          inFlightStatus(lastCommand.status)
            ? normalize(key, lastCommand.params[key])
            : null;
        const unreported = loaded && current === null;
        const tentative =
          inFlight ?? (unreported ? normalize(key, spec.default) : null);
        const hint = HINT[key];
        const levels = LEVEL_LABELS[key];
        const stacked = !!levels; // 3–4 档的分段控件单独占一行，否则标签会被挤断行
        const levelKey = levelLabelKey(key, current);
        const icon = icons?.[key];
        const labelBlock = (
          <View style={stacked ? styles.labelFull : styles.labelCol}>
            <View style={styles.labelLine}>
              {icon && (
                <Ionicons name={icon} size={18} color={theme.textSecondary} />
              )}
              <ThemedText type="small" style={styles.label}>
                {t(LABEL[key])}
              </ThemedText>
              {/* 档位型：标题右侧写头盔确认过的当前档——等回执期间这里和高亮的那一段都还是旧值 */}
              {stacked && levelKey && (
                <ThemedText
                  type="small"
                  themeColor="textSecondary"
                  style={styles.currentValue}
                >
                  {t(levelKey)}
                </ThemedText>
              )}
            </View>
            {hint ? (
              <ThemedText
                type="small"
                themeColor="textSecondary"
                style={styles.hint}
              >
                {t(hint)}
              </ThemedText>
            ) : null}
            {unreported && (
              <ThemedText
                type="small"
                themeColor="textSecondary"
                style={styles.hint}
              >
                {t("device.unconfirmedDefault")}
              </ThemedText>
            )}
          </View>
        );
        const control =
          spec.kind === "bool" ? (
            <Segmented
              compact
              options={[true, false].map((v) => ({
                value: v,
                label: t(v ? "device.on" : "device.off"),
              }))}
              current={current}
              tentative={tentative}
              disabled={disabled}
              onSelect={(v) => onChange(key, v)}
            />
          ) : levels ? (
            <Segmented
              options={levels.map((labelKey, i) => ({
                value: (spec.min ?? 0) + i,
                label: t(labelKey),
              }))}
              current={current}
              tentative={tentative}
              disabled={disabled}
              onSelect={(v) => onChange(key, v)}
            />
          ) : (
            // 有命令在路上时显示它的目标值（待确认样式），再点 + / − 从目标值接着加减：
            // 否则连点两下 + 发出去的是同一个值
            <Stepper
              value={
                typeof inFlight === "number"
                  ? inFlight
                  : typeof current === "number"
                    ? current
                    : loaded
                      ? Number(spec.default)
                      : null
              }
              min={spec.min ?? 0}
              max={spec.max ?? 255}
              step={key === "radarDistance" ? 5 : 1}
              unit={"unit" in spec ? (spec.unit as string) : ""}
              tentative={inFlight !== null || current === null}
              awaiting={inFlight !== null}
              disabled={disabled}
              onChange={(v) => onChange(key, v)}
            />
          );
        return (
          <View
            key={key}
            style={[
              styles.item,
              index > 0 && {
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: theme.border,
              },
            ]}
          >
            <View style={stacked ? styles.rowStacked : styles.row}>
              {labelBlock}
              {control}
            </View>
            <CommandFeedback
              command={lastCommand}
              settingKey={key}
              online={online}
              confirmed={current}
            />
          </View>
        );
      })}
    </>
  );
}

/**
 * 圆角分段控件：一条圆角底槽里并排几段，高亮是一颗滑块，停在头盔确认过的那一段；
 * 回执 success 后才滑到新的一段（components/fluid-segmented，负责人 2026-10-15 画板口径）。
 * 档位型（3–4 段）铺满整行、各段等宽；开 / 关两段用 compact，贴在行右侧。
 * 每段最小高度 42，戴手套也点得中。
 */
function Segmented({
  options,
  current,
  tentative = null,
  disabled,
  onSelect,
  compact = false,
}: {
  options: { value: SettingValue; label: string }[];
  current: SettingValue | null;
  /** 待确认的那一档（在途 / 未上报时的默认）：品牌色描边、不填色 */
  tentative?: SettingValue | null;
  disabled: boolean;
  onSelect: (v: SettingValue) => void;
  compact?: boolean;
}) {
  const theme = useTheme();
  return (
    <FluidSegmented
      options={options}
      current={current}
      tentative={tentative}
      disabled={disabled}
      onSelect={onSelect}
      palette={{
        thumb: theme.brand,
        activeText: theme.onBrand,
        text: theme.textSecondary,
        tentativeText: theme.text,
        outline: theme.brand,
      }}
      style={[
        styles.segments,
        { backgroundColor: theme.backgroundSelected },
        compact && styles.segmentsCompact,
      ]}
      segmentStyle={styles.segment}
      textStyle={styles.segmentText}
      thumbStyle={styles.thumb}
    />
  );
}

/** 大范围整数（雷达距离 5–30 m）：步进按钮比滑杆精确，戴手套也点得中 */
function Stepper({
  value,
  min,
  max,
  step,
  unit,
  tentative = false,
  awaiting = false,
  disabled,
  onChange,
}: {
  /** null = 设置还没拉到：不知道现在是多少，显示一横，不能加减（加减是从现在的值算的） */
  value: number | null;
  min: number;
  max: number;
  step: number;
  unit: string;
  /** 不是头盔确认过的值（没上报过的默认 / 等回执的目标值）：数字用次要色 */
  tentative?: boolean;
  /** 显示的是还在等回执的目标值：读屏补一句「等待头盔确认」 */
  awaiting?: boolean;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  const theme = useTheme();
  const t = useT();
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  const btn = (delta: number, label: string) => (
    <Tappable
      feedback="scale"
      haptic
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={
        disabled || value === null || clamp(value + delta) === value
      }
      onPress={() => {
        if (value !== null) onChange(clamp(value + delta));
      }}
      style={[styles.stepBtn, { backgroundColor: theme.backgroundSelected }]}
    >
      <ThemedText type="smallBold" style={styles.stepBtnText}>
        {label}
      </ThemedText>
    </Tappable>
  );
  return (
    <View style={styles.stepper}>
      {btn(-step, "−")}
      <ThemedText
        type="smallBold"
        themeColor={tentative || value === null ? "textSecondary" : undefined}
        accessibilityHint={
          awaiting ? t("device.a11y.awaitingHelmet") : undefined
        }
        style={styles.stepValue}
      >
        {value === null ? "—" : `${value}${unit}`}
      </ThemedText>
      {btn(step, "+")}
    </View>
  );
}

const styles = StyleSheet.create({
  item: { paddingVertical: 12, gap: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  rowStacked: { gap: 8 },
  feedback: { flexDirection: "row", alignItems: "center", gap: 5 },
  feedbackText: { fontSize: 12, lineHeight: 17, flexShrink: 1 },
  label: { fontSize: 15, flexShrink: 1 },
  labelCol: { flex: 1, minWidth: 0, gap: 2 },
  labelFull: { gap: 2 },
  labelLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  currentValue: { fontSize: 13, marginLeft: "auto" },
  hint: { fontSize: 12, lineHeight: 16, opacity: 0.85 },
  segments: { flexDirection: "row", gap: 4, padding: 4, borderRadius: 12 },
  segmentsCompact: { width: 124, flexShrink: 0 },
  thumb: { borderRadius: 9 },
  segment: {
    minHeight: 42,
    borderRadius: 9,
    // 描边留给「待确认」态；平时透明，占位一致不跳动
    borderWidth: 1.5,
    borderColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  segmentText: { fontSize: 14, textAlign: "center" },
  stepper: { flexDirection: "row", alignItems: "center", gap: 10 },
  stepBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  stepBtnText: { fontSize: 18, lineHeight: 22 },
  stepValue: { fontSize: 15, minWidth: 46, textAlign: "center" },
});
