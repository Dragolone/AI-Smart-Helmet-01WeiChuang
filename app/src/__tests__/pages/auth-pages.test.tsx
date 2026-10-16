// 登录 / 注册 / 找回密码 / 修改密码 / 更换手机号 / 注销账号：本地校验各条分支、提交成功与失败（字段级 / 页面级）、
// 同意勾选门控、发验证码与重发读秒。接口只替换 authApi，短信读秒用真的 useSmsCode。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import * as SecureStore from "expo-secure-store";
import { Alert, Keyboard, Text } from "react-native";
import { act } from "react-test-renderer";
import { mockRouter } from "@/__tests__/helpers/native-mocks";
import {
  flat,
  isHost,
  render,
  waitFor,
  type Rendered,
} from "@/__tests__/helpers/render";
import { authApi } from "@/api/auth";
import { ApiRequestError } from "@/api/client";
import { Colors } from "@/constants/theme";
import { translate, useLocaleStore, type MessageKey } from "@/i18n";
import { useAuthStore } from "@/stores/auth-store";
import { useConsentStore } from "@/stores/consent-store";
import { useThemeStore } from "@/stores/theme-store";
import LoginScreen from "@/app/(auth)/login";
import RegisterScreen from "@/app/(auth)/register";
import ResetPasswordScreen from "@/app/(auth)/reset-password";
import ChangePasswordScreen from "@/app/account/change-password";
import ChangePhoneScreen from "@/app/account/change-phone";
import DeleteAccountScreen from "@/app/account/delete";

jest.mock("@/global.css", () => ({}));
jest.mock("@expo/vector-icons", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .iconsMock(),
);
jest.mock("@expo/vector-icons/Ionicons", () => ({
  __esModule: true,
  default: jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .iconsMock().Ionicons,
}));
jest.mock("react-native-worklets", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .workletsMock(),
);
jest.mock("react-native-reanimated", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .reanimatedMock(),
);
jest.mock("@shopify/react-native-skia", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .skiaMock(),
);
jest.mock("react-native-safe-area-context", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .safeAreaMock(),
);
jest.mock("expo-router", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .expoRouterMock(),
);
jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: "light" },
  NotificationFeedbackType: { Success: "success" },
}));
jest.mock("expo-image", () => {
  const { createElement: h } =
    jest.requireActual<typeof import("react")>("react");
  return { Image: (props: Record<string, unknown>) => h("ExpoImage", props) };
});
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
  AFTER_FIRST_UNLOCK: 0,
}));
jest.mock("@/api/auth", () => ({
  ...jest.requireActual<typeof import("@/api/auth")>("@/api/auth"),
  authApi: {
    login: jest.fn(),
    register: jest.fn(),
    resetPassword: jest.fn(),
    sendSmsCode: jest.fn(),
    changePassword: jest.fn(),
    changePhone: jest.fn(),
    deleteMe: jest.fn(),
  },
}));

const dark = Colors.dark;
const tr = (key: MessageKey, params?: Record<string, string | number>) =>
  translate(key, params, "zh-CN");
const api = authApi as unknown as Record<string, jest.Mock>;
const apiError = (status: number, code: string) =>
  new ApiRequestError(status, { code, message: code });
const AUTH = {
  tokens: { accessToken: "a", refreshToken: "r" },
  user: { id: "u1" },
};
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
/** 页面级错误（FormError）：危险色、不是贴在输入框下面的那一行 */
const pageErrors = (r: Rendered) =>
  r.root
    .findAllByType(Text)
    .filter(
      (t) =>
        flat(t.props.style).color === dark.danger &&
        flat(t.props.style).marginTop !== -6,
    )
    .map((t) => String(t.props.children));
/** 字段级错误：贴在某个输入框下面（FormInput 的 error，上移 6）；返回 [输入框标签, 错误] */
const fieldErrors = (r: Rendered) => {
  const texts = r.root.findAllByType(Text);
  return texts
    .map((t, i) => ({ t, i }))
    .filter(
      ({ t }) =>
        flat(t.props.style).color === dark.danger &&
        flat(t.props.style).marginTop === -6,
    )
    .map(({ i, t }) => {
      // 往前找最近的大写小标签（FormInput 的 label）
      let j = i - 1;
      while (j >= 0 && flat(texts[j].props.style).textTransform !== "uppercase")
        j--;
      return [String(texts[j]?.props.children), String(t.props.children)];
    });
};

