// 合规门控（B 线 2026-09-23 第 13 项）的两条不变式，钉在测试里：
//   ① 注册页必须有「同意协议」勾选，默认不勾，不勾不得发起注册请求；
//   ② 隐私政策 / 用户服务协议只能有一个来源——后端托管版，App 内不得再内置正文。
// 为什么用源码断言而不是渲染断言：本仓库的 jest（jest-expo + react-test-renderer + React 19）
// 渲染带 hooks 的屏幕组件会挂在 dispatcher 上（现有组件测试都是 class 组件，没踩到）；
// 为一条门控改测试栈不划算，先用源码不变式兜住「被误删/被绕过」这个最主要的退化风险。
// ⚠️ 这测不了交互是否真的好使：勾选框能不能点、书名号会不会连带切换勾选，
//    仍要真机各点一次（REGRESSION 1.1）。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@jest/globals";

import {
  consentModalVisible,
  LEGAL_DOCS,
  legalOrigin,
  legalUrl,
  parseLegalDoc,
} from "../constants/legal";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("注册页同意勾选", () => {
  const src = read("app/(auth)/register.tsx");

  it("有 checkbox 角色的控件", () => {
    expect(src).toContain('accessibilityRole="checkbox"');
  });

  it("默认不勾选", () => {
    expect(src).toMatch(/useState\(false\)/);
    expect(src).toContain("const [consented, setConsented] = useState(false)");
  });

  it("未勾选时 submit 直接返回，早于任何网络调用", () => {
    const body = src.slice(src.indexOf("const submit = async"));
    const guard = body.indexOf("if (!consented)");
    const call = body.indexOf("authApi.register");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(call).toBeGreaterThan(guard);
    // 守卫和它的 return 之间不能插进别的语句
    expect(body.slice(guard, guard + 120)).toContain("return;");
  });

  it("两份文档各有一个入口", () => {
    expect(src).toContain('router.navigate("/legal/terms")');
    expect(src).toContain('router.navigate("/legal/privacy")');
  });
});

describe("法律文档单一来源", () => {
  it("字典里不再内置正文章节", () => {
    const dict = read("i18n/messages/legal.ts");
    // 旧草案的章节 key 形如 legal.privacy.s1.p；一条都不该再有
    expect(dict).not.toMatch(/legal\.(privacy|terms)\.s\d+\./);
  });

  it("阅读页走 WebView 打托管地址，不再本地渲染章节", () => {
    const page = read("app/legal/[doc].tsx");
    expect(page).toContain("react-native-webview");
    expect(page).toContain("legalUrl");
    expect(page).not.toContain("sections.map");
  });

  it("地址跟着 EXPO_PUBLIC_API_URL 走，换后端不用改代码", () => {
    expect(legalUrl("privacy", "https://dev-api.01weichuang.com/api/v1")).toBe(
      "https://dev-api.01weichuang.com/legal/privacy",
    );
    expect(legalUrl("terms", "http://192.168.1.111:3000/api/v1")).toBe(
      "http://192.168.1.111:3000/legal/terms",
    );
  });

  it("API base 配坏时返回空串而不是抛异常", () => {
    expect(legalOrigin("这不是个 URL")).toBe("");
    expect(legalUrl("privacy", "")).toBe("");
  });
});

describe("两份清单入口（LAUNCH_CHECKLIST A-6）", () => {
  it("四份文档都有地址；路由参数认不出时回隐私政策", () => {
    expect([...LEGAL_DOCS]).toEqual([
      "privacy",
      "terms",
      "collection",
      "sharing",
    ]);
    expect(legalUrl("collection", "https://api.01weichuang.com/api/v1")).toBe(
      "https://api.01weichuang.com/legal/collection",
    );
    expect(parseLegalDoc("sharing")).toBe("sharing");
    expect(parseLegalDoc("../../etc/passwd")).toBe("privacy");
    expect(parseLegalDoc(undefined)).toBe("privacy");
  });

  it("「我的」页有两份清单的入口，三语都有文案", () => {
    const profile = read("app/(tabs)/profile.tsx");
    expect(profile).toContain('router.navigate("/legal/collection")');
    expect(profile).toContain('router.navigate("/legal/sharing")');
    const dict = read("i18n/messages/legal.ts");
    expect(dict.match(/"legal\.collection\.title"/g)).toHaveLength(3);
    expect(dict.match(/"legal\.sharing\.title"/g)).toHaveLength(3);
  });
});

describe("协议页在同意之前必须读得到（2026-10-05 评审）", () => {
  const layout = read("app/_layout.tsx");
  /** 截出某个 `<Stack.Protected guard={...}>` 块的源码 */
  const protectedBlock = (guard: string): string => {
    const open = layout.indexOf(`<Stack.Protected guard={${guard}}>`);
    expect(open).toBeGreaterThanOrEqual(0);
    const close = layout.indexOf("</Stack.Protected>", open);
    return layout.slice(open, close);
  };

  it("legal/[doc] 不在任何登录门控组里：未登录时登录页 / 注册页的链接点了要能打开", () => {
    // expo-router 把 guard 为 false 的组内 screen 整个剔出导航器，push 过去没有任何反应——
    // 用户只能在读不到正文的情况下勾「已阅读并同意」
    expect(layout).toContain('name="legal/[doc]"');
    expect(protectedBlock("authed")).not.toContain("legal/[doc]");
    expect(protectedBlock("!authed")).not.toContain("legal/[doc]");
  });

  it("登录页也有两份文档的入口", () => {
    const login = read("app/(auth)/login.tsx");
    expect(login).toContain('router.navigate("/legal/terms")');
    expect(login).toContain('router.navigate("/legal/privacy")');
  });

  const base = { authed: true, hydrated: true, accepted: false };

  it("升级用户的同意弹窗：已登录、标记读完、未同意时显示", () => {
    expect(consentModalVisible({ ...base, pathname: "/" })).toBe(true);
    expect(consentModalVisible({ ...base, pathname: "/safety" })).toBe(true);
    expect(consentModalVisible({ ...base, authed: false, pathname: "/" })).toBe(
      false,
    );
    expect(
      consentModalVisible({ ...base, hydrated: false, pathname: "/" }),
    ).toBe(false);
    expect(
      consentModalVisible({ ...base, accepted: true, pathname: "/" }),
    ).toBe(false);
  });

  it("弹窗在协议页上让路：它自己的链接打开的正文不能被它盖住", () => {
    for (const doc of LEGAL_DOCS) {
      expect(consentModalVisible({ ...base, pathname: `/legal/${doc}` })).toBe(
        false,
      );
    }
  });

  it("弹窗在倒计时页上让路：「我没事」不能被一张同意卡片挡住", () => {
    expect(consentModalVisible({ ...base, pathname: "/sos-active" })).toBe(
      false,
    );
  });

  it("弹窗组件用的就是这条规则，且让路时不卸载勾选状态所在的组件", () => {
    const modal = read("components/privacy-consent-modal.tsx");
    expect(modal).toContain("consentModalVisible({");
    expect(modal).toContain("usePathname()");
  });
});
