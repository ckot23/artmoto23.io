#!/usr/bin/env node
"use strict";
/* ============================================================================
   Проверки прайса сайта и отправки заявки в Telegram.

   Проверяем:
     • три плёнки с новыми ставками и минимальный заказ 500 ₽;
     • что калькулятор на странице и заявка модератору считаются по одной
       формуле (иначе клиент видит одну сумму, а Telegram — другую);
     • что форма заказа действительно уходит боту и не притворяется, что
       ушла, если Telegram не ответил.

   Telegram подменяется заглушкой: интернет и настоящий токен не нужны.
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

check("в прайсе ровно три плёнки", function () {
  assert.deepStrictEqual(P.FILMS.map(function (film) { return film.id; }),
    ["matte", "gloss", "metallic"]);
  assert.deepStrictEqual(P.FILMS.map(function (film) { return film.rate; }), [3, 4, 6]);
});

check("ставки на странице совпадают с прайсом", function () {
  assert.ok(/data-film-rate="matte">3 ₽\/см²/.test(html), "на карточке матовой не указана ставка 3 ₽");
  assert.ok(/data-film-rate="gloss">4 ₽\/см²/.test(html), "на карточке глянцевой не указана ставка 4 ₽");
  assert.ok(/data-film-rate="metallic">6 ₽\/см²/.test(html), "на карточке металлика не указана ставка 6 ₽");
  assert.strictEqual(html.indexOf("Светоотражающая"), -1, "осталась плёнка, которой больше нет");
  assert.strictEqual(html.indexOf("Прозрачная"), -1, "осталась плёнка, которой больше нет");
});

check("минимальный заказ — 500 ₽", function () {
  assert.strictEqual(P.MIN_ORDER_PRICE, 500);
  var result = P.calculateEstimate({ film: "matte", w: 10, h: 10, qty: 1 });
  assert.strictEqual(result.unit, 300);
  assert.strictEqual(result.total, 500, "минимум не применился");
  assert.strictEqual(result.minApplied, true);
  assert.strictEqual(result.toMin, 200);
});

check("минимальный заказ показывается, когда он достигнут", function () {
  var result = P.calculateEstimate({ film: "metallic", w: 10, h: 10, qty: 1 });
  assert.strictEqual(result.total, 600, "свыше минимума сумма должна остаться своей");
  assert.strictEqual(result.minApplied, false);
});

check("калькулятор учитывает ставку выбранной плёнки и количество", function () {
  var result = P.calculateEstimate({ film: "gloss", w: 10, h: 10, qty: 2 });
  assert.strictEqual(result.rate, 4);
  assert.strictEqual(result.unit, 400);
  assert.strictEqual(result.total, 800);
});

check("скидка за тираж видна и в расчёте, и в заявке", function () {
  var result = P.calculateEstimate({ film: "matte", w: 10, h: 10, qty: 50 });
  assert.strictEqual(result.discountPercent, 32);
  assert.strictEqual(result.withoutDiscount, 15000);
  assert.strictEqual(result.total, 10200);
});

/* Ключевая проверка: цифра на экране клиента и цифра в сообщении модератору
   обязаны совпадать, иначе заявка приходит с «неправильной» суммой. */
check("расчёт на сайте и заявка модератору дают одну сумму", function () {
  [
    { film: "matte", design: "own", color: "black", w: 20, h: 15, qty: 10 },
    { film: "gloss", design: "logo", color: "gold", w: 30, h: 20, qty: 50 },
    { film: "metallic", design: "own", color: "fullcolor", w: 10, h: 10, qty: 1 }
  ].forEach(function (config) {
    var estimate = P.calculateEstimate(config);
    var order = P.calculate(config);
    assert.strictEqual(estimate.ok, true);
    assert.strictEqual(estimate.total, order.total,
      "сайт показал " + estimate.total + ", а в заявке " + order.total);
    assert.strictEqual(estimate.unit, order.unit, "цена за штуку разошлась");
  });
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

  /* 10×10 матовой × 1 шт = 300 ₽ материала, но показываем минимум 500 ₽ */
  assert.strictEqual(elements["total-price"].textContent, "500 ₽", "начальное значение не отрисовано");
  assert.strictEqual(elements["unit-price"].textContent, "300 ₽", "цена за штуку не показана");

  elements.quantity.value = "2";
  elements.quantity.listeners.change();
  assert.strictEqual(elements["total-price"].textContent, "600 ₽", "изменение количества не пересчитало стоимость");

  elements.width.value = "20";
  elements.width.listeners.input();
  assert.strictEqual(elements["total-price"].textContent.replace(/\u00A0/g, " "), "1 200 ₽",
    "изменение ширины не пересчитало стоимость");

  elements["film-type"].value = "metallic";
  elements["film-type"].listeners.change();
  assert.strictEqual(elements["rate-value"].textContent, "6 ₽", "ставка выбранной плёнки не обновилась");
  assert.strictEqual(elements["total-price"].textContent.replace(/\u00A0/g, " "), "2 400 ₽");
});

