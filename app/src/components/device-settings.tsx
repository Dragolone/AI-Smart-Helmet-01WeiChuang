// 设备设置项（BLE v0.6 内存表 0x20–0x2D，清单在 @helmet/shared DEVICE_SETTINGS，决策 #43）。
// 这里只负责「怎么显示 + 发什么值」，取值范围一律取自清单，不再自己写一份。
// 暴露哪些项给终端用户由产品定（当前：安全相关全给，心跳/定位周期这类工程参数不给）。
import {
  DEVICE_SETTINGS,
  type DeviceSettingKey,
  type DeviceSettingSpec,
} from "@helmet/shared";
import { StyleSheet, View } from "react-native";

import { AnimatedChip } from "@/components/motion";
import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/hooks/use-theme";
import { useT, type MessageKey } from "@/i18n";

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

export function DeviceSettingList({
  settings,
  disabled,
  onChange,
}: {
  settings: Record<string, unknown> | undefined;
  disabled: boolean;
  onChange: (key: DeviceSettingKey, value: SettingValue) => void;
}) {
  const theme = useTheme();
  const t = useT();
  return (
    <>
      {EXPOSED_SETTINGS.map((key) => {
        const spec = DEVICE_SETTINGS[key];
        const current = normalize(key, settings?.[key]);
        const hint = HINT[key];
        const levels = LEVEL_LABELS[key];
        const stacked = !!levels; // 3–4 档的 chip 组单独一行，否则标签会被挤断行
        const labelBlock = (
          <View style={stacked ? styles.labelFull : styles.labelCol}>
            <ThemedText type="small" themeColor="textSecondary">
              {t(LABEL[key])}
            </ThemedText>
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
        const control = (
          <View style={[styles.chipGroup, stacked && styles.chipGroupWrap]}>
            {spec.kind === "bool" ? (
              [true, false].map((v) => (
                <AnimatedChip
                  key={String(v)}
                  label={t(v ? "device.on" : "device.off")}
                  active={current === v}
                  disabled={disabled}
                  onPress={() => onChange(key, v)}
                  style={styles.chip}
                  activeBg={theme.brand}
                  inactiveBg={theme.backgroundSelected}
                  activeFg={theme.onBrand}
                  inactiveFg={theme.textSecondary}
                />
              ))
            ) : levels ? (
              levels.map((labelKey, i) => {
                const v = (spec.min ?? 0) + i;
                return (
                  <AnimatedChip
                    key={labelKey}
                    label={t(labelKey)}
                    active={current === v}
                    disabled={disabled}
                    onPress={() => onChange(key, v)}
                    style={styles.chip}
                    activeBg={theme.brand}
                    inactiveBg={theme.backgroundSelected}
                    activeFg={theme.onBrand}
                    inactiveFg={theme.textSecondary}
                  />
                );
              })
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
            )}
          </View>
        );
        return stacked ? (
          <View key={key} style={styles.rowStacked}>
            {labelBlock}
            {control}
          </View>
        ) : (
          <View key={key} style={styles.row}>
            {labelBlock}
            {control}
          </View>
        );
      })}
    </>
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
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 8,
  },
  rowStacked: { paddingVertical: 8, gap: 8 },
  labelCol: { flex: 1, minWidth: 0, gap: 2 },
  labelFull: { gap: 2 },
  hint: { fontSize: 12, lineHeight: 16, opacity: 0.85 },
  chipGroup: { flexDirection: "row", gap: 6, flexShrink: 0 },
  chipGroupWrap: { flexWrap: "wrap" },
  chip: { paddingHorizontal: 12 },
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
