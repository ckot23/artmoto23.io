#!/usr/bin/env node
"use strict";
/* ============================================================================
   Бот приёма заявок — работает без хостинга и без сервера.

   Запуск:
     node bot.js                 — слушать команды постоянно (компьютер, VPS)
     node bot.js --once          — один проход и выход (GitHub Actions, cron)
     node bot.js --once --budget 240   — слушать 4 минуты и выйти
     node bot.js --selftest      — проверка логики без сети

   Откуда берутся заявки:
     • команда из ссылки t.me/бот?start=<данные> — посетитель сайта нажал
       «Отправить заявку» вне Telegram (см. orderlink.js);
     • tg.sendData() из Mini App — если сайт открыт внутри Telegram;
     • сообщение с меткой #STICKERS:<данные> — «Поделиться заявкой в Telegram».

   Что делает бот с заявкой: проверяет поля, сам считает цену (pricing.js)
   и пересылает её модератору (MODERATOR_ID), а клиенту отвечает номером
   заявки. Заявки нигде не хранятся — только проходят через бота.

   Настройки (окружение или .env рядом с файлом):
     BOT_TOKEN        — токен от @BotFather (обязателен)
     MODERATOR_ID     — chat_id получателя заявок (обязателен)
     PUBLIC_URL       — адрес сайта, показывается в приветствии
     FORWARD_TEXT     — 1 (по умолчанию): пересылать модератору дополнения
                        клиента (город, комментарий) обычными сообщениями
     DRY_RUN          — 1: не отправлять в Telegram, печатать в лог
   ========================================================================= */

var E = require("./env.js");
var P = require("./pricing.js");
var L = require("./orderlink.js");

var CONFIG = {
  botToken: E.env("BOT_TOKEN", ""),
  moderatorId: E.env("MODERATOR_ID", ""),
  publicUrl: E.env("PUBLIC_URL", ""),
  forwardText: E.envBool("FORWARD_TEXT", true),
  dryRun: E.envBool("DRY_RUN", false)
};
if (!CONFIG.botToken || !CONFIG.moderatorId) CONFIG.dryRun = true;

var TG_API = "https://api.telegram.org/bot";
var MESSAGE_LIMIT = 4096;
var SUPPLEMENT_MAX_PER_CHAT = 3;      /* дополнений от одного человека за проход */
var SUPPLEMENT_MAX_TOTAL = 15;        /* и всего за проход — защита от спама */

var counters = { supplements: 0 };
var supplementsByChat = {};
/* Дополнения (город, комментарий) принимаем только от тех, кто в этом проходе
   уже оформил заявку: иначе бот превращался бы в пересылку любого спама. */
var knownClients = {};
/* Заявки из ссылки без контакта: ждём, пока человек пришлёт его сообщением.
   Хранится только в памяти процесса (Google Actions живёт минуты). */
var pendingContact = {};

/* Похоже ли, что проблема именно в контакте. */
function contactMissing(raw) {
  var checked = P.validate(raw);
  return !checked.ok && checked.error.indexOf("контакт") !== -1;
}

/* ---------------------------------------------------------------------------
   1. TELEGRAM
   ------------------------------------------------------------------------ */

function tgCall(method, payload) {
  if (CONFIG.dryRun) {
    console.log("[dry-run] " + method + " " + JSON.stringify(payload).slice(0, 200));
    return Promise.resolve({ ok: true, result: {} });
  }
  return fetch(TG_API + CONFIG.botToken + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {})
  }).then(function (response) {
    return response.json().catch(function () { return { ok: false, description: "Некорректный ответ Telegram" }; });
  }).catch(function (error) {
    return { ok: false, description: "Сеть недоступна: " + error.message };
  });
}

function send(chatId, text, extra) {
  return tgCall("sendMessage", Object.assign({
    chat_id: chatId,
    text: text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  }, extra || {}));
}

