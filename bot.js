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
     SERVER_URL       — адрес работающего сервера (например, https://...onrender.com)
     YIELD_TO_SERVER  — 1 (по умолчанию): если сервер жив и сам принимает
                        обновления, бот уступает и не спорит за getUpdates
                        (иначе оба получают 409 Conflict и заявки теряются)

   Telegram отдаёт getUpdates только одному потребителю. Если сервер сайта
   уже запущен, этот бот — запасной: он проверяет /api/health сервера и
   пропускает запуск, пока тот на связи. Флаг --force отключает эту проверку.
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
  dryRun: E.envBool("DRY_RUN", false),
  /* Адрес постоянного сервера: если он жив и сам принимает обновления,
     этому боту брать getUpdates не нужно — иначе оба ловят 409. */
  serverUrl: String(E.env("SERVER_URL", "")).replace(/\/+$/, ""),
  yieldToServer: E.envBool("YIELD_TO_SERVER", true),
  /* --force: работать даже если сервер на связи (для ручной проверки). */
  force: false
};
if (!CONFIG.botToken || !CONFIG.moderatorId) CONFIG.dryRun = true;

var TG_API = "https://api.telegram.org/bot";
var state = Core.newState();

/* Итог последнего запуска — видно в логе Actions и читается тестами. */
var lastRun = { processed: 0, skipped: "", conflicts: 0, server: null, webhook: "" };

/* Сколько спорим за очередь в разовом запуске, прежде чем уступить. */
var CONFLICT_GIVEUP_MS = 45000;
/* Как часто проверяем сервер, ожидая, когда он освободит очередь. */
var SERVER_RECHECK_MS = 60000;
var HEALTH_TIMEOUT_MS = 6000;

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
  if (code === 409) return "очередь занята (409 Conflict): её держит другой потребитель — сервер сайта, " +
    "вкладка bot.html, GitHub Actions или второй запуск бота: оставьте что-то одно";
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

/* ---------------------------------------------------------------------------
   2a. КТО ГЛАВНЫЙ: СЕРВЕР ИЛИ ЭТОТ БОТ

   Два процесса с одним токеном не работают: Telegram отдаёт getUpdates
   только одному, второй получает 409 Conflict и заявки идут в никуда.
   Поэтому перед работой спрашиваем сервер: «ты сам принимаешь обновления?»
   Если да — этот запуск пропускаем.
   ------------------------------------------------------------------------ */

/* Опрос /api/health сервера. Возвращает true, если сервер жив и сам
   забирает обновления; false — если сервер молчит или обновления не берёт
   (POLL=0); null — если адрес сервера неизвестен. */
function checkServerTakesUpdates(webhookUrl) {
  if (CONFIG.force || !CONFIG.yieldToServer) return Promise.resolve(false);
  var url = Core.serverHealthUrl(webhookUrl, CONFIG.serverUrl);
  if (!url) return Promise.resolve(null);
  return fetch(url, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
  }).then(function (response) {
    if (!response.ok) throw new Error("HTTP " + response.status);
    return response.json();
  }).then(function (health) {
    var detail = health && health.updates_detail;
    lastRun.server = {
      url: url.replace(/\/api\/health$/, ""),
      mode: (detail && detail.mode) || (health && health.updates) || "?",
      alive: Boolean(detail && detail.alive)
    };
    return Core.serverTakesUpdates(health);
  }).catch(function (error) {
    /* Сервер не ответил — значит принимать обновления некому, работаем сами. */
    lastRun.server = { url: url.replace(/\/api\/health$/, ""), mode: "нет ответа", alive: false };
    console.log("[bot] сервер не ответил (" + error.message + ") — забираю обновления сам");
    return false;
  });
}

/* Один проход: забираем накопившиеся команды и подтверждаем их.
   Так работает режим GitHub Actions: процесс живёт минуты, а не постоянно. */
