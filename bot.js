#!/usr/bin/env node
"use strict";
/* ============================================================================
   Бот приёма заявок для Node — работает без хостинга.

   Запуск:
     node bot.js                 — слушать команды постоянно (компьютер, VPS)
     node bot.js --once          — один проход и выход (GitHub Actions, cron)
     node bot.js --once --budget 240   — слушать 4 минуты и выйти
     node bot.js --selftest      — проверка логики без сети

   Транспорт — обычный long polling getUpdates. Логика заявок, тексты и расчёт
   цены живут в botcore.js и общие с браузерной панелью (bot.html), поэтому
   способы запуска не расходятся.

   Настройки (окружение или .env рядом):
     BOT_TOKEN        — токен от @BotFather (обязателен)
     MODERATOR_ID     — chat_id получателя заявок (обязателен)
     PUBLIC_URL       — адрес сайта, показывается в приветствии
     FORWARD_TEXT     — 1 (по умолчанию): пересылать дополнения клиентов
     DRY_RUN          — 1: ничего не отправлять, печатать в лог
   ========================================================================= */

var E = require("./env.js");
require("./pricing.js");
require("./orderlink.js");
var Core = require("./botcore.js");

var CONFIG = {
  botToken: E.env("BOT_TOKEN", ""),
  moderatorId: E.env("MODERATOR_ID", ""),
  publicUrl: E.env("PUBLIC_URL", ""),
  forwardText: E.envBool("FORWARD_TEXT", true),
  dryRun: E.envBool("DRY_RUN", false)
};
if (!CONFIG.botToken || !CONFIG.moderatorId) CONFIG.dryRun = true;

var TG_API = "https://api.telegram.org/bot";
var state = Core.newState();

/* ---------------------------------------------------------------------------
   1. TELEGRAM
   ------------------------------------------------------------------------ */

