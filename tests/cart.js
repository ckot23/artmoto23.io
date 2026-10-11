#!/usr/bin/env node
"use strict";
/* ============================================================================
   Проверки корзины и отправки заявки в Telegram + Google-таблицу.

   Проверяем:
     • цена позиций и минимум 500 ₽ на всю корзину (а не на каждую наклейку);
     • сама корзина: добавить, объединить одинаковые, тираж, удалить, хранение;
     • заявка из нескольких наклеек: одно сообщение в Telegram и строки в таблицу;
     • что отказ одного канала не теряет заявку, а отказ обоих — виден;
     • что скрипт Google Apps Script лежит в репозитории и отвечает на нужные поля.

   Telegram и таблица подменяются заглушкой: интернет и токены не нужны.
   ========================================================================= */

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");

var ROOT = path.join(__dirname, "..");
var P = require(path.join(ROOT, "pricing.js"));
var Cart = require(path.join(ROOT, "cart.js"));
var Direct = require(path.join(ROOT, "tgdirect.js"));

var failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok   " + name); }
  catch (error) { failures++; console.log("  FAIL " + name + " → " + error.message); }
}
var chain = Promise.resolve();
function checkAsync(name, fn) {
  chain = chain.then(function () {
    return Promise.resolve().then(fn).then(function () { console.log("  ok   " + name); },
      function (error) { failures++; console.log("  FAIL " + name + " → " + error.message); });
  });
}

var TOKEN = "1234567890:AAF-TEST-TOKEN-VALUE-0000000000000";
var MODERATOR = "7114829971";
var SHEET = "https://script.google.com/macros/s/TEST/exec";

var SMALL = { film: "matte", design: "own", color: "black", shape: "circle", w: 10, h: 10, qty: 1 };           /* 300 ₽ */
var BIG = { film: "gloss", design: "own", color: "red", shape: "rectangle", w: 30, h: 20, qty: 3, sketch: "Лиса" }; /* 7 200 ₽ */

function customer(extra) {
  return Object.assign({ name: "Пётр", contact: "@petr_777", delivery: "Рига, СДЭК", comment: "к пятнице" }, extra || {});
}

/* --- заглушка Telegram + Google Apps Script --------------------------------- */

