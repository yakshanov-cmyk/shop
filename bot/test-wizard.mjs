// Локальный прогон: мастер нового заказа и список заказов
import worker from "./worker.js";
const store = new Map();
const DB = { get: async k => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); }, delete: async k => { store.delete(k); },
  list: async ({ prefix }) => ({ keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }) };
const sent = []; let mid = 100;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://yakshanov-cmyk.github.io/shop/catalog.json"))
    return { json: async () => ({ items: [{ post: 13371, brand: "Prada", title: "мужские кроссовки", price: 57100, c: "2" }] }) };
  const method = url.split("/").pop(); const body = JSON.parse(init.body); sent.push({ method, ...body });
  return { json: async () => ({ ok: true, result: { message_id: ++mid } }) };
};
const env = { DB, BOT_TOKEN: "x", WEBHOOK_SECRET: "s", API_KEY: "k", OWNER_ID: "568002310", MANAGER: "LanaY777", LANA_USERNAME: "LanaY777", PAY_TEXT: "СБП" };
const OWNER = 568002310; let uid = 1;
const hook = u => worker.fetch(new Request("https://w/tg", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "s" }, body: JSON.stringify({ update_id: uid++, ...u }) }), env);
const msg = (id, text, extra = {}) => hook({ message: { message_id: ++mid, date: Math.floor(Date.now()/1000), chat: { id, type: "private" }, from: { id, first_name: "Александр" }, text, ...extra } });
const cb = (id, data, message_id = 1) => hook({ callback_query: { id: "q" + uid, from: { id, first_name: "Александр" }, data, message: { chat: { id }, message_id } } });
const out = () => sent.splice(0).map(x => `${x.method}: ${(x.text || "").slice(0, 150).replace(/\n/g, " ⏎ ")}${x.reply_markup ? "  KB:" + JSON.stringify(x.reply_markup).replace(/"callback_data":"[^"]*",?/g, "").slice(0, 150) : ""}`).join("\n");
const orders = () => [...store.keys()].filter(k => k.startsWith("order:"));
const check = (name, cond) => console.log((cond ? "✅ " : "❌ ") + name);

await msg(OWNER, "/start"); console.log("A /start:\n" + out());
await msg(OWNER, "➕ Новый заказ"); console.log("\nB шаг 1:\n" + out());
await msg(OWNER, "Coccinelle сумка чёрная"); console.log("\nC шаг 2:\n" + out());
await msg(OWNER, "двенадцать"); console.log("\nD ошибка цены:\n" + out());
await msg(OWNER, "12 100 ₽"); console.log("\nE шаг 3:\n" + out());
await cb(OWNER, "nw:d:1500", 5); console.log("\nF доставка кнопкой → шаг 4:\n" + out());
await msg(OWNER, "Анна @anna"); console.log("\nG предпросмотр:\n" + out());
check("до ✅ заказ не создан", orders().length === 0);
await cb(OWNER, "nw:e:goods", 6); out(); await msg(OWNER, "13000"); console.log("\nH правка цены → снова предпросмотр:\n" + out());
await cb(OWNER, "nw:ok", 7); console.log("\nI создать:\n" + out());
check("создан IB-0001 с ценой 13000", orders().length === 1 && JSON.parse(store.get("order:IB-0001")).goods === 13000);
await cb(OWNER, "nw:ok", 7); console.log("\nJ повторное ✅ (двойное нажатие):\n" + out());
check("дубль не создан", orders().length === 1);

await msg(OWNER, "/new"); out(); await msg(OWNER, "https://t.me/buyitru/13371"); console.log("\nK из ссылки на пост → сразу клиент:\n" + out());
await msg(OWNER, "Иван +7 900"); console.log("\nL предпросмотр:\n" + out());
await cb(OWNER, "nw:cancel", 9); console.log("\nM отмена:\n" + out());
check("после отмены заказов всё ещё 1", orders().length === 1);

await msg(OWNER, "/new"); out();
await hook({ message: { message_id: ++mid, date: 1, chat: { id: OWNER, type: "private" }, from: { id: OWNER, first_name: "А" }, photo: [{ file_id: "f" }], caption: "Prada", forward_origin: { type: "channel", chat: { username: "buyitru" }, message_id: 13371, date: 1 } } });
console.log("\nN пересланный пост канала на шаге 1:\n" + out());
check("из пересланного поста подставлена цена 57100 и доставка 3000", (() => { const d = JSON.parse(store.get("draft:" + OWNER)); return d.goods === 57100 && d.delivery === 3000; })());
await msg(OWNER, "Ольга"); await cb(OWNER, "nw:ok", 11); out();
await msg(OWNER, "новый заказ: Тест; 1000; Кл"); console.log("\nO однострочный формат → предпросмотр, без создания:\n" + out());
check("однострочный не создал сразу", orders().length === 2);
await cb(OWNER, "nw:ok", 12); out();
check("после ✅ создан третий", orders().length === 3);

await cb(OWNER, "st:IB-0001:paid", 20); out();
await msg(OWNER, "📋 Заказы"); console.log("\nP меню заказов:\n" + out());
await cb(OWNER, "ls:s1", 30); console.log("\nQ раздел «Оплачен»:\n" + out());
await cb(OWNER, "od:IB-0001", 30); console.log("\nR карточка:\n" + out());
await cb(OWNER, "ls:menu", 30); console.log("\nS назад:\n" + out());
await msg(OWNER, "привет"); console.log("\nT прочий текст:\n" + out());
// поставщик пересылается на шаге 1 → в очередь, не в мастер
await msg(OWNER, "/new"); out();
await hook({ message: { message_id: ++mid, date: Math.floor(Date.now()/1000), chat: { id: OWNER, type: "private" }, from: { id: OWNER, first_name: "А" }, photo: [{ file_id: "f" }], caption: "#Gucci 300€", forward_origin: { type: "channel", chat: { username: "italianshops" }, message_id: 5, date: Math.floor(Date.now()/1000) } } });
console.log("\nU пост поставщика во время мастера:\n" + out());
check("мастер всё ещё на шаге 1", JSON.parse(store.get("draft:" + OWNER)).step === "item");
