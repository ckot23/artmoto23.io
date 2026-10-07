#!/usr/bin/env node
"use strict";
/* ============================================================================
   Проверки прайса сайта и изолированных внутренних утилит.

   Главная страница больше не содержит оформления заказа и не загружает
   tgdirect.js. Старый модуль отправки проверяется отдельно заглушкой Telegram,
   чтобы случайное изменение внутренних файлов не ломало тесты проекта.
   ========================================================================= */

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");

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
  delivery: "Рига, СДЭК", comment: "нужно к пятнице", client_total: 2460
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
   1. Калькулятор главной страницы и единый прайс
   ----------------------------------------------------------------------- */

var html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

console.log("\n1. Прайс и расчёт стоимости плёнки");

check("матовая плёнка стоит 3 ₽ за см²", function () {
  assert.strictEqual(P.byId(P.FILMS, "matte").rate, 3);
  assert.ok(/data-film-rate="matte">3 ₽\/см²/.test(html), "на карточке не указана новая ставка");
});

check("10×10 см матовой плёнки × 1 шт → 300 ₽", function () {
  var result = P.calculateEstimate({ film: "matte", w: 10, h: 10, qty: 1 });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.area, 100);
  assert.strictEqual(result.unit, 300);
  assert.strictEqual(result.total, 300);
});

check("калькулятор учитывает ставку выбранной плёнки и количество", function () {
  var result = P.calculateEstimate({ film: "gloss", w: 10, h: 10, qty: 2 });
  assert.strictEqual(result.rate, 5.5);
  assert.strictEqual(result.unit, 550);
  assert.strictEqual(result.total, 1100);
});

check("неверные размеры и количество отклоняются", function () {
  assert.strictEqual(P.calculateEstimate({ film: "matte", w: 0, h: 10, qty: 1 }).ok, false);
  assert.strictEqual(P.calculateEstimate({ film: "matte", w: 10, h: 10, qty: 1.5 }).ok, false);
  assert.strictEqual(P.calculateEstimate({ film: "missing", w: 10, h: 10, qty: 1 }).ok, false);
});

check("главная страница использует общую таблицу ставок", function () {
  assert.ok(/src="pricing\.js(?:\?[^\"]*)?"/.test(html), "не подключён прайс");
  assert.ok(/src="site\.js(?:\?[^\"]*)?"/.test(html), "не подключён калькулятор");
  assert.ok(fs.readFileSync(path.join(ROOT, "site.js"), "utf8").indexOf("calculateEstimate") !== -1,
    "калькулятор не использует общий расчёт");
});

check("изменение полей немедленно обновляет цену на странице", function () {
  function element(value) {
    return {
      value: value == null ? "" : String(value), textContent: "", hidden: false, options: [],
      listeners: {}, attributes: {},
      addEventListener: function (type, listener) { this.listeners[type] = listener; },
      setAttribute: function (name, value) { this.attributes[name] = value; },
      getAttribute: function (name) { return this.attributes[name]; },
      focus: function () {}, scrollIntoView: function () {}
    };
  }
  var elements = {
    "film-type": element("matte"), width: element("10"), height: element("10"), quantity: element("1"),
    "calc-error": element(), "total-price": element(), "result-subtitle": element(),
    "area-value": element(), "rate-value": element(), "unit-price": element(), calculator: element()
  };
  elements["film-type"].options = P.FILMS.map(function (film) { return { value: film.id, textContent: "" }; });
  var rateNodes = {};
  P.FILMS.forEach(function (film) { rateNodes[film.id] = element(); });
  var document = {
    getElementById: function (id) { return elements[id] || null; },
    querySelector: function (selector) {
      var match = selector.match(/data-film-rate="([^"]+)"/);
      return match ? rateNodes[match[1]] || null : null;
    },
    addEventListener: function () {}
  };
  var context = { window: { Pricing: P }, document: document, Pricing: P };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "site.js"), "utf8"), context, { filename: "site.js" });

  assert.strictEqual(elements["total-price"].textContent, "300 ₽", "начальное значение не отрисовано");
  elements.width.value = "20";
  elements.width.listeners.input();
  assert.strictEqual(elements["total-price"].textContent, "600 ₽", "изменение ширины не пересчитало стоимость");
  elements.quantity.value = "2";
  elements.quantity.listeners.change();
  assert.strictEqual(elements["total-price"].textContent.replace(/\u00A0/g, " "), "1 200 ₽", "изменение количества не пересчитало стоимость");
  elements["film-type"].value = "gloss";
  elements["film-type"].listeners.change();
  assert.strictEqual(elements["rate-value"].textContent, "5,5 ₽", "ставка выбранной плёнки не обновилась");
  assert.strictEqual(elements["total-price"].textContent.replace(/\u00A0/g, " "), "2 200 ₽");
});

/* --------------------------------------------------------------------------
   2. Внутренние расчёты совместимости
   ----------------------------------------------------------------------- */

console.log("\n2. Внутренний расчёт и проверка полей");

check("10×10, матовая, 10 шт → 2 460 ₽", function () {
  assert.strictEqual(P.calculate({ film: "matte", design: "own", color: "black", w: 10, h: 10, qty: 10 }).total, 2460);
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
  console.log("\n3. Изолированная проверка Telegram-утилиты");
  var fetchStub = makeFetch();
  return sendWith(fetchStub).then(function (reply) {
    check("заявка принята и получила номер", function () {
      assert.ok(reply.ok, "не отправлено: " + reply.error);
      assert.ok(/^\d{6}-[0-9A-F]{4}\d{2}$/.test(reply.order_id), "странный номер: " + reply.order_id);
      assert.strictEqual(reply.total, 2460);
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
   5. На главной нет шаблонов и оформления заказа
   ----------------------------------------------------------------------- */

chain = chain.then(function () {
  console.log("\n5. Главная страница — информация и калькулятор");

  check("нет формы, кнопок и интеграции для оформления заказа", function () {
    ["order-form", "order-send", "panel-order", "TgDirect.send(", "tgdirect.js", "customer-contact"]
      .forEach(function (marker) {
        assert.strictEqual(html.indexOf(marker), -1, "в index.html остался " + marker);
      });
  });

  check("нет галереи шаблонов и демо-примеров", function () {
    ["templates.js", "templates/catalog.js", "Готовые шаблоны", "gallery-grid", "data-template"]
      .forEach(function (marker) {
        assert.strictEqual(html.indexOf(marker), -1, "в index.html остался " + marker);
      });
  });

  check("вместо лишних действий доступны материалы и калькулятор", function () {
    ["id=\"materials\"", "id=\"about\"", "id=\"calculator\"", "id=\"film-type\"", "id=\"total-price\""]
      .forEach(function (marker) { assert.ok(html.indexOf(marker) !== -1, "нет " + marker); });
    assert.ok(html.indexOf("3 ₽/см²") !== -1, "не отображается базовая цена");
  });

  check("серверных файлов в репозитории больше нет", function () {
    ["server.js", "bot.js", "env.js", "render.yaml", "Dockerfile", ".env.example"].forEach(function (name) {
      assert.ok(!fs.existsSync(path.join(ROOT, name)), "остался файл " + name);
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
