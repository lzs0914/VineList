import os
from PIL import Image, ImageDraw, ImageFont

OUT = r"C:\Users\Administrator\Documents\Codex\2026-10-28\new-chat\outputs\vine-demo\assets"
os.makedirs(os.path.join(OUT, "demo"), exist_ok=True)

def font(size, bold=False):
    for p in [r"C:\Windows\Fonts\msyhbd.ttc" if bold else r"C:\Windows\Fonts\msyh.ttc",
              r"C:\Windows\Fonts\msyh.ttc"]:
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            pass
    return ImageFont.load_default()

def rr(d, box, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)

# ---- 1. 代码片段 ----
W, H = 660, 410
im = Image.new("RGB", (W, H), "#1c2027")
d = ImageDraw.Draw(im)
for i in range(H):
    t = i / H
    d.line([(0, i), (W, i)], fill=(28 + int(6*t), 32 + int(8*t), 39 + int(10*t)))
for i in range(9):
    y = 22 + i * 40
    d.text((26, y), [ "$", ">", "$", ">", ">", "$", ">", "$", ">"][i], font=font(13), fill="#5f7a63")
cols = ["#7fb3ff", "#c9a0ff", "#8fd48a", "#f0c674", "#7fb3ff"]
for i in range(9):
    x = 52
    y = 24 + i * 40
    for j in range(5):
        w = [70, 120, 64, 150, 90][(i + j) % 5]
        if x + w > W - 30: break
        rr(d, (x, y, x + w, y + 12), 6, fill=cols[(i * 2 + j) % len(cols)])
        x += w + 14
d.text((26, 372), "vine/render.js", font=font(12), fill="#5a6a5e")
im.save(os.path.join(OUT, "demo", "shot-1.png"))

# ---- 2. 报错 ----
W, H = 620, 380
im = Image.new("RGB", (W, H), "#ffffff")
d = ImageDraw.Draw(im)
d.rectangle([0, 0, W, 44], fill="#f5f6f7")
d.text((20, 14), "构建输出", font=font(13, True), fill="#8a9099")
rr(d, (22, 66, W - 22, 300), 10, fill="#fff6f6", outline="#f3c2c2", width=2)
d.text((44, 88), "×  Error: cannot find module 'vine-core'", font=font(15, True), fill="#c0392b")
lines = ["at require (internal/modules/cjs/loader.js:960:19)",
         "at Object.<anonymous> (renderer/main.js:12:18)",
         "at Module._compile (loader.js:1063:30)"]
for i, l in enumerate(lines):
    d.text((44, 128 + i * 26), l, font=font(12), fill="#8a6a6a")
rr(d, (44, 226, 210, 262), 8, fill="#2f6b47")
d.text((74, 236), "npm install", font=font(13, True), fill="#ffffff")
d.text((22, 322), "耗时 4.2s  ·  退出码 1", font=font(12), fill="#9aa0a8")
im.save(os.path.join(OUT, "demo", "shot-2.png"))

# ---- 3. 对照数据 ----
W, H = 640, 390
im = Image.new("RGB", (W, H), "#ffffff")
d = ImageDraw.Draw(im)
d.text((24, 22), "本周数据对照", font=font(16, True), fill="#2c333a")
rr(d, (24, 62, W - 24, 96), 8, fill="#eef4f0")
for i, h in enumerate(["日期", "新增", "完成", "留存"]):
    d.text((44 + i * 148, 72), h, font=font(12, True), fill="#4a7a5e")
for r in range(6):
    y = 96 + r * 42
    if r % 2 == 0:
        d.rectangle([24, y, W - 24, y + 42], fill="#fafcfb")
    for c in range(4):
        d.text((44 + c * 148, y + 14), ["10/21", "10/22", "10/23", "10/24", "10/25", "10/26"][r]
               if c == 0 else str([12, 18, 9, 23, 16, 21][r] - c)[:4], font=font(12), fill="#5b6470")
im.save(os.path.join(OUT, "demo", "shot-3.png"))

# ---- tray icon ----
S = 64
im = Image.new("RGBA", (S*4, S*4), (0,0,0,0))
d = ImageDraw.Draw(im)
d.arc([18, 10, 230, 220], start=200, end=340, fill=(94, 168, 122, 255), width=16)
for i, (x, y, a, s) in enumerate([(60, 44, -30, 1), (150, 30, -30, 1), (120, 60, 30, -1)]):
    d.ellipse([x-2, y-2, x+46, y+26], fill=(140, 212, 168, 255))
im = im.resize((S, S), Image.LANCZOS)
im.save(os.path.join(OUT, "tray.png"))

# ---- app icon ----
im2 = Image.new("RGBA", (256, 256), (0,0,0,0))
d2 = ImageDraw.Draw(im2)
d2.rounded_rectangle([8, 8, 248, 248], radius=56, fill=(37, 74, 54, 255))
d2.arc([40, 40, 216, 200], start=200, end=340, fill=(122, 200, 154, 255), width=10)
for x, y in [(74, 62), (150, 50), (110, 72)]:
    d2.ellipse([x-4, y-4, x+44, y+26], fill=(160, 226, 186, 255))
im2.save(os.path.join(OUT, "icon.png"))

print("assets ok", sorted(os.listdir(OUT)), sorted(os.listdir(os.path.join(OUT, "demo"))))