function sendToModerator(text) {
  if (CONFIG.dryRun) {
    console.log("\n--- ЗАЯВКА (тестовый режим) ---\n" + text.replace(/<[^>]+>/g, "") + "\n--- конец ---\n");
    return Promise.resolve({ ok: true, dryRun: true });
  }
  return send(CONFIG.moderatorId, text).then(function (data) {
    if (!data || !data.ok) {
      var reason = (data && data.description) || "неизвестная ошибка";
      console.error("[telegram] не отправлено: " + reason + " → " + hintFor(data && data.error_code, reason));
      return { ok: false, error: reason };
    }
    return { ok: true };
  });
}

/* Расшифровка типовых ошибок Telegram (та же логика, что в server.js). */
function hintFor(code, description) {
  var text = String(description || "").toLowerCase();
  if (code === 401) return "токен недействителен: получите новый у @BotFather";
  if (code === 403) return "получатель не начал диалог с ботом: пусть напишет боту /start";
  if (code === 400 && text.indexOf("chat not found") !== -1) return "MODERATOR_ID указан неверно: узнайте свой chat_id командой /id";
  if (code === 429) return "слишком много сообщений: Telegram просит подождать";
  if (text.indexOf("fetch failed") !== -1 || text.indexOf("timed out") !== -1) return "нет связи с api.telegram.org";
  return "проверьте BOT_TOKEN и MODERATOR_ID";
}

/* ---------------------------------------------------------------------------
   2. ЗАЯВКА
   ------------------------------------------------------------------------ */

/* Единая точка: любой путь (ссылка, Mini App, сообщение) приходит сюда. */
function acceptOrder(raw, meta) {
  var checked = P.validate(raw);
  if (!checked.ok) {
    return Promise.resolve({ ok: false, error: checked.error });
  }
  var order = checked.value;
  var price = P.calculate(order);
  var now = new Date();
  var orderId = orderIdFor(meta);

  var text = P.orderMessage(order, price, {
    orderId: orderId,
    time: moscowTime(now),
    userId: meta && meta.userId,
    dryRun: CONFIG.dryRun
  });

  return sendToModerator(text).then(function (result) {
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, orderId: orderId, total: price.total, order: order, price: price };
  });
}

/* Номер заявки. Если известно, из какого обновления Telegram она пришла,
   номер получается одинаковым при повторной доставке того же обновления. */
function orderIdFor(meta) {
  var stamp = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow", year: "2-digit", month: "2-digit", day: "2-digit"
  }).format(new Date()).replace(/-/g, "");
  var tail = meta && meta.updateId
    ? Number(meta.updateId).toString(36).toUpperCase().slice(-4)
    : require("crypto").randomBytes(2).toString("hex").toUpperCase();
  return stamp + "-" + tail;
}

function moscowTime(date) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  }).format(date) + " (МСК)";
}

