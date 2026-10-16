// 绑定头盔：扫码优先（画板「绑定 · 扫码优先」，2026-10-08 定稿）。API.md §4 POST /devices/bind。
// 一进来就是取景框，手动输入收在底部面板里：扫码和手输都还在，只是主次对调——
// 此前先是表单页，扫码另开一页（scan-bind，已并进本页）。
// - 扫到带绑定码的码：直接绑定，卡片上依次是「找到头盔 → 绑定成功」，不再回填表单让人再点一次；
//   只印了设备号的旧码（DEVICE_PROTOCOL §11）：打开手动输入并填好设备号，绑定码手输。
// - 相机只在本页打开；没给权限 → 说明 + 允许 / 去设置，手动输入照常可用（模拟器 / 没有相机也走这条）。
// - 绑定成功后停在卡片上，点「完成」才回设备页。回去一律用 dismissAll：绝不能在这里 push 标签页路由——
//   焦点还在绑定页时那样做会在根栈上新压一套 (tabs)（2026-10-05 评审 R-01）。
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  ZoomIn,
  type EntryAnimationsValues,
  type ExitAnimationsValues,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import type { DevicePublic } from "@helmet/shared";

import { contactsApi } from "@/api/contacts";
import { devicesApi } from "@/api/devices";
import { isTransientFailure, toUserMessage } from "@/api/error-messages";
import { FormError, FormInput, PrimaryButton } from "@/components/form";
import { DotsLoader } from "@/components/motion";
import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { showToast } from "@/components/toast";
import { helmetImageFor } from "@/constants/helmet-images";
import { Colors } from "@/constants/theme";
import { useNotifyPermission } from "@/hooks/use-safety";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";
import {
  BIND_CODE_INPUT_MAX,
  bindLinkInManualInput,
  classifyScan,
  normalizeManualBindCode,
  normalizeManualDeviceId,
} from "@/services/bind-qr";
import { withAlpha } from "@/services/color";

const FRAME = 240;
/** 扫描线上下走的总行程 */
const SWEEP = 216;
/** 刚识别到的那一拍（四角转绿、提示「已识别」）停多久再出卡片 */
const FOUND_MS = 320;
/** 「正在绑定」至少显示这么久：服务器回得快时卡片不至于一闪而过 */
const BINDING_MIN_MS = 500;
/** 扫错码的提示在码离开镜头之后再留多久 */
const NOTICE_MS = 2200;
/** 面板往下拖过这么多就收起 */
const DISMISS_DRAG = 90;
/** 刚处理过的那个码要离开镜头这么久，再对上去才算重新扫 */
const REARM_MS = 1500;

// 取景框画在相机画面上，不跟外观走：深浅两种外观下都是这几个颜色
/** 相机开着时整页压黑，取景画面上的字和角标才看得清；相机没开（授权前 / 被拒 / 模拟器）就按主题来 */
const CAMERA_BG = "#050607";

const ON_CAMERA = {
  scan: Colors.dark.brand,
  ok: Colors.dark.success,
  bad: "#FF8A7A",
  text: "#FFFFFF",
  textDim: "rgba(255,255,255,0.72)",
};

type Stage =
  | { kind: "scan" }
  | { kind: "found"; deviceId: string }
  | { kind: "binding"; deviceId: string }
  | { kind: "done"; deviceId: string }
  | {
      kind: "failed";
      deviceId: string;
      bindCode: string;
      message: string;
      /** 码本身没问题、原样再来一次可能就行的那类失败（断网、超时、限频） */
      transient: boolean;
    };

type Notice = "notBindCode" | "alreadyBound" | "justFailed";

type BindResult =
  | { ok: true; deviceId: string }
  | { ok: false; message: string; transient: boolean };

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
/** 只在相机回调里用（不在渲染期调） */
const nowMs = () => Date.now();