function makeFetch(options) {
  var opts = options || {};
  var log = [];
  function reply(payload) {
    return Promise.resolve({
      ok: payload.ok, status: payload.ok ? 200 : (payload.error_code || 400),
      json: function () { return Promise.resolve(payload); }
    });
  }
  function stub(url, init) {
    var u = String(url);
    var body = JSON.parse((init && init.body) || "{}");
    if (u.indexOf("script.google.com") !== -1) {
      log.push({ kind: "sheet", url: u, init: init, body: body });
      if (opts.sheetOffline) return Promise.reject(new TypeError("Failed to fetch"));
      if (opts.sheetCorsOnly && !(init && init.mode === "no-cors")) return Promise.reject(new TypeError("Failed to fetch"));
      if (opts.sheetNoCors && init && init.mode === "no-cors") return Promise.resolve({ type: "opaque" });
      if (opts.sheetError) return reply({ ok: false, error: "лист занят" });
      if (opts.sheetHtml) return Promise.resolve({ ok: true, json: function () { return Promise.reject(new Error("not json")); } });
      return reply({ ok: true, rows: body.rows && body.rows.length });
    }
    var method = u.replace(/^.*\//, "");
    log.push({ kind: "tg", url: u, method: method, body: body });
    if (opts.tgOffline) return Promise.reject(new TypeError("Failed to fetch"));
    if (opts.tgBadToken) return reply({ ok: false, error_code: 401, description: "Unauthorized" });
    return reply({ ok: true, result: { message_id: log.length } });
  }
  stub.log = log;
  stub.tg = function () { return log.filter(function (c) { return c.kind === "tg"; }); };
  stub.sheet = function () { return log.filter(function (c) { return c.kind === "sheet"; }); };
  return stub;
}

function configure(fetchStub, extra) {
  Direct.configure(Object.assign({ token: TOKEN, chatId: MODERATOR, sheetUrl: SHEET, fetch: fetchStub, timeoutMs: 2000 }, extra || {}));
}

/* --------------------------------------------------------------------------
   1. Цена корзины
   ----------------------------------------------------------------------- */
console.log("\n1. Цена корзины");

check("каждая позиция считается по своему размеру и тиражу", function () {
  var cart = P.quoteCart([P.validateItem(SMALL).value, P.validateItem(BIG).value]);
  assert.strictEqual(cart.lines[0].total, 300);
  assert.strictEqual(cart.lines[1].total, 7200);
  assert.strictEqual(cart.count, 2);
  assert.strictEqual(cart.pieces, 4);
});

check("минимум 500 ₽ действует на всю корзину, а не на каждую позицию", function () {
  var cart = P.quoteCart([
    P.validateItem(SMALL).value,
    P.validateItem(Object.assign({}, SMALL, { w: 5, h: 5, color: "white" })).value
  ]);
  /* 300 ₽ + 75 ₽ = 375 ₽ → доплата до 500 ₽, а не 2 × 500 ₽ */
  assert.strictEqual(cart.subtotal, 375);
  assert.strictEqual(cart.total, 500);
  assert.strictEqual(cart.minApplied, true);
  assert.strictEqual(cart.toMin, 125);
});

check("две наклейки по 300 ₽ — это 600 ₽ без минимума", function () {
  var cart = P.quoteCart([P.validateItem(SMALL).value, P.validateItem(Object.assign({}, SMALL, { color: "white" })).value]);
  assert.strictEqual(cart.total, 600);
  assert.strictEqual(cart.minApplied, false);
});

check("скидка за тираж считается внутри позиции", function () {
  var line = P.quoteCart([P.validateItem(Object.assign({}, SMALL, { qty: 10 })).value]).lines[0];
  assert.strictEqual(line.discountPercent, 18);
  assert.strictEqual(line.total, 2460);
  assert.strictEqual(line.total, P.calculate(Object.assign({}, SMALL, { qty: 10 })).total, "корзина и одиночный расчёт разошлись");
});

check("пустая корзина стоит 0, а не минимальные 500 ₽", function () {
  assert.strictEqual(P.quoteCart([]).total, 0);
});

check("калькулятор отдаёт цену позиции без минимума", function () {
  var est = P.calculateEstimate({ film: "matte", w: 10, h: 10, qty: 1 });
  assert.strictEqual(est.lineTotal, 300);
  assert.strictEqual(est.total, 500, "прежнее поле total не должно меняться");
});

check("validateCart ловит пустую корзину, плохую позицию и плохие контакты", function () {
  assert.ok(/пуста/.test(P.validateCart(Object.assign(customer(), { items: [] })).error));
  var bad = P.validateCart(Object.assign(customer(), { items: [SMALL, Object.assign({}, SMALL, { w: 999 })] }));
  assert.ok(!bad.ok && /Позиция 2/.test(bad.error) && /Ширина/.test(bad.error), bad.error);
  assert.ok(!P.validateCart(Object.assign(customer({ name: "П" }), { items: [SMALL] })).ok);
  assert.ok(!P.validateCart(Object.assign(customer({ contact: "?" }), { items: [SMALL] })).ok);
  var many = [];
  for (var i = 0; i < P.CART_MAX_ITEMS + 1; i++) many.push(SMALL);
  assert.ok(!P.validateCart(Object.assign(customer(), { items: many })).ok, "лимит позиций не работает");
});

check("прежняя validate() для одной наклейки работает как раньше", function () {
  var ok = P.validate(Object.assign({}, SMALL, customer(), { client_total: 500 }));
  assert.ok(ok.ok, ok.error);
  assert.strictEqual(ok.value.clientTotal, 500);
  assert.strictEqual(P.validate(Object.assign({}, SMALL, { name: "П", contact: "@petr_777" })).ok, false);
});

/* --------------------------------------------------------------------------
   2. Корзина
   ----------------------------------------------------------------------- */
console.log("\n2. Корзина");

function memoryStorage() {
  var data = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem: function (k, v) { data[k] = String(v); },
    removeItem: function (k) { delete data[k]; },
    raw: data
  };
}

