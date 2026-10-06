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
  if (code === 409) return "очередь занята (409 Conflict): её держит другой потребитель — сервер сайта, "
    + "вторая вкладка, GitHub Actions или node bot.js: оставьте что-то одно";
  if (code === 429) return "Telegram просит подождать: слишком много запросов";
  if (text.indexOf("failed to fetch") !== -1 || text.indexOf("networkerror") !== -1) {
    return "браузер не смог обратиться к api.telegram.org: проверьте интернет, блокировщики и VPN";
  }
  return "";
}

/* Короткий запрос JSON с таймаутом. Любая ошибка (нет связи, CORS, чужой
   сервер) = «не подтверждено» — тогда потребитель работает сам. */
function fetchJson(fetchImpl, url, timeoutMs) {
  if (!url || !fetchImpl) return Promise.resolve(null);
  var controller = typeof AbortController === "function" ? new AbortController() : null;
  var timer = null;
  if (controller) timer = setTimeout(function () { controller.abort(); }, timeoutMs || 6000);
  return fetchImpl(url, {
    headers: { "Accept": "application/json" },
    signal: controller ? controller.signal : undefined
  }).then(function (response) {
    if (timer) clearTimeout(timer);
    return response.json();
  }).catch(function () {
    if (timer) clearTimeout(timer);
    return null;
  });
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
  var conflictDelayMs = options.conflictDelayMs || 0;   /* пауза при 409 (0 — по нарастающей) */
  var log = options.log || function () {};
  var onStatus = options.onStatus || function () {};
  var state = Core.newState();
  var running = false;
  var offset = 0;
  var stopped = false;
  var loop = null;                 /* фоновая задача опроса (для тестов и stop) */
  var stats = { orders: 0, updates: 0, errors: 0, conflicts: 0 };

  /* Telegram отдаёт getUpdates только одному. Если очередь занята, эта
     вкладка не спорит: сначала отступает, а после третьего 409 подряд
     останавливается — значит, обновления забирает постоянный сервер. */
  var CONFLICT_STOP_AFTER = 3;
  var conflictStreak = 0;

  function note(message, kind) { log(message, kind || "info"); }

  /* /api/health сервера: принимает ли он обновления сам. */
  function serverHealth(url) { return fetchJson(fetchImpl, url, 6000); }

  /* Интерфейсу всегда отдаём полное состояние, иначе плашка «бот работает»
     гасла после первой же заявки. */
  function status() {
    return {
      running: running,
      stats: stats,
      conflicts: stats.conflicts,     /* сколько раз очередь была занята (409) */
      pending: Object.keys(state.pendingContact).length
    };
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
          /* 409 Conflict: очередь getUpdates занята — сервер сайта, вторая
             вкладка, GitHub Actions или node bot.js. Спорить бессмысленно:
             отступаем, а если очередь так и занята — останавливаемся. */
          if (data && data.error_code === 409) {
            conflictStreak++;
            stats.conflicts++;
            if (conflictStreak >= CONFLICT_STOP_AFTER) {
              note("Обновления стабильно забирает кто-то другой (постоянный сервер сайта, " +
                "GitHub Actions или вторая вкладка). Эта вкладка останавливается, чтобы не спорить " +
                "за getUpdates: заявки всё равно доходят. Если принимать их должна вкладка — " +
                "остановите сервер и нажмите «Запустить» снова.", "warn");
              stop();
              return;
            }
            return pause(conflictDelayMs || Core.conflictBackoffMs(conflictStreak)).then(tick);
          }
          return pause(retryDelayMs).then(tick);
        }
        conflictStreak = 0;
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
      conflictStreak = 0;
      onStatus(status());
      /* Если остался вебхук от прежней настройки, Telegram не отдаст
         обновления через getUpdates — снимаем его. Но живой вебхук, по
         которому работает сервер сайта, снимать нельзя: иначе заявки
         перестанут приходить на сервер, а вкладка работает не всегда. */
      return call("getWebhookInfo", {}).then(function (info) {
        var url = info && info.ok && info.result && info.result.url;
        if (!url) return null;
        if (!Core.webhookAlive(info, Date.now())) {
          note("Снимаю неработающий вебхук (" + url + "), иначе обновления не придут", "warn");
          return call("deleteWebhook", { drop_pending_updates: false });
        }
        return serverHealth(Core.serverHealthUrl(url, "")).then(function (health) {
          if (Core.serverTakesUpdates(health)) {
            note("Обновления принимает сервер сайта по вебхуку " + url + " — бот уже работает.", "ok");
            note("Эта вкладка останавливается: два получателя с одним токеном — это 409 Conflict и потерянные заявки.", "warn");
            stop();
            return "skip";
          }
          note("Снимаю вебхук " + url + ": сервер по нему не отвечает — обновления будет забирать эта вкладка", "warn");
          return call("deleteWebhook", { drop_pending_updates: false });
        });
      }).catch(function (error) {
        /* Нет связи — не мешаем запуску: цикл сам сообщит об этом в журнале. */
        note("Не удалось проверить вебхук: " + error.message, "warn");
        return null;
      }).then(function (result) {
        if (result === "skip" || stopped) {
          /* Обновления забирает сервер — запускать опрос не нужно. */
          loop = Promise.resolve();
          return { running: false, processed: stats.updates };
        }
        note("Бот запущен. Пока эта вкладка открыта, заявки уходят модератору.", "ok");
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
