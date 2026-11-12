# Карточка товара ItalBridge v2 (1080×1350). Тот же рисунок, что в задаче по расписанию.
# card([фото_главное, фото2, фото3], 'Бренд', 'Название вещи', цена_руб, старая_руб|None, скидка_%|None, colors|None, out)
import os
from PIL import Image, ImageDraw, ImageFont, ImageOps

_HERE = os.path.dirname(os.path.abspath(__file__))
F = os.path.join(_HERE, "fonts") + "/"
if not os.path.exists(F + "Inter-Regular.otf"):
    F = "/usr/share/fonts/opentype/inter/"


def f(n, s):
    return ImageFont.truetype(F + n, s)


G = (15, 61, 46); BG = (247, 244, 238); TER = (200, 65, 43); GR = (140, 140, 140); TXT = (35, 35, 35)


def fmt(n):
    return f"{n:,}".replace(",", " ") + " ₽"


def card(photos, brand, title, price, old=None, disc=None, colors=None, out="c.jpg"):
    W, H = 1080, 1350
    im = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, 120], fill=G)
    d.ellipse([54, 30, 114, 90], fill=BG)
    d.text((84, 61), "IB", font=f("InterDisplay-Bold.otf", 24), fill=G, anchor="mm")
    fw = f("InterDisplay-Bold.otf", 36); xx = 134
    for c in "ITALBRIDGE":
        d.text((xx, 60), c, font=fw, fill=BG, anchor="lm"); xx += d.textlength(c, font=fw) + 3
    t = "ОРИГИНАЛ ИЗ ИТАЛИИ"; ft = f("Inter-Medium.otf", 25); x = W - 54
    ws = [d.textlength(c, font=ft) + 3 for c in t]; x -= sum(ws)
    for c, w in zip(t, ws):
        d.text((x, 60), c, font=ft, fill=BG, anchor="lm"); x += w
    d.rectangle([0, 120, 360, 128], fill=(0, 146, 70)); d.rectangle([360, 120, 720, 128], fill=(255, 255, 255)); d.rectangle([720, 120, W, 128], fill=(206, 43, 55))
    top, bot, m, gap = 138, 953, 8, 8

    def put(p, box):
        x0, y0, x1, y1 = box; src = Image.open(p).convert("RGB")
        c = src.getpixel((2, 2)); white = min(c) > 235
        ph = ImageOps.pad(src, (x1 - x0, y1 - y0), Image.LANCZOS, color=(255, 255, 255)) if white else ImageOps.fit(src, (x1 - x0, y1 - y0), Image.LANCZOS, centering=(0.5, 0.4))
        im.paste(ph, (x0, y0))

    if len(photos) == 1:
        put(photos[0], (m, top, W - m, bot))
    else:
        bx = m + int((W - 2 * m) * 2 / 3)
        put(photos[0], (m, top, bx, bot))
        if len(photos) >= 3:
            mid = (top + bot) // 2
            put(photos[1], (bx + gap, top, W - m, mid - gap // 2)); put(photos[2], (bx + gap, mid + gap // 2, W - m, bot))
        else:
            put(photos[1], (bx + gap, top, W - m, bot))

    def spaced(x, y, t, ft, fill, sp):
        for c in t:
            d.text((x, y), c, font=ft, fill=fill, anchor="ls"); x += d.textlength(c, font=ft) + sp

    # длинный бренд/название — уменьшаем шрифт, чтобы влезло
    bs = 40
    while bs > 26 and sum(d.textlength(c, font=f("InterDisplay-Bold.otf", bs)) + 4 for c in brand.upper()) > W - 108: bs -= 2
    spaced(54, 1022, brand.upper(), f("InterDisplay-Bold.otf", bs), G, 4)
    ts = 32
    while ts > 22 and d.textlength(title, font=f("Inter-Regular.otf", ts)) > W - 108: ts -= 2
    d.text((54, 1075), title, font=f("Inter-Regular.otf", ts), fill=TXT, anchor="ls")
    py = 1190 if not old else 1218
    if old:
        fo = f("Inter-Medium.otf", 32); ot = fmt(old)
        d.text((54, 1128), ot, font=fo, fill=GR, anchor="ls"); ow = d.textlength(ot, font=fo)
        d.line([54, 1117, 54 + ow, 1117], fill=GR, width=3)
        dt = f"−{disc} %"; fd = f("Inter-Bold.otf", 28); dw = d.textlength(dt, font=fd)
        d.rounded_rectangle([54 + ow + 18, 1096, 54 + ow + 18 + dw + 28, 1136], radius=8, fill=TER)
        d.text((54 + ow + 32, 1116), dt, font=fd, fill=BG, anchor="lm")
    d.text((50, py), fmt(price), font=f("InterDisplay-Bold.otf", 86), fill=TER, anchor="ls")
    fs = f("Inter-Regular.otf", 27)
    d.text((W - 54, 1135), "Доставка до Москвы", font=fs, fill=(70, 70, 70), anchor="rs")
    d.text((W - 54, 1172), "от 1 500 ₽", font=fs, fill=(70, 70, 70), anchor="rs")
    if colors:
        d.text((54, 1245), colors, font=f("Inter-Regular.otf", 26), fill=(90, 90, 90), anchor="ls")
    d.rectangle([0, 1285, W, H], fill=G)
    d.text((W // 2, 1318), "t.me/buyitru · заказ в один клик под постом", font=f("Inter-Medium.otf", 25), fill=BG, anchor="mm")
    im.save(out, quality=92)
    return out


def thumb(card_path, out):
    """Миниатюра для каталога: область фото карточки → 600×456."""
    im = Image.open(card_path).convert("RGB")
    if im.size == (1080, 1350):
        im = im.crop((8, 138, 1072, 953))
    else:  # картинка из канала 640×800
        im = im.crop((4, 83, 636, 565))
    im.resize((600, 456), Image.LANCZOS).save(out, quality=84)
    return out
