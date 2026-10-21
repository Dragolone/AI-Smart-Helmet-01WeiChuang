// 蓝牙工程模式页（硬件联调用；入口：登录页长按 App 名 3 秒 / 设备页信息区）。
// 不登录、不上云。文案只有中文：这页给硬件工程师看，不进三语字典。
// 按钮编号与 docs/BLE_BENCH.md 的测试清单一一对应，硬件按同一编号做固件测试集。
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Badge } from "@/components/badge";
import { PrimaryButton, SecondaryButton } from "@/components/form";
import { Card, SectionLabel } from "@/components/list";
import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { Radius } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import {
  ackLastEvent,
  connectTo,
  disconnect,
  handshake,
  ping,
  readRegister,
  recovery,
  resendData,
  resendQuery,
  reset,
  sendHex,
  setAutoAck,
  shareLog,
  startBench,
  startScan,
  stopBench,
  timeSync,
  writeRegister,
} from "@/services/ble-bench";
import {
  Reg,
  SETTINGS_READ_ADDR,
  SETTINGS_READ_LEN,
} from "@/services/ble/protocol";
import { useBleBenchStore } from "@/stores/ble-bench-store";
import type { BenchLogEntry, BenchPeripheral } from "@/stores/ble-bench-store";

export { RouteErrorBoundary as ErrorBoundary } from "@/components/route-error-boundary";

/** 页面只渲染最近这么多条；完整日志走「分享」导出 */
const VISIBLE_LOG = 200;

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

type Cmd = {
  n: number;
  label: string;
  run: () => void | Promise<unknown>;
  danger?: boolean;
};

function CommandButton({ cmd, disabled }: { cmd: Cmd; disabled: boolean }) {
  const theme = useTheme();
  return (
    <Tappable
      feedback={["opacity", "scale"]}
      disabled={disabled}
      onPress={() => void cmd.run()}
      style={[
        styles.cmd,
        {
          borderColor: cmd.danger ? theme.dangerBg : theme.borderStrong,
        },
      ]}
    >
      <ThemedText
        type="smallBold"
        themeColor="textSecondary"
        style={styles.cmdNum}
      >
        {cmd.n}
      </ThemedText>
      <ThemedText
        type="smallBold"
        style={[styles.cmdLabel, cmd.danger && { color: theme.danger }]}
        numberOfLines={1}
      >
        {cmd.label}
      </ThemedText>
    </Tappable>
  );
}

function PeripheralRow({
  p,
  connected,
  busy,
  preferred,
}: {
  p: BenchPeripheral;
  connected: boolean;
  busy: boolean;
  preferred: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.periph, { borderTopColor: theme.border }]}>
      <View style={styles.periphText}>
        <ThemedText numberOfLines={1}>
          {p.name ?? "(无名)"}
          {preferred ? "  ★" : ""}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {`RSSI ${p.rssi ?? "-"} · ${p.hasHelmetService ? "广播含 FEE0" : "广播无 FEE0"}`}
        </ThemedText>
      </View>
      {connected ? (
        <Badge variant="success" label="已连接" />
      ) : (
        <SecondaryButton
          title="连接"
          compact
          disabled={busy}
          onPress={() => void connectTo(p.id)}
          style={styles.connectBtn}
        />
      )}
    </View>
  );
}

function LogLine({ e }: { e: BenchLogEntry }) {
  const theme = useTheme();
  const tone =
    e.tone === "error"
      ? theme.danger
      : e.tone === "event"
        ? theme.warning
        : e.tone === "ok"
          ? theme.success
          : theme.textSecondary;
  const tag = e.dir === "tx" ? "TX" : e.dir === "rx" ? "RX" : "--";
  const tagBg =
    e.dir === "tx"
      ? "rgba(217,242,74,0.16)"
      : e.dir === "rx"
        ? theme.backgroundSelected
        : "transparent";
  const tagColor =
    e.dir === "tx"
      ? theme.brand
      : e.dir === "rx"
        ? theme.text
        : theme.textSecondary;
  return (
    <View style={styles.logLine}>
      <ThemedText type="code" themeColor="textSecondary" style={styles.logTime}>
        {clock(e.at)}
      </ThemedText>
      <View style={[styles.logTag, { backgroundColor: tagBg }]}>
        <ThemedText type="code" style={{ color: tagColor, fontSize: 10 }}>
          {tag}
        </ThemedText>
      </View>
      <View style={styles.logBody}>
        {e.hex ? (
          <ThemedText type="code" selectable>
            {e.hex.toUpperCase()}
          </ThemedText>
        ) : null}
        <ThemedText
          type="small"
          style={{ color: tone, fontSize: 12, lineHeight: 16 }}
        >
          {e.text}
          {e.latencyMs !== undefined ? ` · ${e.latencyMs} ms` : ""}
        </ThemedText>
      </View>
    </View>
  );
}