check("можно положить разные наклейки в одну корзину", function () {
  var cart = Cart.create({ storage: null });
  assert.ok(cart.add(SMALL).ok);
  assert.ok(cart.add(BIG).ok);
  assert.strictEqual(cart.count(), 2);
  var sum = cart.summary();
  assert.strictEqual(sum.total, 7500);
  assert.deepStrictEqual(sum.lines.map(function (l) { return l.item.w + "x" + l.item.h; }), ["10x10", "30x20"]);
});

check("такая же наклейка не плодит строку, а увеличивает тираж", function () {
  var cart = Cart.create({ storage: null });
  cart.add(SMALL);
  var again = cart.add(Object.assign({}, SMALL, { qty: 4 }));
  assert.ok(again.ok && again.merged);
  assert.strictEqual(cart.count(), 1);
  assert.strictEqual(cart.list()[0].qty, 5);
  assert.strictEqual(cart.summary().lines[0].discountPercent, 10, "скидка за 5 шт не применилась");
});

check("наклейки с разным размером или цветом — разные позиции", function () {
  var cart = Cart.create({ storage: null });
  cart.add(SMALL);
  cart.add(Object.assign({}, SMALL, { w: 11 }));
  cart.add(Object.assign({}, SMALL, { color: "white" }));
  cart.add(Object.assign({}, SMALL, { sketch: "Лиса" }));
  assert.strictEqual(cart.count(), 4);
});

check("неверная наклейка в корзину не попадает", function () {
  var cart = Cart.create({ storage: null });
  assert.strictEqual(cart.add(Object.assign({}, SMALL, { w: 0 })).ok, false);
  assert.strictEqual(cart.add(Object.assign({}, SMALL, { film: "paper" })).ok, false);
  assert.strictEqual(cart.count(), 0);
});

check("тираж меняется и удаляется, цены пересчитываются", function () {
  var cart = Cart.create({ storage: null });
  var id = cart.add(SMALL).item.id;
  assert.ok(cart.setQty(id, 10));
  assert.strictEqual(cart.summary().lines[0].total, 2460);
  assert.strictEqual(cart.setQty(id, 0), false);
  assert.strictEqual(cart.setQty(id, 10001), false);
  assert.strictEqual(cart.setQty("нет-такого", 3), false);
  assert.ok(cart.remove(id));
  assert.strictEqual(cart.count(), 0);
  assert.strictEqual(cart.remove(id), false);
});

check("лимит позиций в корзине", function () {
  var cart = Cart.create({ storage: null });
  for (var i = 0; i < P.CART_MAX_ITEMS; i++) assert.ok(cart.add(Object.assign({}, SMALL, { w: 10 + i })).ok);
  var over = cart.add(Object.assign({}, SMALL, { w: 99 }));
  assert.strictEqual(over.ok, false);
  assert.ok(/не больше/.test(over.error));
});

check("корзина переживает перезагрузку страницы", function () {
  var storage = memoryStorage();
  var first = Cart.create({ storage: storage });
  first.add(SMALL);
  first.add(BIG);
  var second = Cart.create({ storage: storage });
  assert.strictEqual(second.count(), 2);
  assert.strictEqual(second.summary().total, first.summary().total);
});

check("испорченное хранилище не ломает корзину", function () {
  var storage = memoryStorage();
  storage.setItem(Cart.STORAGE_KEY, "{не json");
  assert.strictEqual(Cart.create({ storage: storage }).count(), 0);
  storage.setItem(Cart.STORAGE_KEY, JSON.stringify([{ film: "paper" }, null, 5, Object.assign({ id: "a" }, SMALL)]));
  var cart = Cart.create({ storage: storage });
  assert.strictEqual(cart.count(), 1, "битые позиции должны отбрасываться");
});

check("подписчик узнаёт об изменениях, а его ошибка не ломает корзину", function () {
  var cart = Cart.create({ storage: null });
  var calls = 0;
  cart.subscribe(function () { calls++; throw new Error("сломанный подписчик"); });
  cart.add(SMALL);
  cart.clear();
  assert.strictEqual(calls, 2);
  assert.strictEqual(cart.count(), 0);
});