/* Проверенный заказ из «/start <параметр>» или из сообщения с #STICKERS:. */
function orderFromText(raw, meta) {
  var deep = raw.match(/^\/start\s+([A-Za-z0-9_-]{8,64})$/);
  if (deep) {
    var fromLink = L.unpack(deep[1]);
    /* В ссылке помещается не всё: имя и контакт берём из профиля Telegram. */
    if (fromLink) {
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

/* ---------------------------------------------------------------------------
   3. ОБРАБОТКА ОБНОВЛЕНИЙ
   ------------------------------------------------------------------------ */

function handleMessage(message, meta) {
  var chatId = message.chat && message.chat.id;
  if (!chatId) return Promise.resolve();
  var userId = message.from && message.from.id;
  var userName = (message.from && message.from.username) || "";
  var firstName = (message.from && message.from.first_name) || "";
  var info = {
    userId: userId || chatId,
    username: userName,
    firstName: firstName,
    updateId: meta && meta.updateId
  };

  /* Заявка из Mini App (сайт вызвал tg.sendData). */
  if (message.web_app_data && message.web_app_data.data) {
    var payload;
    try { payload = JSON.parse(message.web_app_data.data); } catch (e) { payload = null; }
    if (payload) {
      return submitOrder(chatId, payload, "mini-app", info);
    }
  }

  var text = String(message.text || "").trim();

  /* Человек открыл ссылку, но в Telegram у него нет @username — спрашиваем
     контакт сообщением и держим заявку в памяти, пока он не ответит. */
  if (pendingContact[chatId] && text && text.charAt(0) !== "/") {
    var waiting = pendingContact[chatId];
    delete pendingContact[chatId];
    return submitOrder(chatId, Object.assign({}, waiting, { contact: text }), waiting.source, info);
  }

  if (text.indexOf("/start") === 0) {
    var parsed = orderFromText(text, info);
    if (parsed) {
      if (contactMissing(parsed.order) && parsed.from === "ссылка") {
        pendingContact[chatId] = parsed.order;
        return send(chatId, "Остался последний шаг: напишите одним сообщением телефон, e-mail " +
          "или @username — передам заявку менеджеру вместе с ним.");
      }
      return submitOrder(chatId, parsed.order, parsed.from, info);
    }
    return send(chatId, greeting());
  }

  if (text.indexOf("/id") === 0) {
    return send(chatId, "Ваш chat_id: <code>" + chatId + "</code>");
  }

  /* Заявка, которой поделились сообщением. */
  var shared = orderFromText(text, info);
  if (shared) return submitOrder(chatId, shared.order, shared.from, info);

  /* Дополнение к заявке: город, способ получения, комментарий, макет. */
  if (CONFIG.forwardText && text && text.charAt(0) !== "/") {
    var used = supplementsByChat[chatId] || 0;
    var allowed = knownClients[chatId] &&
      used < SUPPLEMENT_MAX_PER_CHAT && counters.supplements < SUPPLEMENT_MAX_TOTAL;
    if (allowed) {
      supplementsByChat[chatId] = used + 1;
      counters.supplements++;
      var who = userName ? "@" + userName : (firstName || "клиент") + " (id " + userId + ")";
      return sendToModerator("💬 <b>Дополнение к заявке</b> от " + P.escapeHtml(who) + "\n\n" +
        P.escapeHtml(text).slice(0, 1500)).then(function () { return send(chatId, "Передал менеджеру ✅"); });
    }
    return send(chatId, greeting());
  }

  return Promise.resolve();
}

/* Отправка заявки модератору + ответ клиенту (общий путь для всех способов). */
function submitOrder(chatId, order, source, info) {
  return acceptOrder(order, Object.assign({ source: source, pending: false }, info)).then(function (result) {
    if (!result.ok) return replyFailed(chatId, result.error);
    knownClients[chatId] = true;          /* теперь принимаем дополнения к заявке */
    return replyAccepted(chatId, result);
  });
}

function greeting() {
  var lines = [
    "Привет! Я принимаю заявки на наклейки.",
    "",
    "Соберите наклейку на сайте" + (CONFIG.publicUrl ? ": " + CONFIG.publicUrl : "") +
    " и нажмите «Отправить заявку» — я передам её менеджеру.",
    "",
    "Уже отправили заявку? Напишите одним сообщением город и способ получения — передам менеджеру."
  ];
  return lines.join("\n");
}

function replyAccepted(chatId, result) {
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
  if (!CONFIG.dryRun && chatId === CONFIG.moderatorId) {
    lines.push("");
    lines.push("<i>Это ваша собственная заявка — так посетитель видит ответ бота.</i>");
  }
  return send(chatId, lines.join("\n"));
}

function replyFailed(chatId, error) {
  return send(chatId, "⚠️ Не удалось принять заявку: " + P.escapeHtml(error) +
    "\n\nПроверьте данные на сайте или напишите менеджеру: https://t.me/ckot_23");
}

/* Разбор одного обновления Telegram. */
function handleUpdate(update) {
  var message = update && (update.message || update.edited_message);
  if (!message) return Promise.resolve();
  return handleMessage(message, { updateId: update.update_id });
}

/* ---------------------------------------------------------------------------
   4. ПРИЁМ ОБНОВЛЕНИЙ
   ------------------------------------------------------------------------ */

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

/* Один проход: забираем накопившиеся команды и подтверждаем их.
   Так работает режим GitHub Actions: процесс живёт минуты, а не постоянно. */
function drainOnce(options) {
  var opts = options || {};
  var deadline = Date.now() + (opts.budgetSeconds || 0) * 1000;
  var offset = 0;
  var processed = 0;

  function confirm() {
    /* Пустой getUpdates с offset = последний+1 закрывает уже обработанные
       обновления, иначе следующая сессия получит их снова. */
    if (!offset) return Promise.resolve();
    return tgCall("getUpdates", { offset: offset, timeout: 0, limit: 1, allowed_updates: ["message"] });
  }

  function tick() {
    var wait = opts.budgetSeconds ? Math.min(25, Math.max(1, Math.round((deadline - Date.now()) / 1000))) : 0;
    if (opts.budgetSeconds && wait <= 0) return confirm();
    return tgCall("getUpdates", { offset: offset, timeout: wait, allowed_updates: ["message"] }).then(function (data) {
      if (!data || !data.ok) {
        var reason = (data && data.description) || "нет ответа Telegram";
        console.error("[bot] getUpdates: " + reason + " → " + hintFor(data && data.error_code, reason));
        return sleep(5000);
      }
      var batch = Array.isArray(data.result) ? data.result : [];
      var chain = Promise.resolve();
      batch.forEach(function (update) {
        offset = update.update_id + 1;
        processed++;
        chain = chain.then(function () {
          return handleUpdate(update).catch(function (error) {
            console.error("[bot] обновление " + update.update_id + ": " + error.message);
          });
        });
      });
      return chain.then(function () {
        if (opts.once && !opts.budgetSeconds) return confirm();
        if (opts.budgetSeconds && Date.now() >= deadline) return confirm();
        return tick();
      });
    });
  }

  return Promise.resolve()
    .then(function () {
      /* Вебхук и getUpdates одновременно не работают: если вебхук стоит
         (например, остался от прежнего хостинга), Telegram ответит 409. */
      return tgCall("getWebhookInfo", {});
    })
    .then(function (info) {
      var url = info && info.ok && info.result && info.result.url;
      if (!url) return null;
      console.log("[bot] снимаю старый вебхук (" + url + ") — заявки будет забирать этот процесс");
      return tgCall("deleteWebhook", { drop_pending_updates: false });
    })
    .then(tick)
    .then(function () { return processed; });
}

/* Постоянный режим — для запуска на компьютере: без пауз между проходами. */
function pollForever() {
  var offset = 0;
  console.log("[bot] слушаю команды — заявки будут уходить модератору " + CONFIG.moderatorId);
  (function tick() {
    tgCall("getUpdates", { offset: offset, timeout: 25, allowed_updates: ["message"] }).then(function (data) {
      if (!data || !data.ok) {
        console.error("[bot] getUpdates: " + ((data && data.description) || "нет ответа") +
          (data && data.error_code === 409 ? " → у бота стоит вебхук или запущен второй процесс" : ""));
        return sleep(5000);
      }
      var chain = Promise.resolve();
      (data.result || []).forEach(function (update) {
        offset = update.update_id + 1;
        chain = chain.then(function () {
          return handleUpdate(update).catch(function (error) { console.error("[bot] " + error.message); });
        });
      });
      return chain;
    }).then(function () { setTimeout(tick, 300); });
  })();
}

/* ---------------------------------------------------------------------------
   5. SELFTEST И ТОЧКА ВХОДА
   ------------------------------------------------------------------------ */

function selftest() {
  var failures = 0;
  function check(name, condition, extra) {
    if (condition) console.log("  ok   " + name);
    else { console.log("  FAIL " + name + (extra ? " → " + extra : "")); failures++; }
  }

  console.log("\n1. Упаковка заявки в ссылку t.me/бот?start=");
  var order = {
    film: "matte", design: "own", color: "black", shape: "circle",
    w: 10, h: 10, qty: 10, name: "Пётр", delivery: "Рига, СДЭК", comment: "к пятнице"
  };
  var param = L.startParam(order);
  check("параметр не длиннее 64 символов", param.length <= L.START_LIMIT, param.length + " символов");
  check("только разрешённые символы", /^[A-Za-z0-9_-]+$/.test(param));
  var back = L.unpack(param);
  check("заявка читается обратно", Boolean(back));
  check("материал, дизайн, цвет и форма совпадают",
    back && back.film === order.film && back.design === order.design &&
    back.color === order.color && back.shape === order.shape);
  check("размер и тираж совпадают", back && back.w === 10 && back.h === 10 && back.qty === 10);
  check("имя и город совпадают", back && back.name === "Пётр" && back.delivery === "Рига, СДЭК");
  check("битый параметр не превращается в заявку", L.unpack("AAAA") === null);
  check("чужая версия формата отклоняется", L.unpack(L.base64url("9|m|o|k|r|10|10|10")) === null);

  console.log("\n2. Формат сообщения #STICKERS:");
  var token = L.fromToken("Заявка с сайта\n\n" + L.toToken(order) + "\n\nспасибо");
  check("заявка из сообщения читается целиком", token && token.comment === "к пятнице");
  check("в простом тексте метки нет", L.fromToken("просто сообщение") === null);

  console.log("\n3. Расчёт цены на стороне бота");
  var fromLink = orderFromText("/start " + param, { userId: 777001, username: "petr_777", firstName: "Пётр" });
  var checked = P.validate(fromLink.order);
  check("заявка из ссылки проходит проверку полей", checked.ok, checked.error);
  check("цена считается по серверному прайсу", checked.ok && P.calculate(checked.value).total === 4100,
    checked.ok ? String(P.calculate(checked.value).total) : "");
  var noUser = orderFromText("/start " + param, { userId: 777001, firstName: "Пётр" });
  check("без @username контакт берётся из id", P.validate(noUser.order).ok, noUser.order.contact);
  check("без имени тоже не теряется", Boolean(noUser.order.name));

  console.log("\n4. Разбор команды /start");
  var parsed = orderFromText("/start " + param, { userId: 777001, username: "petr_777", firstName: "Пётр" });
  check("команда из ссылки распознана", Boolean(parsed) && parsed.order.film === "matte");
  check("контакт подставлен из профиля Telegram", parsed && parsed.order.contact === "@petr_777");
  check("слишком короткий username не проходит проверку контакта",
    P.validate({ film: "matte", design: "own", color: "black", w: 10, h: 10, qty: 1, name: "Пётр", contact: "@pet" }).ok === false);
  check("обычный /start заявкой не считается", orderFromText("/start", {}) === null);
  check("случайный текст заявкой не считается", orderFromText("привет, как дела", {}) === null);

  console.log("\n" + (failures ? "ПРОВАЛЕНО ПРОВЕРОК: " + failures : "Все проверки пройдены ✅") + "\n");
  process.exit(failures ? 1 : 0);
}

function main() {
  var args = process.argv.slice(2);
  if (args.indexOf("--selftest") !== -1) return selftest();

  if (CONFIG.dryRun) {
    console.log("Тестовый режим: BOT_TOKEN или MODERATOR_ID не заданы — в Telegram ничего не уходит.");
  }

  if (args.indexOf("--once") !== -1) {
    var budgetAt = args.indexOf("--budget");
    var budget = budgetAt !== -1 ? parseInt(args[budgetAt + 1], 10) || 60 : 0;
    drainOnce({ once: true, budgetSeconds: budget }).then(function (processed) {
      console.log("[bot] обработано обновлений: " + processed);
      process.exit(0);
    }).catch(function (error) {
      console.error("[bot] ошибка: " + (error && error.message));
      process.exit(1);
    });
    return;
  }

  pollForever();
}

module.exports = {
  CONFIG: CONFIG,
  handleUpdate: handleUpdate,
  handleMessage: handleMessage,
  acceptOrder: acceptOrder,
  orderFromText: orderFromText,
  drainOnce: drainOnce,
  greeting: greeting
};

if (require.main === module) main();
