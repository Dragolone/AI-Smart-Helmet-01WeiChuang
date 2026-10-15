// 对讲频道的人数跟得上（2026-10-15 华为实测：另一个账号加入后，频道列表一直写「1 位成员」，
// 点开「更多」同一张弹层里写着「1 位成员」却列出两个人）。别人进出频道不会推到这台手机，
// 只能靠切回这一页时重拉、以及成员档案拉回来时校正列表里的人数。页面在 jest 里渲染不了，用源码不变式钉住。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@jest/globals";

const page = readFileSync(
  join(__dirname, "..", "app/(tabs)/intercom.tsx"),
  "utf8",
);

describe("对讲页的频道人数", () => {
  it("切回这一页时重拉频道列表", () => {
    expect(page).toMatch(
      /if \(!focused\) return;\s*void queryClient\.refetchQueries\(\s*\{ queryKey: \["voice-channels"\]/,
    );
  });

  it("成员档案拉回来后，以档案人数校正列表里的 memberCount", () => {
    expect(page).toMatch(/const loadedCount = members\.data\?\.length;/);
    expect(page).toMatch(
      /setQueryData<VoiceChannel\[\]>\(\["voice-channels"\][\s\S]{0,200}memberCount: loadedCount/,
    );
  });

  it("离开这一页时收起上次进房的报错", () => {
    expect(page).toMatch(
      /if \(!focused\) return;[\s\S]{0,400}return \(\) => setJoinError\(null\);\s*\}, \[focused, queryClient\]\);/,
    );
  });
});
