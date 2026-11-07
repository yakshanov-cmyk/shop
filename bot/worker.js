// ItalBridge — мгновенный бот заказов (Cloudflare Worker)
// Привязки: KV namespace DB. Секреты: BOT_TOKEN, WEBHOOK_SECRET, API_KEY, PAY_TEXT.
// Переменные: OWNER_ID (кто подтверждает оплату), MANAGER (ник менеджера без @), LANA_USERNAME.

const STATUSES = ["Принят", "Оплачен", "Выкуплен", "Отправлен", "В Москве", "Выдан", "Отменён"];
const NORM_DAYS = { "Принят": 2, "Оплачен": 3, "Выкуплен": 7, "Отправлен": 21, "В Москве": 3 };
const NEXT_BTNS = {
  "Принят": [["💳 Выставить счёт", "inv"], ["✅ Оплачен", "paid"]],
  "Оплачен": [["🛍 Выкуплен", "bought"]],
  "Выкуплен": [["🚚 Отправлен", "sent"]],
  "Отправлен": [["📍 В Москве", "msk"]],
  "В Москве": [["🎉 Выдан", "done"]],
};
const CODE_STATUS = { paid: "Оплачен", bought: "Выкуплен", sent: "Отправлен", msk: "В Москве", done: "Выдан", cancel: "Отменён" };
const CLIENT_MSG = {
  "Оплачен": id => `✅ Оплата по заказу ${id} получена. Выкупаем товар.`,
  "Выкуплен": id => `🛍 Заказ ${id} выкуплен в Италии. Готовим к отправке.`,
  "Отправлен": (id, o) => `🚚 Заказ ${id} отправлен.${o.track ? "\nТрек-номер: " + o.track : ""}`,
  "В Москве": id => `📍 Заказ ${id} прибыл в Москву. Менеджер свяжется с вами для выдачи.`,
  "Выдан": id => `🎉 Заказ ${id} выдан. Спасибо, что выбрали ItalBridge! 🇮🇹`,
  "Отменён": id => `Заказ ${id} отменён. Вопросы — менеджеру.`,
};

