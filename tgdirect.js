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
var BOT_TOKEN = "8964570845:AAEjL-kjYnsrxOg3KblpJH6tZPGgX9Fszm8";

/* Кому присылать заявки: ваш chat_id числом (узнать — напишите боту /id
   в панели bot.html или откройте @userinfobot). Можно несколько получателей
   через запятую: "7114829971,123456789". */
var CHAT_ID = "7114829971";

/* Google-таблица для заявок: адрес веб-приложения Google Apps Script
   (вида https://script.google.com/macros/s/AKfycb.../exec).
   Как его получить — в README, раздел «Заявки в Google-таблицу», код скрипта
   лежит в google-apps-script/Code.gs. Пока строка пустая, заявки уходят только
   в Telegram. Адрес не секретный в том смысле, что токена в нём нет, но он
   виден всем, как и токен бота выше. */
var SHEET_URL = "https://script.google.com/macros/s/AKfycbypfdfavi0nIz1HgsfP9fXamMgYnEbCJq0pJk5fh_2eLKvp-_9vxhLA30-Vtk29Joru6A/exec";

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
  sheetUrl: String(SHEET_URL || "").trim(),
  timeoutMs: 15000,
  fetch: null            /* подменяется в тестах */
};

/* Настройки можно переопределить на лету: так делают тесты, а при желании —
   страница админки (localStorage), если токен не хочется держать в файле. */
