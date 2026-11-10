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
  if (o.status === "Выдан" && o.clientChat && !o.reviewGot) return { inline_keyboard: [[{ text: "⭐ Запросить отзыв", callback_data: "rq:" + o.id }]] };
  if (["Выдан", "Отменён"].includes(o.status)) return { inline_keyboard: [] };
  const row = (NEXT_BTNS[o.status] || []).map(([t, c]) => ({ text: t, callback_data: `st:${o.id}:${c}` }));
  return { inline_keyboard: [row, [{ text: "✖️ Отменить заказ", callback_data: `st:${o.id}:cancel` }]] };
}

// ---------- конвертер евро ⇄ USDT (для админов) ----------
// Курс: 1 € = X USDT. Сначала Bybit (спот EUR/USDT), если недоступен — CoinGecko. Кэш 2 минуты.
async function usdtPerEur(env) {
  const c = await kvGet(env, "fx:eurusdt");
  if (c && Date.now() - c.ts < 120e3) return c;
  let r = null;
  try {
    const j = await (await fetch("https://api.bybit.com/v5/market/tickers?category=spot&symbol=EURUSDT", { headers: { "User-Agent": "ItalBridgeBot" } })).json();
    const v = Number(j?.result?.list?.[0]?.lastPrice);
    if (v > 0.5 && v < 2) r = { rate: v, src: "Bybit, спот EUR/USDT" };
  } catch (e) {}
  if (!r) try {
    const j = await (await fetch("https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=eur")).json();
    const v = Number(j?.tether?.eur);
    if (v > 0.5 && v < 2) r = { rate: 1 / v, src: "CoinGecko (Bybit недоступен)" };
  } catch (e) {}
  if (!r) return c ? { ...c, stale: true } : null;
  r.ts = Date.now(); await kvPut(env, "fx:eurusdt", r);
  return r;
}
const num = (n, d = 2) => n.toLocaleString("ru-RU", { minimumFractionDigits: d, maximumFractionDigits: d }).replace(/[\u00a0\u202f]/g, " ");
const FX_RE = /^(\d[\d\s]*(?:[.,]\d+)?)\s*(€|евро|eur|euro|usdt|юсдт|\$t)\s*$/i;
async function fxReply(env, amount, cur) {
  const r = await usdtPerEur(env);
  if (!r) return "Не удалось получить курс USDT. Посмотрите в «Конвертации» Bybit.";
  const toUsdt = !/usdt|юсдт|\$t/i.test(cur);
  const line = toUsdt ? `💱 <b>${num(amount)} € = ${num(amount * r.rate)} USDT</b>` : `💱 <b>${num(amount)} USDT = ${num(amount / r.rate)} €</b>`;
  return line + `\n\nКурс: 1 € = ${num(r.rate, 4)} USDT · 1 USDT = ${num(1 / r.rate, 4)} €\n${esc(r.src)}, ${msk(r.ts)}` + (r.stale ? " ⚠️ курс устарел" : "") +
    "\n\nОриентир. Точную сумму для перевода поставщику смотрите в «Конвертации» Bybit в момент обмена и отправьте ей скриншот. Комиссию сети за перевод USDT добавьте сверху.";
}

// ---------- удобное создание заказа (мастер) и список заказов ----------
const ADMIN_KB = { keyboard: [[{ text: "➕ Новый заказ" }, { text: "📋 Заказы" }], [{ text: "💱 Евро → USDT" }, { text: "⭐ Отзывы" }, { text: "❓ Помощь" }]], resize_keyboard: true, is_persistent: true };
const HELP = "<b>Как работать с заказами</b>\n\n" +
  "➕ <b>Новый заказ</b> — бот спросит по шагам: товар → цена → доставка → клиент. Заказ создаётся <b>только после кнопки «✅ Создать»</b>, до этого всё можно поправить или отменить.\n" +
  "Быстрее всего: на первом шаге пришлите ссылку на пост канала (t.me/buyitru/13371) или перешлите пост из канала — товар, цена и доставка подставятся сами.\n\n" +
  "📋 <b>Заказы</b> — открытые заказы по статусам, ⚠️ просроченные; нажмите на заказ — откроется карточка с кнопками статусов.\n\n" +
  "⭐ <b>Отзывы</b> — через 2 дня после «Выдан» бот сам попросит клиента оценить заказ. Отзыв придёт сюда с кнопками «Опубликовать» / «Скрыть». Кнопка «⭐ Отзывы» внизу: что ждёт проверки и у кого можно запросить отзыв сразу.\n\n" +
  "💱 <b>Евро → USDT</b> — напишите сумму, например <code>500 евро</code> или <code>500€</code>, — бот ответит, сколько это в USDT по текущему курсу. Обратно: <code>560 usdt</code>.\n\n" +
  "Команды: /new — новый заказ, /zakazy — заказы, /status IB-0001 — карточка, /otzyv IB-0001 — запросить отзыв, /cancel — отменить ввод.";
