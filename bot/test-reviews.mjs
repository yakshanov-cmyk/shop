// Локальный прогон: отзывы (сбор, согласие, проверка, API, cron)
import assert from "node:assert";
import worker from "./worker.js";
const realNow = Date.now; Date.now = () => realNow() + 30 * 86400e3; // тест идёт «после запуска» отзывов (REVIEW_FROM)
const store = new Map();
const DB = { get: async k => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); }, delete: async k => { store.delete(k); },
  list: async ({ prefix }) => ({ keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }) };
let sent = []; let mid = 100;
globalThis.fetch = async (url, init) => { const method = url.split("/").pop(); sent.push({ method, ...JSON.parse(init.body) }); return { json: async () => ({ ok: true, result: { message_id: ++mid } }) }; };
const env = { DB, BOT_TOKEN: "x", WEBHOOK_SECRET: "s", API_KEY: "k", OWNER_ID: "1", MANAGER: "LanaY777", LANA_USERNAME: "LanaY777", PAY_TEXT: "СБП" };
const OWNER = 1, CLIENT = 555, OTHER = 666; let uid = 1;
const hook = u => worker.fetch(new Request("https://w/tg", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "s" }, body: JSON.stringify({ update_id: uid++, ...u }) }), env);
const msg = (id, text, extra = {}, from = {}) => hook({ message: { message_id: ++mid, chat: { id, type: "private" }, from: { id, first_name: "U", ...from }, text, ...extra } });
const cb = (id, data, from = {}) => hook({ callback_query: { id: "q" + uid, from: { id, first_name: "Анна", last_name: "Котова", ...from }, data, message: { chat: { id }, message_id: 5 } } });
const take = () => { const s = sent; sent = []; return s; };
const api = (p, body) => worker.fetch(new Request("https://w" + p, { method: body ? "POST" : "GET", headers: { "X-Api-Key": "k" }, body: body ? JSON.stringify(body) : undefined }), env).then(r => r.json());
const order = (id, chat, status = "Выдан", extra = {}) => store.set("order:" + id, JSON.stringify({ id, item: "Prada — кроссовки (пост https://t.me/buyitru/13371)", post: 13371, goods: 57100, delivery: 3000, client: "Анна", clientChat: chat, status, since: Date.now(), created: Date.now(), history: [], ...extra }));
const r = id => JSON.parse(store.get("review:" + id) || "null");
const ord = id => JSON.parse(store.get("order:" + id));
const cron = h => worker.scheduled({ scheduledTime: Date.UTC(2026, 10, 12, h) }, env);
store.set("client:" + CLIENT, JSON.stringify(["IB-0010", "IB-0011", "IB-0012"]));

// cron: кого спрашиваем
const dayAgo = n => Date.now() - n * 86400e3;
order("IB-0003", OWNER, "Выдан", { since: Date.UTC(2026, 10, 7) });   // проверочный, до запуска
order("IB-0010", CLIENT, "Выдан", { since: dayAgo(2.1) });
order("IB-0011", CLIENT, "Выдан", { since: dayAgo(1) });               // рано
order("IB-0012", CLIENT, "В Москве", { since: dayAgo(5) });            // не выдан
order("IB-0013", null, "Выдан", { since: dayAgo(5) });                 // не привязан
await cron(15); assert.equal(take().filter(x => x.chat_id === CLIENT).length, 0, "вечером не спрашиваем");
await cron(7); let s = take().filter(x => String(x.text).startsWith("Как вам заказ")); // сводка и просрочки админу здесь не важны
assert.equal(s.length, 1, "только IB-0010"); assert.equal(s[0].chat_id, CLIENT); assert.ok(s[0].text.includes("IB-0010")); assert.ok(!s[0].text.includes("t.me/buyitru"), "без ссылки");
await cron(7); assert.equal(take().filter(x => String(x.text).startsWith("Как вам заказ")).length, 0, "повторно не спрашиваем");

// чужой не может оценить; не-админ не может модерировать
await cb(OTHER, "rv:r:IB-0010:5"); assert.equal(take().at(-1).text, "Недоступно"); assert.equal(store.get("rvw:" + OTHER), undefined);

