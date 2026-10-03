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
     LOG_ORDERS      — 1 (по умолчанию): дублировать заявки в orders.jsonl
   ========================================================================= */

var http = require("http");
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var P = require("./pricing.js");

var ROOT = __dirname;

/* ---------------------------------------------------------------------------
   1. КОНФИГ
   ------------------------------------------------------------------------ */

function loadEnvFile(file) {
  var out = {};
  var text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { return out; }
  text.split(/\r?\n/).forEach(function (line) {
    var trimmed = line.trim();
    if (!trimmed || trimmed.charAt(0) === "#") return;
    var eq = trimmed.indexOf("=");
    if (eq < 1) return;
    var key = trimmed.slice(0, eq).trim();
    var value = trimmed.slice(eq + 1).trim();
    if ((value.charAt(0) === '"' && value.slice(-1) === '"') ||
        (value.charAt(0) === "'" && value.slice(-1) === "'")) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  });
  return out;
}

var fileEnv = loadEnvFile(path.join(ROOT, ".env"));
function env(name, fallback) {
  var value = process.env[name];
  if (value === undefined || value === "") value = fileEnv[name];
  return value === undefined || value === "" ? fallback : value;
}

var CONFIG = {
  botToken: env("BOT_TOKEN", ""),
  moderatorId: env("MODERATOR_ID", ""),
  port: parseInt(env("PORT", "8080"), 10),
  host: env("HOST", "0.0.0.0"),
  dryRun: env("DRY_RUN", "0") === "1",
  poll: env("POLL", "0") === "1",
  webhookSecret: env("WEBHOOK_SECRET", ""),
  allowOrigin: env("ALLOW_ORIGIN", ""),
  logOrders: env("LOG_ORDERS", "1") === "1",
  publicUrl: env("PUBLIC_URL", "")
};

/* Нет токена — отправлять некуда, автоматически уходим в тестовый режим,
   чтобы сайт можно было спокойно смотреть локально. */
if (!CONFIG.botToken || !CONFIG.moderatorId) CONFIG.dryRun = true;

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
      console.error("[telegram] не отправлено: " + reason);
      return { ok: false, error: reason };
    }
    return { ok: true };
  }).catch(function (error) {
    console.error("[telegram] сеть недоступна: " + error.message);
    return { ok: false, error: "Сеть недоступна: " + error.message };
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

/* Файлы, которые нельзя отдавать наружу. */
var DENY_FILES = ["server.js", "orders.jsonl", "pricing.js", "package.json", "package-lock.json"];

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
  res.setHeader("Access-Control-Allow-Origin", CONFIG.allowOrigin);
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

  /* Заказ из Mini App (сайт отправил tg.sendData). */
  if (message.web_app_data && message.web_app_data.data) {
    var payload;
    try { payload = JSON.parse(message.web_app_data.data); } catch (e) { payload = null; }
    if (payload) {
      var userId = message.from && message.from.id;
      return acceptOrder(payload, { source: "mini-app", userId: userId }).then(function (result) {
        if (!result.ok) console.error("[mini-app] заявка отклонена: " + result.error);
        else console.log("[mini-app] заявка " + result.order_id + " отправлена модератору");
      });
    }
  }

  var text = String(message.text || "");
  var chatId = message.chat && message.chat.id;
  if (!chatId) return Promise.resolve();

  if (text.indexOf("/start") === 0) {
    var hello = "Привет! Здесь принимаются заказы на наклейки.\n\n" +
      "Соберите наклейку в конструкторе" + (CONFIG.publicUrl ? ": " + CONFIG.publicUrl : " на сайте") +
      " — заявка придёт менеджеру, он напишет вам в Telegram.";
    return tgCall("sendMessage", { chat_id: chatId, text: hello, disable_web_page_preview: true })
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
      poll: CONFIG.poll
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
          console.error("[poll] Telegram ответил ошибкой: " + (data.description || "?"));
          return sleep(5000);
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

var args = process.argv.slice(2);

if (args.indexOf("--selftest") !== -1) {
  selftest();
} else if (args.indexOf("--send-test") !== -1) {
  if (CONFIG.dryRun) {
    console.log("Токен или MODERATOR_ID не заданы (или DRY_RUN=1) — отправлять нечего.");
    process.exit(1);
  }
  sendToModerator("🔔 <b>Проверка связи</b>\nСервер наклеек на месте, заявки будут приходить сюда.").then(function (result) {
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
  if (args.indexOf("--poll") !== -1) CONFIG.poll = true;

  server.listen(CONFIG.port, CONFIG.host, function () {
    console.log("Наклейки: сервер запущен на http://" + CONFIG.host + ":" + CONFIG.port);
    console.log("Режим: " + (CONFIG.dryRun ? "ТЕСТОВЫЙ (заявки только в лог, Telegram не трогаем)" : "боевой — заявки уходят модератору " + CONFIG.moderatorId));
    if (CONFIG.dryRun && CONFIG.botToken && CONFIG.moderatorId) {
      console.log("Чтобы включить реальную отправку: DRY_RUN=0 в .env");
    }
    if (!CONFIG.botToken) console.log("BOT_TOKEN не задан — заполните .env (см. .env.example)");
    if (CONFIG.poll) pollLoop();
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