function tgCall(method, payload) {
  if (CONFIG.dryRun && method !== "getMe" && method !== "getUpdates" && method !== "getWebhookInfo") {
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

/* Расшифровка типовых ошибок Telegram (та же логика, что в server.js). */
function hintFor(code, description) {
  var text = String(description || "").toLowerCase();
  if (code === 401) return "токен недействителен: получите новый у @BotFather";
  if (code === 403) return "получатель не начал диалог с ботом: пусть напишет боту /start";
  if (code === 400 && text.indexOf("chat not found") !== -1) return "MODERATOR_ID указан неверно: узнайте свой chat_id командой /id";
  if (code === 409) return "у бота уже стоит вебхук или запущен второй процесс: отключите одно из двух";
  if (code === 429) return "слишком много сообщений: Telegram просит подождать";
  if (text.indexOf("fetch failed") !== -1 || text.indexOf("timed out") !== -1) return "нет связи с api.telegram.org";
  return "проверьте BOT_TOKEN и MODERATOR_ID";
}

/* Выполняет действия, которые вернул botcore: порядок отправки и замену
   подтверждения на «не получилось» тоже решает botcore.runPlan. */
function runActions(actions) {
  return Core.runPlan(actions, function (action) {
    var payload = {
      chat_id: action.chatId,
      text: action.text,
      parse_mode: action.parse_mode,
      disable_web_page_preview: action.disable_web_page_preview
    };
    if (CONFIG.dryRun) {
      console.log("\n--- СООБЩЕНИЕ (тестовый режим) → " + action.chatId + " ---\n" +
        action.text.replace(/<[^>]+>/g, "") + "\n---");
      return { ok: true };
    }
    return tgCall("sendMessage", payload).then(function (data) {
      if (!data || !data.ok) {
        var reason = (data && data.description) || "неизвестная ошибка";
        console.error("[telegram] не отправлено в " + action.chatId + ": " + reason +
          " → " + hintFor(data && data.error_code, reason));
      }
      return data;
    });
  });
}

function handleUpdate(update) {
  var actions = Core.handleUpdate(CONFIG, state, update);
  if (!actions.length) return Promise.resolve();
  var isModerator = actions.some(function (a) { return String(a.chatId) === String(CONFIG.moderatorId); });
  if (isModerator && CONFIG.moderatorId) {
    console.log("[bot] обновление " + (update.update_id || "?") + " → заявка менеджеру");
  }
  return runActions(actions);
}

/* ---------------------------------------------------------------------------
   2. ПРИЁМ ОБНОВЛЕНИЙ
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

/* Постоянный режим — для запуска на компьютере. */
function pollForever() {
  var offset = 0;
  console.log("[bot] слушаю команды — заявки будут уходить модератору " + CONFIG.moderatorId);
  (function tick() {
    tgCall("getUpdates", { offset: offset, timeout: 25, allowed_updates: ["message"] }).then(function (data) {
      if (!data || !data.ok) {
        var reason = (data && data.description) || "нет ответа Telegram";
        console.error("[bot] getUpdates: " + reason + " → " + hintFor(data && data.error_code, reason));
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
   3. SELFTEST И ТОЧКА ВХОДА
   ------------------------------------------------------------------------ */

function selftest() {
  var failures = 0;
  function check(name, condition, extra) {
    if (condition) console.log("  ok   " + name);
    else { console.log("  FAIL " + name + (extra ? " → " + extra : "")); failures++; }
  }
  var config = { moderatorId: "7114829971", publicUrl: "https://example.com", forwardText: true };
  var testState = Core.newState();

  console.log("\n1. Упаковка заявки в ссылку t.me/бот?start=");
  var order = {
    film: "matte", design: "own", color: "black", shape: "circle",
    w: 10, h: 10, qty: 10, name: "Пётр", delivery: "Рига, СДЭК", comment: "к пятнице"
  };
  var L = globalThis.OrderLink;
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

  console.log("\n3. Расчёт цены и текст заявки");
  var fromLink = Core.orderFromText("/start " + param, { userId: 777001, username: "petr_777", firstName: "Пётр" });
  var prepared = Core.prepareOrder(fromLink.order, { userId: 777001 }, config, testState);
  check("заявка из ссылки проходит проверку полей", prepared.ok, prepared.error);
  check("цена считается по прайсу", prepared.ok && prepared.total !== 0 && prepared.price.total === 4100,
    prepared.ok ? String(prepared.price.total) : "");
  check("текст для модератора влезает в лимит Telegram", prepared.ok && prepared.moderatorText.length < 4096);
  check("номер заявки стабилен для одного обновления",
    Core.orderId({ updateId: 500 }, new Date("2026-10-06T12:00:00Z")) ===
    Core.orderId({ updateId: 500 }, new Date("2026-10-06T12:00:00Z")));

  console.log("\n4. Действия бота (то, что потом уходит в Telegram)");
  var actions = Core.handleMessage(config, Core.newState(), {
    chat: { id: 777001, type: "private" },
    from: { id: 777001, username: "petr_777", first_name: "Пётр" },
    text: "/start " + param
  }, { updateId: 501 });
  check("модератору уходит ровно одна заявка", actions.filter(function (a) {
    return String(a.chatId) === config.moderatorId;
  }).length === 1);
  check("клиенту приходит подтверждение с номером", actions.some(function (a) {
    return String(a.chatId) === "777001" && /Заявка №\d{6}-/.test(a.text);
  }));
  var spam = Core.handleMessage(config, Core.newState(), {
    chat: { id: 999, type: "private" }, from: { id: 999, first_name: "Спамер" }, text: "купите крипту"
  }, {});
  check("посторонний текст модератору не пересылается", spam.filter(function (a) {
    return String(a.chatId) === config.moderatorId;
  }).length === 0);
  var noise = Core.handleMessage(config, Core.newState(), {
    chat: { id: 777002, type: "private" }, from: { id: 777002 }, text: "/start " + L.base64url("9|m|o|k|r|1|1|1")
  }, {});
  check("заявка чужого формата не уходит модератору", noise.filter(function (a) {
    return String(a.chatId) === config.moderatorId;
  }).length === 0);

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
  state: state,
  handleUpdate: handleUpdate,
  handleMessage: function (message, meta) {
    return Core.handleMessage(CONFIG, state, message, meta);
  },
  runActions: runActions,
  drainOnce: drainOnce,
  hintFor: hintFor
};

if (require.main === module) main();