// полный путь: оценка → текст → фото → согласие с именем → проверка
await cb(CLIENT, "rv:r:IB-0010:5"); s = take(); assert.ok(s.some(x => x.method === "sendMessage" && x.text.startsWith("Спасибо! Напишите")));
await msg(CLIENT, "Всё пришло, <b>отлично</b>"); s = take(); assert.ok(s[0].text.includes("Пришлите фото"));
await msg(CLIENT, "просто текст снова"); s = take(); assert.ok(s[0].text.includes("Пропустить"));
await msg(CLIENT, "", { photo: [{ file_id: "s" }, { file_id: "BIG" }] }, { first_name: "Анна", last_name: "Котова" }); s = take();
assert.ok(s[0].reply_markup.inline_keyboard[0][0].text.includes("Анна К."));
await msg(CLIENT, "вопрос менеджеру"); s = take(); assert.ok(s.some(x => x.method === "forwardMessage"), "на шаге согласия сообщение уходит менеджеру");
await cb(CLIENT, "rv:c:pub"); s = take();
assert.equal(r("IB-0010").name, "Анна К."); assert.equal(r("IB-0010").status, "pending"); assert.equal(r("IB-0010").photo, "BIG"); assert.equal(r("IB-0010").item, "Prada — кроссовки");
const toAdmin = s.find(x => x.method === "sendMessage" && x.chat_id === OWNER);
assert.ok(toAdmin.text.includes("&lt;b&gt;отлично"), "текст экранирован"); assert.ok(s.some(x => x.method === "sendPhoto" && x.chat_id === OWNER));
assert.equal(store.get("rvw:" + CLIENT), undefined);
// повторная оценка
await cb(CLIENT, "rv:r:IB-0010:1"); s = take(); assert.ok(s.at(-1).text.includes("уже получен")); assert.equal(r("IB-0010").rating, 5);
// модерация
await cb(CLIENT, "ra:IB-0010:ok"); assert.equal(take().at(-1).text, "Недоступно"); assert.equal(r("IB-0010").status, "pending");
assert.equal((await api("/api/reviews?status=approved")).reviews.length, 0);
assert.equal((await api("/api/reviews/done", { id: "IB-0010", post: 1 })).ok, false, "неодобренный нельзя отметить");
await cb(OWNER, "ra:IB-0010:hide"); take(); assert.equal(r("IB-0010").status, "hidden");
await cb(OWNER, "ra:IB-0010:ok"); take(); assert.equal(r("IB-0010").status, "approved");
assert.equal((await api("/api/reviews?status=approved")).reviews.length, 1);
assert.equal((await api("/api/reviews/done", { id: "IB-0010", post: 13400 })).ok, true); s = take();
assert.ok(s[0].chat_id === CLIENT && s[0].text.includes("13400"));
assert.equal((await api("/api/reviews?status=approved")).reviews.length, 0);
assert.equal((await api("/api/reviews")).reviews.length, 1);
await api("/api/reviews/done", { id: "IB-0010", post: 13400 }); assert.equal(take().length, 0, "уведомление один раз");
await cb(OWNER, "ra:IB-0010:hide"); assert.ok(take().at(-1).text.includes("Уже опубликован"));

// только оценка, без имени, низкая оценка
order("IB-0011", CLIENT, "Выдан", { since: dayAgo(1) });
await msg(OWNER, "/otzyv IB-0011"); s = take(); assert.ok(s.some(x => x.chat_id === CLIENT)); assert.ok(ord("IB-0011").reviewAsked);
await cb(CLIENT, "rv:r:IB-0011:2"); s = take(); assert.ok(s.at(-2).text.includes("что пошло не так"));
await cb(CLIENT, "rv:skip"); take(); await cb(CLIENT, "rv:c:anon"); s = take();
assert.equal(r("IB-0011").name, "Покупатель"); assert.equal(r("IB-0011").text, ""); assert.ok(s.find(x => x.chat_id === OWNER).text.startsWith("⚠️"));

// «только менеджеру» — без кнопок и без публикации
order("IB-0012", CLIENT, "Выдан");
await msg(OWNER, "/otzyv IB-0012"); take(); await cb(CLIENT, "rv:r:IB-0012:4"); take();
await msg(CLIENT, "С подписью", { photo: [{ file_id: "A" }], media_group_id: "G" }); s = take(); assert.equal(s.length, 1);
await msg(CLIENT, "", { photo: [{ file_id: "B" }], media_group_id: "G" }); assert.equal(take().length, 0, "альбом — один запрос согласия");
await cb(CLIENT, "rv:c:no"); s = take(); const adm = s.find(x => x.method === "sendMessage" && x.chat_id === OWNER);
assert.equal(adm.reply_markup.inline_keyboard.length, 0); assert.equal(r("IB-0012").status, "private"); assert.equal(r("IB-0012").photo, "A");
await cb(OWNER, "ra:IB-0012:ok"); take(); assert.equal(r("IB-0012").status, "private");

