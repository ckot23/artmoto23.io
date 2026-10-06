#!/usr/bin/env node
"use strict";
/* ============================================================================
   Сервер наклеек: отдаёт сайт и принимает заказы в Telegram-бота.

   Запуск:            node server.js
   Проверка логики:   node server.js --selftest
   Тестовая отправка: node server.js --send-test

   Без зависимостей — нужен только Node 18+ (встроенный fetch и http).

   Переменные окружения (или файл .env рядом, см. .env.example):
     BOT_TOKEN       — токен бота от @BotFather (обязателен для реальной отправки)
     MODERATOR_ID    — chat_id получателя заявок, например 7114829971
     PORT            — порт, по умолчанию 8080
     HOST            — адрес, по умолчанию 0.0.0.0
     DRY_RUN         — 1: заявки не отправляются в Telegram, только пишутся в лог
     POLL            — 1: слушать getUpdates и принимать заказы из Mini App
     WEBHOOK_SECRET  — секрет для /api/tg-webhook (защита вебхука)
     ALLOW_ORIGIN    — если сайт лежит на другом домене, укажите его origin
                    (можно несколько через запятую)
   WEBHOOK_AUTO    — 1: поставить вебхук на своём адресе при запуске
   SERVER_URL      — публичный адрес этого сервера (на Render берётся сам)
   LOG_ORDERS      — 1 (по умолчанию): дублировать заявки в orders.jsonl
   ========================================================================= */

var http = require("http");
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var P = require("./pricing.js");
var E = require("./env.js");

var ROOT = E.ROOT;

/* ---------------------------------------------------------------------------
   1. КОНФИГ
   ------------------------------------------------------------------------ */

/* Настройки читает общий модуль env.js — им же пользуется bot.js. */
var env = E.env;

var CONFIG = {
  botToken: env("BOT_TOKEN", ""),
  moderatorId: env("MODERATOR_ID", ""),
  port: parseInt(env("PORT", "8080"), 10),
  host: env("HOST", "0.0.0.0"),
  dryRun: env("DRY_RUN", "0") === "1",
  poll: String(env("POLL", "auto")).trim().toLowerCase(),
  webhookSecret: env("WEBHOOK_SECRET", ""),
  webhookAuto: env("WEBHOOK_AUTO", "0") === "1",
  serverUrl: (env("SERVER_URL", "") || env("RENDER_EXTERNAL_URL", "")).replace(/\/+$/, ""),
  allowOrigin: env("ALLOW_ORIGIN", ""),
  logOrders: env("LOG_ORDERS", "1") === "1",
  publicUrl: env("PUBLIC_URL", "")
};

/* Нет токена — отправлять некуда, автоматически уходим в тестовый режим,
   чтобы сайт можно было спокойно смотреть локально. */
if (!CONFIG.botToken || !CONFIG.moderatorId) CONFIG.dryRun = true;

/* Как сервер получает обновления от Telegram (заказы из Mini App, команды):
     poll  — слушаем getUpdates;
     webhook — обновления приходят на /api/tg-webhook;
     off   — обновления не принимаем. */
var updates = { mode: "off", url: "", reason: "" };

var TG_API = "https://api.telegram.org/bot";
var ORDERS_LOG = path.join(ROOT, "orders.jsonl");

/* ---------------------------------------------------------------------------
   2. TELEGRAM
   ------------------------------------------------------------------------ */

function tgCall(method, payload) {
  var url = TG_API + CONFIG.botToken + "/" + method;
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {})
  }).then(function (response) {
    return response.json().catch(function () { return { ok: false, description: "Некорректный ответ Telegram" }; });
  });
}

function sendToModerator(text) {
  if (CONFIG.dryRun) {
    console.log("\n--- ЗАЯВКА (тестовый режим, в Telegram не отправлена) ---\n" +
      text.replace(/<[^>]+>/g, "") + "\n--- конец заявки ---\n");
    return Promise.resolve({ ok: true, dryRun: true });
  }
  return tgCall("sendMessage", {
    chat_id: CONFIG.moderatorId,
    text: text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  }).then(function (data) {
    if (!data || !data.ok) {
      var reason = (data && data.description) || "неизвестная ошибка";
      var hint = telegramHint(data && data.error_code, reason);
      console.error("[telegram] не отправлено: " + reason + (hint ? " → " + hint : ""));
      return { ok: false, error: reason, hint: hint };
    }
    return { ok: true };
  }).catch(function (error) {
    console.error("[telegram] сеть недоступна: " + error.message);
    return { ok: false, error: "Сеть недоступна: " + error.message };
  });
}

