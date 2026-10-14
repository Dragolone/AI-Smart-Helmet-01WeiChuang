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
import { StyleSheet, View } from "react-native";

import { helmetErrorText } from "@/api/error-messages";
import { AnimatedChip } from "@/components/motion";
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

/**
 * 某一项设置旁边的回执：最近一条命令改了这一项才显示（下发中 / 已送达等回执 / 已生效 / 失败 / 离线未送达）。
 * 文案与颜色沿用改版前页面底部那一行「最近下发」，只是挪到了对应的项旁边；每档有各自的图标，不只靠颜色。
 */
export function CommandFeedback({
  command,
  settingKey,
}: {
  command: CommandPublic | null;
  settingKey: string;
}) {
  const theme = useTheme();
  const t = useT();
  const locale = useLocale();
  if (!command || !commandTouches(command, settingKey)) return null;
  const view: {
    text: string;
    color: string;
    icon: keyof typeof Ionicons.glyphMap;
  } =
    command.status === "pending"
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
              icon: "checkmark-circle-outline",
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
                // 离线未送达：绝不显示为已生效
                text: t("device.cmd.offline"),
                color: theme.textSecondary,
                icon: "cloud-offline-outline",
              };
  return (
    <View accessibilityLiveRegion="polite" style={styles.feedback}>
      <Ionicons name={view.icon} size={14} color={view.color} />
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
}) {
  const theme = useTheme();
  const t = useT();
  return (
    <>
      {keys.map((key, index) => {
        const spec = DEVICE_SETTINGS[key];
        const current = normalize(key, settings?.[key]);
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
              disabled={disabled}
              onSelect={(v) => onChange(key, v)}
            />
          ) : (
            <Stepper
              value={
                typeof current === "number" ? current : Number(spec.default)
              }
              min={spec.min ?? 0}
              max={spec.max ?? 255}
              step={key === "radarDistance" ? 5 : 1}
              unit={"unit" in spec ? (spec.unit as string) : ""}
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
            <CommandFeedback command={lastCommand} settingKey={key} />
          </View>
        );
      })}
    </>
  );
}

/**
 * 圆角分段控件：一条圆角底槽里并排几段，高亮的是头盔确认过的那一段。
 * 档位型（3–4 段）铺满整行、各段等宽；开 / 关两段用 compact，贴在行右侧。
 * 每段最小高度 42，戴手套也点得中。
 */
function Segmented({
  options,
  current,
  disabled,
  onSelect,
  compact = false,
}: {
  options: { value: SettingValue; label: string }[];
  current: SettingValue | null;
  disabled: boolean;
  onSelect: (v: SettingValue) => void;
  compact?: boolean;
}) {
  const theme = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      style={[
        styles.segments,
        { backgroundColor: theme.backgroundSelected },
        compact && styles.segmentsCompact,
      ]}
    >
      {options.map((o) => (
        // AnimatedChip 的可点区域不带样式入口：外面包一层等宽的格子，里面那段自然撑满
        <View key={String(o.value)} style={styles.segmentSlot}>
          <AnimatedChip
            label={o.label}
            active={current === o.value}
            disabled={disabled}
            onPress={() => onSelect(o.value)}
            style={styles.segment}
            textStyle={styles.segmentText}
            activeBg={theme.brand}
            inactiveBg={theme.backgroundSelected}
            activeFg={theme.onBrand}
            inactiveFg={theme.textSecondary}
          />
        </View>
      ))}
    </View>
  );
}

/** 大范围整数（雷达距离 5–30 m）：步进按钮比滑杆精确，戴手套也点得中 */
function Stepper({
  value,
  min,
  max,
  step,
  unit,
  disabled,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  const theme = useTheme();
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  const btn = (delta: number, label: string) => (
    <Tappable
      feedback="scale"
      haptic
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled || clamp(value + delta) === value}
      onPress={() => onChange(clamp(value + delta))}
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
      <ThemedText type="smallBold" style={styles.stepValue}>
        {value}
        {unit}
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
  segmentSlot: { flex: 1 },
  segment: {
    minHeight: 42,
    borderRadius: 9,
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
