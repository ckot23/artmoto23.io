#!/usr/bin/env node
"use strict";
/* ============================================================================
   Проверка панели бота (bot.html + botpanel.js) — «заявка дойдёт до модератора,
   если владелец запустил панель в браузере?»

   Запуск:  node tests/panel.js   (или npm run test:panel)

   Telegram подменяется заглушкой: интернет не нужен, токен не нужен.
   Проверяем:
     • заявку из ссылки сайта, из Mini App и из «Поделиться»;
     • что подтверждение клиенту не уходит, если заявка не дошла модератору;
     • понятные ошибки для неверного токена, 409 (два приёмника) и обрыва сети;
     • что токен берётся только из полей панели и нигде не зашит в файлы.
   ========================================================================= */

var assert = require("assert");
var fs = require("fs");
var path = require("path");

var ROOT = path.join(__dirname, "..");

require(path.join(ROOT, "pricing.js"));
require(path.join(ROOT, "orderlink.js"));
require(path.join(ROOT, "botcore.js"));
var Panel = require(path.join(ROOT, "botpanel.js"));
var L = globalThis.OrderLink;

var failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok   " + name); }
  catch (error) { failures++; console.log("  FAIL " + name + " → " + error.message); }
}

/* --- заглушка Telegram --------------------------------------------------- */

