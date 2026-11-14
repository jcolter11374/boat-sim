import json, sys, os
from PIL import Image, ImageDraw, ImageFont
import numpy as np
fr = os.environ.get("FR", "/tmp/claude-0/cine2/fr")
font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 13) if os.path.exists("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf") else ImageFont.load_default()
def orange_box(im):
    a = np.asarray(im).astype(int)
    m = (a[:,:,0] > 120) & (a[:,:,0] - a[:,:,1] > 45) & (a[:,:,1] - a[:,:,2] > -10) & (a[:,:,2] < 120)
    ys, xs = np.nonzero(m)
    if len(xs) < 30: return None
    x0, x1 = np.percentile(xs, [1, 99]); y0, y1 = np.percentile(ys, [1, 99])
    return int(x1 - x0), int(y1 - y0)
name = sys.argv[1]; seg = len(sys.argv) > 2
boxes = json.load(open(f"{fr}/{name}.boxes.json"))
idx = list(range(4, 480, 40))
W, H = 480, 270
sheet = Image.new("RGB", (W * 4, (H + 22) * 3), "white")
d = ImageDraw.Draw(sheet)
rows = []
for k, i in enumerate(idx):
    im = Image.open(f"{fr}/{name}/f{i:05d}.jpg").convert("RGB")
    shot = boxes[i]["shot"]
    if seg:
        ob = orange_box(im); w, h = ob if ob else (0, 0); how = "hull px"
    else:
        b = boxes[i]["box"] or {"w": 0, "h": 0}; w, h = b["w"], b["h"]; how = "box px" if not os.environ.get("LOOSE") else "loose box px"
    wp, hp = 100 * w / 960, 100 * h / 468  # picture height inside the letterbox
    rows.append((i / 8, shot, w, h, wp, hp))
    x, y = (k % 4) * W, (k // 4) * (H + 22)
    sheet.paste(im.resize((W, H)), (x, y))
    d.text((x + 4, y + H + 3), f"{i/8:4.1f}s {shot}: {w}x{h} {how} = {wp:.0f}% wide, {hp:.0f}% tall", fill="black", font=font)
sheet.save(os.path.join(os.environ.get("OUT", "/tmp/claude-0/cine2/sheets/"), name + ".jpg"), quality=88)
mn = min(r[4] for r in rows)
print(name, "smallest width %.1f%%" % mn, [f"{r[1]} {r[4]:.0f}%" for r in rows])