function drainOnce(options) {
  var opts = options || {};
  var deadline = Date.now() + (opts.budgetSeconds || 0) * 1000;
  var offset = 0;
  var processed = 0;
  var conflicts = 0;
  var conflictSince = 0;
  lastRun = { processed: 0, skipped: "", conflicts: 0, server: null, webhook: "" };

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
        /* 409: очередь getUpdates держит кто-то ещё — сервер сайта, вторая
           вкладка или ещё один запуск бота. Весь бюджет спорить бессмысленно:
           обновления всё равно кто-то забирает, поэтому уступаем и выходим. */
        if (data && data.error_code === 409) {
          conflicts++;
          lastRun.conflicts = conflicts;
          if (!conflictSince) conflictSince = Date.now();
          if (Date.now() - conflictSince >= (opts.conflictGiveUpMs || CONFLICT_GIVEUP_MS)) {
            lastRun.skipped = "другой потребитель забирает обновления — уступаю";
            console.error("[bot] getUpdates: " + reason);
            console.error("[bot] → " + hintFor(409, reason) +
              ". Заявки доходят, просто их забирает не этот процесс — завершаю запуск.");
            return undefined;
          }
          /* Ждём, но не дольше, чем до конца отведённого на спор времени. */
          var left = (opts.conflictGiveUpMs || CONFLICT_GIVEUP_MS) - (Date.now() - conflictSince);
          return sleep(Math.max(200, Math.min(5000, left))).then(tick);
        }
        console.error("[bot] getUpdates: " + reason + " → " + hintFor(data && data.error_code, reason));
        /* Разовый запуск без бюджета: как и раньше, выходим после паузы.
           С бюджетом (GitHub Actions) одна ошибка не должна обрывать окно
           приёма — иначе заявки ждали бы следующего запуска по расписанию. */
        if (opts.once && !opts.budgetSeconds) return sleep(5000);
        return sleep(5000).then(tick);
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
      lastRun.webhook = url || "";
      if (!url) return null;
      /* Живой вебхук снимать нельзя: по нему работает сервер сайта.
         Сначала проверяем, отвечает ли сервер, — и только если он молчит
         (вебхук старый, хостинг брошен), снимаем его и работаем сами. */
      if (Core.webhookAlive(info, Date.now())) {
        return checkServerTakesUpdates(url).then(function (takes) {
          if (takes) {
            lastRun.skipped = "обновления принимает сервер по вебхуку " + url;
            console.log("[bot] у бота установлен вебхук " + url + " и сервер на связи — обновления забирает он.");
            console.log("[bot] этот запуск пропускаю: второй получатель получил бы 409 и заявки потерялись бы.");
            return "skip";
          }
          console.log("[bot] снимаю вебхук " + url + " (сервер по нему не отвечает) — заявки будет забирать этот процесс");
          console.log("[bot] если обновления должен принимать сервер: включите на нём WEBHOOK_AUTO=1 и не запускайте бота.");
          return tgCall("deleteWebhook", { drop_pending_updates: false });
        });
      }
      console.log("[bot] снимаю неработающий вебхук (" + url + ") — заявки будет забирать этот процесс");
      return tgCall("deleteWebhook", { drop_pending_updates: false });
    })
    .then(function (result) {
      if (result === "skip") return null;
      /* Вебхук уже разобран выше: там либо уступили, либо сняли его. */
      if (lastRun.webhook) return null;
      /* Вебхука нет: если постоянный сервер жив и сам слушает getUpdates,
         этому боту брать очередь не нужно. */
      return checkServerTakesUpdates("").then(function (takes) {
        if (!takes) return null;
        lastRun.skipped = "сервер " + (lastRun.server && lastRun.server.url || CONFIG.serverUrl) +
          " на связи и сам принимает обновления";
        console.log("[bot] сервер на связи и сам забирает обновления (" +
          ((lastRun.server && lastRun.server.mode) || "?") + ") — этот запуск пропускаю, чтобы не спорить за getUpdates.");
        return "skip";
      });
    })
    .then(function (result) {
      if (result === "skip") return null;
      return tick();
    })
    .then(function () { lastRun.processed = processed; return processed; });
}

/* Постоянный режим — для запуска на компьютере. Если рядом работает сервер
   сайта, бот не мешает ему: ждёт и забирает очередь, когда сервер выключится. */