const CATALOG_URL = "https://yakshanov-cmyk.github.io/shop/catalog.json";
const DELIV_BY_C = { "1": 1500, "2": 3000, "05": 750 };
const STEP_Q = {
  item: "🛍 <b>Шаг 1 из 4. Что заказывают?</b>\nПришлите ссылку на пост канала (например, t.me/buyitru/13371), перешлите пост из канала — или напишите название товара.",
  goods: "💶 <b>Шаг 2 из 4. Цена товара в рублях</b> (без доставки). Например: <code>12100</code>",
  delivery: "📦 <b>Шаг 3 из 4. Доставка до Москвы</b> — выберите или напишите сумму.",
  client: "👤 <b>Шаг 4 из 4. Клиент</b> — имя и @ник или телефон. Например: <code>Анна @anna</code>",
};
const cancelBtn = [{ text: "✖️ Отменить", callback_data: "nw:cancel" }];
function stepKb(step) {
  if (step === "delivery") return { inline_keyboard: [[750, 1500, 3000].map(v => ({ text: rub(v), callback_data: "nw:d:" + v })), [{ text: "Без доставки", callback_data: "nw:d:0" }], cancelBtn] };
  return { inline_keyboard: [cancelBtn] };
}
function draftText(d) {
  return ["📝 <b>Новый заказ — проверьте</b>",
    `🛍 ${esc(d.item)}`,
    `💶 Товар: ${rub(d.goods)}`,
    `📦 Доставка: ${rub(d.delivery)}`,
    `👤 Клиент: ${esc(d.client)}`,
    `<b>Итого клиенту: ${rub(d.goods + d.delivery)}</b>`,
    "", "Заказ появится только после «✅ Создать заказ»."].join("\n");
}
const draftKb = () => ({ inline_keyboard: [
  [{ text: "✅ Создать заказ", callback_data: "nw:ok" }],
  [{ text: "✏️ Товар", callback_data: "nw:e:item" }, { text: "✏️ Цена", callback_data: "nw:e:goods" }],
  [{ text: "✏️ Доставка", callback_data: "nw:e:delivery" }, { text: "✏️ Клиент", callback_data: "nw:e:client" }],
  cancelBtn] });
const draftGet = (env, chat) => kvGet(env, "draft:" + chat);
const draftPut = (env, chat, d) => kvPut(env, "draft:" + chat, d, { expirationTtl: 2 * 86400 });
async function draftNext(env, chat, d) {
  const order = ["item", "goods", "delivery", "client"];
  const next = d.editing ? null : order.find(k => d[k] === undefined || d[k] === null || d[k] === "");
  d.step = next || "preview"; d.editing = false;
  await draftPut(env, chat, d);
  if (d.step === "preview") return send(env, chat, draftText(d), { reply_markup: draftKb() });
  return send(env, chat, STEP_Q[d.step], { reply_markup: stepKb(d.step) });
}
async function catalogItem(env, post) {
  try {
    const r = await fetch(CATALOG_URL + "?t=" + Date.now()); const j = await r.json();
    return (j.items || []).find(i => String(i.post) === String(post)) || null;
  } catch (e) { return null; }
}
async function fillFromPost(env, d, post) {
  const it = await catalogItem(env, post);
  if (!it) { d.item = `Товар из поста https://t.me/buyitru/${post}`; return false; }
  d.item = `${it.brand} — ${it.title} (пост https://t.me/buyitru/${post})`;
  d.goods = it.price; d.delivery = DELIV_BY_C[it.c] ?? 1500; d.post = Number(post);
  return true;
}
async function createOrder(env, p, name) {
  const n = (await kvGet(env, "counter", 0)) + 1; await kvPut(env, "counter", n);
  const o = { id: "IB-" + String(n).padStart(4, "0"), item: p.item, goods: p.goods, delivery: p.delivery, client: p.client, ...(p.post ? { post: p.post } : {}),
    status: "Принят", since: Date.now(), created: Date.now(), by: name, history: [{ t: msk(), s: "Принят", by: name }] };
  await putOrder(env, o);
  return o;
}
const isLate = o => NORM_DAYS[o.status] && days(o.since) > NORM_DAYS[o.status];
async function ordersMenu(env) {
  const list = await listOrders(env);
  if (!list.length) return { text: "📋 Открытых заказов нет.\n\n➕ Новый заказ — кнопка внизу.", kb: { inline_keyboard: [] } };
  const late = list.filter(isLate).length;
  const rows = [[{ text: `Все открытые (${list.length})`, callback_data: "ls:all" }]];
  if (late) rows.push([{ text: `⚠️ Просрочены (${late})`, callback_data: "ls:late" }]);
  const by = STATUSES.slice(0, 5).map(s => [s, list.filter(o => o.status === s).length]).filter(x => x[1]);
  for (let i = 0; i < by.length; i += 2) rows.push(by.slice(i, i + 2).map(([s, c]) => ({ text: `${s} (${c})`, callback_data: "ls:s" + STATUSES.indexOf(s) })));
  const text = `📋 <b>Открытые заказы: ${list.length}</b>` + (late ? `, ⚠️ просрочено: ${late}` : "") + "\n" +
    by.map(([s, c]) => `• ${s} — ${c}`).join("\n") + "\n\nВыберите раздел:";
  return { text, kb: { inline_keyboard: rows } };
}
async function ordersList(env, f) {
  let list = await listOrders(env), title = "Все открытые";
  if (f === "late") { list = list.filter(isLate); title = "⚠️ Просроченные"; }
  else if (/^s\d$/.test(f)) { const s = STATUSES[+f.slice(1)]; list = list.filter(o => o.status === s); title = s; }
  const rows = list.slice(0, 40).map(o => [{ text: `${isLate(o) ? "⚠️ " : ""}${o.id} · ${o.status} · ${o.item}`.slice(0, 60), callback_data: "od:" + o.id }]);
  rows.push([{ text: "← К разделам", callback_data: "ls:menu" }]);
  const text = `📋 <b>${esc(title)}: ${list.length}</b>\n` + (list.length ? list.slice(0, 40).map(o => `${isLate(o) ? "⚠️" : "•"} <b>${o.id}</b> — ${esc(o.status)} (${days(o.since)} дн.) · ${esc(o.item)} · ${esc(o.client)} · ${rub(o.goods + o.delivery)}`).join("\n") + "\n\nНажмите на заказ — откроется карточка." : "Нет заказов.");
  return { text, kb: { inline_keyboard: rows } };
}

