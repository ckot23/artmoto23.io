#!/usr/bin/env node
"use strict";
/* ============================================================================
   Панель бота: запуск приёма заявок прямо из браузера — без хостинга, без
   Node и без токена в коде.

   Как это работает: страница bot.html просит у владельца токен бота и chat_id
   модератора, хранит их в localStorage ЭТОГО браузера и сама опрашивает
   Telegram (getUpdates), пересылая заявки модератору. Пока вкладка открыта —
   бот работает. Токен в файлах репозитория не появляется никогда.

   Файл не знает про DOM: те же функции проверяются в Node (tests/panel.js).
   ========================================================================= */

/* В браузере модули приходят обычными <script> и лежат в globalThis,
   в Node — через require. Проверяем оба варианта. */
var IN_NODE = typeof require === "function" && typeof module !== "undefined";
if (IN_NODE) {
  require("./pricing.js");
  require("./orderlink.js");
  require("./botcore.js");
}
var Core = (typeof globalThis !== "undefined" && globalThis.BotCore) || (IN_NODE ? require("./botcore.js") : null);
if (!Core) throw new Error("botpanel.js: не загружен botcore.js (подключите его перед панелью)");

var TG_API = "https://api.telegram.org/bot";

/* Ошибки Telegram человеческим языком (одинаково с server.js и bot.js). */
function hintFor(code, description) {
  var text = String(description || "").toLowerCase();
  if (code === 401) return "токен недействителен: скопируйте свежий у @BotFather (/mybots → API Token)";
  if (code === 403) return "получатель не начинал диалог с ботом: пусть нажмёт «Start» в чате с ботом";
  if (code === 400 && text.indexOf("chat not found") !== -1) return "chat_id указан неверно: напишите боту /id и возьмите число оттуда";
  if (code === 409) return "у бота уже установлен вебхук или запущен второй потребитель обновлений (другая вкладка, GitHub Actions, node bot.js): оставьте что-то одно";
  if (code === 429) return "Telegram просит подождать: слишком много запросов";
  if (text.indexOf("failed to fetch") !== -1 || text.indexOf("networkerror") !== -1) {
    return "браузер не смог обратиться к api.telegram.org: проверьте интернет, блокировщики и VPN";
  }
  return "";
}