let signIn: jest.Mock;
let accept: jest.Mock;
let dismiss: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  useThemeStore.setState({ mode: "dark" });
  useLocaleStore.setState({ locale: "zh-CN" });
  signIn = jest.fn(() => Promise.resolve());
  accept = jest.fn(() => Promise.resolve());
  useAuthStore.setState({
    signIn,
    sessionExpired: false,
    user: null,
    tokens: null,
  } as never);
  useConsentStore.setState({
    hydrated: false,
    privacyAccepted: false,
    accept,
  } as never);
  dismiss = jest.spyOn(Keyboard, "dismiss").mockImplementation(() => undefined);
});
afterEach(() => {
  dismiss.mockRestore();
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe("登录页", () => {
  const P = {
    phone: tr("auth.phonePlaceholder"),
    pwd: tr("auth.passwordPlaceholderLogin"),
  };
  const checkbox = (r: Rendered) =>
    r.root.find(
      (n) =>
        typeof n.type !== "string" &&
        n.props.accessibilityRole === "checkbox" &&
        typeof n.props.onPress === "function",
    );

  it("还没读到同意标记：要勾选；不勾就提交 → 提示先同意，不发请求", async () => {
    const r = render(<LoginScreen />);
    await flush();
    expect(checkbox(r).props.accessibilityState).toEqual({ checked: false });
    r.press(tr("auth.login"));
    expect(pageErrors(r)).toEqual([tr("auth.consentRequired")]);
    expect(api.login).not.toHaveBeenCalled();
  });

  it("记住的手机号会预填；勾选后登录：号码去空格、记下同意、保存号码、建会话", async () => {
    (SecureStore.getItemAsync as jest.Mock).mockImplementationOnce(() =>
      Promise.resolve("13900000042"),
    );
    api.login.mockImplementation(() => Promise.resolve(AUTH));
    const r = render(<LoginScreen />);
    await waitFor(() => expect(r.valueOf(P.phone)).toBe("13900000042"));
    r.type(P.phone, " 13900000042 ");
    r.type(P.pwd, "secret123");
    act(() => checkbox(r).props.onPress());
    r.press(tr("auth.login"));
    await waitFor(() => expect(signIn).toHaveBeenCalledWith(AUTH));
    expect(api.login).toHaveBeenCalledWith({
      phone: "13900000042",
      password: "secret123",
    });
    expect(accept).toHaveBeenCalled();
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      "last_login_phone",
      "13900000042",
    );
  });

  it("这台设备同意过：不显示勾选框，直接登录也不再记同意", async () => {
    useConsentStore.setState({ hydrated: true, privacyAccepted: true });
    api.login.mockImplementation(() => Promise.resolve(AUTH));
    const r = render(<LoginScreen />);
    expect(
      r.root.findAll((n) => n.props.accessibilityRole === "checkbox"),
    ).toHaveLength(0);
    r.press(tr("auth.login"));
    await waitFor(() => expect(signIn).toHaveBeenCalled());
    expect(accept).not.toHaveBeenCalled();
  });

  it("密码错：错误落在密码框下；断网：页面级提示", async () => {
    useConsentStore.setState({ hydrated: true, privacyAccepted: true });
    api.login.mockImplementationOnce(() =>
      Promise.reject(apiError(400, "PASSWORD_INCORRECT")),
    );
    const r = render(<LoginScreen />);
    r.press(tr("auth.login"));
    await waitFor(() =>
      expect(r.allText()).toContain(tr("error.passwordIncorrect")),
    );
    expect(fieldErrors(r)).toEqual([
      [tr("auth.password"), tr("error.passwordIncorrect")],
    ]);
    expect(pageErrors(r)).toEqual([]);
    api.login.mockImplementationOnce(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    r.press(tr("auth.login"));
    await waitFor(() => expect(pageErrors(r)).toEqual([tr("error.network")]));
    expect(signIn).not.toHaveBeenCalled();
  });

  it("被动登出：说明原因；协议链接、注册 / 忘记密码链接、长按 App 名进工程模式", async () => {
    useAuthStore.setState({ sessionExpired: true });
    const r = render(<LoginScreen />);
    expect(r.allText()).toContain(tr("auth.sessionExpiredNotice"));
    expect(r.icons()).toContain("warning-outline");
    r.press(tr("auth.consentTerms"));
    r.press(tr("auth.consentPrivacy"));
    expect(mockRouter.navigate.mock.calls.map((c) => c[0])).toEqual([
      "/legal/terms",
      "/legal/privacy",
    ]);
    expect(dismiss).toHaveBeenCalledTimes(2);
    const links = r.root.findAll((n) => isHost(n, "Link"));
    expect(links.map((l) => l.props.href)).toEqual([
      "/register",
      "/reset-password",
    ]);
    act(() => (links[0].props.onPress as () => void)());
    expect(dismiss).toHaveBeenCalledTimes(3);
    const title = r.root.find(
      (n) =>
        typeof n.props.onLongPress === "function" && typeof n.type !== "string",
    );
    expect(title.props.delayLongPress).toBe(3000);
    act(() => title.props.onLongPress());
    expect(mockRouter.navigate).toHaveBeenLastCalledWith("/ble-bench");
  });

  it("深色用透明商标，浅色用带底的图标（白色的「0」在浅底上看不见）", () => {
    let r = render(<LoginScreen />);
    const darkImg = r.root.find((n) => isHost(n, "ExpoImage")).props;
    expect((darkImg.style as { borderRadius: number }).borderRadius).toBe(0);
    act(() => useThemeStore.setState({ mode: "light" }));
    r = render(<LoginScreen />);
    const lightImg = r.root.findAll((n) => isHost(n, "ExpoImage")).pop()!.props;
    expect(
      (lightImg.style as { borderRadius: number }).borderRadius,
    ).toBeGreaterThan(0);
    expect(lightImg.source).not.toBe(darkImg.source);
  });
});

describe("注册页", () => {
  const P = {
    phone: tr("auth.phonePlaceholder"),
    code: tr("auth.smsCodePlaceholder"),
    pwd: tr("auth.passwordPlaceholder"),
    confirm: tr("auth.confirmPlaceholder"),
    nick: tr("auth.nicknamePlaceholder"),
  };
  const tick = (r: Rendered) =>
    act(() =>
      r.root
        .find(
          (n) =>
            typeof n.type !== "string" &&
            n.props.accessibilityRole === "checkbox" &&
            typeof n.props.onPress === "function",
        )
        .props.onPress(),
    );
  const fill = (r: Rendered, o: Partial<Record<keyof typeof P, string>>) => {
    for (const [k, v] of Object.entries(o)) r.type(P[k as keyof typeof P], v);
  };

  it("发验证码：号码不对就落在手机号上；发出去后按钮读秒、不可再点", async () => {
    jest.useFakeTimers();
    api.sendSmsCode.mockImplementation(() => Promise.resolve());
    const r = render(<RegisterScreen />);
    r.press(tr("auth.getCode"));
    expect(fieldErrors(r)).toEqual([
      [tr("auth.phone"), tr("auth.invalidPhone")],
    ]);
    expect(api.sendSmsCode).not.toHaveBeenCalled();
    fill(r, { phone: "13900000042" });
    r.press(tr("auth.getCode"));
    await flush();
    expect(api.sendSmsCode).toHaveBeenCalledWith({
      phone: "13900000042",
      purpose: "register",
    });
    expect(r.allText()).toContain(tr("auth.resend", { n: 60 }));
    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    expect(r.allText()).toContain(tr("auth.resend", { n: 50 }));
  });

  it("发验证码失败：发得太频繁落在验证码框、号码已注册落到手机号上", async () => {
    api.sendSmsCode.mockImplementationOnce(() =>
      Promise.reject(
        new ApiRequestError(429, { code: "SMS_CODE_TOO_FREQUENT" }),
      ),
    );
    const r = render(<RegisterScreen />);
    fill(r, { phone: "13900000042" });
    r.press(tr("auth.getCode"));
    await waitFor(() =>
      expect(r.allText()).toContain(tr("error.smsCodeTooFrequent")),
    );
    // SMS_CODE_TOO_FREQUENT 含 SMS_CODE：按规则落到验证码框
    expect(fieldErrors(r)).toEqual([
      [tr("auth.smsCode"), tr("error.smsCodeTooFrequent")],
    ]);
    api.sendSmsCode.mockImplementationOnce(() =>
      Promise.reject(apiError(409, "PHONE_ALREADY_REGISTERED")),
    );
    r.press(tr("auth.getCode"));
    await waitFor(() =>
      expect(fieldErrors(r)).toEqual([
        [tr("auth.phone"), tr("error.phoneAlreadyRegistered")],
      ]),
    );
  });

  it("本地校验按顺序：没同意 → 验证码不是 6 位 → 两次密码不一致 → 密码太短", () => {
    const r = render(<RegisterScreen />);
    r.press(tr("auth.registerAndLogin"));
    expect(pageErrors(r)).toEqual([tr("auth.consentRequired")]);
    tick(r);
    fill(r, { code: "12a" });
    r.press(tr("auth.registerAndLogin"));
    expect(fieldErrors(r)).toEqual([
      [tr("auth.smsCode"), tr("auth.invalidCode")],
    ]);
    fill(r, { code: "123456", pwd: "abcdefgh", confirm: "abcdefgx" });
    r.press(tr("auth.registerAndLogin"));
    expect(fieldErrors(r)).toEqual([
      [tr("auth.confirmPassword"), tr("auth.passwordMismatch")],
    ]);
    fill(r, { pwd: "short", confirm: "short" });
    r.press(tr("auth.registerAndLogin"));
    expect(fieldErrors(r)).toEqual([
      [tr("auth.password"), tr("auth.passwordTooShort")],
    ]);
    expect(api.register).not.toHaveBeenCalled();
  });

  it("注册即登录：昵称去空格后才带上；空昵称不带", async () => {
    api.register.mockImplementation(() => Promise.resolve(AUTH));
    const r = render(<RegisterScreen />);
    tick(r);
    fill(r, {
      phone: " 13900000042",
      code: "123456",
      pwd: "abcdefgh",
      confirm: "abcdefgh",
      nick: "  小李 ",
    });
    r.press(tr("auth.registerAndLogin"));
    await waitFor(() => expect(signIn).toHaveBeenCalledWith(AUTH));
    expect(api.register).toHaveBeenCalledWith({
      phone: "13900000042",
      code: "123456",
      password: "abcdefgh",
      nickname: "小李",
    });
    expect(accept).toHaveBeenCalled();
    fill(r, { nick: "   " });
    r.press(tr("auth.registerAndLogin"));
    await waitFor(() => expect(api.register).toHaveBeenCalledTimes(2));
    expect(api.register.mock.calls[1][0]).toEqual({
      phone: "13900000042",
      code: "123456",
      password: "abcdefgh",
    });
  });

  it("服务端说验证码错：落在验证码框；不认识的错：页面级「未知错误」带码", async () => {
    api.register.mockImplementationOnce(() =>
      Promise.reject(apiError(400, "SMS_CODE_INVALID")),
    );
    const r = render(<RegisterScreen />);
    tick(r);
    fill(r, {
      phone: "13900000042",
      code: "123456",
      pwd: "abcdefgh",
      confirm: "abcdefgh",
    });
    r.press(tr("auth.registerAndLogin"));
    await waitFor(() =>
      expect(fieldErrors(r)).toEqual([
        [tr("auth.smsCode"), tr("error.smsCodeInvalid")],
      ]),
    );
    api.register.mockImplementationOnce(() =>
      Promise.reject(apiError(500, "WEIRD")),
    );
    r.press(tr("auth.registerAndLogin"));
    await waitFor(() =>
      expect(pageErrors(r)).toEqual([tr("error.unknown", { code: "WEIRD" })]),
    );
  });

  it("「已有账号」回到栈里的登录页（dismissTo），协议链接先收键盘", () => {
    const r = render(<RegisterScreen />);
    const link = r.root.find((n) => isHost(n, "Link"));
    expect(link.props.href).toBe("/login");
    expect(link.props.dismissTo).toBe(true);
    r.press(tr("auth.consentPrivacy"));
    expect(mockRouter.navigate).toHaveBeenCalledWith("/legal/privacy");
    expect(dismiss).toHaveBeenCalled();
  });
});

describe("找回密码", () => {
  const P = {
    phone: tr("auth.phonePlaceholder"),
    code: tr("auth.smsCodePlaceholder"),
    pwd: tr("auth.passwordPlaceholder"),
    confirm: tr("auth.confirmPlaceholder"),
  };

  it("校验：号码 / 验证码 / 一致 / 长度", async () => {
    const r = render(<ResetPasswordScreen />);
    r.press(tr("auth.getCode"));
    expect(r.allText()).toContain(tr("auth.invalidPhone"));
    r.press(tr("auth.resetPassword"));
    expect(r.allText()).toContain(tr("auth.invalidCode"));
    r.type(P.code, "654321");
    r.type(P.pwd, "abcdefgh");
    r.type(P.confirm, "abcdefgi");
    r.press(tr("auth.resetPassword"));
    expect(r.allText()).toContain(tr("auth.passwordMismatch"));
    r.type(P.pwd, "abc");
    r.type(P.confirm, "abc");
    r.press(tr("auth.resetPassword"));
    expect(r.allText()).toContain(tr("auth.passwordTooShort"));
  });

  it("重置成功：按钮变成功态，画完提示并回登录页", async () => {
    jest.useFakeTimers();
    api.resetPassword.mockImplementation(() => Promise.resolve());
    api.sendSmsCode.mockImplementation(() => Promise.resolve());
    const r = render(<ResetPasswordScreen />);
    r.type(P.phone, "13900000042");
    r.press(tr("auth.getCode"));
    await flush();
    expect(api.sendSmsCode).toHaveBeenCalledWith({
      phone: "13900000042",
      purpose: "reset_password",
    });
    r.type(P.code, "654321");
    r.type(P.pwd, "abcdefgh");
    r.type(P.confirm, "abcdefgh");
    r.press(tr("auth.resetPassword"));
    await flush();
    expect(api.resetPassword).toHaveBeenCalledWith({
      phone: "13900000042",
      code: "654321",
      newPassword: "abcdefgh",
    });
    expect(r.byLabel(tr("auth.resetDoneShort"))).toBeTruthy();
    act(() => {
      jest.advanceTimersByTime(1100);
    });
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it("失败：手机号没注册落到手机号、限频落页面级；「返回登录」收键盘再返回", async () => {
    api.resetPassword.mockImplementationOnce(() =>
      Promise.reject(apiError(404, "PHONE_NOT_REGISTERED")),
    );
    api.sendSmsCode.mockImplementationOnce(() =>
      Promise.reject(new ApiRequestError(429, { code: "RATE_LIMITED" }, 30)),
    );
    const r = render(<ResetPasswordScreen />);
    r.type(P.phone, "13900000042");
    r.press(tr("auth.getCode"));
    await waitFor(() =>
      expect(pageErrors(r)).toEqual([
        tr("error.rateLimitedRetry", { seconds: 30 }),
      ]),
    );
    r.type(P.code, "654321");
    r.type(P.pwd, "abcdefgh");
    r.type(P.confirm, "abcdefgh");
    r.press(tr("auth.resetPassword"));
    await waitFor(() =>
      expect(fieldErrors(r)).toEqual([
        [tr("auth.phone"), tr("error.phoneNotRegistered")],
      ]),
    );
    api.resetPassword.mockImplementationOnce(() =>
      Promise.reject(apiError(500, "INTERNAL_ERROR")),
    );
    r.press(tr("auth.resetPassword"));
    await waitFor(() => expect(pageErrors(r)).toEqual([tr("error.internal")]));
    r.press(tr("auth.backToLogin"));
    expect(dismiss).toHaveBeenCalled();
    expect(mockRouter.back).toHaveBeenCalled();
  });
});

describe("修改密码", () => {
  const P = {
    old: tr("auth.currentPasswordPlaceholder"),
    pwd: tr("auth.passwordPlaceholder"),
    confirm: tr("auth.confirmPlaceholder"),
  };

  it("校验顺序：旧密码太短 → 两次不一致 → 新密码太短 → 超过 72 位", () => {
    const r = render(<ChangePasswordScreen />);
    r.press(tr("common.save"));
    expect(pageErrors(r)).toEqual([tr("auth.passwordTooShort")]);
    r.type(P.old, "oldpass12");
    r.type(P.pwd, "abcdefgh");
    r.type(P.confirm, "abcdefgx");
    r.press(tr("common.save"));
    expect(pageErrors(r)).toEqual([tr("auth.passwordMismatch")]);
    r.type(P.pwd, "abc");
    r.type(P.confirm, "abc");
    r.press(tr("common.save"));
    expect(pageErrors(r)).toEqual([tr("auth.passwordTooShort")]);
    const long = "x".repeat(73);
    r.type(P.pwd, long);
    r.type(P.confirm, long);
    r.press(tr("common.save"));
    expect(pageErrors(r)).toEqual([tr("auth.passwordTooLong")]);
    expect(api.changePassword).not.toHaveBeenCalled();
  });

  it("成功：画完勾提示并返回；旧密码错：页面级提示", async () => {
    jest.useFakeTimers();
    api.changePassword.mockImplementationOnce(() =>
      Promise.reject(apiError(400, "PASSWORD_INCORRECT")),
    );
    const r = render(<ChangePasswordScreen />);
    r.type(P.old, "oldpass12");
    r.type(P.pwd, "newpass12");
    r.type(P.confirm, "newpass12");
    r.press(tr("common.save"));
    await flush();
    expect(pageErrors(r)).toEqual([tr("error.passwordIncorrect")]);
    api.changePassword.mockImplementationOnce(() => Promise.resolve());
    r.press(tr("common.save"));
    await flush();
    expect(api.changePassword).toHaveBeenLastCalledWith({
      oldPassword: "oldpass12",
      newPassword: "newpass12",
    });
    act(() => {
      jest.advanceTimersByTime(1100);
    });
    expect(mockRouter.back).toHaveBeenCalled();
  });
});

describe("更换手机号", () => {
  const P = {
    pwd: tr("auth.currentPasswordPlaceholder"),
    phone: tr("auth.newPhonePlaceholder"),
    code: tr("auth.smsCodePlaceholder"),
  };
  let setUser: jest.Mock;
  beforeEach(() => {
    setUser = jest.fn(() => Promise.resolve());
    useAuthStore.setState({
      user: { id: "u1", phone: "13900000042" },
      setUser,
    } as never);
  });

  it("显示当前号码（脱敏）；新号不合法 / 和当前相同都拦下，发码前也拦", () => {
    const r = render(<ChangePhoneScreen />);
    expect(r.allText()).toContain("139****0042");
    r.press(tr("auth.getCode"));
    expect(pageErrors(r)).toEqual([tr("auth.invalidPhone")]);
    r.type(P.phone, "13900000042");
    r.press(tr("auth.getCode"));
    expect(pageErrors(r)).toEqual([tr("auth.samePhone")]);
    r.press(tr("common.save"));
    expect(pageErrors(r)).toEqual([tr("auth.samePhone")]);
    expect(api.sendSmsCode).not.toHaveBeenCalled();
  });

  it("验证码 / 密码校验；发码用 change_phone；成功后刷新会话档案并返回", async () => {
    jest.useFakeTimers();
    api.sendSmsCode.mockImplementation(() => Promise.resolve());
    const updated = { id: "u1", phone: "13800000001" };
    api.changePhone.mockImplementation(() => Promise.resolve(updated));
    const r = render(<ChangePhoneScreen />);
    r.type(P.phone, "13800000001");
    r.press(tr("auth.getCode"));
    await flush();
    expect(api.sendSmsCode).toHaveBeenCalledWith({
      phone: "13800000001",
      purpose: "change_phone",
    });
    r.press(tr("common.save"));
    expect(pageErrors(r)).toEqual([tr("auth.invalidCode")]);
    r.type(P.code, "111222");
    r.press(tr("common.save"));
    expect(pageErrors(r)).toEqual([tr("auth.passwordTooShort")]);
    r.type(P.pwd, "mypassword");
    r.press(tr("common.save"));
    await flush();
    expect(api.changePhone).toHaveBeenCalledWith({
      newPhone: "13800000001",
      code: "111222",
      password: "mypassword",
    });
    expect(setUser).toHaveBeenCalledWith(updated);
    act(() => {
      jest.advanceTimersByTime(1100);
    });
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it("发码失败 / 提交失败都在页面级说明", async () => {
    api.sendSmsCode.mockImplementationOnce(() =>
      Promise.reject(apiError(409, "PHONE_ALREADY_REGISTERED")),
    );
    api.changePhone.mockImplementationOnce(() =>
      Promise.reject(apiError(400, "SMS_CODE_INVALID")),
    );
    const r = render(<ChangePhoneScreen />);
    r.type(P.phone, "13800000001");
    r.press(tr("auth.getCode"));
    await waitFor(() =>
      expect(pageErrors(r)).toEqual([tr("auth.phoneUsedByOther")]),
    );
    r.type(P.code, "111222");
    r.type(P.pwd, "mypassword");
    r.press(tr("common.save"));
    await waitFor(() =>
      expect(pageErrors(r)).toEqual([tr("error.smsCodeInvalid")]),
    );
    expect(setUser).not.toHaveBeenCalled();
  });
});

describe("注销账号", () => {
  let alert: ReturnType<typeof jest.spyOn>;
  let dropSession: jest.Mock;
  beforeEach(() => {
    alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    dropSession = jest.fn(() => Promise.resolve());
    useAuthStore.setState({ dropSession } as never);
  });
  afterEach(() => alert.mockRestore());
  const pwdBox = () => tr("auth.deletePasswordPlaceholder" as MessageKey);
  const confirmButton = (r: Rendered) =>
    r.root
      .findAll(
        (n) =>
          typeof n.type !== "string" &&
          typeof n.props.onPress === "function" &&
          typeof n.props.title === "string",
      )
      .pop()!;

  it("列出四条后果；密码不足 8 位不弹确认", () => {
    const r = render(<DeleteAccountScreen />);
    for (const k of ["Devices", "Contacts", "Records", "Phone"])
      expect(r.allText()).toContain(
        tr(`auth.deleteConsequence${k}` as MessageKey),
      );
    act(() => confirmButton(r).props.onPress());
    expect(pageErrors(r)).toContain(tr("auth.passwordTooShort"));
    expect(alert).not.toHaveBeenCalled();
  });

  it("确认后注销：清掉预填手机号、只清本地会话；取消那一项什么都不做", async () => {
    api.deleteMe.mockImplementation(() => Promise.resolve());
    const r = render(<DeleteAccountScreen />);
    const input = r.root.find(
      (n) =>
        typeof n.type !== "string" &&
        typeof n.props.onChangeText === "function" &&
        n.props.secureTextEntry !== undefined,
    );
    act(() => input.props.onChangeText("mypassword"));
    act(() => confirmButton(r).props.onPress());
    const [title, body, buttons] = alert.mock.calls[0] as [
      string,
      string,
      { text: string; style: string; onPress?: () => void }[],
    ];
    expect(title).toBe(translate("auth.deleteConfirmTitle"));
    expect(body).toBe(translate("auth.deleteConfirmBody"));
    expect(buttons.map((b) => b.style)).toEqual(["cancel", "destructive"]);
    act(() => buttons[1].onPress!());
    await waitFor(() => expect(dropSession).toHaveBeenCalled());
    expect(api.deleteMe).toHaveBeenCalledWith({ password: "mypassword" });
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(
      "last_login_phone",
    );
    expect(pwdBox).toBeTruthy();
  });

  it("密码错：页面级提示，不清会话", async () => {
    api.deleteMe.mockImplementation(() =>
      Promise.reject(apiError(400, "PASSWORD_INCORRECT")),
    );
    const r = render(<DeleteAccountScreen />);
    const input = r.root.find(
      (n) =>
        typeof n.type !== "string" &&
        typeof n.props.onChangeText === "function" &&
        n.props.secureTextEntry !== undefined,
    );
    act(() => input.props.onChangeText("mypassword"));
    act(() => confirmButton(r).props.onPress());
    const buttons = alert.mock.calls[0][2] as { onPress?: () => void }[];
    act(() => buttons[1].onPress!());
    await waitFor(() =>
      expect(pageErrors(r)).toContain(tr("error.passwordIncorrect")),
    );
    expect(dropSession).not.toHaveBeenCalled();
  });
});
