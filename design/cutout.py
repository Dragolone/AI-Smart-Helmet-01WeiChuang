# 产品图抠图管线(设备卡头盔图等)——把"纯平背景"的生图抠成透明底 webp。
# 用法: python3 design/cutout.py design/helmet-xxx.png app/assets/images/helmet-xxx-vN.webp
#
# 前提(生图时必须满足,写进提示词): 纯色平坦背景、无渐晕、无地面投影、无光晕。
# 背景色任意,关键是"平"(边缘色标准差 <2)。不满足前提的图不要用本脚本硬抠。
#
# 实现要点(2026-08-17 实战结论,勿回退):
# - 洪泛用纯 numpy 迭代膨胀:本机 conda 的 PIL ImageDraw.floodfill 在大图上静默失效
#   (填 0 像素不报错),cv2/scipy 与 numpy ABI 失配不可用;
# - 只清除与图片边界连通的近背景区,镜片等被包围的内部近色区自然保留(免补洞);
# - 输出必须无损 webp(lossless=True):有损编码会把 alpha=0 压漂成几十,重新引入色差;
# - 输出改新文件名(vN 递增):expo-image 按 URI 磁盘缓存,同名换内容看不到更新。
import sys
import numpy as np
from PIL import Image, ImageFilter

BG_TOLERANCE = 6      # 与背景色的最大通道差,平坦背景下 6 足够
FEATHER_PX = 1.2      # 边缘羽化
OUT_SIZE = 720        # 卡片显示 ~128pt@3x=384px,留余量


def flood_from_border(mask: np.ndarray) -> np.ndarray:
    """与边界连通的 True 区域(纯 numpy 迭代膨胀,不依赖任何编译扩展)。"""
    out = np.zeros_like(mask, dtype=bool)
    out[0] = mask[0]
    out[-1] = mask[-1]
    out[:, 0] |= mask[:, 0]
    out[:, -1] |= mask[:, -1]
    prev = 0
    while True:
        grow = out.copy()
        grow[1:] |= out[:-1]
        grow[:-1] |= out[1:]
        grow[:, 1:] |= out[:, :-1]
        grow[:, :-1] |= out[:, 1:]
        out = grow & mask
        n = int(out.sum())
        if n == prev:
            return out
        prev = n


def main(src: str, dst: str) -> None:
    im = Image.open(src).convert('RGB')
    a = np.asarray(im).astype(np.int16)
    ring = np.concatenate([a[:10].reshape(-1, 3), a[-10:].reshape(-1, 3),
                           a[:, :10].reshape(-1, 3), a[:, -10:].reshape(-1, 3)])
    std = ring.std(axis=0).max()
    if std > 2:
        print(f'警告: 背景不平坦(边缘标准差 {std:.1f} > 2),抠图质量无保证——请按提示词要求重出图')
    bg = np.median(ring, axis=0)
    near_bg = np.abs(a - bg).max(axis=2) <= BG_TOLERANCE
    outside = flood_from_border(near_bg)
    alpha = np.where(outside, 0, 255).astype(np.uint8)
    alpha_im = Image.fromarray(alpha, 'L').filter(ImageFilter.MinFilter(3)).filter(
        ImageFilter.GaussianBlur(FEATHER_PX))
    rgba = im.convert('RGBA')
    rgba.putalpha(alpha_im)
    rgba = rgba.resize((OUT_SIZE, OUT_SIZE), Image.LANCZOS)
    rgba.save(dst, 'WEBP', lossless=True)
    # 数值自检:主体外 alpha 必须恒 0
    c = np.asarray(rgba)[:, :, 3]
    edge_max = int(max(c[:45].max(), c[-45:].max(), c[:, :45].max(), c[:, -45:].max()))
    print(f'{dst}: 透明占比 {100 * (c < 10).mean():.0f}%,边缘45px最大alpha {edge_max}'
          f'{"(合格)" if edge_max == 0 else "(不合格!检查背景是否平坦)"}')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('用法: python3 design/cutout.py <输入.png> <输出.webp>')
    main(sys.argv[1], sys.argv[2])
