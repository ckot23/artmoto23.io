"use strict";
/* ============================================================================
   Прямая отправка заявки в Telegram — из браузера, без сервера.

   Раньше заявка шла так:  сайт → POST /api/order → server.js → Telegram.
   Теперь так:             сайт → api.telegram.org/bot<ТОКЕН>/sendMessage.

   Хостинг для этого не нужен: сайт может лежать на GitHub Pages, на флешке
   или в Mini App — браузер сам обращается к Bot API (он отдаёт CORS-заголовки,
   так же работает панель bot.html).

   ⚠️  ТОКЕН ЛЕЖИТ ПРЯМО ЗДЕСЬ, А ЗНАЧИТ ВИДЕН ВСЕМ, кто открыл сайт или
   репозиторий. Любой, у кого есть токен, может читать переписку бота
   (getUpdates) и писать от его имени. Поэтому:
     • заведите для сайта ОТДЕЛЬНОГО бота, не используйте личного;
     • не давайте этому боту админку в своих каналах и группах;
     • если бот начал вести себя странно — /revoke у @BotFather и новый токен
       сюда же, в одну строку ниже.
   Заявки от этого не потеряются: приходят они всё равно только на CHAT_ID.
   ========================================================================= */

/* ---------------------------------------------------------------------------
   НАСТРОЙКИ — единственное, что нужно заполнить.
   ------------------------------------------------------------------------ */

/* Токен бота от @BotFather → /mybots → ваш бот → API Token. */
var BOT_TOKEN = "";

/* Кому присылать заявки: ваш chat_id числом (узнать — напишите боту /id
   в панели bot.html или откройте @userinfobot). Можно несколько получателей
   через запятую: "7114829971,123456789". */
var CHAT_ID = "";

/* ------------------------------------------------------------------------ */

/* В браузере модули приходят обычными <script> и лежат в globalThis,
   в Node — через require. Поддерживаем оба варианта (так же, как botpanel.js). */
var IN_NODE = typeof require === "function" && typeof module !== "undefined";
if (IN_NODE) require("./pricing.js");
var P = (typeof globalThis !== "undefined" && globalThis.Pricing) || (IN_NODE ? require("./pricing.js") : null);
if (!P) throw new Error("tgdirect.js: не загружен pricing.js (подключите его перед этим файлом)");

var TG_API = "https://api.telegram.org/bot";

var config = {
  token: String(BOT_TOKEN || "").trim(),
  chatId: String(CHAT_ID || "").trim(),
  timeoutMs: 15000,
  fetch: null            /* подменяется в тестах */
};

/* Настройки можно переопределить на лету: так делают тесты, а при желании —
   страница админки (localStorage), если токен не хочется держать в файле. */
function configure(patch) {
  var next = patch || {};
  if (next.token !== undefined) config.token = String(next.token || "").trim();
  if (next.chatId !== undefined) config.chatId = String(next.chatId || "").trim();
  if (next.timeoutMs !== undefined) config.timeoutMs = Number(next.timeoutMs) || 15000;
  if (next.fetch !== undefined) config.fetch = next.fetch;
  return config;
}

/* Получателей может быть несколько — заявка уходит каждому. */
function recipients() {
  return config.chatId.split(",").map(function (item) { return item.trim(); })
    .filter(function (item) { return item; });
}

function isReady() {
  return Boolean(config.token && recipients().length);
}

/* ---------------------------------------------------------------------------
   НОМЕР ЗАЯВКИ И ВРЕМЯ (как раньше делал сервер)
   ------------------------------------------------------------------------ */

var orderCounter = 0;

function randomHex(bytes) {
  var buffer = new Uint8Array(bytes);
  var webCrypto = typeof globalThis !== "undefined" ? globalThis.crypto : null;
  if (webCrypto && typeof webCrypto.getRandomValues === "function") {
    webCrypto.getRandomValues(buffer);
  } else {
    for (var i = 0; i < bytes; i++) buffer[i] = Math.floor(Math.random() * 256);
  }
  var out = "";
  for (var j = 0; j < buffer.length; j++) {
    out += (buffer[j] < 16 ? "0" : "") + buffer[j].toString(16);
  }
  return out.toUpperCase();
}

function pad2(value) {
  return (value < 10 ? "0" : "") + value;
}

/* 261007-A3F1 — дата по Москве плюс случайный хвост: номер нужен человеку,
   чтобы сослаться на заявку в переписке, а не для учёта. */
function newOrderId(date) {
  var when = date instanceof Date ? date : new Date();
  var stamp = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow", year: "2-digit", month: "2-digit", day: "2-digit"
  }).format(when).replace(/-/g, "");
  orderCounter = (orderCounter + 1) % 100;
  return stamp + "-" + randomHex(2) + pad2(orderCounter);
}

function moscowTime(date) {
  var when = date instanceof Date ? date : new Date();
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  }).format(when) + " (МСК)";
}

/* ---------------------------------------------------------------------------
   TELEGRAM
   ------------------------------------------------------------------------ */