async function notifyClient(env, o, text) { if (o.clientChat) await send(env, o.clientChat, text); }

async function setStatus(env, o, status, byName) {
  o.status = status; o.since = Date.now(); o.reminded = null;
  o.history.push({ t: msk(), s: status, by: byName });
  if (status !== "Принят") o.awaiting = null;
  await putOrder(env, o);
  const f = CLIENT_MSG[status]; if (f) await notifyClient(env, o, f(o.id, o));
}

// ---------- отзывы ----------
// Сбор: через REVIEW_AFTER_DAYS после «Выдан» (утренний cron) или по /otzyv IB-XXXX.
// Ключи KV: review:IB-XXXX (сам отзыв), rvw:<chat> (клиент заполняет отзыв, 3 дня).
const REVIEW_AFTER_DAYS = 2;
const REVIEW_FROM = Date.UTC(2026, 10, 9, 17, 0); // выданные раньше (проверочные заказы) не спрашиваем
const REVIEW_MAX = 1000;
const ADMIN_BTNS = ["➕ Новый заказ", "📋 Заказы", "💱 Евро → USDT", "⭐ Отзывы", "❓ Помощь"];
const CONSENT_TEXT = "Публикация оценки, текста, фото и названия вещи в канале @buyitru и приложении ItalBridge";
const stars = n => "⭐".repeat(n);
const getReview = (env, id) => kvGet(env, "review:" + id);
const putReview = (env, r) => kvPut(env, "review:" + r.id, r);
const rvPut = (env, chat, s) => kvPut(env, "rvw:" + chat, s, { expirationTtl: 3 * 86400 });
const itemLabel = o => String(o.item || "").replace(/\s*\(пост https?:\/\/\S+\)\s*$/, "").slice(0, 120);
function publicName(from) {
  const first = String(from.first_name || "").trim(), last = String(from.last_name || "").trim();
  if (!first) return "Покупатель";
  return first + (last ? " " + [...last][0].toUpperCase() + "." : "");
}
const skipKb = { inline_keyboard: [[{ text: "Пропустить →", callback_data: "rv:skip" }]] };
const photoOf = m => m.photo ? m.photo[m.photo.length - 1].file_id : (m.document && /^image\//.test(m.document.mime_type || "") ? m.document.file_id : null);

async function askReview(env, o) {
  o.reviewAsked = Date.now(); o.history.push({ t: msk(), s: "Запрошен отзыв" }); await putOrder(env, o);
  const row = [1, 2, 3, 4, 5].map(n => ({ text: n + " ⭐", callback_data: `rv:r:${o.id}:${n}` }));
  return send(env, o.clientChat, `Как вам заказ <b>${o.id}</b>?\n🛍 ${esc(itemLabel(o))}\n\nОцените, пожалуйста, — это займёт полминуты:`, { reply_markup: { inline_keyboard: [row] } });
}
async function askReviews(env) {
  const due = (await listOrders(env, false)).filter(o => o.status === "Выдан" && o.clientChat && !o.reviewAsked && o.since >= REVIEW_FROM && days(o.since) >= REVIEW_AFTER_DAYS);
  for (const o of due.slice(0, 10)) await askReview(env, o);
}
async function listReviews(env) {
  const out = []; let cursor;
  do { const r = await env.DB.list({ prefix: "review:", cursor }); for (const k of r.keys) { const v = await kvGet(env, k.name); if (v) out.push(v); } cursor = r.list_complete ? null : r.cursor; } while (cursor);
  return out.sort((a, b) => a.ts - b.ts);
}
async function reviewsMenu(env) {
  const reviews = await listReviews(env), got = new Set(reviews.map(r => r.id));
  const pending = reviews.filter(r => r.status === "pending");
  const queued = reviews.filter(r => r.status === "approved" && !r.published).length;
  const done = reviews.filter(r => r.published).length;
  const can = (await listOrders(env, false)).filter(o => o.status === "Выдан" && o.clientChat && !got.has(o.id) && o.since >= REVIEW_FROM);
  const rows = [
    ...pending.slice(0, 20).map(r => [{ text: `🔎 ${r.id} · ${r.rating} ⭐ · ${r.item}`.slice(0, 60), callback_data: "rl:" + r.id }]),
    ...can.slice(0, 20).map(o => [{ text: `${o.reviewAsked ? "↻" : "⭐"} ${o.id} · ${itemLabel(o)}`.slice(0, 60), callback_data: "rq:" + o.id + ":m" }]),
  ];
  const text = ["⭐ <b>Отзывы</b>", `Ждут проверки: <b>${pending.length}</b>`, `Одобрены, выйдут в ближайшую публикацию: <b>${queued}</b>`, `Опубликовано: <b>${done}</b>`, "",
    can.length ? "⭐ — запросить отзыв у клиента, ↻ — уже спрашивали, запросить ещё раз." : "Запросить отзыв пока не у кого: нужен заказ «Выдан» с привязанным клиентом."].join("\n");
  return { text, kb: { inline_keyboard: rows } };
}
async function askConsent(env, chat, s, from) {
  s.step = "consent"; await rvPut(env, chat, s);
  const name = publicName(from);
  return send(env, chat, `Можно опубликовать отзыв в канале @buyitru и приложении ItalBridge?\nПокажем оценку, текст${s.photo ? ", фото" : ""} и название вещи. Подпись можно выбрать:`, { reply_markup: { inline_keyboard: [
    [{ text: `✅ С именем: ${name}`.slice(0, 60), callback_data: "rv:c:pub" }],
    [{ text: "✅ Без имени", callback_data: "rv:c:anon" }],
    [{ text: "🔒 Только менеджеру", callback_data: "rv:c:no" }]] } });
}
// true — сообщение относилось к отзыву; false — обработать обычным порядком
async function reviewInput(env, m, s) {
  const chat = m.chat.id, text = (m.text || m.caption || "").trim(), photo = photoOf(m);
  if (m.forward_origin || m.forward_date || text.startsWith("/") || ADMIN_BTNS.includes(text)) return false;
  if (m.media_group_id && s.mg === m.media_group_id) return true; // остальные фото альбома
  if (s.step === "text") {
    if (!text && !photo) { await send(env, chat, "Напишите отзыв текстом или пришлите фото.", { reply_markup: skipKb }); return true; }
    s.text = text.slice(0, REVIEW_MAX);
    if (photo) { s.photo = photo; s.mg = m.media_group_id || null; await askConsent(env, chat, s, m.from); return true; }
    s.step = "photo"; await rvPut(env, chat, s);
    await send(env, chat, "Спасибо! Пришлите фото вещи, если хотите, — одним сообщением.", { reply_markup: skipKb });
    return true;
  }
  if (s.step === "photo") {
    if (!photo) { await send(env, chat, "Пришлите фото или нажмите «Пропустить».", { reply_markup: skipKb }); return true; }
    s.photo = photo; s.mg = m.media_group_id || null;
    await askConsent(env, chat, s, m.from); return true;
  }
  return false;
}
function reviewText(r) {
  return [`${r.rating <= 3 ? "⚠️" : "💬"} <b>Отзыв по ${r.id}</b> ${stars(r.rating)}`, `🛍 ${esc(r.item)}`, `👤 Подпись: ${esc(r.name)}`,
    r.text ? `\n«${esc(r.text)}»` : "\n(без текста)", "",
    r.consent === "no" ? "🔒 Клиент просил не публиковать — только для вас." : "Публикуем? Скрывать стоит только мат и личные данные."].join("\n");
}
function reviewKb(r) {
  if (r.consent === "no") return { inline_keyboard: [] };
  if (r.status === "approved") return { inline_keyboard: [[{ text: `✅ Одобрен: ${mskHour() < 10 ? "~10:00" : mskHour() < 20 ? "~20:00" : "завтра ~10:00"}`, callback_data: "noop" }], [{ text: "🙈 Передумал — скрыть", callback_data: `ra:${r.id}:hide` }]] };
  if (r.status === "hidden") return { inline_keyboard: [[{ text: "🙈 Скрыт", callback_data: "noop" }], [{ text: "✅ Всё же опубликовать", callback_data: `ra:${r.id}:ok` }]] };
  return { inline_keyboard: [[{ text: "✅ Опубликовать", callback_data: `ra:${r.id}:ok` }, { text: "🙈 Скрыть", callback_data: `ra:${r.id}:hide` }]] };
}
async function onReviewCb(env, q, answer) {
  const chat = q.from.id, msg = q.message, p = q.data.split(":");
  const clear = () => msg && tg(env, "editMessageReplyMarkup", { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } });
  if (p[1] === "r") {
    const id = p[2], n = Number(p[3]); const o = await getOrder(env, id);
    if (!o || o.clientChat !== chat || !(n >= 1 && n <= 5)) return answer("Недоступно");
    if (await getReview(env, id)) { await clear(); return answer("Отзыв уже получен, спасибо!"); }
    await rvPut(env, chat, { order: id, rating: n, step: "text", text: "", photo: null });
    await tg(env, "editMessageText", { chat_id: chat, message_id: msg.message_id, text: `Заказ ${id}: ваша оценка ${stars(n)}`, reply_markup: { inline_keyboard: [] } });
    await send(env, chat, n >= 4 ? "Спасибо! Напишите пару слов о заказе и вещи — можно сразу с фото." : "Спасибо за честную оценку. Напишите, что пошло не так, — менеджер разберётся. Можно приложить фото.", { reply_markup: skipKb });
    return answer("");
  }
  const s = await kvGet(env, "rvw:" + chat);
  if (!s) { await clear(); return answer("Время заполнения вышло. Напишите менеджеру, если хотите оставить отзыв.", true); }
  if (p[1] === "skip") {
    if (s.step !== "text" && s.step !== "photo") return answer("");
    await clear(); await askConsent(env, chat, s, q.from); return answer("");
  }
  if (p[1] === "c" && s.step === "consent" && ["pub", "anon", "no"].includes(p[2])) {
    const o = await getOrder(env, s.order);
    await env.DB.delete("rvw:" + chat); await clear();
    if (!o || o.clientChat !== chat || await getReview(env, s.order)) return answer("Отзыв уже получен, спасибо!");
    const r = { id: o.id, item: itemLabel(o), post: o.post || null, rating: s.rating, text: s.text || "", photo: s.photo || null,
      name: p[2] === "pub" ? publicName(q.from) : "Покупатель", consent: p[2], consentText: p[2] === "no" ? null : CONSENT_TEXT,
      status: p[2] === "no" ? "private" : "pending", chat, ts: Date.now() };
    await putReview(env, r);
    o.reviewGot = true; o.history.push({ t: msk(), s: "Получен отзыв " + r.rating + "/5" }); await putOrder(env, o);
    for (const a of await admins(env)) {
      if (r.photo) await tg(env, "sendPhoto", { chat_id: a, photo: r.photo });
      await send(env, a, reviewText(r), { reply_markup: reviewKb(r) });
    }
    await send(env, chat, p[2] === "no" ? "Спасибо! Передали менеджеру, публиковать не будем." : "Спасибо! После проверки отзыв появится в канале @buyitru.");
    return answer("Спасибо!");
  }
  return answer("");
}

