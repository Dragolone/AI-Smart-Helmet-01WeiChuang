// App 回到前台时刷新数据（2026-10-15 iPhone 实测：另一台手机删光联系人后，这台「安全」格一直写「配置正常」）。
// 根布局在 jest 里渲染不了，用源码不变式钉住，同 audit-realtime-wiring 的做法。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@jest/globals";

const layout = readFileSync(join(__dirname, "..", "app/_layout.tsx"), "utf8");

describe("TanStack Query 的前台刷新接在 AppState 上", () => {
  it("根布局用 focusManager.setEventListener 接 AppState：只有 background 算失焦（iOS 的 inactive 时页面还在屏上）", () => {
    expect(layout).toMatch(/focusManager\.setEventListener\(/);
    expect(layout).toMatch(
      /AppState\.addEventListener\("change",[\s\S]{0,80}setFocused\(state !== "background"\)/,
    );
  });
});
