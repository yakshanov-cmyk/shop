#!/usr/bin/env python3
"""Мгновенные черновики ItalBridge (запускается GitHub Actions по сигналу бота).

  python3 bot/instant.py draft   PAYLOAD='{"group": "..."}'  — пересланный пост → карточка → черновик Александру
  python3 bot/instant.py publish PAYLOAD='{"key": "fwd:..."}' — ✅ на мгновенном черновике → пост в канал + каталог + навигатор

Нужны переменные: BOT_TOKEN (секрет репозитория), GITHUB_TOKEN (для ИИ GitHub Models, права models: read).
Репозиторий публичный — в лог ничего лишнего не печатаем (ни текстов, ни источников).
"""
import base64, io, json, math, os, re, subprocess, sys, time, datetime as dt
import requests
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from card import card, thumb  # noqa: E402

BOT = os.environ.get("BOT_TOKEN", "")
GH = os.environ.get("GITHUB_TOKEN", "")
W = "https://italbridge.italbridge-1cd0ad.workers.dev"
OWNER = 568002310
CHANNEL = -1001620098965
MANAGER = "LanaY777"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = "/tmp/ib"
os.makedirs(TMP, exist_ok=True)
CATS = ["сумки", "обувь", "одежда", "аксессуары", "косметика"]
MSK = dt.timezone(dt.timedelta(hours=3))


def log(*a):
    print(*a, flush=True)


# ---------- Telegram и бот ----------
def tg(method, files=None, **params):
    for attempt in range(5):
        if files:
            r = requests.post(f"https://api.telegram.org/bot{BOT}/{method}", data={k: (json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v) for k, v in params.items()}, files=files, timeout=60)
        else:
            r = requests.post(f"https://api.telegram.org/bot{BOT}/{method}", json=params, timeout=60)
        d = r.json()
        if d.get("ok"):
            return d["result"]
        if d.get("error_code") == 429:
            time.sleep(int(d.get("parameters", {}).get("retry_after", 3)) + 1); continue
        if "message is not modified" in str(d.get("description", "")):
            return None
        raise RuntimeError(f"{method}: {d.get('description')}")
    raise RuntimeError(f"{method}: too many retries")


def api(path, body=None):
    h = {"X-Api-Key": BOT, "User-Agent": "ItalBridge-actions"}
    r = requests.post(W + path, json=body, headers=h, timeout=40) if body is not None else requests.get(W + path, headers=h, timeout=40)
    return r.json()


def download(file_id, path):
    fp = tg("getFile", file_id=file_id)["file_path"]
    r = requests.get(f"https://api.telegram.org/file/bot{BOT}/{fp}", timeout=60)
    r.raise_for_status()
    open(path, "wb").write(r.content)
    return path


def esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def rub(n):
    return f"{int(n):,}".replace(",", " ") + " ₽"


def msk(ms):
    return dt.datetime.fromtimestamp(ms / 1000, MSK).strftime("%d.%m %H:%M")


# ---------- цены ----------
NUM = r"(\d{1,5}(?:[.,]\d{1,2})?)"


def parse_prices(text):
    t = text.replace(" ", " ").replace("€ ", "€").replace(" €", "€")
    m = re.search(NUM + r"€?\s*[-–]\s*(?:\d{1,2}\s*)?%\s*=\s*" + NUM + r"\s*€", t)
    if m:
        a, b = float(m.group(1).replace(",", ".")), float(m.group(2).replace(",", "."))
        return (b, a) if a > b else (b, None)
    m = re.search(r"✅\s*" + NUM + r"\s*€", t)
    if m:
        return float(m.group(1).replace(",", ".")), None
    vals = [float(x.replace(",", ".")) for x in re.findall(NUM + r"\s*(?:€|евро|eur\b)", t, re.I)]
    vals = [v for v in vals if v >= 5]
    if not vals:
        return None, None
    if len(vals) >= 2 and vals[0] > vals[-1] and re.search(r"(→|->|замість|вместо|було|было|старая|стара|знижк|скидк|sale|%)", t, re.I):
        return vals[-1], vals[0]
    return vals[-1], None