/* Ошибки Telegram человеческим языком — те же формулировки, что в botpanel.js. */
function hintFor(code, description) {
  var text = String(description || "").toLowerCase();
  if (code === 401) return "токен в tgdirect.js недействителен: возьмите свежий у @BotFather (/mybots → API Token)";
  if (code === 403) return "получатель не начинал диалог с ботом: откройте чат с ботом и нажмите «Start»";
  if (code === 400 && text.indexOf("chat not found") !== -1) return "CHAT_ID указан неверно: напишите боту /id и возьмите число оттуда";
  if (code === 400 && text.indexOf("parse") !== -1) return "текст заявки не прошёл разметку HTML — сообщите разработчику";
  if (code === 429) return "Telegram просит подождать: слишком много сообщений подряд";
  if (text.indexOf("failed to fetch") !== -1 || text.indexOf("networkerror") !== -1 ||
      text.indexOf("load failed") !== -1 || text.indexOf("abort") !== -1) {
    return "браузер не смог достучаться до api.telegram.org: интернет, VPN или блокировщик";
  }
  return "";
}

function call(method, payload) {
  var fetchImpl = config.fetch || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
  if (!fetchImpl) return Promise.reject(new Error("fetch недоступен в этом окружении"));
  var controller = typeof AbortController === "function" ? new AbortController() : null;
  var timer = controller ? setTimeout(function () { controller.abort(); }, config.timeoutMs) : 0;
  return fetchImpl(TG_API + config.token + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
    signal: controller ? controller.signal : undefined
  }).then(function (response) {
    if (timer) clearTimeout(timer);
    return response.json().then(null, function () {
      return { ok: false, description: "некорректный ответ Telegram" };
    });
  }, function (error) {
    if (timer) clearTimeout(timer);
    throw error;
  });
}

/* Проверка настроек: живой ли токен и чей он. Нужна владельцу, а не клиенту. */
function check() {
  if (!isReady()) {
    return Promise.resolve({ ok: false, error: "В tgdirect.js не заполнены BOT_TOKEN и CHAT_ID" });
  }
  return call("getMe", {}).then(function (data) {
    if (data && data.ok && data.result) return { ok: true, bot: data.result };
    var reason = (data && data.description) || "нет ответа";
    return { ok: false, error: reason, hint: hintFor(data && data.error_code, reason) };
  }, function (error) {
    var reason = error && error.message ? error.message : "нет связи";
    return { ok: false, error: reason, hint: hintFor(0, reason) };
  });
}

function sendMessage(chatId, text) {
  return call("sendMessage", {
    chat_id: chatId,
    text: text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

/* ---------------------------------------------------------------------------
   ЗАЯВКА
   ------------------------------------------------------------------------ */

/* Текст заявки для менеджера — ровно тот же, что раньше собирал сервер
   (pricing.js → orderMessage), поэтому привычный вид сообщения не меняется. */
function buildMessage(order, price, meta) {
  return P.orderMessage(order, price, meta || {});
}

/* Единственная точка отправки: проверка полей → расчёт цены → sendMessage.

   Возвращает всегда разрешённый промис:
     { ok: true,  order_id, total, unit }
     { ok: false, error, hint, kind }   kind: field | config | telegram | network

   Важное отличие от серверной версии: цена считается здесь же, в браузере,
   поэтому «client_total» и расчёт заявки совпадают по определению. Пометка
   «проверьте расчёт» остаётся — она сработает, если кто-то подделает запрос. */
function send(raw, options) {
  var opts = options || {};

  var checked = P.validate(raw);
  if (!checked.ok) return Promise.resolve({ ok: false, error: checked.error, kind: "field" });

  if (!isReady()) {
    return Promise.resolve({
      ok: false,
      kind: "config",
      error: "Отправка заявок не настроена",
      hint: "впишите BOT_TOKEN и CHAT_ID в начале файла tgdirect.js"
    });
  }

  var order = checked.value;
  var price = P.calculate(order);
  var now = opts.now instanceof Date ? opts.now : new Date();
  var orderId = opts.orderId || newOrderId(now);
  var text = buildMessage(order, price, {
    orderId: orderId,
    time: moscowTime(now),
    userId: opts.userId
  });

  var targets = recipients();
  return Promise.all(targets.map(function (chatId) {
    return sendMessage(chatId, text).then(function (data) {
      return { chatId: chatId, data: data };
    }, function (error) {
      return { chatId: chatId, error: error };
    });
  })).then(function (results) {
    var delivered = results.filter(function (item) { return item.data && item.data.ok; });
    if (delivered.length) {
      return { ok: true, order_id: orderId, total: price.total, unit: price.unit };
    }
    var first = results[0] || {};
    if (first.error) {
      var netReason = first.error && first.error.message ? first.error.message : "нет связи";
      return {
        ok: false, kind: "network",
        error: "Не удалось связаться с Telegram (" + netReason + ")",
        hint: hintFor(0, netReason)
      };
    }
    var reason = (first.data && first.data.description) || "Telegram не принял заявку";
    return {
      ok: false, kind: "telegram",
      error: reason,
      hint: hintFor(first.data && first.data.error_code, reason)
    };
  });
}

var API = {
  TG_API: TG_API,
  configure: configure,
  isReady: isReady,
  recipients: recipients,
  newOrderId: newOrderId,
  moscowTime: moscowTime,
  buildMessage: buildMessage,
  hintFor: hintFor,
  check: check,
  send: send
};

if (typeof module !== "undefined" && module.exports) module.exports = API;
if (typeof globalThis !== "undefined") globalThis.TgDirect = API;
