#!/usr/bin/env node
"use strict";
/* ============================================================================
   Проверка прямой отправки заявки (tgdirect.js) — «заявка с сайта дойдёт до
   менеджера без сервера?»

   Запуск:  node tests/direct.js   (или npm run test:direct)

   Telegram подменяется заглушкой: интернет не нужен, токен не нужен.
   Проверяем:
     • прайс сайта совпадает с pricing.js (раньше это делал server.js --selftest);
     • расчёт цены, проверку полей и текст заявки для менеджера;
     • что браузер зовёт api.telegram.org/bot<ТОКЕН>/sendMessage с нужным chat_id;
     • что при отказе Telegram заявка НЕ выглядит отправленной;
     • что сайт подключает tgdirect.js и больше никуда не ходит за сервером.
   ========================================================================= */

var assert = require("assert");
var fs = require("fs");
var path = require("path");

var ROOT = path.join(__dirname, "..");

var P = require(path.join(ROOT, "pricing.js"));
var Direct = require(path.join(ROOT, "tgdirect.js"));

var failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok   " + name); }
  catch (error) { failures++; console.log("  FAIL " + name + " → " + error.message); }
}

var TOKEN = "1234567890:AAF-TEST-TOKEN-VALUE-0000000000000";
var MODERATOR = "7114829971";

var ORDER = {
  film: "matte", design: "own", color: "black", shape: "circle",
  w: 10, h: 10, qty: 10, name: "Пётр", contact: "@petr_777",
  delivery: "Рига, СДЭК", comment: "нужно к пятнице", client_total: 4100
};

/* --- заглушка Telegram --------------------------------------------------- */

