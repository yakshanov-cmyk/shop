#!/usr/bin/env python3
"""Публикация в сообщество ВКонтакте ItalBridge (club232870356).
Ключ сообщества (env VK_TOKEN). Ключу сообщества недоступны photos.getWallUploadServer и wall.delete,
поэтому фото грузится через сервер сообщений (photos.getMessagesUploadServer) — ВК принимает такое фото в запись стены.

Использование:
  VK_TOKEN=… BOT_TOKEN=… python3 bot/vk.py --html-file post.html --file-id <file_id карточки в Telegram>
  VK_TOKEN=… python3 bot/vk.py --html-file post.html --photo card.jpg
  VK_TOKEN=… python3 bot/vk.py --text "Курс…"          (пост без фото)
Печатает: VK_OK <post_id> или VK_FAIL <причина>.
"""
import argparse, html, json, os, re, sys, requests

GID = 232870356
V = "5.199"


def vk(token, method, **p):
    p.update(access_token=token, v=V)
    r = requests.post("https://api.vk.com/method/" + method, data=p, timeout=60).json()
    if "error" in r:
        raise RuntimeError(f"{method}: {r['error'].get('error_msg')}")
    return r["response"]


def tg_to_vk(h):
    """HTML-подпись поста Telegram → текст для ВК (без разметки, без ссылок на Telegram)."""
    t = h
    # «💶 <s>СТАРАЯ</s> → <b>НОВАЯ</b> (−XX %)» → «💶 НОВАЯ (вместо СТАРАЯ, −XX %)»
    t = re.sub(r"<s>(.*?)</s>\s*→\s*<b>(.*?)</b>\s*\((−\s?\d+\s?%)\)", r"\2 (вместо \1, \3)", t)
    t = re.sub(r"<[^>]+>", "", t)
    t = html.unescape(t)
    t = t.replace("🇮🇹 Оригинал из Италии · заказ — кнопкой под постом 👇", "🇮🇹 Оригинал из Италии\n🛍 Для заказа напишите нам в сообщения сообщества")
    t = re.sub(r"уточняйте у менеджера @\w+", "уточняйте в сообщениях сообщества", t)
    t = re.sub(r"\s*@\w+", "", t) if "@" in t else t
    t = re.sub(r"(https?://)?t\.me/\S+", "", t)
    return re.sub(r"\n{3,}", "\n\n", t).strip()


def upload_photo(token, data):
    u = vk(token, "photos.getMessagesUploadServer", peer_id=0)
    up = requests.post(u["upload_url"], files={"photo": ("card.jpg", data, "image/jpeg")}, timeout=90).json()
    s = vk(token, "photos.saveMessagesPhoto", photo=up["photo"], server=up["server"], hash=up["hash"])[0]
    return f"photo{s['owner_id']}_{s['id']}" + (f"_{s['access_key']}" if s.get("access_key") else "")


def tg_file(bot, file_id):
    p = requests.get(f"https://api.telegram.org/bot{bot}/getFile", params={"file_id": file_id}, timeout=30).json()["result"]["file_path"]
    return requests.get(f"https://api.telegram.org/file/bot{bot}/{p}", timeout=60).content


def post(token, text, photo_bytes=None):
    att = upload_photo(token, photo_bytes) if photo_bytes else None
    p = dict(owner_id=-GID, from_group=1, message=text)
    if att:
        p["attachments"] = att
    return vk(token, "wall.post", **p)["post_id"]


if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("--html-file"); a.add_argument("--text"); a.add_argument("--photo"); a.add_argument("--file-id")
    a.add_argument("--dry", action="store_true")
    o = a.parse_args()
    tok = os.environ.get("VK_TOKEN", "")
    try:
        text = o.text if o.text else tg_to_vk(open(o.html_file, encoding="utf-8").read())
        if o.dry:
            print(text); sys.exit(0)
        if not tok:
            raise RuntimeError("нет VK_TOKEN")
        data = open(o.photo, "rb").read() if o.photo else (tg_file(os.environ["BOT_TOKEN"], o.file_id) if o.file_id else None)
        print("VK_OK", post(tok, text, data))
    except Exception as e:
        print("VK_FAIL", str(e)[:200]); sys.exit(1)