def kurs():
    try:
        k = float(requests.get(W + "/kurs", timeout=20).json()["kurs"])
        if 60 < k < 150:
            return k
    except Exception:
        pass
    src = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
    return float(re.search(r"KURS:\s*([\d.]+)", src).group(1))


def price_rub(eur, k):
    return int(math.ceil((eur * k * 1.10 + 1500) / 100 - 1e-9) * 100)


def price_tag(p):
    return "#до15тыс" if p <= 15000 else "#до30тыс" if p <= 30000 else "#до60тыс" if p <= 60000 else "#от60тыс"


def dnum(x):
    s = (f"{x:.2f}".rstrip("0").rstrip(".")) if isinstance(x, float) else str(x)
    return s.replace(".", "d")


# ---------- ИИ (GitHub Models): тип вещи, бренд, перевод ----------
PROMPT = """Ты помогаешь магазину ItalBridge (оригинальные брендовые вещи из Италии) оформить пост из поста поставщика.
Текст поста поставщика (часто на украинском) и фото товара — ниже. Ответь ТОЛЬКО JSON:
{"brand": "официальное написание бренда латиницей, напр. Harmont & Blaine",
 "brand_tag": "бренд латиницей без пробелов и знаков, CamelCase, напр. HarmontBlaine",
 "title": "что за вещь по-русски, со строчной, 1–5 слов: тип вещи + заметная деталь (цвет, материал), напр. «мужская куртка с капюшоном». Только то, что видно на фото или есть в тексте; модели и состав НЕ выдумывай",
 "category": "одна из: сумки | обувь | одежда | аксессуары | косметика",
 "weight": "1 — одежда/сумки/косметика, 2 — верхняя одежда/обувь, 05 — украшения/аксессуары/очки/часы/ремни",
 "sized": true если у такой вещи бывает размер (одежда, верхняя одежда, обувь, ремни, кольца, перчатки), иначе false,
 "size": "размеры из текста по-русски (напр. «только XL», «S, M», «41») или null",
 "colors": "цвета из текста по-русски, если перечислены, иначе null",
 "men": true если вещь мужская,
 "main_photo": номер (с 0) фото, где вещь видна лучше всего целиком (не селфи в зеркале),
 "skip": null или короткая причина по-русски, если пост НЕ товар для продажи: «уже в Украине», «продано», «анонс без товара», «нет цены»}"""