/* --------------------------------------------------------------------------
   3. Отправка: Telegram + Google-таблица
   ----------------------------------------------------------------------- */
console.log("\n3. Отправка заявки из корзины");

function cartOrder(extra) {
  return Object.assign({ items: [SMALL, BIG] }, customer(), { client_total: 7500 }, extra || {});
}

checkAsync("одна заявка → одно сообщение в Telegram и строки в таблицу", function () {
  var f = makeFetch();
  configure(f);
  return Direct.send(cartOrder(), { orderId: "261011-TEST01" }).then(function (reply) {
    assert.ok(reply.ok, reply.error);
    assert.strictEqual(reply.order_id, "261011-TEST01");
    assert.strictEqual(reply.total, 7500);
    assert.strictEqual(reply.count, 2);
    assert.strictEqual(reply.telegram, "sent");
    assert.strictEqual(reply.sheet, "sent");
    assert.strictEqual(f.tg().length, 1, "сообщений в Telegram: " + f.tg().length);
    assert.strictEqual(f.sheet().length, 1, "запросов в таблицу: " + f.sheet().length);
  });
});

checkAsync("в Telegram есть все позиции, контакты и итог", function () {
  var f = makeFetch();
  configure(f);
  return Direct.send(cartOrder(), { orderId: "261011-TEST01" }).then(function () {
    var body = f.tg()[0].body;
    assert.strictEqual(String(body.chat_id), MODERATOR);
    assert.strictEqual(body.parse_mode, "HTML");
    var text = body.text;
    ["261011-TEST01", "2 позиции", "Пётр", "@petr_777", "Рига, СДЭК", "к пятнице",
      "Матовая", "Круглая", "10 × 10 см × 1 шт", "Глянцевая", "Красный", "30 × 20 см × 3 шт", "Эскиз: Лиса"]
      .forEach(function (part) { assert.ok(text.indexOf(part) !== -1, "в заявке нет: " + part); });
    assert.ok(/Итого: 7\u00A0500 ₽/.test(text), "нет общего итога");
    assert.ok(text.indexOf("⚠️") === -1, "сумма клиента совпала, предупреждения быть не должно");
  });
});

checkAsync("в Telegram видно, что минимальный заказ применён ко всей корзине", function () {
  var f = makeFetch();
  configure(f);
  return Direct.send(cartOrder({ items: [SMALL], client_total: 500 })).then(function () {
    var text = f.tg()[0].body.text;
    assert.ok(/принято по минимуму/.test(text), "нет пометки о минимуме");
    assert.ok(/Итого: 500 ₽/.test(text));
  });
});

checkAsync("подделанная сумма в заявке помечается", function () {
  var f = makeFetch();
  configure(f);
  return Direct.send(cartOrder({ client_total: 1 })).then(function () {
    assert.ok(f.tg()[0].body.text.indexOf("⚠️ В заявке указана другая сумма") !== -1);
  });
});