function makeFetch(options) {
  var opts = options || {};
  var log = [];
  function reply(payload) {
    return Promise.resolve({
      ok: payload.ok, status: payload.ok ? 200 : (payload.error_code || 400),
      json: function () { return Promise.resolve(payload); }
    });
  }
  function fetchStub(url, init) {
    var method = String(url).replace(/^.*\//, "");
    log.push({ url: String(url), method: method, body: JSON.parse((init && init.body) || "{}") });
    if (opts.offline) return Promise.reject(new TypeError("Failed to fetch"));
    if (opts.badToken) return reply({ ok: false, error_code: 401, description: "Unauthorized" });
    if (opts.blocked) return reply({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" });
    if (method === "getMe") return reply({ ok: true, result: { id: 42, username: "my_stickers_bot" } });
    if (/^getUpdates/.test(method)) return reply({ ok: true, result: opts.updates || [] });
    if (method === "sendMessage") return reply({ ok: true, result: { message_id: log.length } });
    return reply({ ok: true, result: {} });
  }
  fetchStub.log = log;
  return fetchStub;
}

function sendWith(fetchStub, order, options) {
  Direct.configure({ token: TOKEN, chatId: MODERATOR, fetch: fetchStub, timeoutMs: 2000 });
  return Direct.send(order || ORDER, options || {});
}

function sent(fetchStub) {
  return fetchStub.log.filter(function (c) { return c.method === "sendMessage"; });
}

var chain = Promise.resolve();

/* --------------------------------------------------------------------------
   1. Прайс сайта и pricing.js — одна таблица
   ----------------------------------------------------------------------- */

/* Достаёт литерал массива или объекта из index.html, чтобы сравнить его
   с таблицей pricing.js (которой считается заявка менеджеру). */
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

var html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

console.log("\n1. Прайс сайта совпадает с pricing.js");

check("материалы и их ставки", function () {
  var films = new Function("return " + extractLiteral(html, "var FILMS ="))();
  assert.strictEqual(films.length, P.FILMS.length, "разное число материалов");
  films.forEach(function (f) {
    var mine = P.byId(P.FILMS, f.id);
    assert.ok(mine, "в pricing.js нет материала " + f.id);
    assert.strictEqual(mine.rate, f.rate, "ставка " + f.id + " разошлась");
  });
});

check("дизайны: множитель и разработка", function () {
  var designs = new Function("return " + extractLiteral(html, "var DESIGNS ="))();
  assert.strictEqual(designs.length, P.DESIGNS.length, "разное число дизайнов");
  designs.forEach(function (d) {
    var mine = P.byId(P.DESIGNS, d.id);
    assert.ok(mine, "в pricing.js нет дизайна " + d.id);
    assert.strictEqual(mine.mult, d.mult, "множитель " + d.id + " разошёлся");
    assert.strictEqual(mine.setup, d.setup, "стоимость макета " + d.id + " разошлась");
  });
});

check("цвета, наценки и скидки за тираж", function () {
  var colors = new Function("return " + extractLiteral(html, "var COLORS ="))();
  assert.strictEqual(colors.length, P.COLORS.length, "разное число цветов");
  colors.forEach(function (c) { assert.ok(P.byId(P.COLORS, c.id), "в pricing.js нет цвета " + c.id); });
  var colorMult = new Function("return " + extractLiteral(html, "var COLOR_MULT ="))();
  assert.strictEqual(JSON.stringify(colorMult), JSON.stringify(P.COLOR_MULT), "наценки на цвет разошлись");
  var tiers = new Function("return " + extractLiteral(html, "var TIERS ="))();
  assert.strictEqual(JSON.stringify(tiers), JSON.stringify(P.TIERS), "скидки за тираж разошлись");
  assert.ok(new RegExp("MIN_ORDER_PRICE = " + P.MIN_ORDER_PRICE + ";").test(html), "минимальный заказ разошёлся");
});

/* --------------------------------------------------------------------------
   2. Расчёт и проверка полей
   ----------------------------------------------------------------------- */

console.log("\n2. Расчёт цены и проверка заявки");

check("10×10, матовая, 10 шт → 4 100 ₽", function () {
  assert.strictEqual(P.calculate({ film: "matte", design: "own", color: "black", w: 10, h: 10, qty: 10 }).total, 4100);
});
check("5×5, 1 шт → минимальные 300 ₽", function () {
  assert.strictEqual(P.calculate({ film: "matte", design: "own", color: "black", w: 5, h: 5, qty: 1 }).total, 300);
});
check("заявка без имени и контакта не отправляется", function () {
  assert.strictEqual(P.validate({ film: "matte", design: "own", color: "black", w: 10, h: 10, qty: 1, name: "И", contact: "@petr_777" }).ok, false);
  assert.strictEqual(P.validate({ film: "matte", design: "own", color: "black", w: 10, h: 10, qty: 1, name: "Пётр", contact: "" }).ok, false);
});

/* --------------------------------------------------------------------------
   3. Отправка: браузер → api.telegram.org
   ----------------------------------------------------------------------- */

chain = chain.then(function () {
  console.log("\n3. Заявка уходит прямо в Telegram");
  var fetchStub = makeFetch();
  return sendWith(fetchStub).then(function (reply) {
    check("заявка принята и получила номер", function () {
      assert.ok(reply.ok, "не отправлено: " + reply.error);
      assert.ok(/^\d{6}-[0-9A-F]{4}\d{2}$/.test(reply.order_id), "странный номер: " + reply.order_id);
      assert.strictEqual(reply.total, 4100);
    });
    check("запрос ушёл на api.telegram.org с токеном", function () {
      var calls = sent(fetchStub);
      assert.strictEqual(calls.length, 1, "вызовов sendMessage: " + calls.length);
      assert.strictEqual(calls[0].url, "https://api.telegram.org/bot" + TOKEN + "/sendMessage");
    });
    check("получатель — chat_id менеджера, разметка HTML", function () {
      var body = sent(fetchStub)[0].body;
      assert.strictEqual(String(body.chat_id), MODERATOR);
      assert.strictEqual(body.parse_mode, "HTML");
    });
    check("в сообщении есть всё, что нужно менеджеру", function () {
      var text = sent(fetchStub)[0].body.text;
      ["Пётр", "@petr_777", "Рига, СДЭК", "нужно к пятнице", "Матовая", "Круглая", "10 шт"]
        .forEach(function (part) { assert.ok(text.indexOf(part) !== -1, "в заявке нет: " + part); });
      assert.ok(text.indexOf(reply.order_id) !== -1, "в заявке нет номера");
      assert.ok(text.indexOf("4") !== -1 && text.indexOf("₽") !== -1, "в заявке нет суммы");
      assert.ok(text.length < 4096, "текст длиннее лимита Telegram: " + text.length);
    });
  });
});

chain = chain.then(function () {
  var fetchStub = makeFetch();
  return sendWith(fetchStub, ORDER, { userId: 555000111 }).then(function () {
    check("из Mini App в заявке есть ссылка на клиента", function () {
      assert.ok(sent(fetchStub)[0].body.text.indexOf("tg://user?id=555000111") !== -1);
    });
  });
});

chain = chain.then(function () {
  var fetchStub = makeFetch();
  Direct.configure({ token: TOKEN, chatId: MODERATOR + ", 123456789", fetch: fetchStub });
  return Direct.send(ORDER).then(function (reply) {
    check("получателей может быть несколько", function () {
      assert.ok(reply.ok);
      var ids = sent(fetchStub).map(function (c) { return String(c.body.chat_id); });
      assert.deepStrictEqual(ids, [MODERATOR, "123456789"]);
    });
  });
});

check("HTML в имени клиента экранируется", function () {
  var order = Object.assign({}, ORDER, { name: "<b>злой</b>" });
  var checked = P.validate(order);
  var text = Direct.buildMessage(checked.value, P.calculate(checked.value), { orderId: "x", time: "t" });
  assert.ok(text.indexOf("&lt;b&gt;злой&lt;/b&gt;") !== -1, "имя не экранировано");
});

chain = chain.then(function () {
  var fetchStub = makeFetch({ updates: [
    { update_id: 1, message: { chat: { id: 7114829971, first_name: "Пётр", username: "petr_777" }, text: "/start" } },
    { update_id: 2, message: { chat: { id: 7114829971, first_name: "Пётр", username: "petr_777" }, text: "ещё раз" } }
  ] });
  Direct.configure({ token: TOKEN, chatId: "", fetch: fetchStub });
  return Direct.chats().then(function (reply) {
    check("chats() подсказывает chat_id при настройке", function () {
      assert.ok(reply.ok, reply.error);
      assert.deepStrictEqual(reply.chats, [{ id: 7114829971, name: "Пётр", username: "petr_777" }]);
    });
  });
});

check("номера заявок не повторяются", function () {
  var seen = {};
  for (var i = 0; i < 50; i++) {
    var id = Direct.newOrderId(new Date());
    assert.ok(!seen[id], "номер повторился: " + id);
    seen[id] = true;
  }
});

/* --------------------------------------------------------------------------
   4. Отказы: заявка не должна выглядеть отправленной
   ----------------------------------------------------------------------- */

chain = chain.then(function () {
  console.log("\n4. Когда заявка не уходит — это видно");
  var fetchStub = makeFetch({ badToken: true });
  return sendWith(fetchStub).then(function (reply) {
    check("неверный токен: отказ и подсказка про @BotFather", function () {
      assert.strictEqual(reply.ok, false);
      assert.strictEqual(reply.kind, "telegram");
      assert.ok(/BotFather/.test(reply.hint), "нет подсказки: " + reply.hint);
    });
  });
});

chain = chain.then(function () {
  var fetchStub = makeFetch({ blocked: true });
  return sendWith(fetchStub).then(function (reply) {
    check("менеджер не нажал Start: понятная причина", function () {
      assert.strictEqual(reply.ok, false);
      assert.ok(/Start/.test(reply.hint), "нет подсказки: " + reply.hint);
    });
  });
});

chain = chain.then(function () {
  var fetchStub = makeFetch({ offline: true });
  return sendWith(fetchStub).then(function (reply) {
    check("нет связи: ошибка сети, а не «отправлено»", function () {
      assert.strictEqual(reply.ok, false);
      assert.strictEqual(reply.kind, "network");
      assert.ok(/api\.telegram\.org/.test(reply.hint), "нет подсказки: " + reply.hint);
    });
  });
});

chain = chain.then(function () {
  Direct.configure({ token: "", chatId: "", fetch: makeFetch() });
  check("без токена отправка не притворяется рабочей", function () {
    assert.strictEqual(Direct.isReady(), false);
  });
  return Direct.send(ORDER).then(function (reply) {
    check("незаполненный tgdirect.js объясняет сам себя", function () {
      assert.strictEqual(reply.ok, false);
      assert.strictEqual(reply.kind, "config");
      assert.ok(/tgdirect\.js/.test(reply.hint), "нет подсказки: " + reply.hint);
    });
  });
});

chain = chain.then(function () {
  var fetchStub = makeFetch();
  return sendWith(fetchStub, Object.assign({}, ORDER, { name: "И" })).then(function (reply) {
    check("кривое поле ловится до обращения к Telegram", function () {
      assert.strictEqual(reply.ok, false);
      assert.strictEqual(reply.kind, "field");
      assert.strictEqual(sent(fetchStub).length, 0, "зря сходили в Telegram");
    });
  });
});

/* --------------------------------------------------------------------------
   5. Сайт подключён правильно и сервера больше не ждёт
   ----------------------------------------------------------------------- */

chain = chain.then(function () {
  console.log("\n5. Сайт настроен на прямую отправку");

  check("index.html подключает pricing.js и tgdirect.js в нужном порядке", function () {
    var pricingAt = html.indexOf('src="pricing.js"');
    var directAt = html.indexOf('src="tgdirect.js"');
    assert.ok(pricingAt !== -1, "нет pricing.js");
    assert.ok(directAt !== -1, "нет tgdirect.js");
    assert.ok(pricingAt < directAt, "pricing.js должен идти перед tgdirect.js");
  });

  check("сайт зовёт TgDirect.send, а не сервер", function () {
    assert.ok(html.indexOf("TgDirect.send(") !== -1, "сайт не вызывает прямую отправку");
    assert.strictEqual(html.indexOf("/api/order"), -1, "в сайте остался запрос к серверу");
    assert.strictEqual(html.indexOf('name="api-base"'), -1, "в сайте остался адрес сервера");
  });

  check("запасной путь на месте: чат с менеджером и копия текста", function () {
    assert.ok(html.indexOf('id="order-fallback-send"') !== -1, "нет кнопки «написать менеджеру»");
    assert.ok(html.indexOf('id="order-fallback-copy"') !== -1, "нет кнопки «скопировать текст»");
    assert.ok(html.indexOf("showTelegramFallback(") !== -1, "запасной путь не показывается");
  });

  check("серверных файлов в репозитории больше нет", function () {
    ["server.js", "bot.js", "env.js", "render.yaml", "Dockerfile", ".env.example"].forEach(function (name) {
      assert.ok(!fs.existsSync(path.join(ROOT, name)), "остался файл " + name);
    });
  });

  check("в tgdirect.js есть место для токена и предупреждение", function () {
    var direct = fs.readFileSync(path.join(ROOT, "tgdirect.js"), "utf8");
    assert.ok(/var BOT_TOKEN = /.test(direct), "нет строки BOT_TOKEN");
    assert.ok(/var CHAT_ID = /.test(direct), "нет строки CHAT_ID");
    assert.ok(direct.indexOf("ВИДЕН ВСЕМ") !== -1, "нет предупреждения о публичном токене");
  });
});

chain.then(function () {
  console.log("\n" + (failures ? "ПРОВАЛЕНО ПРОВЕРОК: " + failures : "Все проверки пройдены ✅") + "\n");
  process.exit(failures ? 1 : 0);
}).catch(function (error) {
  console.error("\nТест упал: " + (error && error.stack || error));
  process.exit(1);
});
