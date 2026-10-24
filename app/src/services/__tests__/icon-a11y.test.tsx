// 优化清单 13：图标字符不拼进按钮的读屏名字——用真的图标组件渲染，看落到 Text 上的属性
import { describe, expect, it } from "@jest/globals";
import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import type { ReactElement } from "react";
import { Pressable, Text } from "react-native";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { hideIconsFromScreenReader } from "../icon-a11y";

async function render(el: ReactElement): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(el);
  });
  return r;
}

describe("hideIconsFromScreenReader", () => {
  it("两套图标的字形 Text 都带上「不进读屏」，原有默认值（不随系统字号放大）和传入的属性照旧", async () => {
    hideIconsFromScreenReader();
    const r = await render(
      <Pressable accessibilityRole="button">
        <Ionicons name="home" size={20} color="red" />
        <MaterialIcons name="home" size={18} />
        <Text>安全记录</Text>
      </Pressable>,
    );
    const glyphs = r.root
      .findAllByType(Text)
      .filter((t) => t.props.children !== "安全记录");
    expect(glyphs.length).toBeGreaterThanOrEqual(2);
    for (const g of glyphs) {
      expect(g.props.accessibilityElementsHidden).toBe(true);
      expect(g.props.importantForAccessibility).toBe("no");
      expect(g.props.allowFontScaling).toBe(false);
    }
    // 按钮里真正的文字不受影响
    const label = r.root
      .findAllByType(Text)
      .find((t) => t.props.children === "安全记录");
    expect(label?.props.accessibilityElementsHidden).toBeUndefined();
  });

  it("调多次不出错、结果一样", async () => {
    hideIconsFromScreenReader();
    hideIconsFromScreenReader();
    const r = await render(<Ionicons name="close" size={16} />);
    const g = r.root.findAllByType(Text)[0];
    expect(g.props.accessibilityElementsHidden).toBe(true);
    expect(g.props.importantForAccessibility).toBe("no");
  });
});
