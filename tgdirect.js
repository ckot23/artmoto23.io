"use strict";
/* ============================================================================
   Отправка заявки сайта через Google Apps Script.

   Заявка корзины уходит в веб-приложение Apps Script. Оно записывает данные
   в Google Таблицу и отправляет уведомление в Telegram от имени бота.
   Токен хранится в свойствах Apps Script и не публикуется в браузере.

   Для внутренней совместимости в файле оставлены функции прямой отправки
   отдельных заявок, но публичная форма использует только Apps Script.
   ========================================================================= */

/* ---------------------------------------------------------------------------
   НАСТРОЙКИ — адрес веб-приложения Apps Script.
   ------------------------------------------------------------------------ */

/* Токен и chat_id НЕ задаются в этом публичном файле.
   Добавьте их в свойствах Apps Script: BOT_TOKEN и MODERATOR_CHAT_ID. */
var BOT_TOKEN = "";
var CHAT_ID = "";

/* Адрес веб-приложения (заканчивается на /exec). */
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

/* Настройки можно переопределить на лету — например, тестовой заглушкой.
   Публичная форма сайта не хранит здесь секреты и отправляет через Apps Script. */
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
  if (code === 401) return "токен бота недействителен: проверьте BOT_TOKEN в свойствах Google Apps Script";
  if (code === 403) return "получатель не начинал диалог с ботом: откройте чат с ботом и нажмите «Start»";
  if (code === 400 && text.indexOf("chat not found") !== -1) return "MODERATOR_CHAT_ID указан неверно: проверьте ID в свойствах Google Apps Script";
  if (code === 400 && text.indexOf("parse") !== -1) return "текст заявки не прошёл разметку — сообщите разработчику";
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
    return Promise.resolve({ ok: false, error: "Для прямой отправки не заданы BOT_TOKEN и CHAT_ID." });
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
   Вернётся список чатов. Публичная форма сайта использует настройки Apps Script. */
function chats() {
  if (!config.token) {
    return Promise.resolve({ ok: false, error: "Для прямой отправки не задан BOT_TOKEN." });
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
      hint: "Одиночная прямая отправка отключена; заявка с сайта использует веб-приложение Google Apps Script."
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
      if (!data || !data.ok) {
        return { ok: false, error: (data && data.error) || "Google Apps Script не принял заявку" };
      }
      return {
        ok: true,
        sheetOk: typeof data.sheetOk === "boolean" ? data.sheetOk : true,
        detailsOk: typeof data.detailsOk === "boolean" ? data.detailsOk : null,
        telegramOk: typeof data.telegramOk === "boolean" ? data.telegramOk : null,
        sheetError: data.sheetError || "",
        detailsError: data.detailsError || "",
        telegramError: data.telegramError || ""
      };
    }, function () {
      /* Ответ пришёл, но не JSON (страница входа Google, ошибка скрипта). */
      return { ok: false, error: "Google Apps Script ответил не JSON: проверьте развёртывание и доступ «Все»." };
    });
  }, function () {
    return attempt(true).then(function () {
      /* CORS может скрыть результат, но запрос уже обработан на стороне Apps Script. */
      return { ok: true, blind: true, sheetOk: null, detailsOk: null, telegramOk: null };
    }, function (error) {
      return { ok: false, error: error && error.message ? error.message : "Нет связи с Google Apps Script." };
    });
  });
}

function sheetEnabled() {
  return /^https:\/\//.test(config.sheetUrl);
}

/* ---------------------------------------------------------------------------
   ЗАЯВКА С КОРЗИНОЙ

   Одна отправка в Apps Script обслуживает оба канала: сводный лист «Заказы»,
   подробный лист «Заявки» и Telegram. Бот-токен остаётся только на серверной
   стороне Google Apps Script.
   ------------------------------------------------------------------------ */
function sendCart(raw, options) {
  var opts = options || {};
  var checked = P.validateCart(raw);
  if (!checked.ok) return Promise.resolve({ ok: false, error: checked.error, kind: "field" });

  if (!sheetEnabled()) {
    return Promise.resolve({
      ok: false,
      kind: "config",
      error: "Не настроен адрес Google Apps Script",
      hint: "Укажите URL веб-приложения Apps Script в SHEET_URL файла tgdirect.js."
    });
  }

  var order = checked.value;
  var cart = P.quoteCart(order.items);
  var now = opts.now instanceof Date ? opts.now : new Date();
  var orderId = opts.orderId || newOrderId(now);
  var meta = { orderId: orderId, time: moscowTime(now), userId: opts.userId };
  var payload = {
    action: "order",
    order_id: orderId,
    columns: P.SHEET_COLUMNS,
    rows: P.sheetRows(order, cart, meta)
  };

  return sheetPost(payload).then(function (result) {
    if (!result.ok) {
      return {
        ok: false,
        kind: "backend",
        error: result.error || "Google Apps Script не принял заявку",
        hint: "Проверьте развёртывание Apps Script и права доступа «Все»."
      };
    }

    var warnings = [];
    if (result.sheetOk === false) warnings.push("Таблица: " + (result.sheetError || "не удалось записать сводку"));
    if (result.detailsOk === false) warnings.push("Подробности позиций: " + (result.detailsError || "не записаны"));
    if (result.telegramOk === false) warnings.push("Telegram: " + (result.telegramError || "бот не подтвердил отправку"));
    if (result.telegramOk === null && !result.blind) {
      warnings.push("Telegram: Apps Script не вернул статус отправки — обновите его код и разверните новую версию.");
    }
    if (result.blind) warnings.push("Google не показал ответ браузеру; проверьте лист «Заказы» и Telegram.");

    return {
      ok: true,
      order_id: orderId,
      total: cart.total,
      count: cart.count,
      telegram: result.telegramOk === true ? "sent" : (result.telegramOk === false ? "failed" : "unknown"),
      sheet: result.sheetOk === true ? "sent" : (result.sheetOk === false ? "failed" : "unknown"),
      details: result.detailsOk === true ? "sent" : (result.detailsOk === false ? "failed" : "unknown"),
      warnings: warnings
    };
  }, function (error) {
    return {
      ok: false,
      kind: "network",
      error: error && error.message ? error.message : "Нет связи с Google Apps Script.",
      hint: "Проверьте интернет, URL веб-приложения и его доступ «Все»."
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