/* Расшифровка типовых ошибок Telegram — чтобы «заявка не дошла» не искали
   методом тыка. Пустая строка (нет подсказки) — тоже ответ. */
function telegramHint(code, description) {
  var text = String(description || "").toLowerCase();
  if (code === 401) return "токен бота недействителен: получите новый у @BotFather (/mybots → API Token) и впишите его в .env → BOT_TOKEN";
  if (code === 403) return "бот не может написать этому получателю: MODERATOR_ID должен сам открыть бота и нажать «Start»";
  if (code === 400 && text.indexOf("chat not found") !== -1) return "MODERATOR_ID указан неверно: узнайте свой chat_id, отправив боту /id";
  if (code === 400 && text.indexOf("parse") !== -1) return "текст заявки не прошёл разметку HTML — сообщите об этом разработчику";
  if (code === 429) return "слишком много сообщений в минуту: Telegram просит подождать";
  if (text.indexOf("timed out") !== -1 || text.indexOf("fetch failed") !== -1) return "нет связи с api.telegram.org (файрвол, прокси у хостинга)";
  return "";
}

/* Проверка бота при старте: живой ли токен и кому он принадлежит. */
function botDiagnostics() {
  if (!CONFIG.botToken) {
    console.log("⚠️  BOT_TOKEN не задан — заявки уходят только в лог (см. .env.example)");
    return Promise.resolve(null);
  }
  return tgCall("getMe", {}).then(function (data) {
    if (data && data.ok && data.result) {
      console.log("Бот: @" + (data.result.username || data.result.first_name) + " (id " + data.result.id + ")");
      return data.result;
    }
    var code = data && data.error_code;
    console.error("⚠️  Токен бота не работает: " + ((data && data.description) || "нет ответа"));
    var hint = telegramHint(code, data && data.description);
    if (hint) console.error("⚠️  " + hint);
    return null;
  }).catch(function (error) {
    console.error("⚠️  api.telegram.org недоступен: " + error.message +
      " — заявки не смогут уйти менеджеру");
    return null;
  });
}

/* Регистрация вебхука на хостинге: адрес сервера известен (SERVER_URL, а на
   Render — RENDER_EXTERNAL_URL), поэтому сервер сам сообщает его Telegram.
   Это ещё и будильник: Telegram стучится к спящему контейнеру и поднимает его. */
function registerWebhook() {
  if (!CONFIG.webhookAuto) return Promise.resolve(null);
  if (!CONFIG.webhookSecret) {
    console.error("⚠️  WEBHOOK_AUTO=1, но WEBHOOK_SECRET пустой — вебхук не регистрирую (его пришлось бы принимать от кого угодно)");
    return Promise.resolve(null);
  }
  if (!CONFIG.serverUrl) {
    console.error("⚠️  WEBHOOK_AUTO=1, но не задан SERVER_URL — вебхук не регистрирую");
    return Promise.resolve(null);
  }
  var target = CONFIG.serverUrl + "/api/tg-webhook";
  return tgCall("setWebhook", {
    url: target,
    secret_token: CONFIG.webhookSecret,
    allowed_updates: ["message"],
    drop_pending_updates: false
  }).then(function (data) {
    if (data && data.ok) {
      console.log("Вебхук зарегистрирован: " + target);
      return target;
    }
    console.error("⚠️  Не удалось поставить вебхук: " + ((data && data.description) || "нет ответа"));
    return null;
  }).catch(function (error) {
    console.error("⚠️  Вебхук не установлен: " + error.message);
    return null;
  });
}

/* Режим приёма обновлений. POLL=auto (по умолчанию) сам выбирает:
   вебхук уже стоит → обновления придут на него; вебхука нет → слушаем сами,
   иначе заказы, отправленные сайтом через tg.sendData, потерялись бы. */
