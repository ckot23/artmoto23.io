#!/usr/bin/env node
"use strict";
/* ============================================================================
   Логика бота приёма заявок — общая для Node (bot.js) и браузера (панель).

   Здесь нет ни сети, ни таймеров, ни файлов: функция handleMessage() получает
   сообщение Telegram и возвращает список действий («отправить модератору вот
   такой текст», «ответить клиенту вот так»). Выполняет их тот, кто вызвал:
   Node-бот через fetch, панель бота — прямо из браузера.

   Так одна и та же проверка заявки, расчёт цены и текст сообщения работают
   везде, и нет второй копии, которая может разъехаться.

   Работает и в Node (require), и в браузере (globalThis.BotCore).
   ========================================================================= */

/* В браузере модули подключены обычными <script> и лежат в globalThis,
   в Node — через require. Так одна и та же логика работает везде. */
var IN_NODE = typeof require === "function" && typeof module !== "undefined";
var P = (typeof globalThis !== "undefined" && globalThis.Pricing) || (IN_NODE ? require("./pricing.js") : null);
var L = (typeof globalThis !== "undefined" && globalThis.OrderLink) || (IN_NODE ? require("./orderlink.js") : null);
if (!P || !L) throw new Error("botcore.js: подключите pricing.js и orderlink.js перед ним");

var MESSAGE_LIMIT = 4096;
var SUPPLEMENT_MAX_PER_CHAT = 3;      /* дополнений от одного человека за заход */
var SUPPLEMENT_MAX_TOTAL = 15;        /* и всего за заход — защита от спама */

var HAS_BUFFER = typeof Buffer !== "undefined" && typeof Buffer.from === "function";

/* Случайные байты в hex — работает в Node и в браузере. */
function randomHex(bytes) {
  var out = "";
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    var arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    for (var i = 0; i < arr.length; i++) out += (arr[i] + 256).toString(16).slice(1);
    return out;
  }
  if (HAS_BUFFER) return require("crypto").randomBytes(bytes).toString("hex");
  for (var j = 0; j < bytes * 2; j++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

/* Номер заявки. Если известно обновление Telegram, номер получается
   одинаковым при повторной доставке того же обновления. */
function orderId(meta, now) {
  var stamp = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow", year: "2-digit", month: "2-digit", day: "2-digit"
  }).format(now || new Date()).replace(/-/g, "");
  var tail = meta && meta.updateId
    ? Number(meta.updateId).toString(36).toUpperCase().slice(-4)
    : randomHex(2).toUpperCase();
  while (tail.length < 2) tail = "0" + tail;
  return stamp + "-" + tail;
}

function moscowTime(date) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  }).format(date) + " (МСК)";
}

/* Разбор текста: «/start <параметр>» из ссылки сайта или сообщение с меткой. */
function orderFromText(raw, meta) {
  var deep = String(raw || "").match(/^\/start\s+([A-Za-z0-9_-]{8,64})$/);
  if (deep) {
    var fromLink = L.unpack(deep[1]);
    if (fromLink) {
      /* В ссылку помещается не всё: имя и контакт берём из профиля Telegram. */
      if (!fromLink.name && meta && meta.firstName) fromLink.name = meta.firstName;
      if (!fromLink.name && meta && meta.username) fromLink.name = "@" + meta.username;
      if (!fromLink.contact) {
        if (meta && meta.username) fromLink.contact = "@" + meta.username;
        else if (meta && meta.userId) fromLink.contact = "id" + meta.userId;
      }
      return { order: fromLink, from: "ссылка" };
    }
  }
  var token = L.fromToken(raw);
  if (token) return { order: token, from: "сообщение" };
  return null;
}

function contactMissing(raw) {
  var checked = P.validate(raw);
  return !checked.ok && checked.error.indexOf("контакт") !== -1;
}

function greeting(config) {
  return [
    "Привет! Я принимаю заявки на наклейки.",
    "",
    "Соберите наклейку на сайте" + (config.publicUrl ? ": " + config.publicUrl : "") +
    " и нажмите «Отправить заявку» — я передам её менеджеру.",
    "",
    "Уже отправили заявку? Напишите одним сообщением город и способ получения — передам менеджеру."
  ].join("\n");
}