/* --------------------------------------------------------------------------
   2. Внутренние расчёты совместимости
   ----------------------------------------------------------------------- */

console.log("\n2. Внутренний расчёт и проверка полей");

check("10×10, матовая, 10 шт → 2 460 ₽", function () {
  assert.strictEqual(P.calculate({ film: "matte", design: "own", color: "black", w: 10, h: 10, qty: 10 }).total, 2460);
});
check("5×5, 1 шт → минимальные 500 ₽", function () {
  assert.strictEqual(P.calculate({ film: "matte", design: "own", color: "black", w: 5, h: 5, qty: 1 }).total, 500);
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
   5. На главной есть форма заказа, галерея шаблонов и ссылка на канал
   ----------------------------------------------------------------------- */

chain = chain.then(function () {
  console.log("\n5. Главная страница: заказ, шаблоны, канал");

  check("форма заказа на месте и связана с расчётом", function () {
    ["order-form", "order-name", "order-contact", "order-delivery", "order-comment",
      "order-design", "order-color", "order-shape", "order-send", "order-status",
      "order-summary", "film-type", "width", "height", "quantity", "total-price"]
      .forEach(function (id) {
        assert.ok(html.indexOf('id="' + id + '"') !== -1, "нет элемента " + id);
      });
  });

  check("форма загружает отправку и запасную ссылку только по необходимости", function () {
    ["pricing.js", "site.js", "site.config.js"].forEach(function (file) {
      assert.ok(html.indexOf('src="' + file) !== -1, "не подключён основной модуль " + file);
    });
    assert.strictEqual(html.indexOf('src="tgdirect.js'), -1, "отправка загружается до нажатия кнопки");
    assert.strictEqual(html.indexOf('src="orderlink.js'), -1, "страховочная ссылка загружается заранее");
    var site = fs.readFileSync(path.join(ROOT, "site.js"), "utf8");
    assert.ok(site.indexOf("tgdirect.js?v=4") !== -1, "нет загрузки модуля отправки по запросу");
    assert.ok(site.indexOf("orderlink.js?v=4") !== -1, "нет загрузки запасной ссылки при ошибке");
    assert.ok(site.indexOf("TgDirect") !== -1, "форма не вызывает отправку");
    assert.ok(site.indexOf("orderLink.botLink") !== -1, "нет запасного пути через бота");
  });

  check("галерея загружается только если в каталоге есть шаблоны", function () {
    ["templates/catalog.js", "gallery-loader.js", "templates-grid"].forEach(function (marker) {
      assert.ok(html.indexOf(marker) !== -1, "на главной нет " + marker);
    });
    assert.strictEqual(html.indexOf('src="templates.js'), -1, "код каталога загружается заранее");
    assert.strictEqual(html.indexOf('src="gallery.js'), -1, "код галереи загружается заранее");
    assert.ok(/id="templates"[^>]*hidden/.test(html), "витрина шаблонов не спрятана в разметке");
    var loader = fs.readFileSync(path.join(ROOT, "gallery-loader.js"), "utf8");
    assert.ok(loader.indexOf("catalog.length === 0") !== -1, "пустой каталог не прерывает загрузку");
    assert.ok(loader.indexOf("templates.js?v=4") !== -1 && loader.indexOf("gallery.js?v=4") !== -1,
      "не подключаются нужные файлы при заполненном каталоге");
  });

  check("эскиз из формы доезжает до заявки модератору", function () {
    var order = Object.assign({}, ORDER, { sketch: "Волк — геометрия" });
    var checked = P.validate(order);
    assert.ok(checked.ok, checked.error);
    assert.strictEqual(checked.value.sketch, "Волк — геометрия");
    var text = Direct.buildMessage(checked.value, P.calculate(checked.value), { orderId: "x", time: "t" });
    assert.ok(text.indexOf("• Эскиз: Волк — геометрия") !== -1, "эскиза нет в сообщении модератору");
  });

  check("без эскиза заявка выглядит как раньше", function () {
    var checked = P.validate(ORDER);
    assert.strictEqual(checked.value.sketch, "");
    var text = Direct.buildMessage(checked.value, P.calculate(checked.value), { orderId: "x", time: "t" });
    assert.ok(text.indexOf("Эскиз") === -1, "лишняя строка в сообщении модератору");
  });

  check("примеры эскизов подключены и видны в форме заказа", function () {
    assert.ok(html.indexOf('src="sketches/catalog.js') !== -1, "каталог эскизов не подключён");
    assert.ok(html.indexOf('id="order-sketch"') !== -1, "в форме нет селекта «Эскиз»");
    assert.ok(/id="templates"[^>]*hidden/.test(html), "витрина примеров не спрятана в разметке");
    var catalog = fs.readFileSync(path.join(ROOT, "sketches/catalog.js"), "utf8");
    assert.ok(/SITE_SKETCHES\s*=\s*\[/, "каталог эскизов пуст");
    var found = catalog.match(/img:\s*"([^"]+)"/g) || [];
    assert.ok(found.length >= 2, "в каталоге меньше двух эскизов");
    found.forEach(function (entry) {
      var file = String(ROOT + "/" + entry.replace(/img:\s*"/, "").replace(/"$/, ""));
      assert.ok(fs.existsSync(file), "нет картинки эскиза: " + file);
    });
    var loader = fs.readFileSync(path.join(ROOT, "gallery-loader.js"), "utf8");
    assert.ok(loader.indexOf("sketch-gallery.js") !== -1, "загрузчик не подключает витрину эскизов");
    var site = fs.readFileSync(path.join(ROOT, "site.js"), "utf8");
    assert.ok(site.indexOf("SITE_SKETCHES") !== -1, "форма не наполняет селект эскизами");
    assert.ok(site.indexOf("sketch:") !== -1, "эскиз не уходит в заявку");
  });

  check("на странице есть ссылка на Telegram-канал", function () {
    var channel = "https://t.me/+aZLbDN640q5hNGYy";
    assert.ok(html.indexOf(channel) !== -1, "нет ссылки на канал");
    assert.ok(html.split(channel).length - 1 >= 2, "канал упомянут меньше двух раз");
    assert.ok(fs.readFileSync(path.join(ROOT, "site.config.js"), "utf8").indexOf(channel) !== -1,
      "канал не вынесен в настройки сайта");
  });

  check("неоновая 3D-стилистика без постоянно работающих анимаций", function () {
    ["--cyan", "--violet", "text-shadow", "preserve-3d", "perspective"]
      .forEach(function (marker) {
        assert.ok(html.indexOf(marker) !== -1, "в стилях нет " + marker);
      });
    assert.strictEqual(/animation:[^;]*infinite/.test(html), false, "остались бесконечные анимации");
    assert.strictEqual(html.indexOf("cursor-glow"), -1, "осталось отслеживание курсора");
    assert.ok(html.indexOf("prefers-reduced-motion") !== -1, "нет уважения к настройке движения");
    assert.strictEqual(html.indexOf('src="effects.js'), -1, "декоративный JS загружается на главной");
  });

  check("внутренние инструменты не попали на публичную страницу", function () {
    ["admin.html", "bot.html", "botcore.js", "botpanel.js", "adminlock.js", "templatesync.js"]
      .forEach(function (marker) {
        assert.strictEqual(html.indexOf(marker), -1, "в index.html остался " + marker);
      });
  });

  check("серверных файлов в репозитории по-прежнему нет", function () {
    ["server.js", "bot.js", "env.js", "render.yaml", "Dockerfile", ".env.example"].forEach(function (name) {
      assert.ok(!fs.existsSync(path.join(ROOT, name)), "остался файл " + name);
    });
  });

  check("токен бота лежит только в tgdirect.js и настроен", function () {
    var files = ["index.html", "site.js", "site.config.js", "gallery-loader.js", "gallery.js",
      "pricing.js", "orderlink.js", "templates.js", "templates/catalog.js"];
    files.forEach(function (name) {
      var text = fs.readFileSync(path.join(ROOT, name), "utf8");
      assert.ok(!/\d{8,}:[A-Za-z0-9_-]{30,}/.test(text), "токен найден в " + name);
    });
    /* Проверяем сам файл: к этому моменту предыдущие тесты уже подменили
     настройки модуля заглушкой, поэтому состояние в памяти не годится. */
    var direct = fs.readFileSync(path.join(ROOT, "tgdirect.js"), "utf8");
    assert.ok(/var BOT_TOKEN = "\d{8,}:[A-Za-z0-9_-]{30,}"/.test(direct), "в tgdirect.js нет токена бота");
    assert.ok(/var CHAT_ID = "7114829971"/.test(direct), "в tgdirect.js не задан chat_id модератора");
  });
});

chain.then(function () {
  console.log("\n" + (failures ? "ПРОВАЛЕНО ПРОВЕРОК: " + failures : "Все проверки пройдены ✅") + "\n");
  process.exit(failures ? 1 : 0);
}).catch(function (error) {
  console.error("\nТест упал: " + (error && error.stack || error));
  process.exit(1);
});