checkAsync("в таблицу уходит по строке на позицию, с шапкой и итогом", function () {
  var f = makeFetch();
  configure(f);
  return Direct.send(cartOrder(), { orderId: "261011-TEST01" }).then(function () {
    var req = f.sheet()[0];
    assert.strictEqual(req.url, SHEET);
    assert.strictEqual(req.init.method, "POST");
    assert.strictEqual(req.init.headers["Content-Type"], "text/plain;charset=utf-8", "нужен простой запрос без OPTIONS");
    var body = req.body;
    assert.strictEqual(body.action, "order");
    assert.strictEqual(body.order_id, "261011-TEST01");
    assert.deepStrictEqual(body.columns, P.SHEET_COLUMNS);
    assert.strictEqual(body.rows.length, 2);
    body.rows.forEach(function (row) { assert.strictEqual(row.length, P.SHEET_COLUMNS.length, "строка не по шапке"); });

    var col = function (name) { return P.SHEET_COLUMNS.indexOf(name); };
    var r1 = body.rows[0], r2 = body.rows[1];
    assert.strictEqual(r1[col("Номер заявки")], "261011-TEST01");
    assert.strictEqual(r2[col("Номер заявки")], "261011-TEST01");
    assert.strictEqual(r1[col("Имя")], "Пётр");
    assert.strictEqual(r1[col("Контакт")], "@petr_777");
    assert.strictEqual(r1[col("Статус")], "Новая");
    assert.strictEqual(r1[col("Плёнка")], "Матовая");
    assert.strictEqual(r2[col("Плёнка")], "Глянцевая");
    assert.strictEqual(r2[col("Эскиз")], "Лиса");
    assert.strictEqual(r2[col("Ширина, см")], 30);
    assert.strictEqual(r2[col("Тираж, шт")], 3);
    assert.strictEqual(r1[col("Сумма позиции, ₽")], 300);
    assert.strictEqual(r2[col("Сумма позиции, ₽")], 7200);
    assert.strictEqual(r1[col("Итого заказа, ₽")], 7500, "итог только в первой строке");
    assert.strictEqual(r2[col("Итого заказа, ₽")], "", "итог не должен дублироваться");
    assert.strictEqual(r1[col("Позиций в заказе")], 2);
    assert.strictEqual(r1[col("Минимум применён")], "нет");
  });
});

checkAsync("получателей Telegram может быть несколько, таблица пишется один раз", function () {
  var f = makeFetch();
  configure(f, { chatId: MODERATOR + ", 123456789" });
  return Direct.send(cartOrder()).then(function (reply) {
    assert.ok(reply.ok);
    assert.deepStrictEqual(f.tg().map(function (c) { return String(c.body.chat_id); }), [MODERATOR, "123456789"]);
    assert.strictEqual(f.sheet().length, 1);
  });
});

checkAsync("HTML в имени и комментарии экранируется", function () {
  var f = makeFetch();
  configure(f);
  return Direct.send(cartOrder({ name: "<b>злой</b>", comment: "<script>" })).then(function () {
    var text = f.tg()[0].body.text;
    assert.ok(text.indexOf("&lt;b&gt;злой&lt;/b&gt;") !== -1);
    assert.ok(text.indexOf("<script>") === -1);
  });
});

checkAsync("таблица не настроена: заявка уходит только в Telegram", function () {
  var f = makeFetch();
  configure(f, { sheetUrl: "" });
  return Direct.send(cartOrder()).then(function (reply) {
    assert.ok(reply.ok, reply.error);
    assert.strictEqual(reply.sheet, "skipped");
    assert.strictEqual(f.sheet().length, 0);
    assert.strictEqual(f.tg().length, 1);
  });
});

checkAsync("таблица отказала, Telegram принял: заявка принята, менеджеру — предупреждение", function () {
  var f = makeFetch({ sheetError: true });
  configure(f);
  return Direct.send(cartOrder(), { orderId: "261011-TEST02" }).then(function (reply) {
    assert.ok(reply.ok, "заявка потеряна из-за таблицы");
    assert.strictEqual(reply.telegram, "sent");
    assert.strictEqual(reply.sheet, "failed");
    assert.ok(reply.warnings.some(function (w) { return /Таблица/.test(w); }));
    var messages = f.tg();
    assert.strictEqual(messages.length, 2, "ожидалось основное сообщение и предупреждение");
    assert.ok(/не записался в Google-таблицу/.test(messages[1].body.text));
    assert.ok(messages[1].body.text.indexOf("261011-TEST02") !== -1);
  });
});

checkAsync("Google ответил страницей, а не JSON: считается ошибкой таблицы", function () {
  var f = makeFetch({ sheetHtml: true });
  configure(f);
  return Direct.send(cartOrder()).then(function (reply) {
    assert.ok(reply.ok);
    assert.strictEqual(reply.sheet, "failed");
    assert.ok(reply.warnings.some(function (w) { return /У всех/.test(w); }), "нет подсказки про доступ");
  });
});

