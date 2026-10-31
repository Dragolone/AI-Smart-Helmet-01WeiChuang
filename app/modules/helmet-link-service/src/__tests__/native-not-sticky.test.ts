// 进程被杀后系统不能把前台服务重启回来：重启只有服务没有 JS，通知却写「已连接」。Kotlin 没有单测环境，这里钉源码
import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVICE = join(
  __dirname,
  "../../android/src/main/java/com/lingyiweichuang/linkservice/HelmetLinkService.kt",
);

describe("HelmetLinkService 启动语义", () => {
  it("每条分支都返回 START_NOT_STICKY", () => {
    const source = readFileSync(SERVICE, "utf8");
    expect(source).toContain("return START_NOT_STICKY");
    expect(source).not.toMatch(/START_REDELIVER_INTENT|START_STICKY/);
  });
});
