#!/usr/bin/env python3
"""Публикует одобренные отзывы: канал @buyitru + reviews.json + img/reviews/.
Запуск из корня репозитория: BOT_TOKEN=... python3 bot/publish_reviews.py
Вывод — итог для отчёта. Без одобренных отзывов ничего не меняет.
Порядок по каждому отзыву: фото → пост в канале → reviews.json → commit+push → /api/reviews/done.
"""
import html, io, json, os, subprocess, sys, time, urllib.error, urllib.request
from datetime import datetime, timedelta, timezone
from PIL import Image, ImageOps

TOKEN = os.environ["BOT_TOKEN"]
TG = os.environ.get("TG_API", "https://api.telegram.org")
WORKER = os.environ.get("WORKER_URL", "https://italbridge.italbridge-1cd0ad.workers.dev")
CHANNEL = os.environ.get("CHANNEL_ID", "-1001620098965")
NO_GIT = os.environ.get("NO_GIT") == "1"
UA = {"User-Agent": "curl/8"}  # Cloudflare отклоняет Python-urllib
MSK = timezone(timedelta(hours=3))


def req(url, body=None, headers=None):
    h = {**UA, **(headers or {})}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h), timeout=60) as r:
        return r.read()


def tg(method, body):
    j = json.loads(req(f"{TG}/bot{TOKEN}/{method}", body))
    if not j.get("ok"):
        raise RuntimeError(f"{method}: {j.get('description')}")
    return j["result"]


def api(path, body=None):
    return json.loads(req(WORKER + path, body, {"X-Api-Key": TOKEN}))


def save_photo(file_id, rid):
    path = tg("getFile", {"file_id": file_id})["file_path"]
    raw = req(f"{TG}/file/bot{TOKEN}/{path}")
    im = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("RGB")
    im.thumbnail((900, 900), Image.LANCZOS)
    os.makedirs("img/reviews", exist_ok=True)
    rel = f"img/reviews/{rid}.jpg"
    im.save(rel, quality=84)
    return rel


def caption(r):
    stars = "⭐" * r["rating"]
    text = r.get("text") or ""
    if len(text) > 800:
        text = text[:800].rstrip() + "…"
    parts = [f"{stars} <b>Отзыв покупателя</b>", ""]
    if text:
        parts += [f"«{html.escape(text, quote=False)}»", ""]
    parts += [f"— {html.escape(r['name'], quote=False)}", f"🛍 {html.escape(r['item'], quote=False)}", "", "#отзывы"]
    return "\n".join(parts)


def git(*a):
    subprocess.run(["git", *a], check=True, capture_output=True, text=True)


def commit(rid):
    if NO_GIT:
        return
    git("add", "reviews.json", *(["img/reviews"] if os.path.isdir("img/reviews") else []))
    git("commit", "-m", f"Отзыв {rid}")
    for attempt in range(3):
        try:
            git("fetch", "origin", "main")
            git("rebase", "origin/main")
            git("push", "origin", "HEAD:main")
            return
        except subprocess.CalledProcessError:
            if attempt == 2:
                raise
            time.sleep(5)


def main():
    try:
        pending = api("/api/reviews?status=approved")["reviews"]
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print("Отзывы: код отзывов в боте ещё не выложен — пропускаю")
            return
        raise
    if not pending:
        print("Отзывы: новых одобренных нет")
        return
    with open("reviews.json", encoding="utf8") as f:
        data = json.load(f)
    first = not data["items"]
    done, failed = [], []
    for r in pending:
        rid = r["id"]
        try:
            if any(x["id"] == rid for x in data["items"]):  # уже в ленте: прошлый запуск оборвался до /done
                api("/api/reviews/done", {"id": rid, "post": next(x for x in data["items"] if x["id"] == rid)["reviewPost"]})
                continue
            img = save_photo(r["photo"], rid) if r.get("photo") else None
            kb = {"inline_keyboard": [[{"text": "⭐ Все отзывы", "url": "https://t.me/ItalBridgeBot/shop?startapp=reviews"}]]}
            if r.get("photo"):
                m = tg("sendPhoto", {"chat_id": CHANNEL, "photo": r["photo"], "caption": caption(r), "parse_mode": "HTML", "reply_markup": kb})
            else:
                m = tg("sendMessage", {"chat_id": CHANNEL, "text": caption(r), "parse_mode": "HTML", "reply_markup": kb})
            post = m["message_id"]
            data["items"].insert(0, {"id": rid, "name": r["name"], "rating": r["rating"], "text": r.get("text") or "", "item": r["item"],
                                     "post": r.get("post"), "reviewPost": post, "date": datetime.now(MSK).strftime("%Y-%m-%d"), "img": img})
            data["updated"] = datetime.now(MSK).strftime("%Y-%m-%d")
            with open("reviews.json", "w", encoding="utf8") as f:
                json.dump(data, f, ensure_ascii=False, indent=1)
                f.write("\n")
            commit(rid)
            api("/api/reviews/done", {"id": rid, "post": post})
            done.append(f"{rid}→№{post}")
        except Exception as e:
            failed.append(f"{rid}: {type(e).__name__}")
    print("Отзывы: опубликовано " + str(len(done)) + (" (" + ", ".join(done) + ")" if done else ""))
    if failed:
        print("Отзывы, ошибки: " + "; ".join(failed))
    if first and done:
        print("ПЕРВЫЙ_ОТЗЫВ")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