function pollForever() {
  var offset = 0;
  var conflictStreak = 0;
  var stopped = false;

  function tick() {
    if (stopped) return Promise.resolve();
    tgCall("getUpdates", { offset: offset, timeout: 25, allowed_updates: ["message"] }).then(function (data) {
      if (stopped) return;
      if (!data || !data.ok) {
        var reason = (data && data.description) || "нет ответа Telegram";
        if (data && data.error_code === 409) {
          conflictStreak++;
          lastRun.conflicts = conflictStreak;
          var wait = Core.conflictBackoffMs(conflictStreak);
          if (conflictStreak === 1) {
            console.error("[bot] getUpdates: " + reason);
            console.error("[bot] → " + hintFor(409, reason) +
              ". Попробую снова через " + Math.max(1, Math.round(wait / 1000)) + " с.");
          }
          return sleep(wait);
        }
        console.error("[bot] getUpdates: " + reason + " → " + hintFor(data && data.error_code, reason));
        return sleep(5000);
      }
      if (conflictStreak) console.log("[bot] очередь свободна — снова принимаю обновления");
      conflictStreak = 0;
      var chain = Promise.resolve();
      (data.result || []).forEach(function (update) {
        offset = update.update_id + 1;
        chain = chain.then(function () {
          return handleUpdate(update).catch(function (error) { console.error("[bot] " + error.message); });
        });
      });
      return chain;
    }).then(function () { setTimeout(tick, 300); });
  }

  function start() {
    console.log("[bot] слушаю команды — заявки будут уходить модератору " + CONFIG.moderatorId);
    tick();
  }

  /* Пока сервер жив, он главный: проверяем раз в минуту и не мешаем. */
  function waitForServer() {
    return checkServerTakesUpdates("").then(function (takes) {
      if (!takes) return start();
      console.log("[bot] сервер " + (CONFIG.serverUrl || "(из вебхука)") +
        " на связи и сам принимает обновления — жду, чтобы не спорить за getUpdates.");
      console.log("[bot] проверяю раз в " + Math.round(SERVER_RECHECK_MS / 1000) +
        " с: как только сервер перестанет забирать обновления, приму их сам.");
      (function recheck() {
        setTimeout(function () {
          if (stopped) return;
          checkServerTakesUpdates("").then(function (stillTakes) {
            if (stillTakes) return recheck();
            console.log("[bot] сервер перестал принимать обновления — забираю их сам");
            return start();
          });
        }, SERVER_RECHECK_MS);
      })();
    });
  }

  if (CONFIG.force || !CONFIG.yieldToServer || !CONFIG.serverUrl) return start();
  return waitForServer();
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

  console.log("\n5. Один бот — один потребитель обновлений (409 Conflict)");
  check("живой вебхук — значит обновления уже кто-то принимает",
    Core.webhookAlive({ ok: true, result: { url: "https://server.example.com/api/tg-webhook" } }, Date.now()) === true);
  check("вебхука нет — принимать некому",
    Core.webhookAlive({ ok: true, result: { url: "" } }, Date.now()) === false);
  check("вебхук со свежей ошибкой доставки считается неработающим",
    Core.webhookAlive({
      ok: true, result: {
        url: "https://old.example.com/api/tg-webhook",
        last_error_message: "Wrong response from the webhook: 404 Not Found",
        last_error_date: Math.floor(Date.now() / 1000) - 60
      }
    }, Date.now()) === false);
  check("адрес проверки сервера выводится из вебхука",
    Core.serverHealthUrl("https://server.example.com/api/tg-webhook", "") ===
    "https://server.example.com/api/health");
  check("явный SERVER_URL важнее вебхука",
    Core.serverHealthUrl("https://hook.example.com/api/tg-webhook", "https://site.example.com/") ===
    "https://site.example.com/api/health");
  check("сервер с вебхуком сам принимает обновления — бот уступает",
    Core.serverTakesUpdates({ ok: true, updates: "webhook" }) === true);
  check("сервер с живым опросом сам принимает обновления",
    Core.serverTakesUpdates({
      ok: true, updates: "poll",
      updates_detail: { mode: "poll", alive: true, last_ok_age_ms: 3000 }
    }) === true);
  check("сервер с POLL=0 обновления не берёт — бот работает",
    Core.serverTakesUpdates({ ok: true, updates: "off", updates_detail: { mode: "off", alive: false } }) === false);
  check("мёртвый опрос сервера (обновления никто не забирает) — бот работает",
    Core.serverTakesUpdates({
      ok: true, updates: "poll",
      updates_detail: { mode: "poll", alive: false, last_ok_age_ms: 3600000 }
    }) === false);
  check("сервер в 409 всё ещё считается живым: очередь держит кто-то другой",
    Core.serverTakesUpdates({
      ok: true, updates: "poll",
      updates_detail: { mode: "poll", alive: true, last_ok_age_ms: 600000, conflict_age_ms: 30000 }
    }) === true);
  check("пауза после 409 нарастает и ограничена минутой",
    Core.conflictBackoffMs(1) >= 5000 && Core.conflictBackoffMs(2) > Core.conflictBackoffMs(1) &&
    Core.conflictBackoffMs(99) <= 78000,
    Core.conflictBackoffMs(1) + " → " + Core.conflictBackoffMs(99));

  console.log("\n" + (failures ? "ПРОВАЛЕНО ПРОВЕРОК: " + failures : "Все проверки пройдены ✅") + "\n");
  process.exit(failures ? 1 : 0);
}

function main() {
  var args = process.argv.slice(2);
  if (args.indexOf("--selftest") !== -1) return selftest();
  /* --force: работать, даже если сервер сайта на связи и сам забирает
     обновления. Нужно только для ручной проверки — иначе оба процесса
     получают 409 Conflict и часть заявок теряется. */
  if (args.indexOf("--force") !== -1) {
    CONFIG.force = true;
    console.log("[bot] режим --force: не уступаю серверу, работаю в любом случае");
  }

  if (CONFIG.dryRun) {
    console.log("Тестовый режим: BOT_TOKEN или MODERATOR_ID не заданы — в Telegram ничего не уходит.");
  }

  if (args.indexOf("--once") !== -1) {
    var budgetAt = args.indexOf("--budget");
    var budget = budgetAt !== -1 ? parseInt(args[budgetAt + 1], 10) || 60 : 0;
    drainOnce({ once: true, budgetSeconds: budget }).then(function (processed) {
      if (lastRun.skipped) {
        console.log("[bot] запуск пропущен: " + lastRun.skipped);
        console.log("[bot] обработано обновлений: " + processed);
      } else {
        console.log("[bot] обработано обновлений: " + processed);
      }
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
  lastRun: function () { return lastRun; },
  serverTakesUpdates: checkServerTakesUpdates,
  handleUpdate: handleUpdate,
  handleMessage: function (message, meta) {
    return Core.handleMessage(CONFIG, state, message, meta);
  },
  runActions: runActions,
  drainOnce: drainOnce,
  hintFor: hintFor
};

if (require.main === module) main();
