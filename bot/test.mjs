// Локальный прогон сценария заказа с поддельными KV и Telegram
import worker from "./worker.js";

const store = new Map();
const DB = {
  get: async k => store.get(k) ?? null,
  put: async (k, v) => { store.set(k, v); },
  delete: async k => { store.delete(k); },
  list: async ({ prefix }) => ({ keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }),
};
const sent = [];
let mid = 100;
globalThis.fetch = async (url, init) => {
  const method = url.split("/").pop(); const body = JSON.parse(init.body);
  sent.push({ method, ...body });
  return { json: async () => ({ ok: true, result: { message_id: ++mid } }) };
};
const env = { DB, BOT_TOKEN: "x", WEBHOOK_SECRET: "s", API_KEY: "k", OWNER_ID: "568002310", MANAGER: "LanaY777", LANA_USERNAME: "LanaY777", PAY_TEXT: "Оплата по СБП: +7 XXX, Т-Банк, получатель Тест" };
const OWNER = 568002310, LANA = 777, CLIENT = 555;
let uid = 1;
const hook = u => worker.fetch(new Request("https://w/tg", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "s" }, body: JSON.stringify({ update_id: uid++, ...u }) }), env);
const msg = (id, text, extra = {}, username) => hook({ message: { message_id: ++mid, chat: { id, type: "private" }, from: { id, first_name: "U" + id, username }, text, ...extra } });
const cb = (id, data, message) => hook({ callback_query: { id: "q" + uid, from: { id, first_name: "U" + id }, data, message } });
const last = (n = 1) => { const s = sent.splice(0); return s.map(x => `${x.method} → ${x.chat_id ?? ""}: ${(x.text || x.callback_query_id && x.text || "").slice(0, 160).replace(/\n/g, " ⏎ ")}${x.reply_markup ? " KB:" + JSON.stringify(x.reply_markup).slice(0, 160) : ""}`).join("\n"); };

await msg(LANA, "/start", {}, "LanaY777"); console.log("1 Лана /start:\n" + last());
await msg(OWNER, "новый заказ: Coccinelle сумка чёрная; 12 100 ₽; 1500; Анна @anna"); console.log("\n2 новый заказ:\n" + last());
await msg(OWNER, "новый заказ: Prada кошелёк; 30000"); console.log("\n2b ошибка:\n" + last());
await cb(OWNER, "st:IB-0001:inv", { chat: { id: OWNER }, message_id: 1, text: "🧾 Заказ IB-0001" }); console.log("\n3 счёт без клиента:\n" + last());
await msg(CLIENT, "/start IB-0001"); console.log("\n4 клиент привязался:\n" + last());
await msg(999, "/start IB-0001"); console.log("\n4b чужой:\n" + last());
await cb(OWNER, "st:IB-0001:inv", { chat: { id: OWNER }, message_id: 1, text: "🧾 Заказ IB-0001" }); console.log("\n5 счёт:\n" + last());
await msg(CLIENT, "", { photo: [{ file_id: "p" }] }); console.log("\n6 чек:\n" + last());
await cb(OWNER, "st:IB-0001:paid", { chat: { id: OWNER }, message_id: 2, text: "🧾 Чек по IB-0001" }); console.log("\n7 оплачено:\n" + last());
await cb(LANA, "st:IB-0001:bought", { chat: { id: LANA }, message_id: 3, text: "🧾 Заказ IB-0001" }); console.log("\n8 выкуплен (Лана):\n" + last());
await cb(LANA, "st:IB-0001:sent", { chat: { id: LANA }, message_id: 3, text: "🧾 Заказ IB-0001" }); await msg(LANA, "RU123456789IT", {}, "LanaY777"); console.log("\n9 отправлен + трек:\n" + last());
await msg(CLIENT, "/status"); console.log("\n10 /status клиента:\n" + last());
await msg(CLIENT, "Когда приедет?"); console.log("\n11 вопрос клиента:\n" + last());
await msg(OWNER, "/zakazy"); console.log("\n12 /zakazy:\n" + last());
await cb(OWNER, "pub:italianshops:18604", { chat: { id: OWNER }, message_id: 50, reply_markup: { inline_keyboard: [[{ text: "💶", url: "https://x" }], [{ text: "✅", callback_data: "pub:italianshops:18604" }]] } }); console.log("\n13 черновик ✅:\n" + last());
await cb(CLIENT, "st:IB-0001:done", { chat: { id: CLIENT }, message_id: 9 }); console.log("\n14 клиент жмёт админ-кнопку:\n" + last());
const st = await worker.fetch(new Request("https://w/api/state", { headers: { "X-Api-Key": "k" } }), env); console.log("\n15 API state:", (await st.text()).slice(0, 300));
const bad = await worker.fetch(new Request("https://w/api/state", { headers: { "X-Api-Key": "no" } }), env); console.log("16 API без ключа:", bad.status);
const badHook = await worker.fetch(new Request("https://w/tg", { method: "POST", body: "{}" }), env); console.log("17 webhook без секрета:", badHook.status);
await msg(888, "привет"); await msg(888, "ещё раз"); console.log("\n18 незнакомец 2 раза:\n" + last());