export default function BleBenchScreen() {
  const theme = useTheme();
  const { deviceId } = useLocalSearchParams<{ deviceId?: string }>();
  const preferredName = deviceId ? `Helmet-${deviceId.slice(-6)}` : null;

  const phase = useBleBenchStore((s) => s.phase);
  const adapter = useBleBenchStore((s) => s.adapter);
  const peripherals = useBleBenchStore((s) => s.peripherals);
  const connectedId = useBleBenchStore((s) => s.connectedId);
  const connectedName = useBleBenchStore((s) => s.connectedName);
  const mtu = useBleBenchStore((s) => s.mtu);
  const services = useBleBenchStore((s) => s.services);
  const notifyOk = useBleBenchStore((s) => s.notifyOk);
  const writeOk = useBleBenchStore((s) => s.writeOk);
  const autoAck = useBleBenchStore((s) => s.autoAck);
  const log = useBleBenchStore((s) => s.log);
  const clearLog = useBleBenchStore((s) => s.clearLog);

  const [hex, setHex] = useState("");
  const [showGatt, setShowGatt] = useState(false);
  const logRef = useRef<ScrollView>(null);

  useEffect(() => {
    void startBench();
    return () => {
      void stopBench();
    };
  }, []);

  const connected = phase === "connected";
  const busy = phase === "connecting";

  const confirmThen = useCallback(
    (title: string, body: string, run: () => Promise<unknown>) => {
      Alert.alert(title, body, [
        { text: "取消", style: "cancel" },
        { text: "发送", style: "destructive", onPress: () => void run() },
      ]);
    },
    [],
  );

  const commands: Cmd[] = [
    { n: 1, label: "PING", run: ping },
    { n: 2, label: "读 deviceId", run: () => readRegister(Reg.DEVICE_ID, 16) },
    { n: 3, label: "读固件", run: () => readRegister(Reg.FW_MAJOR, 3) },
    {
      n: 4,
      label: "读设置表",
      run: () => readRegister(SETTINGS_READ_ADDR, SETTINGS_READ_LEN),
    },
    { n: 5, label: "读状态区", run: () => readRegister(0x10, 10) },
    { n: 6, label: "对时", run: timeSync },
    {
      n: 7,
      label: "写音量 50",
      run: () => writeRegister(Reg.BUZZER_VOLUME, [50]),
    },
    {
      n: 8,
      label: "写越界 200",
      run: () => writeRegister(Reg.BUZZER_VOLUME, [200]),
    },
    {
      n: 9,
      label: "连写蜂鸣+音量",
      run: () => writeRegister(Reg.BUZZER_ENABLED, [1, 90]),
    },
    { n: 10, label: "补传查询", run: resendQuery },
    { n: 11, label: "补传取数", run: () => resendData(0, 10) },
    { n: 12, label: "手动 ACK", run: ackLastEvent },
    {
      n: 13,
      label: "RECOVERY",
      danger: true,
      run: () =>
        confirmThen(
          "恢复出厂参数",
          "头盔 0x20–0x2D 全部回到出厂值。确定发 RECOVERY？",
          recovery,
        ),
    },
    {
      n: 14,
      label: "RESET",
      danger: true,
      run: () =>
        confirmThen("软重启头盔", "头盔会重启并断开连接。确定发 RESET？", () =>
          reset(0x01),
        ),
    },
  ];

  const sorted = Object.values(peripherals).sort((a, b) => {
    const pa = a.name === preferredName ? 1 : 0;
    const pb = b.name === preferredName ? 1 : 0;
    if (pa !== pb) return pb - pa;
    if (a.hasHelmetService !== b.hasHelmetService)
      return a.hasHelmetService ? -1 : 1;
    return (b.rssi ?? -999) - (a.rssi ?? -999);
  });

  const scanBadge =
    adapter === "off" ||
    adapter === "unauthorized" ||
    adapter === "unsupported" ? (
      <Badge
        variant="danger"
        label={
          adapter === "off"
            ? "蓝牙已关闭"
            : adapter === "unauthorized"
              ? "无蓝牙权限"
              : "本机无蓝牙"
        }
      />
    ) : phase === "scanning" ? (
      <Badge variant="warning" label="扫描中" />
    ) : (
      <Badge variant="neutral" label={phase === "idle" ? "已停止" : "已连接"} />
    );

  const helmetSvc = services.find((s) => s.uuid.startsWith("0000fee0"));
  const charsText = helmetSvc
    ? `${notifyOk ? "FEE1 notify ✓" : "FEE1 notify ✗"} · ${writeOk ? "FEE2 write ✓" : "FEE2 write ✗"}`
    : "无 FEE0 服务";

  const visible = log.length > VISIBLE_LOG ? log.slice(-VISIBLE_LOG) : log;

  return (
    <SafeAreaView style={styles.flex} edges={["bottom"]}>
      <ThemedView style={styles.flex}>
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
        >
          <ThemedText style={styles.title}>蓝牙工程模式</ThemedText>
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.subtitle}
          >
            不登录、不上云，只对头盔收发字节。清单见 docs/BLE_BENCH.md。
          </ThemedText>

          {/* 附近设备 */}
          <View style={styles.sectionHead}>
            <SectionLabel title="附近设备" />
            <View style={styles.sectionRight}>
              {scanBadge}
              {phase === "idle" && adapter === "on" && (
                <Tappable onPress={startScan} hitSlop={8}>
                  <ThemedText type="smallBold" themeColor="brand">
                    重新扫描
                  </ThemedText>
                </Tappable>
              )}
            </View>
          </View>
          <Card>
            {sorted.length === 0 ? (
              <ThemedText type="small" themeColor="textSecondary">
                {phase === "scanning"
                  ? "还没扫到外设，让头盔上电并广播…"
                  : "列表为空"}
              </ThemedText>
            ) : (
              sorted.map((p) => (
                <PeripheralRow
                  key={p.id}
                  p={p}
                  connected={connectedId === p.id}
                  busy={busy || connected}
                  preferred={p.name === preferredName}
                />
              ))
            )}
          </Card>

          {/* 连接信息 */}
          {(connected || busy) && (
            <>
              <View
                style={[
                  styles.row,
                  {
                    backgroundColor: theme.backgroundElement,
                    borderColor: theme.border,
                  },
                ]}
              >
                <View style={styles.rowLeft}>
                  <Ionicons
                    name="bluetooth"
                    size={16}
                    color={theme.textSecondary}
                  />
                  <ThemedText type="label" themeColor="textSecondary">
                    设备
                  </ThemedText>
                </View>
                <View style={styles.rowRight}>
                  <ThemedText type="smallBold" numberOfLines={1}>
                    {connectedName ?? "-"}
                  </ThemedText>
                  {connected && (
                    <Tappable onPress={() => void disconnect()} hitSlop={8}>
                      <ThemedText
                        type="smallBold"
                        style={{ color: theme.danger }}
                      >
                        断开
                      </ThemedText>
                    </Tappable>
                  )}
                </View>
              </View>
              <View
                style={[
                  styles.row,
                  {
                    backgroundColor: theme.backgroundElement,
                    borderColor: theme.border,
                  },
                ]}
              >
                <View style={styles.rowLeft}>
                  <Ionicons
                    name="swap-horizontal-outline"
                    size={16}
                    color={theme.textSecondary}
                  />
                  <ThemedText type="label" themeColor="textSecondary">
                    MTU
                  </ThemedText>
                </View>
                <ThemedText type="smallBold">{mtu ?? "-"}</ThemedText>
              </View>
              <Tappable
                feedback="fill"
                onPress={() => setShowGatt((v) => !v)}
                style={[
                  styles.row,
                  {
                    backgroundColor: theme.backgroundElement,
                    borderColor: theme.border,
                  },
                ]}
              >
                <View style={styles.rowLeft}>
                  <Ionicons
                    name="git-network-outline"
                    size={16}
                    color={theme.textSecondary}
                  />
                  <ThemedText type="label" themeColor="textSecondary">
                    特征值
                  </ThemedText>
                </View>
                <View style={styles.rowRight}>
                  <ThemedText
                    type="smallBold"
                    style={{
                      color: notifyOk && writeOk ? theme.success : theme.danger,
                    }}
                  >
                    {charsText}
                  </ThemedText>
                  <Ionicons
                    name={showGatt ? "chevron-up" : "chevron-down"}
                    size={14}
                    color={theme.textSecondary}
                  />
                </View>
              </Tappable>
              {showGatt && (
                <Card>
                  {services.map((s) => (
                    <View key={s.uuid} style={styles.gattSvc}>
                      <ThemedText type="code">{s.uuid}</ThemedText>
                      {s.characteristics.map((c) => (
                        <ThemedText
                          key={c.uuid}
                          type="code"
                          themeColor="textSecondary"
                        >
                          {`  ${c.uuid}  ${[
                            c.notify && "notify",
                            c.write && "write",
                            c.writeNoResp && "write-no-resp",
                            c.read && "read",
                          ]
                            .filter(Boolean)
                            .join(" ")}`}
                        </ThemedText>
                      ))}
                    </View>
                  ))}
                </Card>
              )}
              <View
                style={[
                  styles.row,
                  {
                    backgroundColor: theme.backgroundElement,
                    borderColor: theme.border,
                  },
                ]}
              >
                <View style={styles.rowLeft}>
                  <Ionicons
                    name="checkmark-done-outline"
                    size={16}
                    color={theme.textSecondary}
                  />
                  <ThemedText type="label" themeColor="textSecondary">
                    高危事件自动 ACK
                  </ThemedText>
                </View>
                <Switch
                  value={autoAck}
                  onValueChange={setAutoAck}
                  trackColor={{ true: theme.brand, false: theme.borderStrong }}
                  thumbColor={autoAck ? theme.onBrand : "#FFFFFF"}
                />
              </View>
            </>
          )}

          {/* 逐条发指令 */}
          <View style={styles.sectionHead}>
            <SectionLabel title="逐条发指令" caption="编号 = 测试清单编号" />
          </View>
          <Card>
            <View style={styles.grid}>
              {commands.map((c) => (
                <CommandButton key={c.n} cmd={c} disabled={!connected} />
              ))}
            </View>
            <PrimaryButton
              title="一键握手（跑完整流程）"
              compact
              disabled={!connected}
              onPress={() => void handshake()}
            />
            <View
              style={[
                styles.hexRow,
                {
                  backgroundColor: theme.background,
                  borderColor: theme.borderStrong,
                },
              ]}
            >
              <TextInput
                value={hex}
                onChangeText={setHex}
                placeholder="自定义帧 hex，如 03 07 24 32"
                placeholderTextColor={theme.textSecondary}
                autoCapitalize="characters"
                autoCorrect={false}
                style={[styles.hexInput, { color: theme.text }]}
              />
              <SecondaryButton
                title="发送"
                compact
                disabled={!connected || hex.trim().length === 0}
                onPress={() => {
                  void sendHex(hex).then((ok) => {
                    if (ok) setHex("");
                  });
                }}
                style={styles.hexBtn}
              />
            </View>
          </Card>

          {/* 收发日志 */}
          <View style={styles.sectionHead}>
            <SectionLabel title="收发日志" caption={`${log.length} 条`} />
            <View style={styles.sectionRight}>
              <Tappable onPress={() => void shareLog()} hitSlop={8}>
                <Badge variant="neutral" label="分享" />
              </Tappable>
              <Tappable onPress={clearLog} hitSlop={8}>
                <Badge variant="neutral" label="清空" />
              </Tappable>
            </View>
          </View>
          <Card>
            {visible.length === 0 ? (
              <ThemedText type="small" themeColor="textSecondary">
                还没有收发记录
              </ThemedText>
            ) : (
              <ScrollView
                ref={logRef}
                style={styles.logBox}
                nestedScrollEnabled
                onContentSizeChange={() =>
                  logRef.current?.scrollToEnd({ animated: false })
                }
              >
                {visible.map((e) => (
                  <LogLine key={e.id} e={e} />
                ))}
              </ScrollView>
            )}
          </Card>
        </ScrollView>
      </ThemedView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: 20, gap: 12, paddingBottom: 40 },
  title: { fontSize: 30, lineHeight: 36, fontWeight: "600" },
  subtitle: { marginTop: -8 },
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 4,
  },
  sectionRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  periph: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  periphText: { flex: 1, gap: 2 },
  connectBtn: { minWidth: 76, paddingHorizontal: 14 },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderRadius: Radius.control,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
  },
  rowLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flexShrink: 1,
  },
  gattSvc: { gap: 2, marginBottom: 6 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  cmd: {
    flexBasis: "30%",
    flexGrow: 1,
    height: 40,
    borderRadius: Radius.pill,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingHorizontal: 8,
  },
  cmdNum: { fontSize: 12 },
  cmdLabel: { fontSize: 13, flexShrink: 1 },
  hexRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: Radius.control,
    borderWidth: 1,
    paddingLeft: 14,
    paddingRight: 4,
    paddingVertical: 4,
  },
  hexInput: { flex: 1, fontSize: 14, paddingVertical: 8 },
  hexBtn: { minWidth: 72, paddingHorizontal: 14 },
  logBox: { maxHeight: 420 },
  logLine: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    paddingVertical: 4,
  },
  logTime: { width: 58, fontSize: 11, lineHeight: 16 },
  logTag: {
    width: 24,
    borderRadius: 4,
    alignItems: "center",
    paddingVertical: 1,
    marginTop: 1,
  },
  logBody: { flex: 1, gap: 1 },
});