def ai(text, photos):
    if not GH:
        return None
    content = [{"type": "text", "text": PROMPT + "\n\nТЕКСТ ПОСТА:\n" + (text or "(нет текста)")}]
    for p in photos[:4]:
        im = Image.open(p).convert("RGB"); im.thumbnail((512, 512))
        b = io.BytesIO(); im.save(b, "JPEG", quality=80)
        content.append({"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(b.getvalue()).decode(), "detail": "low"}})
    try:
        r = requests.post("https://models.github.ai/inference/chat/completions", timeout=90,
                          headers={"Authorization": "Bearer " + GH, "Content-Type": "application/json", "Accept": "application/vnd.github+json"},
                          json={"model": "openai/gpt-4o-mini", "temperature": 0.2, "response_format": {"type": "json_object"},
                                "messages": [{"role": "user", "content": content}]})
        if r.status_code != 200:
            log("ai status", r.status_code); return None
        return json.loads(r.json()["choices"][0]["message"]["content"])
    except Exception as e:
        log("ai error", type(e).__name__); return None


def fallback(text):
    tag = (re.findall(r"#([A-Za-z][\w&]*)", text) or ["ItalBridge"])[0]
    brand = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", tag)
    t = text.lower()
    cat = "сумки" if re.search(r"сумк|bag|рюкзак|клатч", t) else "обувь" if re.search(r"взутт|обув|кросівк|кроссовк|туфл|черевик|ботин|сапог|чоботи|лофер", t) \
        else "аксессуары" if re.search(r"ремін|ремень|окуляр|очки|гаманець|кошел|шарф|хуст|прикрас|годинник|час", t) \
        else "косметика" if re.search(r"космет|парфум|парфюм|крем|адвент", t) else "одежда"
    return {"brand": brand, "brand_tag": tag, "title": "новинка", "category": cat, "weight": "2" if cat == "обувь" else "05" if cat == "аксессуары" else "1",
            "sized": cat in ("одежда", "обувь"), "size": None, "colors": None, "men": False, "main_photo": 0, "skip": None, "_fallback": True}


# ---------- черновик ----------
def build_caption(a, price, old, disc):
    brand, title = a["brand"], a["title"]
    lines = [f"<b>{esc(brand)}</b> — {esc(title)}", ""]
    lines.append(f"💶 <s>{rub(old)}</s> → <b>{rub(price)}</b> (−{disc} %)" if old else f"💶 <b>{rub(price)}</b>")
    lines.append("📦 Доставка до Москвы — от 1 500 ₽")
    if a.get("colors"):
        lines.append(f"🎨 Цвета: {esc(a['colors'])}")
    if a.get("size"):
        lines.append(f"📏 Размер: {esc(a['size'])}")
    elif a.get("sized"):
        lines.append(f"📏 Размеры — уточняйте у менеджера @{MANAGER}")
    lines += ["", "🇮🇹 Оригинал из Италии · заказ — кнопкой под постом 👇"]
    tags = [f"#{a['brand_tag']}", f"#{a['category']}"] + (["#мужское"] if a.get("men") else []) + (["#скидки"] if old else []) + [price_tag(price)]
    lines.append(" ".join(tags))
    return "\n".join(lines)


def clean(a, text):
    fb = fallback(text)
    for k, v in fb.items():
        if k not in a or a[k] in (None, "") and k not in ("size", "colors", "skip"):
            a[k] = v
    a["brand"] = re.sub(r"[@<>]|https?://\S+", "", str(a["brand"])).strip()[:40] or fb["brand"]
    a["brand_tag"] = re.sub(r"[^A-Za-z0-9]", "", str(a.get("brand_tag") or a["brand"])) or fb["brand_tag"]
    a["title"] = re.sub(r"[@<>#]|https?://\S+", "", str(a["title"])).strip().rstrip(".")[:60] or "новинка"
    a["title"] = a["title"][0].lower() + a["title"][1:] if a["title"][:2].upper() != a["title"][:2] else a["title"]
    if a["category"] not in CATS:
        a["category"] = fb["category"]
    a["weight"] = str(a.get("weight") or "1").replace("0.5", "05").replace("0,5", "05")
    if a["weight"] not in ("1", "2", "05"):
        a["weight"] = fb["weight"]
    for k in ("size", "colors"):
        v = a.get(k)
        a[k] = re.sub(r"[@<>]|https?://\S+", "", str(v)).strip()[:60] if v not in (None, "", "null") else None
    return a


def do_draft(group):
    time.sleep(20)  # ждём, пока дойдут все фото альбома
    q = api("/api/queue").get("queue", [])
    g = next((x for x in q if x["group"] == group), None)
    if not g:
        log("group not in queue"); return
    key = f"{g['src']}:{g['srcMsg']}" if g.get("srcMsg") and re.fullmatch(r"[A-Za-z]\w{3,}", g.get("src") or "") else f"fwd:{group}"
    key = key[:58]
    if api(f"/api/idraft?key={requests.utils.quote(key)}").get("key"):
        log("already drafted"); api("/api/queue/done", {"group": group}); return
    age_h = (time.time() * 1000 - g["date"]) / 3600e3
    src_line = (f"https://t.me/{g['src']}/{g['srcMsg']}" if key != f"fwd:{group}" else f"переслано: {esc(g['src'])}") + f", пост от {msk(g['date'])}"
    if age_h > 48:
        tg("sendMessage", chat_id=OWNER, text=f"⏭ Пропущено (посту больше 2 суток): {src_line}", disable_web_page_preview=True)
        api("/api/queue/done", {"group": group}); return
    text = g.get("text") or ""
    eur, old_eur = parse_prices(text)
    photos = [download(fid, f"{TMP}/p{i}.jpg") for i, fid in enumerate(g["photos"][:6])]
    if not photos:
        tg("sendMessage", chat_id=OWNER, text=f"⏭ Пропущено (в посте нет фото): {src_line}", disable_web_page_preview=True)
        api("/api/queue/done", {"group": group}); return
    a = ai(text, photos) or fallback(text)
    a = clean(a, text)
    if g.get("src", "").lower() == "italianshopsman":
        a["men"] = True
    if a.get("skip") or not eur:
        reason = a.get("skip") or "нет цены в евро"
        tg("sendMessage", chat_id=OWNER, text=f"⏭ Пропущено ({esc(reason)}): {src_line}\nЕсли это ошибка — перешлите пост ещё раз с пояснением менеджеру.", parse_mode="HTML", disable_web_page_preview=True)
        api("/api/queue/done", {"group": group}); return
    k = kurs()
    price = price_rub(eur, k)
    old = price_rub(old_eur, k) if old_eur and old_eur > eur else None
    disc = round((1 - eur / old_eur) * 100) if old else None
    mi = a.get("main_photo") if isinstance(a.get("main_photo"), int) and 0 <= a["main_photo"] < len(photos) else 0
    order = [photos[mi]] + [p for i, p in enumerate(photos) if i != mi]
    out = card(order[:3], a["brand"], a["title"][0].upper() + a["title"][1:], price, old, disc, a.get("colors"), f"{TMP}/card.jpg")
    html = build_caption(a, price, old, disc)
    startapp = f"e{dnum(eur)}" + (f"_o{dnum(old_eur)}" if old else "") + f"_c{a['weight']}_k{dnum(round(k, 2))}"
    calc = f"{eur:g} € × {str(round(k, 2)).replace('.', ',')} × 1,10 + 1 500 → {rub(price)}"
    priv = ["", "———", "🔒 Только для вас (в канал не попадёт):", src_line, f"Курс: {str(round(k, 2)).replace('.', ',')} · {calc}", f"Вес: {a['weight'].replace('05', '0,5')} кг"]
    if a.get("_fallback"):
        priv.append("⚠️ ИИ не ответил — тип вещи не определён, лучше отклонить и переслать позже")
    caption = "⚡ ЧЕРНОВИК — после ✅ выйдет сразу\n\n" + html + "\n".join(priv)
    kb = {"inline_keyboard": [[{"text": "💶 Цена и заказ (проверка)", "url": f"https://t.me/ItalBridgeBot/shop?startapp={startapp}"}],
                              [{"text": "✅ Опубликовать сразу", "callback_data": f"ipub:{key}"}, {"text": "❌ Отклонить", "callback_data": f"irej:{key}"}]]}
    with open(out, "rb") as fh:
        res = tg("sendPhoto", files={"photo": ("card.jpg", fh, "image/jpeg")}, chat_id=OWNER, caption=caption, parse_mode="HTML", reply_markup=kb)
    file_id = res["photo"][-1]["file_id"]
    item = {"brand": a["brand"], "title": a["title"], "price": price, "old": old, "disc": disc, "eur": eur, "oldEur": old_eur if old else None,
            "c": a["weight"], "k": round(k, 2), "cat": a["category"], "men": bool(a.get("men")), "sale": bool(old)}
    api("/api/idraft", {"key": key, "html": html, "file_id": file_id, "startapp": startapp, "item": item, "srcDate": g["date"],
                        "chat": OWNER, "msg": res["message_id"], "brand_tag": a["brand_tag"], "ts": int(time.time() * 1000)})
    api("/api/queue/done", {"group": group})
    log("draft sent")


# ---------- публикация ----------
def git(*args):
    return subprocess.run(["git", "-C", ROOT, *args], check=True, capture_output=True, text=True).stdout


def push_with_retry(msg):
    git("add", "-A", "catalog.json", "img", "bot/navigator.json")
    if not git("status", "--porcelain").strip():
        return
    git("commit", "-q", "-m", msg)
    for i in range(5):
        try:
            git("pull", "-q", "--rebase", "origin", "main"); git("push", "-q", "origin", "HEAD:main"); return
        except subprocess.CalledProcessError:
            time.sleep(3 + 3 * i)
    raise RuntimeError("push failed")


def add_brand_to_nav(tag):
    path = os.path.join(ROOT, "bot", "navigator.json")
    nav = json.load(open(path, encoding="utf-8"))
    m = re.search(r"(🏷 <b>Бренды</b>\n)([^\n]*)", nav["html"])
    if not m:
        return False
    brands = [b.strip() for b in m.group(2).split("·") if b.strip()]
    if f"#{tag}".lower() in [b.lower() for b in brands]:
        return False
    brands = sorted(brands + [f"#{tag}"], key=lambda b: b.lower())
    nav["html"] = nav["html"][:m.start(2)] + " · ".join(brands) + nav["html"][m.end(2):]
    tg("editMessageText", chat_id=CHANNEL, message_id=nav["message_id"], text=nav["html"], parse_mode="HTML", disable_web_page_preview=True,
       reply_markup={"inline_keyboard": [[nav["button"]]]})
    json.dump(nav, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    return True


def do_publish(key):
    d = api(f"/api/idraft?key={requests.utils.quote(key)}")
    if not d.get("key"):
        tg("sendMessage", chat_id=OWNER, text="Не нашёл данные черновика — опубликую в ближайшее окно (~10:00 / ~20:00)."); return
    dec = api(f"/api/dec?key={requests.utils.quote(key)}")
    if dec.get("published") or dec.get("d") != "pub":
        log("nothing to do"); return
    if (time.time() * 1000 - d["srcDate"]) / 3600e3 > 72:
        tg("editMessageReplyMarkup", chat_id=d["chat"], message_id=d["msg"], reply_markup={"inline_keyboard": [[{"text": "⌛ Устарел — не опубликован", "callback_data": "noop"}]]})
        return
    btn = lambda sa: {"inline_keyboard": [[{"text": "💶 Цена и заказ", "url": f"https://t.me/ItalBridgeBot/shop?startapp={sa}"}]]}
    res = tg("sendPhoto", chat_id=CHANNEL, photo=d["file_id"], caption=d["html"], parse_mode="HTML", reply_markup=btn(d["startapp"]))
    n = res["message_id"]
    tg("editMessageReplyMarkup", chat_id=CHANNEL, message_id=n, reply_markup=btn(f"p{n}_" + d["startapp"]))
    api("/api/published", {"key": key, "post": n})
    tg("editMessageReplyMarkup", chat_id=d["chat"], message_id=d["msg"], reply_markup={"inline_keyboard": [[{"text": f"✅ Опубликовано №{n}", "url": f"https://t.me/buyitru/{n}"}]]})
    log("published", n)
    # каталог и навигатор
    try:
        git("pull", "-q", "--rebase", "origin", "main")
        download(d["file_id"], f"{TMP}/pub.jpg")
        thumb(f"{TMP}/pub.jpg", os.path.join(ROOT, "img", f"{n}.jpg"))
        cpath = os.path.join(ROOT, "catalog.json")
        cat = json.load(open(cpath, encoding="utf-8"))
        if not any(i.get("post") == n for i in cat["items"]):
            it = dict(d["item"]); it.update({"post": n, "date": dt.datetime.now(MSK).strftime("%Y-%m-%d"), "img": f"img/{n}.jpg"})
            cat["items"].insert(0, {k: it.get(k) for k in ["post", "brand", "title", "price", "old", "disc", "eur", "oldEur", "c", "k", "cat", "men", "sale", "date", "img"]})
            cat["updated"] = dt.datetime.now(MSK).strftime("%Y-%m-%d")
            json.dump(cat, open(cpath, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        added = add_brand_to_nav(d.get("brand_tag") or re.sub(r"[^A-Za-z0-9]", "", d["item"]["brand"]))
        push_with_retry(f"Каталог: +№{n} (мгновенная публикация)" + (" · навигатор: +бренд" if added else ""))
    except Exception as e:
        log("catalog/nav error", type(e).__name__, str(e)[:200])
        tg("sendMessage", chat_id=OWNER, text=f"Пост №{n} опубликован, но каталог не обновился — обновлю в ближайший запуск.")


if __name__ == "__main__":
    mode = sys.argv[1]
    payload = json.loads(os.environ.get("PAYLOAD") or "{}")
    try:
        if mode == "draft":
            do_draft(payload["group"])
        elif mode == "publish":
            do_publish(payload["key"])
    except Exception as e:
        log("error", type(e).__name__, str(e)[:300])
        try:
            tg("sendMessage", chat_id=OWNER, text=f"⚠️ Мгновенный {'черновик' if mode == 'draft' else 'пост'} не получился ({type(e).__name__}). Пост останется в очереди — его возьмёт ближайший запуск (~9:00 / ~19:00).")
        except Exception:
            pass
        sys.exit(1)