function resolveUpdatesMode() {
  if (CONFIG.poll === "0" || CONFIG.poll === "off" || CONFIG.poll === "no") {
    updates = { mode: "off", url: "", reason: "POLL=0" };
    return Promise.resolve(updates);
  }
  if (CONFIG.poll === "1" || CONFIG.poll === "on" || CONFIG.poll === "yes") {
    updates = { mode: "poll", url: "", reason: "POLL=1" };
    return Promise.resolve(updates);
  }
  if (!CONFIG.botToken) {
    updates = { mode: "off", url: "", reason: "нет токена бота" };
    return Promise.resolve(updates);
  }
  return tgCall("getWebhookInfo", {}).then(function (data) {
    var url = data && data.ok && data.result && data.result.url;
    updates = url
      ? { mode: "webhook", url: url, reason: "вебхук уже установлен" }
      : { mode: "poll", url: "", reason: "POLL=auto, вебхука нет" };
    return updates;
  }).catch(function (error) {
    /* Telegram не ответил (сеть, файрвол у хостинга): не выключаем приём
       обновлений, а пробуем слушать getUpdates — лучше потерять вебхук,
       чем заказ. */
    updates = { mode: "poll", url: "", reason: "нет связи с Telegram при старте: " + error.message };
    return updates;
  });
}

/* Подпись initData из Mini App: подтверждает, что данные пришли из Telegram,
   и позволяет достать id пользователя для ссылки «написать клиенту». */
function verifyInitData(initData) {
  if (!initData || !CONFIG.botToken) return null;
  var params;
  try { params = new URLSearchParams(initData); } catch (e) { return null; }
  var hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  var pairs = [];
  params.forEach(function (value, key) { pairs.push(key + "=" + value); });
  pairs.sort();
  var secret = crypto.createHmac("sha256", "WebAppData").update(CONFIG.botToken).digest();
  var calculated = crypto.createHmac("sha256", secret).update(pairs.join("\n")).digest("hex");
  var a = Buffer.from(calculated, "hex");
  var b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(params.get("user") || "null"); } catch (e) { return null; }
}

/* ---------------------------------------------------------------------------
   3. ЗАКАЗЫ
   ------------------------------------------------------------------------ */

var orderCounter = 0;

function newOrderId(date) {
  var stamp = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow", year: "2-digit", month: "2-digit", day: "2-digit"
  }).format(date).replace(/-/g, "");
  orderCounter = (orderCounter + 1) % 10000;
  var tail = crypto.randomBytes(2).toString("hex").toUpperCase();
  return stamp + "-" + tail + String(orderCounter).padStart(2, "0");
}

function moscowTime(date) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  }).format(date) + " (МСК)";
}

function appendOrderLog(record) {
  if (!CONFIG.logOrders) return;
  fs.appendFile(ORDERS_LOG, JSON.stringify(record) + "\n", function () { /* лог не критичен */ });
}

/* Единая точка приёма заявки: используется и HTTP-эндпоинтом, и Mini App. */
function acceptOrder(raw, meta) {
  var checked = P.validate(raw);
  if (!checked.ok) return Promise.resolve({ ok: false, error: checked.error });

  var order = checked.value;
  var price = P.calculate(order);
  var now = new Date();
  var orderId = newOrderId(now);

  var text = P.orderMessage(order, price, {
    orderId: orderId,
    time: moscowTime(now),
    userId: meta && meta.userId,
    dryRun: CONFIG.dryRun
  });

  appendOrderLog({
    order_id: orderId,
    created_at: now.toISOString(),
    source: (meta && meta.source) || "site",
    user_id: (meta && meta.userId) || null,
    dry_run: CONFIG.dryRun,
    order: order,
    price: price
  });

  return sendToModerator(text).then(function (result) {
    if (!result.ok) {
      return { ok: false, error: "Не удалось передать заявку менеджеру. Напишите напрямую: https://t.me/ckot_23" };
    }
    return { ok: true, order_id: orderId, total: price.total, unit: price.unit, dry_run: CONFIG.dryRun };
  });
}

