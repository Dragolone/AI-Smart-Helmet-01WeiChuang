import { describe, expect, it } from "@jest/globals";

import { profilePatch } from "../profile-patch";

const user = { nickname: "骑手", avatarUrl: "data:image/jpeg;base64,AAA" };

describe("profilePatch：编辑资料只发改过的字段", () => {
  it("只换头像时不带昵称（不把本机旧昵称写回去）", () => {
    expect(profilePatch(user, "骑手", "data:image/jpeg;base64,BBB")).toEqual({
      avatarUrl: "data:image/jpeg;base64,BBB",
    });
  });

  it("只改昵称时不带头像", () => {
    expect(profilePatch(user, "新名字", user.avatarUrl)).toEqual({
      nickname: "新名字",
    });
  });

  it("什么都没改返回 null", () => {
    expect(profilePatch(user, "骑手", user.avatarUrl)).toBeNull();
  });

  it("昵称前后空格不算改动；改动时发 trim 后的值", () => {
    expect(profilePatch(user, "  骑手  ", user.avatarUrl)).toBeNull();
    expect(profilePatch(user, "  新名字 ", user.avatarUrl)).toEqual({
      nickname: "新名字",
    });
  });

  it("清空昵称算改动，发空串", () => {
    expect(profilePatch(user, "   ", user.avatarUrl)).toEqual({ nickname: "" });
  });

  it("头像草稿为空（没选过、原来也没有）不发头像", () => {
    expect(
      profilePatch({ nickname: null, avatarUrl: null }, "", null),
    ).toBeNull();
  });

  it("本机还没有用户资料时：填了昵称就发", () => {
    expect(profilePatch(null, "骑手", null)).toEqual({ nickname: "骑手" });
    expect(profilePatch(undefined, "", null)).toBeNull();
  });
});