// ---------- утилиты ----------
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const rub = n => Math.round(n).toLocaleString("ru-RU").replace(/[ ,]/g, " ") + " ₽";
function msk(ts = Date.now()) {
  const d = new Date(ts + 3 * 3600e3);
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
const mskHour = (ts = Date.now()) => new Date(ts + 3 * 3600e3).getUTCHours();
const days = (from, to = Date.now()) => Math.floor((to - from) / 86400e3);

function tg(env, method, body) {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then(r => r.json()).catch(e => ({ ok: false, description: String(e) }));
}
const send = (env, chat_id, text, extra = {}) =>
  tg(env, "sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

async function kvGet(env, key, def = null) { const v = await env.DB.get(key); return v ? JSON.parse(v) : def; }
const kvPut = (env, key, val, opts) => env.DB.put(key, JSON.stringify(val), opts);

async function admins(env) {
  const ids = [Number(env.OWNER_ID)];
  const lana = await kvGet(env, "admin:lana");
  if (lana) ids.push(lana);
  return ids;
}
const isAdmin = async (env, id) => (await admins(env)).includes(Number(id));
async function managerChat(env) { return (await kvGet(env, "admin:lana")) || Number(env.OWNER_ID); }

// ---------- заказы ----------
const getOrder = (env, id) => kvGet(env, "order:" + id);
const putOrder = (env, o) => kvPut(env, "order:" + o.id, o);

async function listOrders(env, onlyOpen = true) {
  const out = []; let cursor;
  do {
    const r = await env.DB.list({ prefix: "order:", cursor });
    for (const k of r.keys) { const o = await kvGet(env, k.name); if (o && (!onlyOpen || !["Выдан", "Отменён"].includes(o.status))) out.push(o); }
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function parseMoney(s) {
  const m = String(s).replace(/\s| /g, "").match(/(\d+(?:[.,]\d+)?)/);
  return m ? Math.round(parseFloat(m[1].replace(",", "."))) : null;
}

// Формат: /new Товар; цена товара; доставка; клиент   (доставку можно пропустить: Товар; цена; клиент → 1 500 ₽)
function parseNewOrder(text) {
  const body = text.replace(/^\s*(\/new(@\w+)?|новый заказ)\s*:?\s*/i, "").trim();
  const parts = body.split(/[;\n]/).map(s => s.trim()).filter(Boolean);
  if (parts.length < 3) return { error: "Нужно минимум 3 части через «;»: товар; цена товара; клиент. Пример:\n<code>новый заказ: Coccinelle сумка чёрная; 12100; 1500; Анна @anna</code>" };
  const item = parts[0];
  const goods = parseMoney(parts[1]);
  if (!goods) return { error: "Не понял цену товара (вторая часть). Пример: <code>12100</code>" };
  let delivery = 1500, client;
  const maybeDel = parseMoney(parts[2]);
  if (parts.length >= 4 && maybeDel !== null && /^[\d\s.,₽рруб]+$/i.test(parts[2])) { delivery = maybeDel; client = parts.slice(3).join("; "); }
  else client = parts.slice(2).join("; ");
  return { item, goods, delivery, client };
}

function card(o) {
  const hist = o.history.map(h => `• ${h.t} — ${esc(h.s)}${h.by ? " (" + esc(h.by) + ")" : ""}`).join("\n");
  return [
    `🧾 <b>Заказ ${o.id}</b> — <b>${esc(o.status)}</b>`,
    `🛍 ${esc(o.item)}`,
    `💶 ${rub(o.goods)} + доставка ${rub(o.delivery)} = <b>${rub(o.goods + o.delivery)}</b>`,
    `👤 ${esc(o.client)}${o.clientChat ? " · ✅ привязан к боту" : " · ⏳ не привязан"}`,
    o.track ? `📦 Трек: <code>${esc(o.track)}</code>` : "",
    o.awaiting === "check" ? "⏳ Ждём чек от клиента" : "",
    "", hist, "",
    `🔗 Ссылка для клиента: https://t.me/ItalBridgeBot?start=${o.id}`,
  ].join("\n").replace(/\n{3,}/g, "\n\n");
}
function cardKb(o) {
  if (["Выдан", "Отменён"].includes(o.status)) return { inline_keyboard: [] };
  const row = (NEXT_BTNS[o.status] || []).map(([t, c]) => ({ text: t, callback_data: `st:${o.id}:${c}` }));
  return { inline_keyboard: [row, [{ text: "✖️ Отменить заказ", callback_data: `st:${o.id}:cancel` }]] };
}

async function notifyClient(env, o, text) { if (o.clientChat) await send(env, o.clientChat, text); }

async function setStatus(env, o, status, byName) {
  o.status = status; o.since = Date.now(); o.reminded = null;
  o.history.push({ t: msk(), s: status, by: byName });
  if (status !== "Принят") o.awaiting = null;
  await putOrder(env, o);
  const f = CLIENT_MSG[status]; if (f) await notifyClient(env, o, f(o.id, o));
}

// ---------- обработка апдейтов ----------
async function onMessage(env, m) {
  const chat = m.chat.id, from = m.from || {}, text = (m.text || m.caption || "").trim();
  if (m.chat.type !== "private") return;

  // Лана — админ
  if (env.LANA_USERNAME && (from.username || "").toLowerCase() === env.LANA_USERNAME.toLowerCase() && !(await kvGet(env, "admin:lana"))) {
    await kvPut(env, "admin:lana", from.id);
    await tg(env, "setMyCommands", { commands: ADMIN_CMDS, scope: { type: "chat", chat_id: from.id } });
    await send(env, from.id, "Вы подключены как менеджер ItalBridge. Команды: /zakazy — открытые заказы, /new — новый заказ.\nФормат: <code>новый заказ: товар; цена товара; доставка; клиент</code>");
    if (text === "/start") return;
  }
  const admin = await isAdmin(env, from.id);
  const name = from.first_name || from.username || "админ";

  if (admin) {
    // ожидание трек-номера
    const wait = await kvGet(env, "wait:" + chat);
    if (wait && wait.what === "track" && text && !text.startsWith("/")) {
      const o = await getOrder(env, wait.order);
      await env.DB.delete("wait:" + chat);
      if (o) { o.track = text; await setStatus(env, o, "Отправлен", name); await send(env, chat, `Трек сохранён, клиент уведомлён.\n\n${card(o)}`, { reply_markup: cardKb(o) }); }
      return;
    }
    if (/^(\/new(@\w+)?|новый заказ)/i.test(text)) {
      if (/^\/new(@\w+)?\s*$/i.test(text)) return send(env, chat, "Напишите одним сообщением:\n<code>новый заказ: Coccinelle сумка чёрная; 12100; 1500; Анна @anna</code>\n(товар; цена товара; доставка; клиент — доставку можно не писать, будет 1 500 ₽)");
      const p = parseNewOrder(text);
      if (p.error) return send(env, chat, p.error);
      const n = (await kvGet(env, "counter", 0)) + 1; await kvPut(env, "counter", n);
      const o = { id: "IB-" + String(n).padStart(4, "0"), ...p, status: "Принят", since: Date.now(), created: Date.now(), by: name, history: [{ t: msk(), s: "Принят", by: name }] };
      await putOrder(env, o);
      return send(env, chat, card(o), { reply_markup: cardKb(o) });
    }
    if (/^(\/zakazy|мои заказы|\/orders)/i.test(text)) {
      const list = await listOrders(env);
      if (!list.length) return send(env, chat, "Открытых заказов нет.");
      const lines = list.map(o => { const d = days(o.since); const late = NORM_DAYS[o.status] && d > NORM_DAYS[o.status]; return `${late ? "⚠️" : "•"} <b>${o.id}</b> — ${esc(o.status)} (${d} дн.) · ${esc(o.item)} · ${esc(o.client)} · ${rub(o.goods + o.delivery)}`; });
      return send(env, chat, `<b>Открытые заказы (${list.length}):</b>\n` + lines.join("\n") + "\n\nКарточка: <code>/status IB-0001</code>");
    }
    const st = text.match(/^\/status(?:@\w+)?\s+(IB-\d+)/i);
    if (st) { const o = await getOrder(env, st[1].toUpperCase()); return o ? send(env, chat, card(o), { reply_markup: cardKb(o) }) : send(env, chat, "Заказ не найден."); }
    if (text === "/start" || text.startsWith("/start ")) {
      const id = text.split(" ")[1];
      if (!id || !/^IB-\d+$/i.test(id)) return send(env, chat, "Вы администратор ItalBridge.\n/zakazy — открытые заказы\n/new — новый заказ\n/status IB-0001 — карточка");
      // админ открыл ссылку клиента (тест) — продолжаем как клиент ниже
    } else if (text) {
      return send(env, chat, "Команды: /zakazy, /new, /status IB-0001.\nНовый заказ: <code>новый заказ: товар; цена; доставка; клиент</code>");
    }
  }

  // ---------- клиент ----------
  const myIds = await kvGet(env, "client:" + chat, []);
  const sm = text.match(/^\/start(?:@\w+)?\s+(IB-\d+)/i);
  if (sm) {
    const id = sm[1].toUpperCase(); const o = await getOrder(env, id);
    if (!o) return send(env, chat, `Заказ ${id} не найден. Напишите менеджеру @${env.MANAGER}.`);
    if (o.clientChat && o.clientChat !== chat) return send(env, chat, `Этот заказ уже привязан. Напишите менеджеру @${env.MANAGER}.`);
    if (!o.clientChat) {
      o.clientChat = chat; o.history.push({ t: msk(), s: "Клиент привязался к боту" }); await putOrder(env, o);
      if (!myIds.includes(id)) { myIds.push(id); await kvPut(env, "client:" + chat, myIds); }
      for (const a of await admins(env)) await send(env, a, `🔗 Клиент привязался к ${id} (${esc(o.client)}).`);
    }
    return send(env, chat, `Заказ <b>${id}</b> привязан ✅\n🛍 ${esc(o.item)}\nСтатус: <b>${esc(o.status)}</b>\n\nСообщения о каждом изменении придут сюда. Команда /status — текущий статус.`);
  }
  if (/^\/status/i.test(text)) {
    if (!myIds.length) return send(env, chat, `У вас пока нет заказов в боте. Если вы уже оформили заказ — откройте ссылку от менеджера @${env.MANAGER}.`);
    const parts = [];
    for (const id of myIds) { const o = await getOrder(env, id); if (o) parts.push(`<b>${id}</b> — ${esc(o.status)}\n🛍 ${esc(o.item)}${o.track ? "\n📦 Трек: <code>" + esc(o.track) + "</code>" : ""}`); }
    return send(env, chat, parts.join("\n\n"));
  }
  if (myIds.length) {
    // чек
    if (m.photo || m.document) {
      let target = null;
      for (const id of myIds) { const o = await getOrder(env, id); if (o && o.awaiting === "check") { target = o; break; } }
      if (!target) for (const id of myIds) { const o = await getOrder(env, id); if (o && o.status === "Принят") { target = o; break; } }
      if (target) {
        const owner = Number(env.OWNER_ID);
        await tg(env, "forwardMessage", { chat_id: owner, from_chat_id: chat, message_id: m.message_id });
        await send(env, owner, `🧾 Чек по <b>${target.id}</b>, сумма ${rub(target.goods + target.delivery)}`, { reply_markup: { inline_keyboard: [[{ text: "✅ Подтвердить оплату", callback_data: `st:${target.id}:paid` }, { text: "❌ Не пришло", callback_data: `st:${target.id}:nopay` }]] } });
        return send(env, chat, "Чек получен, проверяем оплату. Сообщим здесь 🙏");
      }
    }
    const mgr = await managerChat(env);
    await tg(env, "forwardMessage", { chat_id: mgr, from_chat_id: chat, message_id: m.message_id });
    await send(env, mgr, `↑ Сообщение от клиента по ${myIds.join(", ")}`);
    return send(env, chat, `Передал менеджеру @${env.MANAGER} — вам ответят в ближайшее время.`);
  }
  // незнакомец — приветствие раз в сутки
  if (!(await env.DB.get("greet:" + chat))) {
    await env.DB.put("greet:" + chat, "1", { expirationTtl: 86400 });
    return send(env, chat, `Здравствуйте! Это ItalBridge 🇮🇹 — оригинальные бренды из Италии.\n\n💶 Цена и заказ — кнопка «💶 Цена и заказ» внизу.\n💬 Вопросы — @${env.MANAGER}\n📣 Канал: @buyitru`);
  }
}

async function onCallback(env, q) {
  const from = q.from, data = q.data || "", msg = q.message;
  const answer = (text, alert = false) => tg(env, "answerCallbackQuery", { callback_query_id: q.id, text, show_alert: alert });
  if (!(await isAdmin(env, from.id))) return answer("Недоступно");
  const name = from.first_name || from.username || "админ";

  // черновики постов
  const dm = data.match(/^(pub|rej):(.+)$/);
  if (dm) {
    const key = "dec:" + dm[2];
    const prev = await kvGet(env, key, {});
    if (prev.published) return answer("Уже опубликовано");
    await kvPut(env, key, { ...prev, d: dm[1], chat: msg.chat.id, msg: msg.message_id, ts: Date.now() });
    const slot = mskHour() < 10 ? "~10:00" : mskHour() < 20 ? "~20:00" : "завтра ~10:00";
    const keep = (msg.reply_markup?.inline_keyboard || []).flat().filter(b => b.url);
    const kb = dm[1] === "pub"
      ? [[{ text: `✅ В очереди: ${slot}`, callback_data: "noop" }], [{ text: "❌ Передумал — отклонить", callback_data: "rej:" + dm[2] }]]
      : [[{ text: "❌ Отклонён", callback_data: "noop" }], [{ text: "✅ Всё же опубликовать", callback_data: "pub:" + dm[2] }]];
    await tg(env, "editMessageReplyMarkup", { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [...(keep.length ? [keep] : []), ...kb] } });
    return answer(dm[1] === "pub" ? `Будет опубликовано ${slot}` : "Отклонено");
  }
  if (data === "noop") return answer("");

  const sm = data.match(/^st:(IB-\d+):(\w+)$/);
  if (!sm) return answer("");
  const o = await getOrder(env, sm[1]);
  if (!o) return answer("Заказ не найден", true);
  const code = sm[2];
  if (["Выдан", "Отменён"].includes(o.status) && code !== "noop") return answer(`Заказ уже ${o.status.toLowerCase()}`);

  if (code === "inv") {
    if (!o.clientChat) return answer("Клиент ещё не открыл ссылку — отправьте ему ссылку из карточки", true);
    await send(env, o.clientChat, `🧾 <b>Заказ ${o.id}</b>\n🛍 ${esc(o.item)}\n\nК оплате: <b>${rub(o.goods + o.delivery)}</b> (товар ${rub(o.goods)} + доставка ${rub(o.delivery)})\n\n${env.PAY_TEXT}\n\nПосле оплаты пришлите сюда скриншот чека.`);
    o.awaiting = "check"; o.history.push({ t: msk(), s: "Счёт выставлен", by: name }); await putOrder(env, o);
    await answer("Счёт отправлен клиенту");
  } else if (code === "nopay") {
    await notifyClient(env, o, `Оплата по ${o.id} пока не поступила. Проверьте перевод или напишите @${env.MANAGER}.`);
    o.history.push({ t: msk(), s: "Оплата не найдена", by: name }); await putOrder(env, o);
    await answer("Клиенту отправлено: оплата не поступила");
  } else if (code === "sent") {
    await kvPut(env, "wait:" + msg.chat.id, { what: "track", order: o.id }, { expirationTtl: 7 * 86400 });
    await send(env, msg.chat.id, `Пришлите трек-номер для <b>${o.id}</b> следующим сообщением.`, { reply_markup: { force_reply: true } });
    return answer("Жду трек-номер");
  } else if (CODE_STATUS[code]) {
    await setStatus(env, o, CODE_STATUS[code], name);
    await answer(`Статус: ${o.status}`);
  } else return answer("");

  // обновить карточку, если нажато под карточкой заказа
  if (msg && (msg.text || "").startsWith("🧾 Заказ") ) {
    await tg(env, "editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, text: card(o), parse_mode: "HTML", disable_web_page_preview: true, reply_markup: cardKb(o) });
  } else if (msg) {
    await tg(env, "editMessageReplyMarkup", { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [[{ text: `${o.id}: ${o.status}`, callback_data: "noop" }]] } });
  }
}

const ADMIN_CMDS = [
  { command: "zakazy", description: "Открытые заказы" },
  { command: "new", description: "Новый заказ" },
  { command: "status", description: "Карточка заказа: /status IB-0001" },
];

// ---------- ежедневная сводка и напоминания (cron) ----------
async function daily(env, summary) {
  const list = await listOrders(env);
  const adm = await admins(env);
  const late = [];
  for (const o of list) {
    const d = days(o.since), norm = NORM_DAYS[o.status];
    if (norm && d > norm && o.reminded !== o.status) { late.push(o); o.reminded = o.status; await putOrder(env, o); }
  }
  for (const o of late) for (const a of adm) await send(env, a, `⚠️ <b>${o.id}</b> — «${esc(o.status)}» уже ${days(o.since)} дн. (норма ${NORM_DAYS[o.status]}). ${esc(o.item)} · ${esc(o.client)}`, { reply_markup: cardKb(o) });
  if (summary && list.length) {
    const lines = list.map(o => { const d = days(o.since); const bad = NORM_DAYS[o.status] && d > NORM_DAYS[o.status]; return `${bad ? "⚠️" : "•"} <b>${o.id}</b> — ${esc(o.status)} (${d} дн.) · ${esc(o.item)}`; });
    for (const a of adm) await send(env, a, `☀️ <b>Сводка по заказам</b> (${list.length} открытых):\n` + lines.join("\n"));
  }
}

// ---------- API для задачи по расписанию ----------
async function api(env, req, url) {
  const key = req.headers.get("X-Api-Key"); if (!key || (key !== env.API_KEY && key !== env.BOT_TOKEN)) return new Response("forbidden", { status: 403 });
  const j = o => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json" } });
  if (url.pathname === "/api/state") {
    const decisions = []; let cursor;
    do { const r = await env.DB.list({ prefix: "dec:", cursor }); for (const k of r.keys) decisions.push({ key: k.name.slice(4), ...(await kvGet(env, k.name)) }); cursor = r.list_complete ? null : r.cursor; } while (cursor);
    return j({ orders: await listOrders(env, url.searchParams.get("all") !== "1"), decisions, lana: await kvGet(env, "admin:lana"), counter: await kvGet(env, "counter", 0) });
  }
  if (url.pathname === "/api/published" && req.method === "POST") {
    const b = await req.json(); const k = "dec:" + b.key; const d = await kvGet(env, k, {});
    await kvPut(env, k, { ...d, published: b.post, pts: Date.now() }, { expirationTtl: 30 * 86400 });
    return j({ ok: true });
  }
  if (url.pathname === "/api/forget" && req.method === "POST") { const b = await req.json(); await env.DB.delete("dec:" + b.key); return j({ ok: true }); }
  return new Response("not found", { status: 404 });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return api(env, req, url);
    if (url.pathname === "/tg" && req.method === "POST") {
      if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const u = await req.json();
      try {
        if (u.message) await onMessage(env, u.message);
        else if (u.callback_query) await onCallback(env, u.callback_query);
      } catch (e) { console.log("error", e && e.stack || e); }
      return new Response("ok");
    }
    return new Response("ItalBridge bot is running");
  },
  async scheduled(ev, env) {
    // 07:00 UTC = 10:00 МСК — сводка; остальные запуски — только напоминания о просрочках
    await daily(env, new Date(ev.scheduledTime).getUTCHours() === 7);
  },
};

export { parseNewOrder, card, cardKb };
