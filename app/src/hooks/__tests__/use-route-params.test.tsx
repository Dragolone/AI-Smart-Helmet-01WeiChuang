// 路由参数取单值（10-22 夜测）：同一个参数在链接里写两次时 expo-router 给数组，页面一律只拿第一个
import { describe, expect, it, jest } from "@jest/globals";
import { act, create } from "react-test-renderer";

import { firstParam, useRouteParams } from "../use-route-params";

let mockRaw: Record<string, string | string[]> = {};
jest.mock("expo-router", () => ({ useLocalSearchParams: () => mockRaw }));

function paramsOf(raw: Record<string, string | string[]>) {
  mockRaw = raw;
  let got: Record<string, string | undefined> = {};
  function Probe() {
    got = useRouteParams<{ sosId?: string; deviceId?: string }>();
    return null;
  }
  act(() => {
    create(<Probe />);
  });
  return got;
}

describe("firstParam", () => {
  it("数组取第一个，单值和没有照旧", () => {
    expect(firstParam(["a", "b"])).toBe("a");
    expect(firstParam("a")).toBe("a");
    expect(firstParam(undefined)).toBeUndefined();
    expect(firstParam([])).toBeUndefined();
  });
});

describe("useRouteParams", () => {
  it("…?sosId=a&sosId=b 只给页面 a；别的参数原样", () => {
    expect(paramsOf({ sosId: ["a", "b"], deviceId: "helmet_1" })).toEqual({
      sosId: "a",
      deviceId: "helmet_1",
    });
  });
  it("空数组的参数当作没给", () => {
    expect(paramsOf({ sosId: [] })).toEqual({});
  });
});