checkAsync("браузер не дал прочитать ответ таблицы: повтор в режиме no-cors", function () {
  var f = makeFetch({ sheetCorsOnly: true, sheetNoCors: true });
  configure(f);
  return Direct.send(cartOrder()).then(function (reply) {
    assert.ok(reply.ok);
    assert.strictEqual(reply.sheet, "sent-blind");
    var calls = f.sheet();
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[1].init.mode, "no-cors");
    assert.strictEqual(calls[0].body.order_id, calls[1].body.order_id, "повтор должен нести тот же номер — иначе будет дубль");
  });
});

checkAsync("таблица недоступна совсем: заявка всё равно доходит в Telegram", function () {
  var f = makeFetch({ sheetOffline: true });
  configure(f);
  return Direct.send(cartOrder()).then(function (reply) {
    assert.ok(reply.ok);
    assert.strictEqual(reply.sheet, "failed");
  });
});

checkAsync("Telegram отказал, таблица приняла: заявка не потеряна", function () {
  var f = makeFetch({ tgBadToken: true });
  configure(f);
  return Direct.send(cartOrder()).then(function (reply) {
    assert.ok(reply.ok, "заявка есть в таблице, а клиенту показана ошибка");
    assert.strictEqual(reply.telegram, "failed");
    assert.strictEqual(reply.sheet, "sent");
    assert.ok(reply.warnings.some(function (w) { return /Telegram/.test(w); }));
  });
});

checkAsync("не дошло никуда: ошибка и подсказка, а не «принято»", function () {
  var f = makeFetch({ tgOffline: true, sheetOffline: true });
  configure(f);
  return Direct.send(cartOrder()).then(function (reply) {
    assert.strictEqual(reply.ok, false);
    assert.strictEqual(reply.kind, "network");
    assert.ok(/api\.telegram\.org/.test(reply.hint));
  });
});

checkAsync("неверный токен и нет таблицы: понятная причина", function () {
  var f = makeFetch({ tgBadToken: true });
  configure(f, { sheetUrl: "" });
  return Direct.send(cartOrder()).then(function (reply) {
    assert.strictEqual(reply.ok, false);
    assert.strictEqual(reply.kind, "telegram");
    assert.ok(/@BotFather/.test(reply.hint));
  });
});

checkAsync("пустая или кривая корзина отклоняется до обращения к сети", function () {
  var f = makeFetch();
  configure(f);
  return Direct.send(cartOrder({ items: [] })).then(function (a) {
    assert.strictEqual(a.ok, false);
    assert.strictEqual(a.kind, "field");
    return Direct.send(cartOrder({ name: "" }));
  }).then(function (b) {
    assert.strictEqual(b.kind, "field");
    assert.strictEqual(f.log.length, 0, "в сеть что-то ушло");
  });
});

checkAsync("ничего не настроено: заявка не притворяется отправленной", function () {
  var f = makeFetch();
  configure(f, { token: "", sheetUrl: "" });
  return Direct.send(cartOrder()).then(function (reply) {
    assert.strictEqual(reply.ok, false);
    assert.strictEqual(reply.kind, "config");
    assert.strictEqual(f.log.length, 0);
  });
});

checkAsync("только Google-таблица (без Telegram) тоже работает", function () {
  var f = makeFetch();
  configure(f, { token: "" });
  return Direct.send(cartOrder()).then(function (reply) {
    assert.ok(reply.ok, reply.error);
    assert.strictEqual(reply.telegram, "skipped");
    assert.strictEqual(reply.sheet, "sent");
  });
});

checkAsync("адрес таблицы без https не используется", function () {
  var f = makeFetch();
  configure(f, { sheetUrl: "http://example.com/exec" });
  return Direct.send(cartOrder()).then(function (reply) {
    assert.strictEqual(reply.sheet, "skipped");
    assert.strictEqual(f.sheet().length, 0);
  });
});