/* Создаёт бота, который живёт в браузерной вкладке. */
function createBot(options) {
  var config = {
    token: String(options.token || "").trim(),
    moderatorId: String(options.moderatorId || "").trim(),
    publicUrl: String(options.publicUrl || "").trim(),
    forwardText: options.forwardText !== false
  };
  var fetchImpl = options.fetch || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
  var retryDelayMs = options.retryDelayMs || 5000;      /* пауза после ошибки */
  var hiddenDelayMs = options.hiddenDelayMs || 3000;    /* пауза, если вкладка свёрнута */
  var minCycleMs = options.minCycleMs || 1000;          /* не частим с запросами к Telegram */
  var log = options.log || function () {};
  var onStatus = options.onStatus || function () {};
  var state = Core.newState();
  var running = false;
  var offset = 0;
  var stopped = false;
  var loop = null;                 /* фоновая задача опроса (для тестов и stop) */
  var stats = { orders: 0, updates: 0, errors: 0 };

  function note(message, kind) { log(message, kind || "info"); }

  /* Интерфейсу всегда отдаём полное состояние, иначе плашка «бот работает»
     гасла после первой же заявки. */
  function status() {
    return { running: running, stats: stats, pending: Object.keys(state.pendingContact).length };
  }

  function call(method, payload) {
    if (!fetchImpl) return Promise.reject(new Error("fetch недоступен"));
    return fetchImpl(TG_API + config.token + "/" + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    }).then(function (response) {
      return response.json().catch(function () {
        return { ok: false, description: "Ответ Telegram не разобран (HTTP " + response.status + ")" };
      });
    });
  }

  /* Отправка одного действия из плана botcore. */
  function deliver(action) {
    return call("sendMessage", {
      chat_id: action.chatId,
      text: action.text,
      parse_mode: action.parse_mode,
      disable_web_page_preview: action.disable_web_page_preview
    }).then(function (data) {
      if (!data || !data.ok) {
        var reason = (data && data.description) || "нет ответа";
        stats.errors++;
        note("Не удалось отправить в " + action.chatId + ": " + reason +
          (hintFor(data && data.error_code, reason) ? " → " + hintFor(data && data.error_code, reason) : ""), "error");
        return { ok: false, description: reason, error_code: data && data.error_code };
      }
      return { ok: true };
    }).catch(function (error) {
      stats.errors++;
      note("Сеть: " + error.message + (hintFor(0, error.message) ? " → " + hintFor(0, error.message) : ""), "error");
      return { ok: false, description: error.message };
    });
  }

  function processUpdate(update) {
    var actions = Core.handleUpdate(config, state, update);
    if (!actions.length) return Promise.resolve();
    stats.updates++;
    var orders = actions.filter(function (a) { return a.role === "order"; }).length;
    return Core.runPlan(actions, deliver).then(function () {
      if (orders) {
        stats.orders += orders;
        note("Заявка передана модератору (" + stats.orders + " за этот заход)", "order");
      }
      onStatus(status());
    });
  }

  function tick() {
    if (stopped) return Promise.resolve();
    var startedAt = Date.now();
    return call("getUpdates", { offset: offset, timeout: 25, allowed_updates: ["message"] })
      .then(function (data) {
        if (stopped) return;
        if (!data || !data.ok) {
          var reason = (data && data.description) || "нет ответа Telegram";
          stats.errors++;
          note("getUpdates: " + reason +
            (hintFor(data && data.error_code, reason) ? " → " + hintFor(data && data.error_code, reason) : ""), "error");
          if (data && data.error_code === 401) { stop(); return; }
          return pause(retryDelayMs).then(tick);
        }
        var batch = Array.isArray(data.result) ? data.result : [];
        var chain = Promise.resolve();
        batch.forEach(function (update) {
          offset = update.update_id + 1;
          chain = chain.then(function () { return processUpdate(update); });
        });
        return chain.then(function () {
          if (stopped) return;
          if (batch.length) note("Обработано обновлений: " + batch.length);
          /* Telegram иногда отвечает мгновенно (пустой ответ, ошибка сети) —
             держим паузу, чтобы не забрасывать API запросами. */
          var elapsed = Date.now() - startedAt;
          var wait = batch.length ? 0 : Math.max(0, minCycleMs - elapsed);
          if (documentHidden()) {
            if (!batch.length) note("Вкладка свёрнута — проверяю реже, заявки продолжат приходить", "warn");
            wait = Math.max(wait, hiddenDelayMs);
          }
          return pause(wait).then(tick);
        });
      })
      .catch(function (error) {
        if (stopped) return;
        stats.errors++;
        note("Сеть: " + error.message + (hintFor(0, error.message) ? " → " + hintFor(0, error.message) : ""), "error");
        return pause(retryDelayMs).then(tick);
      });
  }

  function pause(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function documentHidden() {
    return typeof document !== "undefined" && document.hidden === true;
  }

  function stop() {
    if (!running) return;
    running = false;
    stopped = true;
    onStatus(status());
  }

  return {
    /* Проверка токена и того, кому принадлежит бот. */
    check: function () {
      if (!config.token) return Promise.reject(new Error("Укажите токен бота"));
      return call("getMe", {}).then(function (data) {
        if (!data || !data.ok) {
          var reason = (data && data.description) || "нет ответа Telegram";
          throw new Error(reason + (hintFor(data && data.error_code, reason) ? " → " + hintFor(data && data.error_code, reason) : ""));
        }
        return { username: data.result.username, id: data.result.id, name: data.result.first_name };
      });
    },

    /* Один проход: забрать накопившиеся заявки и выйти. Удобно для проверки. */
    once: function () {
      return call("getUpdates", { offset: offset, timeout: 0, allowed_updates: ["message"] }).then(function (data) {
        if (!data || !data.ok) {
          var reason = (data && data.description) || "нет ответа Telegram";
          throw new Error(reason + (hintFor(data && data.error_code, reason) ? " → " + hintFor(data && data.error_code, reason) : ""));
        }
        var batch = Array.isArray(data.result) ? data.result : [];
        var chain = Promise.resolve();
        batch.forEach(function (update) {
          offset = update.update_id + 1;
          chain = chain.then(function () { return processUpdate(update); });
        });
        return chain.then(function () { return { processed: batch.length, orders: stats.orders }; });
      });
    },

    /* Запуск: сразу отвечаем «работаю», а опрос идёт в фоне — панель не
       должна ждать бесконечный цикл. */
    start: function () {
      if (running) return Promise.resolve();
      running = true;
      stopped = false;
      note("Бот запущен. Пока эта вкладка открыта, заявки уходят модератору.", "ok");
      onStatus(status());
      /* Если остался вебхук от прежней настройки, Telegram не отдаст
         обновления через getUpdates — снимаем его. */
      return call("getWebhookInfo", {}).then(function (info) {
        var url = info && info.ok && info.result && info.result.url;
        if (!url) return null;
        note("Снимаю старый вебхук (" + url + "), иначе обновления не придут", "warn");
        return call("deleteWebhook", { drop_pending_updates: false });
      }).catch(function (error) {
        /* Нет связи — не мешаем запуску: цикл сам сообщит об этом в журнале. */
        note("Не удалось проверить вебхук: " + error.message, "warn");
        return null;
      }).then(function () {
        loop = tick();                 /* фоновая работа, ошибки видны в журнале */
        loop.catch(function () {});
        return { running: true, processed: stats.updates };
      });
    },

    stop: stop,

    get status() {
      return Object.assign(status(), { orders: state.orders, offset: offset, config: config });
    }
  };
}

var API = { TG_API: TG_API, createBot: createBot, hintFor: hintFor };
if (typeof module !== "undefined" && module.exports) module.exports = API;
if (typeof globalThis !== "undefined") globalThis.BotPanel = API;