// ---------- обработка апдейтов ----------
async function onMessage(env, m) {
  const chat = m.chat.id, from = m.from || {}, text = (m.text || m.caption || "").trim();
  if (m.chat.type !== "private") return;

  // Лана — админ
  if (env.LANA_USERNAME && (from.username || "").toLowerCase() === env.LANA_USERNAME.toLowerCase() && !(await kvGet(env, "admin:lana"))) {
    await kvPut(env, "admin:lana", from.id);
    await tg(env, "setMyCommands", { commands: ADMIN_CMDS, scope: { type: "chat", chat_id: from.id } });
    await send(env, from.id, "Вы подключены как менеджер ItalBridge.\n\n" + HELP, { reply_markup: ADMIN_KB });
    if (text === "/start") return;
  }
  const admin = await isAdmin(env, from.id);
  const name = from.first_name || from.username || "админ";

  // клиент заполняет отзыв (в том числе админ, который проверяет сценарий)
  const rvs = await kvGet(env, "rvw:" + chat);
  if (rvs && await reviewInput(env, m, rvs)) return;

  if (admin) {
    // ожидание трек-номера
    const wait = await kvGet(env, "wait:" + chat);
    if (wait && wait.what === "track" && text && !text.startsWith("/")) {
      const o = await getOrder(env, wait.order);
      await env.DB.delete("wait:" + chat);
      if (o) { o.track = text; await setStatus(env, o, "Отправлен", name); await send(env, chat, card(o) + "\n\n✅ Трек сохранён, клиент уведомлён.", { reply_markup: cardKb(o) }); }
      return;
    }
    // кнопки нижнего меню и отмена
    if (text === "⭐ Отзывы") { const r = await reviewsMenu(env); return send(env, chat, r.text, { reply_markup: r.kb }); }
    if (text === "❓ Помощь" || text === "/help") return send(env, chat, HELP, { reply_markup: ADMIN_KB });
    if (text === "📋 Заказы" || /^(\/zakazy|мои заказы|\/orders)(@\w+)?\s*$/i.test(text)) { const r = await ordersMenu(env); return send(env, chat, r.text, { reply_markup: r.kb }); }
    const oz = text.match(/^\/otzyv(?:@\w+)?\s+(IB-\d+)/i);
    if (oz) {
      const o = await getOrder(env, oz[1].toUpperCase());
      if (!o) return send(env, chat, "Заказ не найден.");
      if (o.status !== "Выдан") return send(env, chat, `Отзыв можно запросить только после статуса «Выдан». Сейчас: ${esc(o.status)}.`);
      if (!o.clientChat) return send(env, chat, "Клиент не привязан к боту — запросить отзыв некому.");
      if (await getReview(env, o.id)) return send(env, chat, "Отзыв по этому заказу уже получен.");
      await askReview(env, o);
      return send(env, chat, `⭐ Запрос отзыва по ${o.id} отправлен клиенту.`);
    }
    if (text === "/cancel") { await env.DB.delete("draft:" + chat); return send(env, chat, "Ввод отменён.", { reply_markup: ADMIN_KB }); }
    // конвертер евро ⇄ USDT
    const isFwd = m.forward_origin || m.forward_date;
    if (!isFwd && (text === "💱 Евро → USDT" || /^\/usdt(@\w+)?\s*$/i.test(text))) {
      const r = await usdtPerEur(env);
      return send(env, chat, (r ? `💱 Сейчас 1 € = ${num(r.rate, 4)} USDT (${esc(r.src)}, ${msk(r.ts)}).\n\n` : "") +
        "Напишите сумму: <code>500 евро</code>, <code>500€</code> — посчитаю в USDT. Обратно: <code>560 usdt</code>.", { reply_markup: ADMIN_KB });
    }
    const fx = !isFwd && (text.match(FX_RE) || text.match(/^\/usdt(?:@\w+)?\s+(\d[\d\s]*(?:[.,]\d+)?)()\s*$/i));
    if (fx) {
      const amount = Number(fx[1].replace(/\s/g, "").replace(",", "."));
      if (amount > 0) return send(env, chat, await fxReply(env, amount, fx[2] || "€"), { reply_markup: ADMIN_KB });
    }
    if (text === "➕ Новый заказ" || /^\/new(@\w+)?\s*$/i.test(text)) {
      const d = { by: name }; await draftPut(env, chat, d);
      return draftNext(env, chat, d);
    }
    // мастер нового заказа: ответы на шаги
    const d = await draftGet(env, chat);
    const fo0 = m.forward_origin || (m.forward_date ? { chat: m.forward_from_chat, message_id: m.forward_from_message_id } : null);
    const fch = fo0 && (fo0.chat || {});
    const fromOurChannel = fch && (fch.username || "").toLowerCase() === "buyitru";
    if (d && d.step && d.step !== "preview" && (!fo0 || fromOurChannel)) {
      if (d.step === "item") {
        const lp = text.match(/t\.me\/buyitru\/(\d+)/i) || (fromOurChannel && fo0.message_id ? [null, String(fo0.message_id)] : null);
        if (lp) {
          const ok = await fillFromPost(env, d, lp[1]);
          if (!ok) await send(env, chat, "Поста нет в каталоге — цену и доставку введите вручную.");
        } else if (text && !text.startsWith("/")) d.item = text;
        else return send(env, chat, STEP_Q.item, { reply_markup: stepKb("item") });
        return draftNext(env, chat, d);
      }
      if (d.step === "goods" || d.step === "delivery") {
        const v = parseMoney(text);
        if (v === null || (d.step === "goods" && v <= 0)) return send(env, chat, "Нужна сумма цифрами, например <code>12100</code>.", { reply_markup: stepKb(d.step) });
        d[d.step] = v; return draftNext(env, chat, d);
      }
      if (d.step === "client") {
        if (!text || text.startsWith("/")) return send(env, chat, STEP_Q.client, { reply_markup: stepKb("client") });
        d.client = text; return draftNext(env, chat, d);
      }
    }
    // пересланный пост поставщика → очередь черновиков
    const fo = m.forward_origin || (m.forward_date ? { date: m.forward_date, chat: m.forward_from_chat } : null);
    if (fo) {
      const srcChat = fo.chat || fo.sender_chat || {};
      const src = srcChat.username || srcChat.title || fo.sender_user_name || (fo.sender_user && (fo.sender_user.username || fo.sender_user.first_name)) || "пересылка";
      const date = (fo.date || m.date) * 1000;
      const group = m.media_group_id || `${chat}_${m.message_id}`;
      const photo = m.photo ? m.photo[m.photo.length - 1].file_id : (m.document && /^image\//.test(m.document.mime_type || "") ? m.document.file_id : null);
      await kvPut(env, `fwdm:${group}:${String(m.message_id).padStart(10, "0")}`,
        { src, srcMsg: fo.message_id || null, date, photo, text: m.caption || m.text || "", by: name, ts: Date.now() }, { expirationTtl: 7 * 86400 });
      if (!m.media_group_id || m.caption) {
        const age = (Date.now() - date) / 3600e3;
        return send(env, chat, `📥 Принято в очередь черновиков: <b>${esc(src)}</b>, пост от ${msk(date)}.` +
          (age > 48 ? "\n⚠️ Посту больше 2 суток — по правилу свежести в черновик не попадёт." : "\nПопадёт в ближайшие черновики (~9:00 / ~19:00)."));
      }
      return;
    }
    if (/^(\/new(@\w+)?|новый заказ)/i.test(text)) {
      const p = parseNewOrder(text);
      if (p.error) return send(env, chat, p.error + "\n\nИли нажмите «➕ Новый заказ» — бот спросит всё по шагам.", { reply_markup: ADMIN_KB });
      const dd = { ...p, by: name, step: "preview" }; await draftPut(env, chat, dd);
      return send(env, chat, draftText(dd), { reply_markup: draftKb() });
    }
    const st = text.match(/^\/status(?:@\w+)?\s+(IB-\d+)/i);
    if (st) { const o = await getOrder(env, st[1].toUpperCase()); return o ? send(env, chat, card(o), { reply_markup: cardKb(o) }) : send(env, chat, "Заказ не найден."); }
    if (text === "/start" || text.startsWith("/start ")) {
      const id = text.split(" ")[1];
      if (!id || !/^IB-\d+$/i.test(id)) return send(env, chat, "Вы администратор ItalBridge.\n\n" + HELP, { reply_markup: ADMIN_KB });
      // админ открыл ссылку клиента (тест) — продолжаем как клиент ниже
    } else if (text) {
      if (d && d.step === "preview") return send(env, chat, "У вас есть незавершённый заказ — проверьте и нажмите «✅ Создать заказ» или «✖️ Отменить»:\n\n" + draftText(d), { reply_markup: draftKb() });
      return send(env, chat, "Выберите действие кнопками внизу 👇\n\n" + HELP, { reply_markup: ADMIN_KB });
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
  if (data.startsWith("rv:")) return onReviewCb(env, q, answer);
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

  // меню отзывов и запрос отзыва кнопкой
  const rl = data.match(/^rl:(IB-\d+)$/);
  if (rl) {
    const r = await getReview(env, rl[1]);
    if (!r) return answer("Отзыв не найден", true);
    if (r.photo) await tg(env, "sendPhoto", { chat_id: msg.chat.id, photo: r.photo });
    await send(env, msg.chat.id, reviewText(r), { reply_markup: reviewKb(r) });
    return answer("");
  }
  const rq = data.match(/^rq:(IB-\d+)(:m)?$/);
  if (rq) {
    const o = await getOrder(env, rq[1]);
    if (!o || o.status !== "Выдан" || !o.clientChat) return answer("Запросить нельзя: нужен заказ «Выдан» с привязанным клиентом", true);
    if (await getReview(env, o.id)) return answer("Отзыв по этому заказу уже получен", true);
    if (o.reviewAsked && Date.now() - o.reviewAsked < 3600e3) return answer("Запрос уже отправлен меньше часа назад", true);
    await askReview(env, o);
    if (rq[2]) { const m = await reviewsMenu(env); await tg(env, "editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, text: m.text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: m.kb }); }
    return answer("Запрос отправлен клиенту");
  }

  // проверка отзывов
  const ra = data.match(/^ra:(IB-\d+):(ok|hide)$/);
  if (ra) {
    const r = await getReview(env, ra[1]);
    if (!r || r.consent === "no") return answer("Недоступно", true);
    if (r.published) return answer("Уже опубликован", true);
    r.status = ra[2] === "ok" ? "approved" : "hidden"; r.by = name; r.dts = Date.now();
    await putReview(env, r);
    await tg(env, "editMessageReplyMarkup", { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: reviewKb(r) });
    return answer(r.status === "approved" ? "Одобрен — выйдет в ближайшую публикацию" : "Скрыт");
  }

  // мастер нового заказа
  const nw = data.match(/^nw:(.+)$/);
  if (nw) {
    const chat = msg.chat.id; const d = await draftGet(env, chat);
    const act = nw[1];
    if (act === "cancel") {
      await env.DB.delete("draft:" + chat);
      await tg(env, "editMessageReplyMarkup", { chat_id: chat, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } });
      await send(env, chat, "✖️ Новый заказ отменён — ничего не создано.", { reply_markup: ADMIN_KB });
      return answer("Отменено");
    }
    if (!d) { await tg(env, "editMessageReplyMarkup", { chat_id: chat, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } }); return answer("Черновик уже закрыт. Нажмите «➕ Новый заказ».", true); }
    if (act.startsWith("d:") && d.step === "delivery") {
      d.delivery = Number(act.slice(2));
      await tg(env, "editMessageReplyMarkup", { chat_id: chat, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } });
      await answer("Доставка: " + rub(d.delivery)); await draftNext(env, chat, d); return;
    }
    if (act.startsWith("e:")) {
      const f = act.slice(2); if (!STEP_Q[f]) return answer("");
      d.step = f; d.editing = true; await draftPut(env, chat, d);
      await answer("Изменяем");
      return send(env, chat, STEP_Q[f], { reply_markup: stepKb(f) });
    }
    if (act === "ok") {
      if (d.step !== "preview" || !d.item || !d.goods || d.delivery == null || !d.client) return answer("Заполните все шаги", true);
      await env.DB.delete("draft:" + chat);
      const o = await createOrder(env, d, name);
      await tg(env, "editMessageText", { chat_id: chat, message_id: msg.message_id, text: draftText(d).replace("📝 <b>Новый заказ — проверьте</b>", `✅ <b>Создан ${o.id}</b>`).replace("\n\nЗаказ появится только после «✅ Создать заказ».", ""), parse_mode: "HTML", disable_web_page_preview: true, reply_markup: { inline_keyboard: [] } });
      await send(env, chat, card(o) + "\n\n👉 Перешлите клиенту ссылку выше — после нажатия «Запустить» он будет получать статусы.", { reply_markup: cardKb(o) });
      return answer("Заказ " + o.id + " создан");
    }
    return answer("");
  }
  // список заказов
  const ls = data.match(/^ls:(.+)$/);
  if (ls) {
    const r = ls[1] === "menu" ? await ordersMenu(env) : await ordersList(env, ls[1]);
    await tg(env, "editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, text: r.text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: r.kb });
    return answer("");
  }
  const od = data.match(/^od:(IB-\d+)$/);
  if (od) {
    const o = await getOrder(env, od[1]); if (!o) return answer("Заказ не найден", true);
    await send(env, msg.chat.id, card(o), { reply_markup: cardKb(o) });
    return answer("");
  }

  const sm = data.match(/^st:(IB-\d+):(\w+)$/);
  if (!sm) return answer("");
  const o = await getOrder(env, sm[1]);
  if (!o) return answer("Заказ не найден", true);
  const code = sm[2];
  const refresh = () => msg && tg(env, "editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, text: card(o), parse_mode: "HTML", disable_web_page_preview: true, reply_markup: cardKb(o) });
  // разрешены только следующие шаги (старые кнопки на старых сообщениях не срабатывают)
  const allowed = new Set([...(NEXT_BTNS[o.status] || []).map(x => x[1]), ...(["Выдан", "Отменён"].includes(o.status) ? [] : ["cancel"]), ...(o.status === "Принят" ? ["nopay"] : [])]);
  if (!allowed.has(code)) { await refresh(); return answer(`Статус уже «${o.status}» — обновил карточку`); }

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

  // любое сообщение с кнопками заказа превращается в актуальную карточку со следующими шагами
  await refresh();
}

const ADMIN_CMDS = [
  { command: "zakazy", description: "Открытые заказы" },
  { command: "new", description: "Новый заказ" },
  { command: "status", description: "Карточка заказа: /status IB-0001" },
  { command: "otzyv", description: "Запросить отзыв: /otzyv IB-0001" },
  { command: "usdt", description: "Евро → USDT: /usdt 500" },
  { command: "cancel", description: "Отменить ввод заказа" },
  { command: "help", description: "Как работать с заказами" },
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
  if (url.pathname === "/api/queue") {
    const groups = {}; let cursor;
    do { const r = await env.DB.list({ prefix: "fwdm:", cursor });
      const vals = await Promise.all(r.keys.map(k => kvGet(env, k.name)));
      for (let ix = 0; ix < r.keys.length; ix++) { const k = r.keys[ix]; const [, g] = k.name.split(":"); const v = vals[ix]; if (!v) continue;
        const G = groups[g] ||= { group: g, src: v.src, srcMsg: v.srcMsg, date: v.date, by: v.by, photos: [], text: "" };
        if (v.photo) G.photos.push(v.photo); if (v.text && !G.text) G.text = v.text; if (v.srcMsg && !G.srcMsg) G.srcMsg = v.srcMsg; }
      cursor = r.list_complete ? null : r.cursor; } while (cursor);
    return j({ queue: Object.values(groups).sort((a, b) => a.date - b.date) });
  }
  if (url.pathname === "/api/queue/done" && req.method === "POST") {
    const b = await req.json(); let cursor, n = 0;
    do { const r = await env.DB.list({ prefix: `fwdm:${b.group}:`, cursor }); await Promise.all(r.keys.map(k => env.DB.delete(k.name))); n += r.keys.length; cursor = r.list_complete ? null : r.cursor; } while (cursor);
    return j({ ok: true, deleted: n });
  }
  if (url.pathname === "/api/reviews") {
    const st = url.searchParams.get("status");
    return j({ reviews: (await listReviews(env)).filter(r => !st || (r.status === st && !r.published)) });
  }
  if (url.pathname === "/api/reviews/done" && req.method === "POST") {
    const b = await req.json(); const r = await getReview(env, b.id);
    if (!r || r.status !== "approved") return j({ ok: false, error: "not approved" });
    if (!r.published) {
      r.published = b.post; r.pts = Date.now(); await putReview(env, r);
      await send(env, r.chat, `Ваш отзыв опубликован, спасибо! https://t.me/buyitru/${b.post}`);
    }
    return j({ ok: true });
  }
  if (url.pathname === "/api/forget" && req.method === "POST") { const b = await req.json(); await env.DB.delete("dec:" + b.key); return j({ ok: true }); }
  return new Response("not found", { status: 404 });
}

// ---------- живой курс € Т-Банка (для мини-приложения) ----------
const KURS_TTL = 2 * 3600e3; // обновлять не реже раза в 2 часа
async function fetchKurs() {
  const r = await fetch("https://bankiros.ru/bank/tcs/currency/eur/moskva", { headers: { "User-Agent": "Mozilla/5.0 (ItalBridge bot)", "Accept-Language": "ru" }, cf: { cacheTtl: 600 } });
  if (!r.ok) throw new Error("bankiros " + r.status);
  const t = (await r.text()).replace(/<[^>]+>/g, " ").replace(/&nbsp;|\s+/g, " ");
  const m = t.match(/Курсы «Т-Банка»[\s\S]{0,200}?EUR\s*([\d]{2,3}[.,]\d{1,2})\s+([\d]{2,3}[.,]\d{1,2})/);
  if (!m) throw new Error("bankiros: блок не найден");
  const buy = parseFloat(m[1].replace(",", ".")), sell = parseFloat(m[2].replace(",", "."));
  if (!(sell > 60 && sell < 150 && buy < sell)) throw new Error("bankiros: странные числа " + buy + "/" + sell);
  return { kurs: sell, buy, ts: Date.now(), src: "bankiros.ru · Т-Банк, продажа €" };
}
async function getKurs(env, force = false) {
  const c = await kvGet(env, "kurs:live");
  if (!force && c && Date.now() - c.ts < KURS_TTL) return c;
  try { const k = await fetchKurs(); await kvPut(env, "kurs:live", k); return k; }
  catch (e) { console.log("kurs", String(e)); return c ? { ...c, stale: true } : null; }
}
async function kursResponse(env) {
  const k = await getKurs(env);
  return new Response(JSON.stringify(k || { kurs: null }), { status: k ? 200 : 503, headers: {
    "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" } });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/kurs") return kursResponse(env);
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
    await getKurs(env, true);
    // 07:00 UTC = 10:00 МСК — сводка; остальные запуски — только напоминания о просрочках
    const morning = new Date(ev.scheduledTime).getUTCHours() === 7;
    await daily(env, morning);
    if (morning) await askReviews(env);
  },
};

export { parseNewOrder, card, cardKb, ADMIN_CMDS };