// админ: запрет для невыданного, без клиента, чужой /otzyv; админ-тестировщик проходит отзыв
order("IB-0020", CLIENT, "В Москве"); await msg(OWNER, "/otzyv IB-0020"); assert.ok(take()[0].text.includes("только после"));
await msg(OWNER, "/otzyv IB-0013"); assert.ok(take()[0].text.includes("не привязан"));
await msg(CLIENT, "/otzyv IB-0020"); assert.ok(take().every(x => !String(x.text).includes("Запрос отзыва")));
order("IB-0021", OWNER, "Выдан"); await msg(OWNER, "/otzyv IB-0021"); take(); await cb(OWNER, "rv:r:IB-0021:5"); take();
await msg(OWNER, "📋 Заказы"); s = take(); assert.ok(s[0].text.includes("заказ") || s[0].text.includes("Заказ"), "кнопка меню не попала в отзыв"); assert.equal(JSON.parse(store.get("rvw:" + OWNER)).text, "");
await msg(OWNER, "Отличный сервис"); s = take(); assert.ok(s[0].text.includes("Пришлите фото"));
await cb(OTHER, "rv:skip"); s = take(); assert.ok(s.at(-1).show_alert, "нет состояния");
// кнопка «⭐ Отзывы» и запрос из карточки
store.delete("rvw:" + OWNER);
for (const k of [...store.keys()]) if (k.startsWith("review:") || k.startsWith("order:")) store.delete(k);
order("IB-0030", CLIENT); order("IB-0031", CLIENT); order("IB-0003", OWNER, "Выдан", { since: Date.UTC(2026, 10, 7) }); order("IB-0032", null);
await msg(OWNER, "⭐ Отзывы"); s = take();
let cbs = s[0].reply_markup.inline_keyboard.flat().map(b => b.callback_data);
assert.deepEqual(cbs, ["rq:IB-0030:m", "rq:IB-0031:m"], "проверочные и непривязанные не показываем"); assert.ok(s[0].text.includes("Ждут проверки: <b>0</b>"));
await cb(CLIENT, "rq:IB-0030:m"); assert.equal(take().at(-1).text, "Недоступно", "клиенту нельзя");
await cb(OWNER, "rq:IB-0030:m"); s = take(); assert.ok(s.some(x => x.chat_id === CLIENT && x.text.startsWith("Как вам заказ"))); assert.ok(s.find(x => x.method === "editMessageText").reply_markup.inline_keyboard[0][0].text.startsWith("↻"));
await cb(OWNER, "rq:IB-0030:m"); s = take(); assert.ok(s.at(-1).text.includes("меньше часа")); assert.ok(!s.some(x => x.chat_id === CLIENT));
await cb(CLIENT, "rv:r:IB-0030:5"); take(); await cb(CLIENT, "rv:skip"); take(); await cb(CLIENT, "rv:c:anon"); take();
await msg(OWNER, "⭐ Отзывы"); s = take(); cbs = s[0].reply_markup.inline_keyboard.flat().map(b => b.callback_data);
assert.deepEqual(cbs, ["rl:IB-0030", "rq:IB-0031:m"]); assert.ok(s[0].text.includes("Ждут проверки: <b>1</b>"));
await cb(OWNER, "rl:IB-0030"); s = take(); assert.ok(s[0].text.includes("Отзыв по IB-0030")); assert.equal(s[0].reply_markup.inline_keyboard[0][0].callback_data, "ra:IB-0030:ok");
await cb(OWNER, "rq:IB-0030"); assert.ok(take().at(-1).text.includes("уже получен"));
await msg(OWNER, "/status IB-0031"); s = take(); assert.equal(s[0].reply_markup.inline_keyboard[0][0].callback_data, "rq:IB-0031", "кнопка в карточке выданного");
await msg(OWNER, "/status IB-0030"); s = take(); assert.equal(s[0].reply_markup.inline_keyboard.length, 0, "отзыв получен — кнопки нет");
await msg(OWNER, "/status IB-0032"); s = take(); assert.equal(s[0].reply_markup.inline_keyboard.length, 0, "клиент не привязан — кнопки нет");
order("IB-0033", CLIENT, "В Москве"); await msg(OWNER, "/status IB-0033"); s = take(); assert.ok(!JSON.stringify(s[0].reply_markup).includes("rq:"), "не выдан — кнопки нет");
await cb(OWNER, "rq:IB-0033"); assert.ok(take().at(-1).text.includes("Запросить нельзя"));
console.log("test-reviews: все проверки пройдены");