// --- регрессия: Выдан после трек-номера и защита от старых кнопок
await msg(OWNER, "новый заказ: Тест; 1000; Кл"); last();
const id2 = "IB-0002";
for (const c of ["paid","bought"]) await cb(OWNER, `st:${id2}:${c}`, { chat: { id: OWNER }, message_id: 70, text: "🧾 Заказ" });
await cb(OWNER, `st:${id2}:sent`, { chat: { id: OWNER }, message_id: 70, text: "🧾 Заказ" }); await msg(OWNER, "TRACK1"); last();
await cb(OWNER, `st:${id2}:msk`, { chat: { id: OWNER }, message_id: 71, text: "🧾 Заказ IB-0002 ... ✅ Трек сохранён" });
console.log("\n19 после «В Москве» под сообщением с треком:\n" + last());
await cb(OWNER, `st:${id2}:sent`, { chat: { id: OWNER }, message_id: 70, text: "🧾 Заказ" });
console.log("\n20 старая кнопка «Отправлен»:\n" + last());
await cb(OWNER, `st:${id2}:done`, { chat: { id: OWNER }, message_id: 71, text: "🧾 Заказ" });
console.log("\n21 Выдан:\n" + last());

// --- пересылка постов поставщика в очередь
const now = Math.floor(Date.now()/1000);
await hook({ message: { message_id: 900, date: now, media_group_id: "G1", chat: { id: OWNER, type: "private" }, from: { id: OWNER, first_name: "Александр" }, photo: [{ file_id: "s" }, { file_id: "BIG1" }], caption: "#Prada | 520€", forward_origin: { type: "channel", chat: { title: "Онлайн-шопинг в Италии", username: "shopping_italia_outlet" }, message_id: 777, date: now - 3600 } } });
await hook({ message: { message_id: 901, date: now, media_group_id: "G1", chat: { id: OWNER, type: "private" }, from: { id: OWNER, first_name: "Александр" }, photo: [{ file_id: "BIG2" }], forward_origin: { type: "channel", chat: { username: "shopping_italia_outlet" }, message_id: 778, date: now - 3600 } } });
await hook({ message: { message_id: 902, date: now, chat: { id: OWNER, type: "private" }, from: { id: OWNER, first_name: "Александр" }, photo: [{ file_id: "OLD" }], caption: "#Gucci 300€", forward_origin: { type: "channel", chat: { title: "X" }, message_id: 5, date: now - 4*86400 } } });
console.log("\n22 пересылка:\n" + last());
const q = await (await worker.fetch(new Request("https://w/api/queue", { headers: { "X-Api-Key": "k" } }), env)).json();
console.log("23 очередь:", JSON.stringify(q.queue.map(g => [g.group, g.src, g.srcMsg, g.photos, g.text])));
await worker.fetch(new Request("https://w/api/queue/done", { method: "POST", headers: { "X-Api-Key": "k" }, body: JSON.stringify({ group: "G1" }) }), env);
const q2 = await (await worker.fetch(new Request("https://w/api/queue", { headers: { "X-Api-Key": "k" } }), env)).json();
console.log("24 после done:", q2.queue.length);
await hook({ message: { message_id: 903, date: now, chat: { id: CLIENT, type: "private" }, from: { id: CLIENT }, text: "смотрите", forward_origin: { type: "channel", chat: { title: "X" }, date: now } } });
console.log("25 пересылка от клиента (не в очередь):\n" + last());