checkAsync("длинная заявка режется на сообщения по границам позиций", function () {
  var f = makeFetch();
  configure(f);
  var items = [];
  for (var i = 0; i < P.CART_MAX_ITEMS; i++) {
    items.push(Object.assign({}, BIG, { w: 20 + i, sketch: "Очень длинное название эскиза для проверки лимита сообщения " + i }));
  }
  return Direct.send(Object.assign({ items: items }, customer({ comment: new Array(601).join("я") }))).then(function (reply) {
    assert.ok(reply.ok, reply.error);
    var messages = f.tg();
    assert.ok(messages.length >= 1);
    messages.forEach(function (m) { assert.ok(m.body.text.length <= 4096, "сообщение длиннее лимита: " + m.body.text.length); });
    var joined = messages.map(function (m) { return m.body.text; }).join("\n");
    for (var n = 1; n <= P.CART_MAX_ITEMS; n++) assert.ok(joined.indexOf("<b>" + n + ".</b>") !== -1, "потеряна позиция " + n);
  });
});

check("splitMessage не рвёт HTML-теги и не теряет текст", function () {
  var blocks = [];
  for (var i = 0; i < 40; i++) blocks.push("<b>" + i + ".</b> " + new Array(150).join("ж"));
  var text = blocks.join("\n\n");
  var parts = Direct.splitMessage(text);
  assert.ok(parts.length > 1);
  parts.forEach(function (p) { assert.ok(p.length <= 4000); assert.strictEqual((p.match(/<b>/g) || []).length, (p.match(/<\/b>/g) || []).length); });
  assert.strictEqual(parts.join("\n\n"), text);
  assert.deepStrictEqual(Direct.splitMessage("коротко"), ["коротко"]);
});

check("одиночная заявка без корзины по-прежнему работает (бот, шаблоны)", function () {
  var f = makeFetch();
  configure(f, { sheetUrl: "" });
  return Direct.send(Object.assign({}, SMALL, customer())).then(function (reply) {
    assert.ok(reply.ok, reply.error);
    assert.ok(f.tg()[0].body.text.indexOf("Конфигурация") !== -1);
  });
});

/* --------------------------------------------------------------------------
   4. Страница и скрипт таблицы
   ----------------------------------------------------------------------- */
