#!/usr/bin/env python3
"""生成插件图标：一枚「已读勾 + 书本」的简约图标，多尺寸 PNG。"""
import os
import sys
from PIL import Image, ImageDraw

out_dir = sys.argv[1] if len(sys.argv) > 1 else "dist/icons"
# 可选第二个参数：写一个固定路径的大图（给 macOS app 图标 / .icns 用）
big_out = sys.argv[2] if len(sys.argv) > 2 else None
os.makedirs(out_dir, exist_ok=True)

S = 512  # 先画大图再缩放，边缘更干净
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角底板
r = int(S * 0.22)
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=(229, 72, 77, 255))

# 书本（两页）
m = S * 0.20
mid = S / 2
top = S * 0.28
bottom = S * 0.76
w = (S - 2 * m) / 2 - S * 0.02
d.rounded_rectangle([m, top, mid - S * 0.015, bottom], radius=S * 0.03, fill=(255, 255, 255, 240))
d.rounded_rectangle([mid + S * 0.015, top, S - m, bottom], radius=S * 0.03, fill=(255, 255, 255, 240))

# 书脊
d.rectangle([mid - S * 0.012, top, mid + S * 0.012, bottom], fill=(229, 72, 77, 255))

# 已读勾
stroke = int(S * 0.085)
pts = [(S * 0.34, S * 0.55), (S * 0.46, S * 0.67), (S * 0.68, S * 0.40)]
for i in range(len(pts) - 1):
    d.line([pts[i], pts[i + 1]], fill=(34, 160, 92, 255), width=stroke, joint="curve")
for p in pts:
    d.ellipse([p[0] - stroke / 2, p[1] - stroke / 2, p[0] + stroke / 2, p[1] + stroke / 2], fill=(34, 160, 92, 255))

if big_out:
    # macOS Big Sur 风格：1024 画布，内容缩到 80% 居中，留出系统要求的边距
    canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    inner = img.resize((820, 820), Image.LANCZOS)
    canvas.paste(inner, ((1024 - 820) // 2, (1024 - 820) // 2), inner)
    canvas.save(big_out)

for size in (16, 32, 48, 128):
    img.resize((size, size), Image.LANCZOS).save(os.path.join(out_dir, f"icon{size}.png"))

print("icons written to", out_dir)