function makeFetch(options) {
  var opts = options || {};
  var log = [];
  var updates = opts.updates || [];
  function reply(payload) {
    return Promise.resolve({
      ok: payload.ok, status: payload.ok ? 200 : (payload.error_code || 400),
      json: function () { return Promise.resolve(payload); }
    });
  }
  function fetchStub(url, init) {
    var method = String(url).replace(/^.*\//, "");
    var body = JSON.parse((init && init.body) || "{}");
    log.push({ method: method, body: body });
    if (opts.offline) return Promise.reject(new TypeError("Failed to fetch"));
    if (method === "getMe") {
      if (opts.badToken) return reply({ ok: false, error_code: 401, description: "Unauthorized" });
      return reply({ ok: true, result: { id: 42, username: "my_stickers_bot", first_name: "Наклейки" } });
    }
    if (method === "health") {
      /* /api/health сервера сайта: по нему панель решает, уступать или нет. */
      return reply(opts.health || { ok: true, updates: "off", updates_detail: { mode: "off", alive: false } });
    }
    if (method === "getWebhookInfo") {
      return reply({ ok: true, result: { url: opts.webhookUrl || "" } });
    }
    if (method === "deleteWebhook") return reply({ ok: true, result: true });
    if (method === "getUpdates") {
      if (opts.conflict) return reply({ ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" });
      var batch = updates.slice();
      updates = [];
      return reply({ ok: true, result: batch });
    }
    if (method === "sendMessage") {
      if (opts.sendFails) return reply({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" });
      return reply({ ok: true, result: { message_id: log.length } });
    }
    return reply({ ok: true, result: {} });
  }
  fetchStub.log = log;
  return fetchStub;
}

function message(chatId, text, extra) {
  var opts = extra || {};
  return {
    update_id: opts.updateId || Math.floor(Math.random() * 1e6),
    message: {
      message_id: 1,
      from: { id: chatId, is_bot: false, first_name: opts.firstName || "Пётр", username: opts.username === undefined ? "petr_777" : opts.username },
      chat: { id: chatId, type: "private" },
      date: Math.floor(Date.now() / 1000),
      text: text,
      web_app_data: opts.webAppData ? { data: opts.webAppData, button_text: "Отправить" } : undefined
    }
  };
}

function sentTo(fetchStub, chatId) {
  return fetchStub.log.filter(function (c) {
    return c.method === "sendMessage" && String(c.body.chat_id) === String(chatId);
  });
}
function sentToModerator(fetchStub) { return sentTo(fetchStub, "7114829971"); }

var ORDER = {
  film: "matte", design: "own", color: "black", shape: "circle",
  w: 10, h: 10, qty: 10, name: "Пётр", contact: "@petr_777",
  delivery: "Рига, СДЭК", comment: "нужно к пятнице", client_total: 4100
};

var chain = Promise.resolve();

/* 1. Проверка токена. */
chain = chain.then(function () {
  console.log("\n1. Проверка токена и настройки");
  var good = makeFetch({});
  var bot = Panel.createBot({ token: "111:AAA", moderatorId: "7114829971", fetch: good });
  return bot.check().then(function (info) {
    check("рабочий токен показывает имя бота", function () {
      assert.strictEqual(info.username, "my_stickers_bot");
    });
    var bad = makeFetch({ badToken: true });
    var badBot = Panel.createBot({ token: "111:AAA", moderatorId: "7114829971", fetch: bad });
    return badBot.check().catch(function (error) { return error; });
  }).then(function (error) {
    check("неверный токен объясняется человеческим языком", function () {
      assert.ok(error instanceof Error, "ошибки не было");
      assert.ok(error.message.indexOf("@BotFather") !== -1, error.message);
    });
    var empty = Panel.createBot({ token: "", moderatorId: "1", fetch: makeFetch({}) });
    return empty.check().catch(function (e) { return e; });
  }).then(function (error) {
    check("без токена панель не запускается и говорит об этом", function () {
      assert.ok(error instanceof Error && error.message.indexOf("токен") !== -1, String(error));
    });
  });
});

/* 2. Заявка по ссылке сайта. */
chain = chain.then(function () {
  console.log("\n2. Заявка из ссылки сайта (кнопка «Отправить заявку боту»)");
  var fetchStub = makeFetch({ updates: [message(777001, "/start " + L.startParam(ORDER))] });
  var bot = Panel.createBot({ token: "111:AAA", moderatorId: "7114829971", fetch: fetchStub, log: function () {} });
  return bot.once().then(function (result) {
    check("заявка передана модератору", function () {
      var toMod = sentToModerator(fetchStub);
      assert.strictEqual(toMod.length, 1, "сообщений модератору: " + toMod.length);
      assert.ok(toMod[0].body.text.indexOf("Пётр") !== -1);
      assert.ok(toMod[0].body.text.replace(/\u00A0/g, " ").indexOf("4 100 ₽") !== -1);
    });
    check("клиент получил подтверждение", function () {
      var toClient = sentTo(fetchStub, 777001);
      assert.strictEqual(toClient.length, 1);
      assert.ok(/Заявка №\d{6}-/.test(toClient[0].body.text), toClient[0].body.text.slice(0, 100));
    });
    check("счётчик заявок увеличен", function () {
      assert.strictEqual(result.orders, 1);
    });
  });
});

/* 3. Mini App и «Поделиться». */
chain = chain.then(function () {
  console.log("\n3. Mini App и «Поделиться»");
  var fetchStub = makeFetch({ updates: [
    message(777002, "", { webAppData: JSON.stringify(ORDER), updateId: 10 }),
    message(777003, "Заявка с сайта\n\n" + L.toToken(ORDER), { updateId: 11 })
  ] });
  var bot = Panel.createBot({ token: "111:AAA", moderatorId: "7114829971", fetch: fetchStub, log: function () {} });
  return bot.once().then(function () {
    check("обе заявки ушли модератору", function () {
      assert.strictEqual(sentToModerator(fetchStub).length, 2);
    });
    check("в заявке из Mini App сохранён комментарий", function () {
      var found = sentToModerator(fetchStub).some(function (c) {
        return c.body.text.indexOf("нужно к пятнице") !== -1;
      });
      assert.ok(found, "комментарий потерялся");
    });
  });
});

/* 4. Если заявка не ушла модератору — клиент не должен получить «принято». */
chain = chain.then(function () {
  console.log("\n4. Модератору отправить не удалось");
  var fetchStub = makeFetch({ sendFails: true, updates: [message(777004, "/start " + L.startParam(ORDER))] });
  var bot = Panel.createBot({ token: "111:AAA", moderatorId: "7114829971", fetch: fetchStub, log: function () {} });
  return bot.once().then(function () {
    check("клиент получает просьбу написать менеджеру, а не подтверждение", function () {
      var toClient = sentTo(fetchStub, 777004);
      assert.strictEqual(toClient.length, 1);
      assert.ok(toClient[0].body.text.indexOf("Не удалось передать заявку") !== -1, toClient[0].body.text.slice(0, 120));
      assert.ok(toClient[0].body.text.indexOf("t.me/ckot_23") !== -1);
    });
  });
});

/* 5. Понятные ошибки: 409 и обрыв сети. */
chain = chain.then(function () {
  console.log("\n5. Понятные ошибки");
  var logs = [];
  var conflict = makeFetch({ conflict: true });
  var bot = Panel.createBot({
    token: "111:AAA", moderatorId: "7114829971", fetch: conflict,
    retryDelayMs: 10, log: function (m) { logs.push(m); }
  });
  /* start() отвечает сразу, опрос идёт в фоне — как в живой панели. */
  return bot.start().then(function () {
    return new Promise(function (resolve) { setTimeout(resolve, 120); });
  }).then(function () {
    bot.stop();
    check("409 объясняется как «запущен второй приёмник»", function () {
      var text = logs.join(" | ");
      assert.ok(text.indexOf("409") !== -1 || text.indexOf("вебхук") !== -1, text);
    });
    var offlineLogs = [];
    var offlineBot = Panel.createBot({
      token: "111:AAA", moderatorId: "7114829971", fetch: makeFetch({ offline: true }),
      retryDelayMs: 10, log: function (m) { offlineLogs.push(m); }
    });
    return offlineBot.start().then(function () {
      return new Promise(function (resolve) { setTimeout(resolve, 120); });
    }).then(function () {
      offlineBot.stop();
      check("обрыв сети не выглядит как успех", function () {
        assert.ok(offlineLogs.join(" ").indexOf("Сеть") !== -1, offlineLogs.join(" | "));
      });
    });
  });
});

/* 6. Вебхук: неработающий снимается сам, живой (сервер работает) — нет. */
chain = chain.then(function () {
  console.log("\n6. Вебхук");
  var fetchStub = makeFetch({ webhookUrl: "https://old.example.com/api/tg-webhook" });
  var bot = Panel.createBot({ token: "111:AAA", moderatorId: "7114829971", fetch: fetchStub, retryDelayMs: 10, log: function () {} });
  return bot.start().then(function () {
    bot.stop();
    check("панель снимает неработающий вебхук перед работой", function () {
      assert.ok(fetchStub.log.some(function (c) { return c.method === "deleteWebhook"; }), "deleteWebhook не вызван");
    });

    /* Живой вебхук, по которому работает сервер сайта, снимать нельзя:
       иначе заявки перестанут приходить на сервер. */
    var liveLogs = [];
    var live = makeFetch({
      webhookUrl: "https://orders.example.com/api/tg-webhook",
      health: { ok: true, updates: "webhook", updates_detail: { mode: "webhook", alive: true } }
    });
    var liveBot = Panel.createBot({
      token: "111:AAA", moderatorId: "7114829971", fetch: live,
      retryDelayMs: 10, log: function (m) { liveLogs.push(m); }
    });
    return liveBot.start().then(function (result) {
      check("живой вебхук работающего сервера панель не снимает", function () {
        assert.ok(!live.log.some(function (c) { return c.method === "deleteWebhook"; }), "панель сняла чужой вебхук");
        assert.strictEqual(result.running, false, "панель осталась работать — начнётся 409 Conflict");
      });
      check("панель объясняет, почему остановилась", function () {
        var text = liveLogs.join(" | ");
        assert.ok(text.indexOf("сервер сайта") !== -1, text);
        assert.ok(text.indexOf("409") !== -1, "не сказано про 409 Conflict");
      });
    });
  });
});

/* 6b. Очередь стабильно занята — панель уступает, а не спортит до бесконечности. */
chain = chain.then(function () {
  console.log("\n6b. Очередь getUpdates занята");
  var logs = [];
  var conflict = makeFetch({ conflict: true });
  var bot = Panel.createBot({
    token: "111:AAA", moderatorId: "7114829971", fetch: conflict,
    retryDelayMs: 10, conflictDelayMs: 10, log: function (m) { logs.push(m); }
  });
  return bot.start().then(function () {
    return new Promise(function (resolve) { setTimeout(resolve, 300); });
  }).then(function () {
    check("панель останавливается, если очередь держит кто-то другой", function () {
      assert.strictEqual(bot.status.running, false, "панель продолжает спорить за getUpdates");
      assert.ok(bot.status.conflicts >= 3, "конфликтов: " + bot.status.conflicts);
    });
    check("причина остановки понятна владельцу", function () {
      var text = logs.join(" | ");
      assert.ok(text.indexOf("Эта вкладка останавливается") !== -1, text);
      assert.ok(text.indexOf("сервер") !== -1, "не сказано, что обновления забирает сервер");
    });
  });
});

/* 7. Приём мусора и спама. */
chain = chain.then(function () {
  console.log("\n7. Мусор и спам");
  var fetchStub = makeFetch({ updates: [
    message(777005, "привет", { updateId: 20 }),
    message(777006, "/start", { updateId: 21 }),
    message(777007, "/id", { updateId: 22 }),
    message(777008, "/start " + L.base64url("9|m|o|k|r|1|1|1"), { updateId: 23 })
  ] });
  var bot = Panel.createBot({ token: "111:AAA", moderatorId: "7114829971", fetch: fetchStub, log: function () {} });
  return bot.once().then(function () {
    check("модератору не приходит ни одной заявки", function () {
      assert.strictEqual(sentToModerator(fetchStub).length, 0);
    });
    check("/id отвечает chat_id", function () {
      var toClient = sentTo(fetchStub, 777007);
      assert.strictEqual(toClient.length, 1);
      assert.ok(toClient[0].body.text.indexOf("777007") !== -1);
    });
    check("на /start приходит приветствие со ссылкой на сайт", function () {
      var toClient = sentTo(fetchStub, 777006);
      assert.ok(toClient[0].body.text.indexOf("https://ckot23.github.io") !== -1 ||
        toClient[0].body.text.indexOf("Менеджер") !== -1 || toClient[0].body.text.indexOf("сайте") !== -1,
        toClient[0].body.text.slice(0, 150));
    });
  });
});

/* 8. Токен — только из полей админки, в файлах его нет. */
chain = chain.then(function () {
  console.log("\n8. Токен не попадает в файлы");
  var html = fs.readFileSync(path.join(ROOT, "bot.html"), "utf8");
  var admin = fs.readFileSync(path.join(ROOT, "admin.html"), "utf8");
  var workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/bot.yml"), "utf8");

  check("токен вводится в меню админа и там же шифруется", function () {
    assert.ok(admin.indexOf('id="s-token" type="password"') !== -1, "нет защищённого поля токена");
    assert.ok(admin.indexOf("vault.save") !== -1, "настройки не сохраняются через замок");
    assert.ok(admin.indexOf("Сбросить доступ") !== -1, "нет способа удалить настройки");
  });
  check("панель берёт токен из разблокированной сессии", function () {
    assert.ok(html.indexOf("vault.session()") !== -1, "панель не читает сессию");
    assert.ok(html.indexOf("AdminLock.createVault") !== -1, "панель не использует замок");
  });
  check("ни в одном файле нет токена бота", function () {
    var files = ["bot.html", "admin.html", "botpanel.js", "botcore.js", "bot.js",
      "adminlock.js", "index.html", "orderlink.js", "pricing.js", "env.js"];
    var found = files.filter(function (name) {
      var text = fs.readFileSync(path.join(ROOT, name), "utf8");
      return /\d{8,}:[A-Za-z0-9_-]{30,}/.test(text);
    });
    assert.strictEqual(found.length, 0, "токен найден в: " + found.join(", "));
  });
  check("в workflow токен по-прежнему из секретов", function () {
    assert.ok(workflow.indexOf("secrets.BOT_TOKEN") !== -1);
    assert.ok(!/\d{8,}:[A-Za-z0-9_-]{30,}/.test(workflow));
  });
  check("на страницах написано, где лежит токен", function () {
    assert.ok(html.indexOf("Токен лежит в этом браузере зашифрованным паролем") !== -1);
    assert.ok(admin.indexOf("Токен зашифрован") !== -1);
  });
  check("сайт ведёт в меню админа, а меню — в панель и обратно", function () {
    var index = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    assert.ok(index.indexOf("admin.html") !== -1, "на сайте нет ссылки на меню админа");
    assert.ok(admin.indexOf('href="bot.html"') !== -1, "в меню нет перехода в панель");
    assert.ok(admin.indexOf('href="index.html"') !== -1, "в меню нет возврата на сайт");
    assert.ok(html.indexOf('href="admin.html"') !== -1, "в панели нет перехода в меню");
  });
});

chain.then(function () {
  console.log("\n" + (failures ? "ПРОВАЛЕНО ПРОВЕРОК: " + failures : "Все проверки пройдены ✅") + "\n");
  process.exit(failures ? 1 : 0);
}).catch(function (error) {
  console.error("\nТест упал: " + (error && error.stack || error));
  process.exit(1);
});
