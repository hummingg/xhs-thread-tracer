#!/usr/bin/env python3
"""生成插件图标：红底 + 白色对话树/链条示意（纯几何绘制，不依赖字体）。"""
from pathlib import Path
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent.parent
OUT = HERE / "icons"
OUT.mkdir(exist_ok=True)

BG = (255, 36, 66)      # 小红书红
FG = (255, 255, 255)


def draw(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 圆角矩形底（带内边距）
    pad = max(1, round(size * 0.03))
    radius = round(size * 0.24)
    d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=radius, fill=BG)

    u = size / 32.0  # 以 32 为设计栅格
    lw = max(1, round(u * 1.9))
    cx = size / 2

    # 顶部节点（楼主）
    d.ellipse([cx - 3.2 * u, 5.0 * u, cx + 3.2 * u, 11.4 * u], fill=FG)

    # 竖直主干
    d.line([cx, 10.0 * u, cx, 27.0 * u], fill=FG, width=lw)

    # 第一层分支（左）：短横 + 节点
    d.line([cx, 15.2 * u, cx - 6.4 * u, 15.2 * u], fill=FG, width=lw)
    d.ellipse([cx - 10.0 * u, 12.4 * u, cx - 3.6 * u, 18.0 * u], fill=FG)

    # 第二层分支（右）：短横 + 节点（体现逐层缩进）
    d.line([cx, 21.6 * u, cx + 6.4 * u, 21.6 * u], fill=FG, width=lw)
    d.ellipse([cx + 3.6 * u, 18.8 * u, cx + 10.0 * u, 24.4 * u], fill=FG)

    # 底部节点
    d.ellipse([cx - 3.2 * u, 24.6 * u, cx + 3.2 * u, 29.0 * u], fill=FG)
    return img


if __name__ == '__main__':
    for s in (16, 32, 48, 128):
        p = OUT / f"icon{s}.png"
        draw(s).save(p)
        print("wrote", p)