function configure(patch) {
  var next = patch || {};
  if (next.token !== undefined) config.token = String(next.token || "").trim();
  if (next.chatId !== undefined) config.chatId = String(next.chatId || "").trim();
  if (next.sheetUrl !== undefined) config.sheetUrl = String(next.sheetUrl || "").trim();
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

/* Кто писал боту — чтобы узнать свой chat_id при настройке.
   Напишите боту любое сообщение и выполните в консоли сайта:
       await TgDirect.chats()
   Вернётся список вида [{ id: 7114829971, name: "Пётр", username: "petr_777" }];
   нужное число вписывается в CHAT_ID наверху этого файла. */
function chats() {
  if (!config.token) {
    return Promise.resolve({ ok: false, error: "В tgdirect.js не заполнен BOT_TOKEN" });
  }
  return call("getUpdates", { limit: 100 }).then(function (data) {
    if (!data || !data.ok) {
      var reason = (data && data.description) || "нет ответа";
      return { ok: false, error: reason, hint: hintFor(data && data.error_code, reason) };
    }
    var seen = {};
    var list = [];
    (data.result || []).forEach(function (update) {
      var msg = update.message || update.edited_message || update.channel_post;
      var chat = msg && msg.chat;
      if (!chat || seen[chat.id]) return;
      seen[chat.id] = true;
      list.push({
        id: chat.id,
        name: [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.title || "",
        username: chat.username || ""
      });
    });
    return { ok: true, chats: list };
  }, function (error) {
    var reason = error && error.message ? error.message : "нет связи";
    return { ok: false, error: reason, hint: hintFor(0, reason) };
  });
}

/* Telegram принимает не больше 4096 символов в сообщении. Заявка на 20 позиций
   может не влезть — тогда режем по границам позиций (пустым строкам), чтобы не
   порвать HTML-теги посередине. */
var MESSAGE_LIMIT = 4000;

function splitMessage(text) {
  if (text.length <= MESSAGE_LIMIT) return [text];
  var blocks = text.split("\n\n");
  var parts = [];
  var current = "";
  blocks.forEach(function (block) {
    var next = current ? current + "\n\n" + block : block;
    if (next.length > MESSAGE_LIMIT && current) {
      parts.push(current);
      current = block;
    } else {
      current = next;
    }
  });
  if (current) parts.push(current);
  return parts;
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

  /* Заявка с корзиной (items) — основной путь сайта; одиночная — для
     внутренних инструментов и старых ссылок. */
  if (raw && Array.isArray(raw.items)) return sendCart(raw, opts);

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

/* ---------------------------------------------------------------------------
   GOOGLE-ТАБЛИЦА
   ------------------------------------------------------------------------ */

/* Заявка уходит в веб-приложение Google Apps Script, которое дописывает строки
   в таблицу (google-apps-script/Code.gs). Тело — JSON в text/plain: такой
   запрос браузер считает «простым» и не делает предварительный OPTIONS,
   который Apps Script не умеет.

   Сначала обычный запрос — по ответу видно, записалась ли заявка. Если браузер
   не дал прочитать ответ (CORS, расширения), повторяем запрос в режиме no-cors:
   ответа не видно, но запись уходит. Дубль исключён: скрипт игнорирует номер
   заявки, который уже есть в таблице. */
function sheetPost(payload) {
  var fetchImpl = config.fetch || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
  if (!fetchImpl) return Promise.reject(new Error("fetch недоступен в этом окружении"));
  var body = JSON.stringify(payload);

  function attempt(noCors) {
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, config.timeoutMs) : 0;
    var init = {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: body,
      redirect: "follow",
      signal: controller ? controller.signal : undefined
    };
    if (noCors) init.mode = "no-cors";
    return fetchImpl(config.sheetUrl, init).then(function (response) {
      if (timer) clearTimeout(timer);
      return response;
    }, function (error) {
      if (timer) clearTimeout(timer);
      throw error;
    });
  }

  return attempt(false).then(function (response) {
    return response.json().then(function (data) {
      if (data && data.ok) return { ok: true };
      return { ok: false, error: (data && data.error) || "таблица не приняла заявку" };
    }, function () {
      /* Ответ пришёл, но не JSON (страница входа Google, ошибка скрипта). */
      return { ok: false, error: "таблица ответила не так, как ожидалось: проверьте доступ веб-приложения («У всех»)" };
    });
  }, function () {
    return attempt(true).then(function () {
      return { ok: true, blind: true };
    }, function (error) {
      return { ok: false, error: error && error.message ? error.message : "нет связи" };
    });
  });
}

function sheetEnabled() {
  return /^https:\/\//.test(config.sheetUrl);
}

/* ---------------------------------------------------------------------------
   ЗАЯВКА С КОРЗИНОЙ

   {items: [{film, design, color, shape, sketch, w, h, qty}, ...],
    name, contact, delivery, comment, client_total}

   Одна заявка уходит двумя путями одновременно:
     • уведомление в Telegram — всем получателям из CHAT_ID;
     • строки в Google-таблицу — по строке на позицию.
   Заявка считается принятой, если дошла хотя бы до одного места: менеджер
   увидит её либо в чате, либо в таблице. Если Telegram принял, а таблица нет,
   менеджеру в чат уходит отдельное предупреждение — чтобы внести строки руками.
   ------------------------------------------------------------------------ */
function sendCart(raw, options) {
  var opts = options || {};

  var checked = P.validateCart(raw);
  if (!checked.ok) return Promise.resolve({ ok: false, error: checked.error, kind: "field" });

  var telegramReady = isReady();
  var sheetReady = sheetEnabled();
  if (!telegramReady && !sheetReady) {
    return Promise.resolve({
      ok: false,
      kind: "config",
      error: "Отправка заявок не настроена",
      hint: "впишите BOT_TOKEN и CHAT_ID в начале файла tgdirect.js"
    });
  }

  var order = checked.value;
  var cart = P.quoteCart(order.items);
  var now = opts.now instanceof Date ? opts.now : new Date();
  var orderId = opts.orderId || newOrderId(now);
  var meta = { orderId: orderId, time: moscowTime(now), userId: opts.userId };
  var parts = splitMessage(P.cartMessage(order, cart, meta));

  /* Telegram: каждому получателю — все части по порядку. */
  var telegram = !telegramReady ? Promise.resolve({ skipped: true }) :
    Promise.all(recipients().map(function (chatId) {
      return parts.reduce(function (chain, text) {
        return chain.then(function (prev) {
          if (prev && prev.failed) return prev;
          return sendMessage(chatId, text).then(function (data) {
            return data && data.ok ? { chatId: chatId } : { chatId: chatId, failed: true, data: data };
          }, function (error) {
            return { chatId: chatId, failed: true, error: error };
          });
        });
      }, Promise.resolve(null));
    })).then(function (results) {
      var delivered = results.filter(function (item) { return item && !item.failed; });
      if (delivered.length) return { ok: true };
      var first = results[0] || {};
      if (first.error) {
        var netReason = first.error.message ? first.error.message : "нет связи";
        return {
          ok: false, kind: "network",
          error: "Не удалось связаться с Telegram (" + netReason + ")",
          hint: hintFor(0, netReason)
        };
      }
      var reason = (first.data && first.data.description) || "Telegram не принял заявку";
      return { ok: false, kind: "telegram", error: reason, hint: hintFor(first.data && first.data.error_code, reason) };
    });

  /* Таблица: общий payload с готовыми строками. */
  var sheet = !sheetReady ? Promise.resolve({ skipped: true }) :
    sheetPost({
      action: "order",
      order_id: orderId,
      columns: P.SHEET_COLUMNS,
      rows: P.sheetRows(order, cart, meta)
    }).then(null, function (error) {
      return { ok: false, error: error && error.message ? error.message : "нет связи" };
    });

  return Promise.all([telegram, sheet]).then(function (done) {
    var tg = done[0];
    var sh = done[1];
    var tgOk = !!tg.ok;
    var shOk = !!sh.ok;

    if (!tgOk && !shOk) {
      /* Объясняем причину по Telegram — это основной канал; если он не
         настроен, то по таблице. */
      var main = tg.skipped ? { error: "Таблица не приняла заявку: " + (sh.error || "нет ответа"), kind: "sheet", hint: "" } : tg;
      return { ok: false, kind: main.kind, error: main.error, hint: main.hint };
    }

    /* Заявка дошла не везде — предупреждаем менеджера в чат. */
    if (tgOk && sheetReady && !shOk) {
      var warn = "⚠️ <b>Заказ №" + P.escapeHtml(orderId) + "</b> не записался в Google-таблицу" +
        (sh.error ? " (" + P.escapeHtml(sh.error) + ")" : "") + ". Внесите его вручную из сообщения выше.";
      return Promise.all(recipients().map(function (chatId) {
        return sendMessage(chatId, warn).then(null, function () { return null; });
      })).then(function () { return done; });
    }
    return done;
  }).then(function (done) {
    if (done && done.ok === false) return done;       /* ответ об ошибке из ветки выше */
    var tg = done[0];
    var sh = done[1];
    return {
      ok: true,
      order_id: orderId,
      total: cart.total,
      count: cart.count,
      telegram: tg.skipped ? "skipped" : (tg.ok ? "sent" : "failed"),
      sheet: sh.skipped ? "skipped" : (sh.ok ? (sh.blind ? "sent-blind" : "sent") : "failed"),
      warnings: [
        !tg.skipped && !tg.ok ? "Telegram: " + tg.error : "",
        !sh.skipped && !sh.ok ? "Таблица: " + sh.error : ""
      ].filter(Boolean)
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
  chats: chats,
  send: send,
  sendCart: sendCart,
  splitMessage: splitMessage,
  sheetEnabled: sheetEnabled
};

if (typeof module !== "undefined" && module.exports) module.exports = API;
if (typeof globalThis !== "undefined") globalThis.TgDirect = API;