function clientAcceptedText(result, config) {
  var lines = [
    "✅ <b>Заявка №" + P.escapeHtml(result.orderId) + " принята</b>",
    "Сумма: <b>" + P.money(result.total) + "</b>",
    "",
    "Менеджер проверит расчёт и напишет вам" +
      (result.order.contactKind === "телефон" ? " по телефону." : " в Telegram.")
  ];
  if (!result.order.delivery || !result.order.comment) {
    lines.push("");
    lines.push("Если нужно — напишите одним сообщением город, способ получения и комментарий: передам менеджеру.");
  }
  return lines.join("\n");
}

function clientFailedText(error) {
  return "⚠️ Не удалось принять заявку: " + P.escapeHtml(error) +
    "\n\nПроверьте данные на сайте или напишите менеджеру: https://t.me/ckot_23";
}

/* ---------------------------------------------------------------------------
   Состояние: живёт, пока работает бот (в браузере — пока открыта панель).
   ------------------------------------------------------------------------ */

function newState() {
  return {
    knownClients: {},        /* кому уже приняли заявку — от них принимаем дополнения */
    supplementsByChat: {},
    supplements: 0,
    pendingContact: {},      /* ждём контакт от тех, у кого нет @username */
    orders: 0                /* сколько заявок принято за заход */
  };
}

/* role: "order" — заявка модератору, "confirm" — подтверждение клиенту.
   Если заявка не ушла (нет связи, отозван токен), подтверждение заменяется
   честным «не получилось» — этим занимается runPlan(). */
function send(chatId, text, extra) {
  return Object.assign({
    type: "send",
    chatId: chatId,
    text: text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  }, extra || {});
}

function clientDeliveryFailedText() {
  return "⚠️ Не удалось передать заявку менеджеру. Напишите напрямую: https://t.me/ckot_23";
}

/* Выполняет действия по порядку. Если заявка модератору не ушла, клиент
   получает не «принято», а просьбу написать менеджеру напрямую. */
function runPlan(actions, sendFn) {
  var chain = Promise.resolve();
  var failure = null;
  actions.forEach(function (action) {
    chain = chain.then(function () {
      var outgoing = action;
      if (action.role === "confirm" && failure) {
        outgoing = Object.assign({}, action, { text: clientDeliveryFailedText() });
      }
      return Promise.resolve(sendFn(outgoing)).then(function (result) {
        var ok = result !== false && (!result || result.ok !== false);
        if (action.role === "order" && !ok) failure = true;
        if (action.role === "confirm") failure = null;
        return result;
      });
    });
  });
  return chain;
}

/* Проверить заявку и собрать текст для модератора. */
function prepareOrder(raw, meta, config, state) {
  var checked = P.validate(raw);
  if (!checked.ok) return { ok: false, error: checked.error };

  var order = checked.value;
  var price = P.calculate(order);
  var id = orderId(meta, new Date());
  var text = P.orderMessage(order, price, {
    orderId: id,
    time: moscowTime(new Date()),
    userId: meta && meta.userId,
    dryRun: false
  });
  if (text.length > MESSAGE_LIMIT) text = text.slice(0, MESSAGE_LIMIT - 1);
  return { ok: true, order: order, price: price, orderId: id, moderatorText: text };
}

/* ---------------------------------------------------------------------------
   ГЛАВНАЯ ФУНКЦИЯ: сообщение Telegram → список действий.
   ------------------------------------------------------------------------ */