/* ---------------------------------------------------------------------------
   4. HTTP
   ------------------------------------------------------------------------ */

var MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".pdf": "application/pdf"
};

/* Файлы, которые нельзя отдавать наружу. pricing.js, orderlink.js, botcore.js
   и botpanel.js наоборот должны быть доступны: их грузит панель бота (bot.html). */
var DENY_FILES = ["server.js", "orders.jsonl", "env.js", "bot.js", "package.json",
  "package-lock.json", "render.yaml", "Dockerfile", ".dockerignore"];

var RATE_WINDOW_MS = 15 * 60 * 1000;
var RATE_MAX = 8;
var rateHits = new Map();

function rateLimited(ip) {
  var now = Date.now();
  var list = (rateHits.get(ip) || []).filter(function (t) { return now - t < RATE_WINDOW_MS; });
  if (list.length >= RATE_MAX) { rateHits.set(ip, list); return true; }
  list.push(now);
  rateHits.set(ip, list);
  if (rateHits.size > 5000) rateHits.clear();
  return false;
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var size = 0;
    req.on("data", function (chunk) {
      size += chunk.length;
      if (size > limit) { reject(new Error("Слишком большой запрос")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", function () { resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  var body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function applyCors(req, res) {
  if (!CONFIG.allowOrigin) return;
  var allowed = CONFIG.allowOrigin.split(",").map(function (item) { return item.trim(); })
    .filter(function (item) { return item; });
  if (!allowed.length) return;
  /* Сайт может открываться и с GitHub Pages, и с домена — разрешаем список. */
  var origin = req.headers.origin;
  var value = origin && allowed.indexOf(origin) !== -1 ? origin : allowed[0];
  res.setHeader("Access-Control-Allow-Origin", value);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function serveStatic(req, res, pathname) {
  var relative = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (relative === "") relative = "index.html";
  if (relative.indexOf("\0") !== -1) { res.writeHead(400).end("Bad request"); return; }

  var segments = relative.split("/");
  for (var i = 0; i < segments.length; i++) {
    if (segments[i].charAt(0) === ".") { res.writeHead(403).end("Forbidden"); return; }
  }
  if (DENY_FILES.indexOf(segments[segments.length - 1]) !== -1) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  var full = path.resolve(ROOT, relative);
  if (full !== ROOT && full.indexOf(ROOT + path.sep) !== 0) { res.writeHead(403).end("Forbidden"); return; }

  fs.stat(full, function (error, stat) {
    if (!error && stat.isDirectory()) {
      full = path.join(full, "index.html");
      stat = null;
      error = null;
      fs.stat(full, function (err2, st2) { error = err2; stat = st2; deliver(); });
      return;
    }
    deliver();

    function deliver() {
      if (error || !stat || !stat.isFile()) { res.writeHead(404).end("Not found"); return; }
      var type = MIME[path.extname(full).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": stat.size,
        "Cache-Control": "no-cache"
      });
      fs.createReadStream(full).pipe(res);
    }
  });
}

function handleUpdate(update) {
  var message = update && (update.message || update.edited_message);
  if (!message) return Promise.resolve();
  var chatId = message.chat && message.chat.id;

  /* Заказ из Mini App (сайт отправил tg.sendData). */
  if (message.web_app_data && message.web_app_data.data) {
    var payload;
    try { payload = JSON.parse(message.web_app_data.data); } catch (e) { payload = null; }
    if (payload) {
      var userId = message.from && message.from.id;
      return acceptOrder(payload, { source: "mini-app", userId: userId }).then(function (result) {
        if (result.ok) {
          console.log("[mini-app] заявка " + result.order_id + " отправлена модератору");
          return;
        }
        /* Заявка НЕ ушла: клиент об этом узнает сразу в чате с ботом,
           иначе он останется ждать ответа менеджера. */
        console.error("[mini-app] заявка отклонена: " + result.error);
        if (!chatId) return;
        return tgCall("sendMessage", {
          chat_id: chatId,
          text: "⚠️ Заявку не удалось передать менеджеру: " + result.error,
          disable_web_page_preview: true
        }).catch(function () { /* клиент мог заблокировать бота */ });
      });
    }
  }

  var text = String(message.text || "");
  if (!chatId) return Promise.resolve();

  if (text.indexOf("/start") === 0) {
    var hello = "Привет! Здесь принимаются заказы на наклейки.\n\n" +
      "Соберите наклейку в конструкторе" + (CONFIG.publicUrl ? ": " + CONFIG.publicUrl : " на сайте") +
      " — заявка придёт менеджеру, он напишет вам в Telegram.";
    var reply = { chat_id: chatId, text: hello, disable_web_page_preview: true };
    /* Кнопка открывает тот же сайт как Mini App. Требует, чтобы домен был
       привязан к боту: @BotFather → /mybots → Bot Settings → Domain. */
    if (CONFIG.publicUrl) {
      reply.reply_markup = {
        inline_keyboard: [[{ text: "🛠 Собрать наклейку", web_app: { url: CONFIG.publicUrl } }]]
      };
    }
    return tgCall("sendMessage", reply)
      .catch(function () { /* клиент мог заблокировать бота */ });
  }
  if (text.indexOf("/id") === 0) {
    return tgCall("sendMessage", { chat_id: chatId, text: "Ваш chat_id: " + chatId })
      .catch(function () { /* ok */ });
  }
  return Promise.resolve();
}

var server = http.createServer(function (req, res) {
  var url;
  try { url = new URL(req.url, "http://localhost"); } catch (e) { res.writeHead(400).end("Bad request"); return; }
  var pathname = url.pathname;
  var ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";

  applyCors(req, res);

  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

  if (pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      dry_run: CONFIG.dryRun,
      token: Boolean(CONFIG.botToken),
      moderator: Boolean(CONFIG.moderatorId),
      poll: updates.mode === "poll",
      updates: updates.mode,
      order_path: CONFIG.dryRun ? "лог (тестовый режим)" : "телеграм модератору"
    });
    return;
  }

  /* Проверка бота «по требованию»: показывает, жив ли токен и видит ли сервер
     Telegram. Секретов не раскрывает — только ok/ошибку. */
  if (pathname === "/api/tg-check") {
    if (!CONFIG.botToken) {
      sendJson(res, 200, { ok: false, error: "BOT_TOKEN не задан" });
      return;
    }
    tgCall("getMe", {}).then(function (data) {
      sendJson(res, 200, {
        ok: Boolean(data && data.ok),
        bot: data && data.ok && data.result ? "@" + (data.result.username || data.result.id) : null,
        error: data && data.ok ? null : ((data && data.description) || "нет ответа Telegram"),
        dry_run: CONFIG.dryRun,
        updates: updates.mode
      });
    }).catch(function (error) {
      sendJson(res, 200, { ok: false, error: "api.telegram.org недоступен: " + error.message });
    });
    return;
  }

  if (pathname === "/api/order" && req.method === "POST") {
    if (rateLimited(ip)) {
      sendJson(res, 429, { ok: false, error: "Слишком много заявок подряд. Попробуйте через 15 минут." });
      return;
    }
    readBody(req, 64 * 1024).then(function (body) {
      var payload;
      try { payload = JSON.parse(body); } catch (e) { payload = null; }
      if (!payload) { sendJson(res, 400, { ok: false, error: "Некорректный запрос" }); return; }

      var user = verifyInitData(payload.init_data);
      return acceptOrder(payload, { source: user ? "mini-app" : "site", userId: user && user.id }).then(function (result) {
        sendJson(res, result.ok ? 200 : 502, result);
      });
    }).catch(function (error) {
      sendJson(res, 413, { ok: false, error: error.message });
    });
    return;
  }

  if (pathname === "/api/tg-webhook" && req.method === "POST") {
    if (!CONFIG.webhookSecret ||
        req.headers["x-telegram-bot-api-secret-token"] !== CONFIG.webhookSecret) {
      sendJson(res, 403, { ok: false, error: "Forbidden" });
      return;
    }
    readBody(req, 256 * 1024).then(function (body) {
      var update;
      try { update = JSON.parse(body); } catch (e) { update = null; }
      res.writeHead(200).end("ok");
      if (update) handleUpdate(update);
    }).catch(function () { res.writeHead(200).end("ok"); });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  serveStatic(req, res, pathname);
});

/* ---------------------------------------------------------------------------
   5. ПРИЁМ ОБНОВЛЕНИЙ ИЗ TELEGRAM (Mini App)
   ------------------------------------------------------------------------ */

var stopping = false;

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

function pollLoop() {
  var offset = 0;
  console.log("[poll] слушаю обновления бота — заказы из Mini App будут приходить сюда");
  (function tick() {
    if (stopping) return;
    tgCall("getUpdates", { offset: offset, timeout: 25, allowed_updates: ["message"] })
      .then(function (data) {
        if (data && data.ok && Array.isArray(data.result)) {
          data.result.forEach(function (update) {
            offset = update.update_id + 1;
            handleUpdate(update).catch(function () { /* одна ошибка не должна ронять цикл */ });
          });
        } else if (data && !data.ok) {
          console.error("[poll] Telegram ответил ошибкой: " + (data.description || "?") +
            (data.error_code === 409
              ? " → у бота уже установлен вебхук или запущен второй сервер: отключите одно из двух"
              : ""));
          return sleep(15000);
        }
      })
      .catch(function (error) {
        console.error("[poll] сеть недоступна: " + error.message);
        return sleep(5000);
      })
      .then(function () { setTimeout(tick, 300); });
  })();
}

/* ---------------------------------------------------------------------------
   6. SELFTEST — проверка логики без сети
   ------------------------------------------------------------------------ */

/* Достаёт литерал массива или объекта из исходника index.html,
   чтобы сравнить его с серверной копией прайса. */
function extractLiteral(source, marker) {
  var markerAt = source.indexOf(marker);
  if (markerAt === -1) throw new Error("в index.html не найден " + marker);
  var square = source.indexOf("[", markerAt);
  var curly = source.indexOf("{", markerAt);
  var start = square === -1 ? curly : curly === -1 ? square : Math.min(square, curly);
  if (start === -1) throw new Error("не найден литерал после " + marker);
  var depth = 0;
  for (var i = start; i < source.length; i++) {
    var ch = source.charAt(i);
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("не закрыт литерал после " + marker);
}

function selftest() {
  var failures = 0;
  function check(name, condition, extra) {
    if (condition) { console.log("  ok   " + name); }
    else { console.log("  FAIL " + name + (extra ? " → " + extra : "")); failures++; }
  }

  console.log("\n1. Прайс на сервере совпадает с прайсом в index.html");
  var html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  var frontFilms = new Function("return " + extractLiteral(html, "var FILMS ="))();
  var frontDesigns = new Function("return " + extractLiteral(html, "var DESIGNS ="))();
  var frontColors = new Function("return " + extractLiteral(html, "var COLORS ="))();
  var frontColorMult = new Function("return " + extractLiteral(html, "var COLOR_MULT ="))();
  var frontTiers = new Function("return " + extractLiteral(html, "var TIERS ="))();

  check("материалы и их ставки", frontFilms.every(function (f) {
    var mine = P.byId(P.FILMS, f.id);
    return mine && mine.rate === f.rate;
  }) && frontFilms.length === P.FILMS.length);

  check("дизайны: множитель и разработка", frontDesigns.every(function (d) {
    var mine = P.byId(P.DESIGNS, d.id);
    return mine && mine.mult === d.mult && mine.setup === d.setup;
  }) && frontDesigns.length === P.DESIGNS.length);

  check("цвета", frontColors.every(function (c) { return Boolean(P.byId(P.COLORS, c.id)); }) &&
    frontColors.length === P.COLORS.length);

  check("наценки на цвет", JSON.stringify(frontColorMult) === JSON.stringify(P.COLOR_MULT));
  check("скидки за тираж", JSON.stringify(frontTiers) === JSON.stringify(P.TIERS));
  check("минимальный заказ " + P.MIN_ORDER_PRICE + " ₽",
    new RegExp("MIN_ORDER_PRICE = " + P.MIN_ORDER_PRICE + ";").test(html));

  console.log("\n2. Расчёт цены");
  var tenByTen = P.calculate({ film: "matte", design: "own", color: "black", w: 10, h: 10, qty: 10 });
  check("10×10, матовая, 10 шт → 4 100 ₽", tenByTen.total === 4100, "получилось " + tenByTen.total);
  var big = P.calculate({ film: "metallic", design: "logo", color: "gold", w: 300, h: 200, qty: 1 });
  check("3×2 м, металлик, золото, макет под ключ → 605 250 ₽", big.total === 605250, "получилось " + big.total);
  var small = P.calculate({ film: "matte", design: "own", color: "black", w: 5, h: 5, qty: 1 });
  check("5×5, 1 шт → минимальные 300 ₽", small.total === 300, "получилось " + small.total);
  var bulk = P.calculate({ film: "matte", design: "own", color: "black", w: 100, h: 100, qty: 100 });
  check("1×1 м, 100 шт → скидка 40%", bulk.discountPercent === 40, "получилось " + bulk.discountPercent + "%");

  console.log("\n3. Проверка заявок");
  var good = P.validate({
    film: "matte", design: "own", color: "black", shape: "circle",
    w: 10, h: 10, qty: 10, name: "Иван", contact: "@ivan_2281", delivery: "Москва, СДЭК"
  });
  check("корректная заявка проходит", good.ok, good.error);
  check("форма сохраняется", good.ok && good.value.shapeName === "Круглая");
  check("телефон распознан как телефон",
    P.validate({ film: "matte", design: "own", color: "black", w: 10, h: 10, qty: 1, name: "Иван", contact: "+7 999 123-45-67" }).value.contactKind === "телефон");
  check("e-mail распознан как e-mail",
    P.validate({ film: "matte", design: "own", color: "black", w: 10, h: 10, qty: 1, name: "Иван", contact: "ivan@mail.ru" }).value.contactKind === "e-mail");
  check("заявка без имени отклонена",
    P.validate({ film: "matte", design: "own", color: "black", w: 10, h: 10, qty: 1, name: "И", contact: "@ivan_2281" }).ok === false);
  check("заявка без контакта отклонена",
    P.validate({ film: "matte", design: "own", color: "black", w: 10, h: 10, qty: 1, name: "Иван", contact: "" }).ok === false);
  check("несуществующий материал отклонён",
    P.validate({ film: "paper", design: "own", color: "black", w: 10, h: 10, qty: 1, name: "Иван", contact: "@ivan_2281" }).ok === false);
  check("размер 900 см отклонён",
    P.validate({ film: "matte", design: "own", color: "black", w: 900, h: 10, qty: 1, name: "Иван", contact: "@ivan_2281" }).ok === false);
  check("HTML в имени экранируется",
    P.escapeHtml("<b>злой</b>") === "&lt;b&gt;злой&lt;/b&gt;");

  console.log("\n4. Текст заявки для модератора");
  var message = P.orderMessage(good.value, P.calculate(good.value), {
    orderId: "261003-ABCD", time: "03.10.2026, 14:20 (МСК)", userId: 7114829971
  });
  check("есть номер заявки", message.indexOf("261003-ABCD") !== -1);
  check("есть имя и контакт", message.indexOf("Иван") !== -1 && message.indexOf("@ivan_2281") !== -1);
  check("есть итоговая цена", message.indexOf("4" ) !== -1 && message.indexOf("₽") !== -1);
  check("есть ссылка на клиента", message.indexOf("tg://user?id=7114829971") !== -1);
  check("текст влезает в лимит Telegram", message.length < 4096, message.length + " символов");
  check("тестовый режим помечен", P.orderMessage(good.value, P.calculate(good.value), { orderId: "x", time: "t", dryRun: true }).indexOf("тестовый режим") !== -1);

  console.log("\n" + (failures ? "ПРОВАЛЕНО ПРОВЕРОК: " + failures : "Все проверки пройдены ✅") + "\n");
  process.exit(failures ? 1 : 0);
}

/* ---------------------------------------------------------------------------
   7. ТОЧКА ВХОДА
   ------------------------------------------------------------------------ */

/* Запуск сервера: сначала проверяем бота и решаем, как принимаем обновления,
   потом слушаем порт. Так в логе сразу видно, дойдут ли заявки до менеджера. */
function startServer() {
  server.listen(CONFIG.port, CONFIG.host, function () {
    console.log("Наклейки: сервер запущен на http://" + CONFIG.host + ":" + CONFIG.port);
    console.log("Режим: " + (CONFIG.dryRun
      ? "ТЕСТОВЫЙ (заявки только в лог, Telegram не трогаем)"
      : "боевой — заявки уходят модератору " + CONFIG.moderatorId));
    if (CONFIG.dryRun && CONFIG.botToken && CONFIG.moderatorId) {
      console.log("Чтобы включить реальную отправку: DRY_RUN=0 в .env");
    }

    botDiagnostics().then(registerWebhook).then(resolveUpdatesMode).then(function (mode) {
      if (mode.mode === "poll") {
        console.log("Обновления: слушаю getUpdates (" + mode.reason + ") — заказы из Mini App придут сюда");
        pollLoop();
      } else if (mode.mode === "webhook") {
        console.log("Обновления: вебхук " + mode.url + " — следите, чтобы он смотрел на /api/tg-webhook");
      } else {
        console.log("Обновления: не принимаю (" + (mode.reason || "POLL=0") + ") — заказы, отправленные из Mini App через tg.sendData, потеряются");
      }
    });
  });

  server.on("error", function (error) {
    console.error("Не удалось запустить сервер: " + error.message);
    process.exit(1);
  });

  function shutdown() {
    stopping = true;
    console.log("\nОстанавливаюсь…");
    server.close(function () { process.exit(0); });
    setTimeout(function () { process.exit(0); }, 1500).unref();
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function main() {
  var args = process.argv.slice(2);

  if (args.indexOf("--selftest") !== -1) {
    selftest();
  } else if (args.indexOf("--send-test") !== -1) {
    if (CONFIG.dryRun) {
      console.log("Токен или MODERATOR_ID не заданы (или DRY_RUN=1) — отправлять нечего.");
      process.exit(1);
    }
    botDiagnostics().then(function () {
      return sendToModerator("🔔 <b>Проверка связи</b>\nСервер наклеек на месте, заявки будут приходить сюда.");
    }).then(function (result) {
      console.log(result.ok ? "Тестовое сообщение отправлено ✅" : "Не отправлено: " + result.error);
      process.exit(result.ok ? 0 : 1);
    });
  } else if (args.indexOf("--webhook") !== -1) {
    var target = args[args.indexOf("--webhook") + 1];
    if (!target) { console.log("Укажите адрес: node server.js --webhook https://example.com/api/tg-webhook"); process.exit(1); }
    tgCall("setWebhook", {
      url: target,
      secret_token: CONFIG.webhookSecret || undefined,
      allowed_updates: ["message"],
      drop_pending_updates: true
    }).then(function (data) {
      console.log(data && data.ok ? "Вебхук установлен ✅" : "Ошибка: " + ((data && data.description) || "?"));
      process.exit(data && data.ok ? 0 : 1);
    });
  } else if (args.indexOf("--unwebhook") !== -1) {
    tgCall("deleteWebhook", { drop_pending_updates: true }).then(function (data) {
      console.log(data && data.ok ? "Вебхук удалён ✅" : "Ошибка: " + ((data && data.description) || "?"));
      process.exit(data && data.ok ? 0 : 1);
    });
  } else {
    if (args.indexOf("--poll") !== -1) CONFIG.poll = "1";
    startServer();
  }
}

/* Экспорт нужен тестам (tests/e2e.js): они подменяют Telegram заглушкой
   и проверяют, что заявка действительно уходит модератору. */
module.exports = {
  CONFIG: CONFIG,
  updates: function () { return updates; },
  server: server,
  startServer: startServer,
  pollLoop: pollLoop,
  acceptOrder: acceptOrder,
  handleUpdate: handleUpdate,
  verifyInitData: verifyInitData,
  sendToModerator: sendToModerator,
  telegramHint: telegramHint,
  tgCall: tgCall,
  newOrderId: newOrderId,
  money: P.money
};

if (require.main === module) main();