// 底部面板的进出（设计规范）：进 320 ms、到位前略微过头一点再落回；出 200 ms
const panelIn = (values: EntryAnimationsValues) => {
  "worklet";
  return {
    initialValues: {
      transform: [{ translateY: values.targetHeight + 24 }],
    },
    animations: {
      transform: [
        {
          translateY: withSequence(
            withTiming(-6, {
              duration: 224,
              easing: Easing.bezier(0.2, 0.8, 0.2, 1),
            }),
            withTiming(0, { duration: 96, easing: Easing.out(Easing.quad) }),
          ),
        },
      ],
    },
  };
};
const panelOut = (values: ExitAnimationsValues) => {
  "worklet";
  return {
    initialValues: { transform: [{ translateY: 0 }] },
    animations: {
      transform: [
        {
          translateY: withTiming(values.currentHeight + 24, {
            duration: 200,
            easing: Easing.bezier(0.4, 0, 1, 1),
          }),
        },
      ],
    },
  };
};

export default function BindDeviceScreen() {
  const theme = useTheme();
  const t = useT();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  // 带着设备号 / 绑定码打开时：填进手动输入，等用户自己点「绑定」，不替他提交。
  // manual=1：一进来就开着手动输入的面板（别的页面上的「手动输入设备编号」入口用）
  const params = useLocalSearchParams<{
    deviceId?: string;
    bindCode?: string;
    manual?: string;
  }>();
  const [permission, requestPermission] = useCameraPermissions();
  const granted = permission?.granted === true;

  const [stage, setStage] = useState<Stage>({ kind: "scan" });
  /** 这一次的结果是扫出来的（不是手输的）：取景框才转绿、写「已识别」 */
  const [viaScan, setViaScan] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sheetOpen, setSheetOpen] = useState(
    () => !!params.deviceId || params.manual === "1",
  );
  const [idVal, setIdVal] = useState(params.deviceId ?? "");
  const [codeVal, setCodeVal] = useState(params.bindCode ?? "");
  /** 扫到的码里只有设备号：面板里多一句说明 */
  const [codeMissing, setCodeMissing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 安全设置还差东西（确定知道的才算，没查到的不算）时，成功卡片才提「去做安全设置」
  const notify = useNotifyPermission();
  const contacts = useQuery({
    queryKey: ["contacts"],
    queryFn: contactsApi.list,
  });
  const safetyGap = notify === "denied" || contacts.data?.length === 0;

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  /** 这次进来已经绑上的设备号：码还留在镜头里时不拿它再绑一次 */
  const boundHere = useRef(new Set<string>());
  /** 一个码只处理一次：相机在页面重新渲染之前还会把同一个码再报几遍 */
  const scanLock = useRef(false);
  /**
   * 刚处理过的那个码（绑上了 / 没绑上 / 转去手输）。回到取景时它多半还在镜头里：
   * 不离开镜头就一直不理它，否则「重新扫码」会立刻再失败一次、关掉的面板会立刻再弹出来。
   * 例外见 rescan：没连上服务器那类失败，点「重新扫码」就认同一个码。
   * failed = 这个码刚才没绑上：它还在镜头里时在取景框下面说一声，不然页面看着像没反应
   */
  const handled = useRef<{
    data: string;
    seenAt: number;
    failed?: boolean;
  } | null>(null);
  /** 上一次因为「不是绑定码 / 刚绑过」而提示是什么时候 */
  const lastNoticeAt = useRef<number | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  /** 提交绑定。成功时列表缓存已经更新；失败带回给用户看的原因 */
  const bind = async (
    deviceId: string,
    bindCode: string,
  ): Promise<BindResult> => {
    try {
      const bound = await devicesApi.bind({
        // 扫码来的已经是干净的；手输的去掉全角、分组空格 / 横线、复制夹带的零宽字符（幂等）
        deviceId: normalizeManualDeviceId(deviceId),
        bindCode: normalizeManualBindCode(bindCode),
      });
      // 服务端一确认就把新设备写进列表缓存，随后后台刷新拿权威数据：回到设备页时它已经在列表里
      queryClient.setQueryData<DevicePublic[]>(["devices"], (prev) =>
        prev?.some((d) => d.deviceId === bound.deviceId)
          ? prev
          : [...(prev ?? []), bound],
      );
      void queryClient.invalidateQueries({ queryKey: ["devices"] });
      boundHere.current.add(bound.deviceId);
      return { ok: true, deviceId: bound.deviceId };
    } catch (e) {
      return {
        ok: false,
        message: toUserMessage(e),
        transient: isTransientFailure(e),
      };
    }
  };

  const showDone = (deviceId: string) => {
    setStage({ kind: "done", deviceId });
    AccessibilityInfo.announceForAccessibility(t("device.bindSuccess"));
  };

  /** 扫到带绑定码的码：四角转绿停一拍 → 「找到头盔 · 正在绑定」→ 成功 / 没绑上 */
  const bindScanned = async (deviceId: string, bindCode: string) => {
    setNotice(null);
    setViaScan(true);
    setStage({ kind: "found", deviceId });
    const request = bind(deviceId, bindCode); // 请求立刻发，不等动画
    await wait(FOUND_MS);
    if (alive.current) setStage({ kind: "binding", deviceId });
    const [result] = await Promise.all([request, wait(BINDING_MIN_MS)]);
    if (!alive.current) {
      // 没等结果就关了页面：绑上了也要让人知道
      if (result.ok) showToast(t("device.bindSuccess"));
      return;
    }
    if (result.ok) {
      showDone(result.deviceId);
      return;
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(
      () => undefined,
    );
    if (handled.current) handled.current.failed = true;
    setStage({
      kind: "failed",
      deviceId,
      bindCode,
      message: result.message,
      transient: result.transient,
    });
    AccessibilityInfo.announceForAccessibility(
      `${t("bind.failedTitle")}${t("common.a11ySep")}${result.message}`,
    );
  };

  const drag = useSharedValue(0);
  const openSheet = (prefill?: {
    deviceId: string;
    bindCode?: string;
    codeMissing?: boolean;
  }) => {
    if (prefill) {
      setIdVal(prefill.deviceId);
      setCodeVal(prefill.bindCode ?? "");
    }
    setCodeMissing(prefill?.codeMissing === true);
    setFormError(null);
    setBusy(false);
    drag.set(0);
    setSheetOpen(true);
  };
  const closeSheet = () => setSheetOpen(false);
  const rescan = () => {
    // 码本身没问题的那类失败（断网、超时、限频）：连好网点「重新扫码」时镜头多半还对着同一个码，这时要认它。
    // 不然页面只有扫描线在走、对着码没有任何反应，要把镜头移开再对回来才行（2026-10-08 模拟器实测）
    if (stage.kind === "failed" && stage.transient) handled.current = null;
    setViaScan(false);
    setIdVal("");
    setCodeVal("");
    setStage({ kind: "scan" });
  };

  const shakeX = useSharedValue(0);
  const onScanned = ({ data }: { data: string }) => {
    if (scanLock.current || stage.kind !== "scan" || sheetOpen) return;
    const now = nowMs();
    if (handled.current?.data === data) {
      const away = now - handled.current.seenAt > REARM_MS;
      handled.current.seenAt = now;
      if (!away) {
        if (handled.current.failed) {
          setNotice("justFailed");
          if (noticeTimer.current) clearTimeout(noticeTimer.current);
          noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
        }
        return;
      }
    }
    const outcome = classifyScan(data, boundHere.current);
    if (outcome.kind === "bind" || outcome.kind === "needCode") {
      scanLock.current = true;
      handled.current = { data, seenAt: now };
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => undefined,
      );
      if (outcome.kind === "bind") {
        void bindScanned(outcome.deviceId, outcome.bindCode);
      } else {
        setNotice(null);
        openSheet({ deviceId: outcome.deviceId, codeMissing: true });
      }
      return;
    }
    // 不是绑定码 / 刚绑过的那一顶：提示写在取景框下面，继续扫。
    // 提示出来之后，只要镜头里还有这类码就留着，不跟着相机的回调反复抖和震——
    // 镜头里同时有两个无关的码时，回调会在两个码之间来回跳，按「是不是同一个码」来判断会一直震
    const last = lastNoticeAt.current;
    lastNoticeAt.current = now;
    if (last === null || now - last > NOTICE_MS) {
      setNotice(outcome.kind);
      if (outcome.kind === "notBindCode") {
        shakeX.set(
          withSequence(
            withTiming(-8, { duration: 72 }),
            withTiming(8, { duration: 72 }),
            withTiming(-5, { duration: 72 }),
            withTiming(3, { duration: 72 }),
            withTiming(0, { duration: 72 }),
          ),
        );
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(
          () => undefined,
        );
      }
    }
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  };

  const submitManual = async () => {
    setFormError(null);
    setBusy(true);
    const result = await bind(idVal, codeVal);
    if (!alive.current) {
      if (result.ok) showToast(t("device.bindSuccess"));
      return;
    }
    if (!result.ok) {
      // 手输绑不上：原因写在面板里，填的内容留着改
      setBusy(false);
      setFormError(result.message);
      return;
    }
    // busy 不复位：面板正在收起，「绑定」保持不可点，杜绝重复提交（下次打开面板时再复位）
    setSheetOpen(false);
    setViaScan(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
      () => undefined,
    );
    showDone(result.deviceId);
  };

  const scanning = stage.kind === "scan";
  const wrongCode = scanning && notice === "notBindCode";

  // 回到取景（卡片关了、面板收了）：放开「只处理一次」的锁，并把刚处理过的那个码记成「此刻还在镜头里」
  const idle = scanning && !sheetOpen;
  useEffect(() => {
    if (!idle) return;
    scanLock.current = false;
    if (handled.current) handled.current.seenAt = nowMs();
  }, [idle]);
  // 面板不管怎么收的（关闭按钮、点空白、往下拖、返回键、绑上了），键盘都跟着收
  useEffect(() => {
    if (!sheetOpen) Keyboard.dismiss();
  }, [sheetOpen]);

  // Android 返回键：先收面板；成功卡片上等于「完成」，没绑上的卡片上等于「重新扫码」。
  // 只在本页在最上面时接管：绑定途中来了求救、倒计时页盖上来后，这里若跟着 stage 变化重新注册，
  // 会排到倒计时页那份前面，倒数中按返回键就 dismissAll 把倒计时页一起关掉（10-06 F-4）
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        if (sheetOpen) {
          setSheetOpen(false);
          return true;
        }
        if (stage.kind === "done") {
          router.dismissAll();
          return true;
        }
        if (stage.kind === "failed") {
          setViaScan(false);
          setStage({ kind: "scan" });
          return true;
        }
        return false;
      });
      return () => sub.remove();
    }, [sheetOpen, stage.kind]),
  );

  // 扫描线只在真的在扫的时候走。开着读屏或「减弱动态效果」时停在中间不动：
  // Android 上一直在变的 transform 会不停发「内容变了」的无障碍事件，读屏等不到界面静止
  const reducedMotion = useReducedMotion();
  const [screenReader, setScreenReader] = useState(false);
  useEffect(() => {
    let on = true;
    void AccessibilityInfo.isScreenReaderEnabled().then((v) => {
      if (on) setScreenReader(v);
    });
    const sub = AccessibilityInfo.addEventListener(
      "screenReaderChanged",
      setScreenReader,
    );
    return () => {
      on = false;
      sub.remove();
    };
  }, []);
  const lineShown = granted && scanning && !wrongCode && !sheetOpen;
  const lineMoving = lineShown && !reducedMotion && !screenReader;
  const sweep = useSharedValue(0.5);
  useEffect(() => {
    if (!lineMoving) {
      sweep.set(0.5);
      return;
    }
    sweep.set(0);
    sweep.set(
      withRepeat(
        withTiming(1, { duration: 1700, easing: Easing.inOut(Easing.ease) }),
        -1,
        true,
      ),
    );
    return () => cancelAnimation(sweep);
  }, [lineMoving, sweep]);
  const lineStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (sweep.get() - 0.5) * SWEEP }],
  }));
  const frameStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shakeX.get() }],
  }));

  const grab = Gesture.Pan()
    .onUpdate((e) => {
      drag.set(Math.max(0, e.translationY));
    })
    .onEnd(() => {
      if (drag.get() > DISMISS_DRAG) {
        scheduleOnRN(closeSheet);
      } else {
        drag.set(
          withTiming(0, {
            duration: 220,
            easing: Easing.bezier(0.2, 0.8, 0.2, 1),
          }),
        );
      }
    });
  const dragStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: drag.get() }],
  }));

  const recognized = !scanning && viaScan;
  const cornerColor = wrongCode
    ? ON_CAMERA.bad
    : recognized
      ? ON_CAMERA.ok
      : ON_CAMERA.scan;
  const hint = recognized
    ? t("scan.recognized")
    : notice === "notBindCode"
      ? t("scan.notBindCode")
      : notice === "alreadyBound"
        ? t("scan.alreadyBound")
        : notice === "justFailed"
          ? t("scan.justFailed")
          : t("scan.hint");
  const card =
    stage.kind === "binding" || stage.kind === "done" || stage.kind === "failed"
      ? stage
      : null;
  // 面板贴着屏幕底边留 10：里面的下边距把 iPhone 底部横条 / Android 导航条让出来
  const panelPadBottom = Math.max(22, insets.bottom - 2);
  const manualReady = idVal.trim().length > 0 && codeVal.trim().length > 0;

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: granted ? CAMERA_BG : theme.background },
      ]}
    >
      <StatusBar style={granted ? "light" : "auto"} />
      {granted && (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={scanning && !sheetOpen ? onScanned : undefined}
        />
      )}

      <View
        pointerEvents="box-none"
        style={[
          styles.center,
          { paddingTop: insets.top + 52, paddingBottom: insets.bottom + 132 },
        ]}
      >
        {granted ? (
          <>
            {/* 取景框：四角亮线，中间留空 */}
            <Animated.View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={[styles.frame, frameStyle]}
            >
              {/* 四角各垫一圈深色半透明的边：画面是白的（白色说明卡）时亮色的角才分得出来 */}
              {(["tl", "tr", "bl", "br"] as const).map((c) => (
                <View
                  key={`${c}-edge`}
                  style={[styles.corner, styles.cornerEdge, styles[c]]}
                />
              ))}
              {(["tl", "tr", "bl", "br"] as const).map((c) => (
                <View
                  key={c}
                  style={[
                    styles.corner,
                    styles[c],
                    { borderColor: cornerColor },
                  ]}
                />
              ))}
              {lineShown && (
                <Animated.View
                  style={[
                    styles.line,
                    { backgroundColor: ON_CAMERA.scan },
                    lineStyle,
                  ]}
                />
              )}
            </Animated.View>
            <View
              accessibilityLiveRegion="polite"
              style={[
                styles.hint,
                {
                  backgroundColor: wrongCode
                    ? "rgba(185,50,41,0.92)"
                    : "rgba(0,0,0,0.6)",
                },
              ]}
            >
              <ThemedText style={styles.hintText}>{hint}</ThemedText>
            </View>
          </>
        ) : permission ? (
          <View style={styles.permission}>
            <View
              style={[
                styles.permissionIcon,
                { backgroundColor: theme.backgroundSelected },
              ]}
            >
              <Ionicons name="camera-outline" size={30} color={theme.text} />
            </View>
            <ThemedText style={[styles.permissionTitle, { color: theme.text }]}>
              {t("scan.permissionTitle")}
            </ThemedText>
            <ThemedText
              style={[styles.permissionBody, { color: theme.textSecondary }]}
            >
              {t("scan.permissionBody")}
            </ThemedText>
            <PrimaryButton
              title={t(
                permission.canAskAgain ? "scan.allow" : "ble.onboarding.go",
              )}
              onPress={() =>
                void (permission.canAskAgain
                  ? requestPermission()
                  : Linking.openSettings())
              }
              style={styles.permissionBtn}
            />
          </View>
        ) : null}
      </View>

      {/* 画面上下各压一层由深到透明的暗角：镜头对着白墙、白色说明卡时，顶上的关闭钮、标题、状态栏
          和底下的按钮才看得见（2026-10-08 模拟器回归：亮画面上白字白钮整个消失） */}
      {granted && (
        <>
          <View
            pointerEvents="none"
            style={[styles.shadeTop, { height: insets.top + 132 }]}
          />
          <View
            pointerEvents="none"
            style={[styles.shadeBottom, { height: insets.bottom + 190 }]}
          />
        </>
      )}

      <View style={[styles.topBar, { top: insets.top + 8 }]}>
        <Tappable
          feedback="opacity"
          accessibilityRole="button"
          accessibilityLabel={t("common.close")}
          onPress={() => router.back()}
          style={styles.close}
        >
          <Ionicons
            name="close"
            size={22}
            color={granted ? ON_CAMERA.text : theme.text}
          />
        </Tappable>
        <ThemedText
          accessibilityRole="header"
          style={[styles.topTitle, !granted && { color: theme.text }]}
        >
          {t("scan.title")}
        </ThemedText>
        <View style={styles.topSpacer} />
      </View>

      {/* 手动输入的入口：只在取景时出现 */}
      <View
        pointerEvents={scanning ? "auto" : "none"}
        style={[
          styles.bottom,
          { bottom: insets.bottom + 12, opacity: scanning ? 1 : 0 },
        ]}
      >
        <Tappable
          feedback="scale"
          accessibilityRole="button"
          onPress={() => openSheet()}
          style={styles.manual}
        >
          <ThemedText style={styles.manualText}>{t("scan.manual")}</ThemedText>
        </Tappable>
      </View>

      {/* 结果卡片：找到头盔（绑定中）/ 绑定成功 / 没绑上 */}
      {card && (
        <Animated.View
          entering={FadeIn.duration(220)}
          exiting={FadeOut.duration(200)}
          style={styles.mask}
        />
      )}
      {card && (
        <Animated.View
          entering={panelIn}
          exiting={panelOut}
          accessibilityViewIsModal
          style={[
            styles.panel,
            styles.card,
            {
              backgroundColor: theme.backgroundElement,
              borderColor: theme.border,
              paddingBottom: panelPadBottom,
            },
          ]}
        >
          <View style={styles.cardImage}>
            <View
              style={[
                styles.cardHalo,
                {
                  backgroundColor:
                    card.kind === "failed"
                      ? theme.dangerBg
                      : withAlpha(theme.brand, 0.15),
                },
              ]}
            />
            <Image
              source={helmetImageFor(card.deviceId)}
              contentFit="contain"
              style={styles.cardHelmet}
            />
            {card.kind !== "binding" && (
              <Animated.View
                entering={ZoomIn.duration(320).easing(
                  Easing.out(Easing.back(2)),
                )}
                style={[
                  styles.cardBadge,
                  {
                    backgroundColor:
                      card.kind === "done" ? theme.success : theme.danger,
                    borderColor: theme.backgroundElement,
                  },
                ]}
              >
                <Ionicons
                  name={card.kind === "done" ? "checkmark" : "close"}
                  size={20}
                  color={theme.backgroundElement}
                />
              </Animated.View>
            )}
          </View>
          <ThemedText accessibilityRole="header" style={styles.cardTitle}>
            {card.kind === "done"
              ? t("device.bindSuccess")
              : card.kind === "failed"
                ? t("bind.failedTitle")
                : t("bind.found")}
          </ThemedText>
          <ThemedText
            type="code"
            themeColor="textSecondary"
            style={styles.cardId}
          >
            {card.deviceId}
          </ThemedText>
          {(card.kind !== "done" || safetyGap) && (
            <View style={styles.cardBody}>
              {card.kind === "binding" && (
                <DotsLoader color={theme.brand} size={7} />
              )}
              <ThemedText
                themeColor="textSecondary"
                style={styles.cardBodyText}
              >
                {card.kind === "binding"
                  ? t("bind.binding")
                  : card.kind === "failed"
                    ? card.message
                    : t("bind.doneBodySafety")}
              </ThemedText>
            </View>
          )}
          {card.kind !== "binding" && (
            <Animated.View
              entering={FadeIn.duration(220)}
              style={styles.cardActions}
            >
              <PrimaryButton
                title={
                  card.kind === "done" ? t("bind.finish") : t("bind.rescan")
                }
                onPress={
                  card.kind === "done" ? () => router.dismissAll() : rescan
                }
              />
              <Tappable
                feedback="opacity"
                accessibilityRole="button"
                onPress={
                  card.kind === "done"
                    ? rescan
                    : () => {
                        // 填好扫到的内容再打开：码印错了的话改一位就行
                        openSheet({
                          deviceId: card.deviceId,
                          bindCode: card.bindCode,
                        });
                        setViaScan(false);
                        setStage({ kind: "scan" });
                      }
                }
                style={styles.cardLink}
              >
                <ThemedText
                  themeColor="textSecondary"
                  style={styles.cardLinkText}
                >
                  {t(
                    card.kind === "done" ? "bind.another" : "scan.typeInstead",
                  )}
                </ThemedText>
              </Tappable>
            </Animated.View>
          )}
        </Animated.View>
      )}

      {/* 手动输入面板。键盘出来时整块跟着上移；这层容器一直在，面板进出的动画才播得完。
          Android 也要显式让位：内容铺到系统栏底下之后，系统不再替 App 把窗口缩到键盘上方
          （2026-10-08 模拟器实测：只在 iOS 让位时，面板被键盘盖住，「绑定」按钮点不到） */}
      <KeyboardAvoidingView
        pointerEvents="box-none"
        behavior="padding"
        style={styles.sheetLayer}
      >
        {sheetOpen && (
          <Animated.View
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(200)}
            style={styles.mask}
          >
            <Pressable
              accessibilityLabel={t("common.close")}
              style={StyleSheet.absoluteFill}
              onPress={closeSheet}
            />
          </Animated.View>
        )}
        {sheetOpen && (
          <Animated.View
            entering={panelIn}
            exiting={panelOut}
            style={styles.sheetWrap}
          >
            <Animated.View
              accessibilityViewIsModal
              style={[
                styles.sheet,
                {
                  backgroundColor: theme.backgroundElement,
                  borderColor: theme.border,
                  paddingBottom: panelPadBottom,
                },
                dragStyle,
              ]}
            >
              <GestureDetector gesture={grab}>
                <View style={styles.grab}>
                  <View
                    style={[
                      styles.grabBar,
                      { backgroundColor: theme.borderStrong },
                    ]}
                  />
                </View>
              </GestureDetector>
              <View style={styles.sheetHead}>
                <ThemedText
                  accessibilityRole="header"
                  style={styles.sheetTitle}
                >
                  {t("bind.manualTitle")}
                </ThemedText>
                <Tappable
                  feedback="opacity"
                  accessibilityRole="button"
                  accessibilityLabel={t("common.close")}
                  onPress={closeSheet}
                  style={[
                    styles.sheetClose,
                    { backgroundColor: theme.backgroundSelected },
                  ]}
                >
                  <Ionicons name="close" size={20} color={theme.text} />
                </Tappable>
              </View>
              <ScrollView
                bounces={false}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.sheetBody}
              >
                <ThemedText themeColor="textSecondary" style={styles.sheetLead}>
                  {t(codeMissing ? "bind.codeMissing" : "device.bindLead")}
                </ThemedText>
                <FormInput
                  label={t("device.deviceId")}
                  icon="hardware-chip-outline"
                  value={idVal}
                  // 粘进来的是绑定链接（微信扫码落到网页后复制的）：拆成设备号 + 绑定码，不把整条链接当设备号提交
                  onChangeText={(v) => {
                    const link = bindLinkInManualInput(v);
                    if (!link) {
                      setIdVal(v);
                      return;
                    }
                    setIdVal(link.deviceId);
                    if (link.bindCode) setCodeVal(link.bindCode);
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder={t("device.deviceIdPlaceholder")}
                />
                <FormInput
                  label={t("device.bindCode")}
                  icon="key-outline"
                  value={codeVal}
                  onChangeText={setCodeVal}
                  keyboardType="number-pad"
                  // 留出分组空格 / 横线的位置（粘贴「1234 5678」），提交前再规整成 8 位
                  maxLength={BIND_CODE_INPUT_MAX}
                  placeholder={t("device.bindCodePlaceholder")}
                />
                <FormError message={formError} />
                <PrimaryButton
                  title={t("device.bindAction")}
                  onPress={() => void submitManual()}
                  loading={busy}
                  disabled={!manualReady}
                />
              </ScrollView>
            </Animated.View>
          </Animated.View>
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

const CORNER = 30;
const styles = StyleSheet.create({
  root: { flex: 1 },
  center: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 24,
  },
  frame: { width: FRAME, height: FRAME, justifyContent: "center" },
  corner: {
    position: "absolute",
    width: CORNER,
    height: CORNER,
    borderWidth: 4,
  },
  cornerEdge: {
    width: CORNER + 2,
    height: CORNER + 2,
    margin: -1,
    borderWidth: 6,
    borderColor: "rgba(0,0,0,0.3)",
  },
  tl: {
    top: 0,
    left: 0,
    borderRightWidth: 0,
    borderBottomWidth: 0,
    borderTopLeftRadius: 10,
  },
  tr: {
    top: 0,
    right: 0,
    borderLeftWidth: 0,
    borderBottomWidth: 0,
    borderTopRightRadius: 10,
  },
  bl: {
    bottom: 0,
    left: 0,
    borderRightWidth: 0,
    borderTopWidth: 0,
    borderBottomLeftRadius: 10,
  },
  br: {
    bottom: 0,
    right: 0,
    borderLeftWidth: 0,
    borderTopWidth: 0,
    borderBottomRightRadius: 10,
  },
  line: { marginHorizontal: 14, height: 2, borderRadius: 1 },
  hint: {
    maxWidth: 320,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
  },
  hintText: {
    color: ON_CAMERA.text,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: 600,
    textAlign: "center",
  },
  permission: { alignItems: "center", paddingHorizontal: 32, gap: 10 },
  permissionIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.14)",
    marginBottom: 6,
  },
  permissionTitle: {
    color: ON_CAMERA.text,
    fontSize: 20,
    lineHeight: 26,
    fontWeight: 700,
    textAlign: "center",
  },
  permissionBody: {
    color: ON_CAMERA.textDim,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    maxWidth: 300,
  },
  permissionBtn: { marginTop: 14, minWidth: 220 },
  topBar: {
    position: "absolute",
    left: 14,
    right: 14,
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  shadeTop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    experimental_backgroundImage:
      "linear-gradient(to bottom, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.38) 55%, rgba(0,0,0,0) 100%)",
  },
  shadeBottom: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    experimental_backgroundImage:
      "linear-gradient(to top, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.3) 55%, rgba(0,0,0,0) 100%)",
  },
  close: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    // 深色半透明底：亮画面上也看得出是个按钮（原型里是白色半透明，那是画在黑底上的）
    backgroundColor: "rgba(0,0,0,0.38)",
  },
  topTitle: {
    color: ON_CAMERA.text,
    fontSize: 17,
    lineHeight: 24,
    fontWeight: 600,
  },
  topSpacer: { width: 44, height: 44 },
  bottom: { position: "absolute", left: 20, right: 20 },
  manual: {
    height: 56,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.45)",
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  manualText: {
    color: ON_CAMERA.text,
    fontSize: 16,
    lineHeight: 22,
    fontWeight: 700,
  },
  mask: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  panel: { position: "absolute", left: 10, right: 10, bottom: 10 },
  card: {
    alignItems: "center",
    paddingTop: 24,
    paddingHorizontal: 20,
    borderRadius: 24,
    borderWidth: 1,
  },
  cardImage: { width: 120, height: 120 },
  cardHalo: {
    position: "absolute",
    left: 12,
    top: 12,
    width: 96,
    height: 96,
    borderRadius: 48,
  },
  cardHelmet: { width: 120, height: 120 },
  cardBadge: {
    position: "absolute",
    right: 0,
    bottom: 4,
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: {
    marginTop: 12,
    fontSize: 22,
    lineHeight: 28,
    fontWeight: 700,
    textAlign: "center",
  },
  cardId: { marginTop: 4, fontSize: 13, lineHeight: 18 },
  cardBody: {
    minHeight: 40,
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  cardBodyText: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    flexShrink: 1,
  },
  cardActions: { alignSelf: "stretch", marginTop: 14, gap: 10 },
  cardLink: { height: 48, alignItems: "center", justifyContent: "center" },
  cardLinkText: { fontSize: 15, lineHeight: 20, fontWeight: 600 },
  sheetLayer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: "flex-end",
  },
  sheetWrap: { margin: 10, flexShrink: 1 },
  sheet: {
    flexShrink: 1,
    paddingHorizontal: 20,
    borderRadius: 24,
    borderWidth: 1,
  },
  grab: { height: 28, alignItems: "center", justifyContent: "center" },
  grabBar: { width: 38, height: 5, borderRadius: 3 },
  sheetHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  sheetTitle: { fontSize: 20, lineHeight: 26, fontWeight: 700, flexShrink: 1 },
  sheetClose: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetBody: { gap: 12, paddingTop: 6 },
  sheetLead: { fontSize: 13, lineHeight: 19, marginBottom: 4 },
});