function handleMessage(config, state, message, meta) {
  var actions = [];
  var chatId = message.chat && message.chat.id;
  if (!chatId) return actions;
  var userId = (message.from && message.from.id) || chatId;
  var userName = (message.from && message.from.username) || "";
  var firstName = (message.from && message.from.first_name) || "";
  var info = { userId: userId, username: userName, firstName: firstName, updateId: meta && meta.updateId };

  function submit(order, source) {
    var prepared = prepareOrder(order, info, config, state);
    if (!prepared.ok) {
      actions.push(send(chatId, clientFailedText(prepared.error)));
      return;
    }
    actions.push(send(config.moderatorId, prepared.moderatorText, { role: "order" }));
    actions.push(send(chatId, clientAcceptedText(prepared, config), { role: "confirm" }));
    state.knownClients[chatId] = true;
    state.orders++;
  }

  /* 1. Заявка из Mini App (сайт вызвал tg.sendData). */
  if (message.web_app_data && message.web_app_data.data) {
    var payload;
    try { payload = JSON.parse(message.web_app_data.data); } catch (e) { payload = null; }
    if (payload) { submit(payload, "mini-app"); return actions; }
  }

  var text = String(message.text || "").trim();

  /* 2. Посетитель без @username присылает контакт ответом на вопрос бота. */
  if (state.pendingContact[chatId] && text && text.charAt(0) !== "/") {
    var waiting = state.pendingContact[chatId];
    delete state.pendingContact[chatId];
    submit(Object.assign({}, waiting, { contact: text }), waiting.source);
    return actions;
  }

  /* 3. Команда из ссылки сайта: /start <данные заявки>. */
  if (text.indexOf("/start") === 0) {
    var parsed = orderFromText(text, info);
    if (parsed) {
      if (contactMissing(parsed.order) && parsed.from === "ссылка") {
        state.pendingContact[chatId] = parsed.order;
        actions.push(send(chatId, "Остался последний шаг: напишите одним сообщением телефон, e-mail " +
          "или @username — передам заявку менеджеру вместе с ним."));
        return actions;
      }
      submit(parsed.order, parsed.from);
      return actions;
    }
    actions.push(send(chatId, greeting(config)));
    return actions;
  }

  if (text.indexOf("/id") === 0) {
    actions.push(send(chatId, "Ваш chat_id: <code>" + chatId + "</code>"));
    return actions;
  }

  /* 4. Заявка, которой поделились сообщением (#STICKERS:). */
  var shared = orderFromText(text, info);
  if (shared) { submit(shared.order, shared.from); return actions; }

  /* 5. Дополнение к заявке: город, комментарий. Только от тех, кто в этом
        заходе оформил заявку — иначе бот пересылал бы любой спам. */
  if (config.forwardText && text && text.charAt(0) !== "/") {
    var used = state.supplementsByChat[chatId] || 0;
    var allowed = state.knownClients[chatId] &&
      used < SUPPLEMENT_MAX_PER_CHAT && state.supplements < SUPPLEMENT_MAX_TOTAL;
    if (allowed) {
      state.supplementsByChat[chatId] = used + 1;
      state.supplements++;
      var who = userName ? "@" + userName : (firstName || "клиент") + " (id " + userId + ")";
      actions.push(send(config.moderatorId, "💬 <b>Дополнение к заявке</b> от " + P.escapeHtml(who) +
        "\n\n" + P.escapeHtml(text).slice(0, 1500), { role: "order" }));
      actions.push(send(chatId, "Передал менеджеру ✅"));
      return actions;
    }
    actions.push(send(chatId, greeting(config)));
  }

  return actions;
}

/* Разбор одного обновления Telegram → действия. */
function handleUpdate(config, state, update) {
  var message = update && (update.message || update.edited_message);
  if (!message) return [];
  return handleMessage(config, state, message, { updateId: update.update_id });
}

var API = {
  MESSAGE_LIMIT: MESSAGE_LIMIT,
  runPlan: runPlan,
  clientDeliveryFailedText: clientDeliveryFailedText,
  newState: newState,
  orderId: orderId,
  moscowTime: moscowTime,
  orderFromText: orderFromText,
  contactMissing: contactMissing,
  prepareOrder: prepareOrder,
  handleMessage: handleMessage,
  handleUpdate: handleUpdate,
  greeting: greeting,
  clientAcceptedText: clientAcceptedText,
  clientFailedText: clientFailedText
};

if (typeof module !== "undefined" && module.exports) module.exports = API;
if (typeof globalThis !== "undefined") globalThis.BotCore = API;