chain = chain.then(function () {
  console.log("\n4. Страница и Google Apps Script");

  var html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  var site = fs.readFileSync(path.join(ROOT, "site.js"), "utf8");

  check("в калькуляторе есть кнопка подтверждения, а в корзине — «Отправить заявку»", function () {
    assert.ok(/id="cart-add"[^>]*type="button"/.test(html), "кнопка добавления должна быть type=button");
    assert.ok(/Подтвердить и добавить в корзину/.test(html));
    var send = html.match(/<button[^>]*id="order-send"[^>]*>[\s\S]*?<\/button>/);
    assert.ok(send, "нет кнопки отправки");
    assert.ok(/Отправить заявку/.test(send[0]) && !/в Telegram/.test(send[0].replace(/<svg[\s\S]*<\/svg>/, "")), "подпись кнопки");
    assert.ok(/disabled/.test(send[0]), "пустую корзину отправить нельзя");
  });

  check("кнопка «Отправить заявку» внутри корзины, а форма контактов — в ней же", function () {
    var cartStart = html.indexOf('id="cart"');
    var formStart = html.indexOf('id="order-form"');
    var sendPos = html.indexOf('id="order-send"');
    var addPos = html.indexOf('id="cart-add"');
    assert.ok(addPos < cartStart, "кнопка добавления должна быть до корзины");
    assert.ok(cartStart < formStart && formStart < sendPos, "кнопка отправки вне корзины");
  });

  check("параметры наклейки (форма, эскиз) вынесены из контактов в калькулятор", function () {
    var calc = html.indexOf('class="calc-panel"');
    var cart = html.indexOf('id="cart"');
    ["order-shape", "order-sketch", "order-design", "order-color", "film-type"].forEach(function (id) {
      var at = html.indexOf('id="' + id + '"');
      assert.ok(at > calc && at < cart, id + " должен быть в калькуляторе, а не в форме контактов");
    });
  });

  check("cart.js подключён до site.js, корзина есть в шапке", function () {
    assert.ok(html.indexOf('src="cart.js') !== -1 && html.indexOf('src="cart.js') < html.indexOf('src="site.js'));
    assert.ok(html.indexOf('id="cart-badge"') !== -1);
    assert.strictEqual(html.indexOf('src="tgdirect.js'), -1, "отправка не должна грузиться заранее");
  });

  check("site.js отправляет позиции корзины, а не одну наклейку", function () {
    assert.ok(site.indexOf("items: cart.toOrderItems()") !== -1);
    assert.ok(site.indexOf("validateCart") !== -1);
  });

  check("скрипт Google Apps Script лежит в репозитории и принимает нужные поля", function () {
    var gs = fs.readFileSync(path.join(ROOT, "google-apps-script/Code.gs"), "utf8");
    ["function doPost", "function doGet", "order_id", "body.rows", "body.columns", "setValues", "LockService", "alreadyHas_"].forEach(function (marker) {
      assert.ok(gs.indexOf(marker) !== -1, "в Code.gs нет " + marker);
    });
  });

  check("адрес таблицы вписывается в одном месте — tgdirect.js", function () {
    var direct = fs.readFileSync(path.join(ROOT, "tgdirect.js"), "utf8");
    assert.ok(/var SHEET_URL = "[^"]*";/.test(direct), "нет настройки SHEET_URL");
  });

  check("Code.gs работает: дописывает строки, не дублирует заявку, экранирует формулы", function () {
    var gs = fs.readFileSync(path.join(ROOT, "google-apps-script/Code.gs"), "utf8");
    var rows = [];
    var sheetObj = {
      getLastRow: function () { return rows.length; },
      getLastColumn: function () { return rows.length ? rows[0].length : 0; },
      setFrozenRows: function () {},
      getRange: function (r, c, h, w) {
        return {
          setValues: function (values) { values.forEach(function (v, i) { rows[r - 1 + i] = v; }); return this; },
          getValues: function () { return rows.slice(r - 1, r - 1 + h).map(function (row) { return [row[c - 1]]; }); },
          setFontWeight: function () { return this; },
          setBackground: function () { return this; }
        };
      }
    };
    var out = [];
    var context = {
      LockService: { getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; } },
      SpreadsheetApp: {
        getActiveSpreadsheet: function () { return { getSheetByName: function () { return sheetObj; }, insertSheet: function () { return sheetObj; } }; },
        flush: function () {}
      },
      ContentService: {
        MimeType: { JSON: "json" },
        createTextOutput: function (text) { return { text: text, setMimeType: function () { return this; } }; }
      }
    };
    vm.runInNewContext(gs, context);
    function post(body) {
      var res = context.doPost({ postData: { contents: JSON.stringify(body) } });
      return JSON.parse(res.text);
    }
    var columns = ["Номер заявки", "Имя"];
    var first = post({ action: "order", order_id: "A1", columns: columns, rows: [["A1", "=HYPERLINK(1)"], ["A1", "+79001112233"]] });
    assert.ok(first.ok, first.error);
    assert.strictEqual(rows.length, 3, "шапка + 2 строки");
    assert.strictEqual(JSON.stringify(rows[0]), JSON.stringify(columns));
    assert.strictEqual(rows[1][1], "'=HYPERLINK(1)", "формула не экранирована");
    var again = post({ action: "order", order_id: "A1", columns: columns, rows: [["A1", "x"]] });
    assert.ok(again.ok && again.duplicate, "повтор того же номера должен игнорироваться");
    assert.strictEqual(rows.length, 3, "появился дубль");
    assert.strictEqual(post({ action: "order", order_id: "", rows: [] }).ok, false);
    assert.strictEqual(post({ action: "wipe" }).ok, false);
    assert.ok(JSON.parse(context.doGet().text).ok);
  });

  check("токена бота нет в cart.js и в скрипте таблицы", function () {
    ["cart.js", "google-apps-script/Code.gs"].forEach(function (name) {
      var text = fs.readFileSync(path.join(ROOT, name), "utf8");
      assert.ok(!/\d{8,}:[A-Za-z0-9_-]{30,}/.test(text), "токен найден в " + name);
    });
  });
});

chain.then(function () {
  console.log("\n" + (failures ? "ПРОВАЛЕНО ПРОВЕРОК: " + failures : "Все проверки пройдены ✅") + "\n");
  process.exit(failures ? 1 : 0);
}).catch(function (error) {
  console.error("\nТест упал: " + (error && error.stack || error));
  process.exit(1);
});
