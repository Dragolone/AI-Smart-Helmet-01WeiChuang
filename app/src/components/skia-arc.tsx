// 用 Skia 画一段圆弧：底环整段 + 进度弧按 progress（0–1）从起点截取。只给旧绘制管线的安卓用（见 legacy-renderer）
import { Canvas, Group, Path, Skia } from "@shopify/react-native-skia";
import { useMemo } from "react";
import { useDerivedValue, type SharedValue } from "react-native-reanimated";

export function SkiaArc({
  box,
  r,
  w,
  startDeg,
  sweepDeg,
  track,
  color,
  progress,
  opacity,
}: {
  /** 画布边长 */
  box: number;
  /** 弧的中线半径 */
  r: number;
  /** 线宽 */
  w: number;
  /** 起点角度：0° 在三点钟方向，顺时针为正 */
  startDeg: number;
  sweepDeg: number;
  track: string;
  color: string | SharedValue<string>;
  progress: SharedValue<number>;
  /** 进度弧整体的不透明度（电量环没连上时变淡） */
  opacity?: SharedValue<number>;
}) {
  const path = useMemo(() => {
    const p = Skia.Path.Make();
    p.addArc(
      Skia.XYWHRect(box / 2 - r, box / 2 - r, r * 2, r * 2),
      startDeg,
      sweepDeg,
    );
    return p;
  }, [box, r, startDeg, sweepDeg]);
  // 进度为 0 时整段不画：圆头的截取长度为 0 时仍会点出一个圆点
  const visible = useDerivedValue(() =>
    progress.get() > 0 ? (opacity ? opacity.get() : 1) : 0,
  );
  return (
    <Canvas
      pointerEvents="none"
      style={{ position: "absolute", left: 0, top: 0, width: box, height: box }}
    >
      <Path
        path={path}
        style="stroke"
        strokeWidth={w}
        strokeCap="round"
        color={track}
      />
      <Group opacity={visible}>
        <Path
          path={path}
          style="stroke"
          strokeWidth={w}
          strokeCap="round"
          color={color}
          start={0}
          end={progress}
        />
      </Group>
    </Canvas>
  );
}
