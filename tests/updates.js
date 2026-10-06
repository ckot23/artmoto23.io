#!/usr/bin/env node
"use strict";
/* ============================================================================
   Проверка главного правила бота: «один бот — один потребитель обновлений».

   Запуск:  node tests/updates.js   (или npm run test:updates)

   Telegram отдаёт getUpdates только одному процессу. Если очередь уже держит
   кто-то ещё (GitHub Actions, вкладка bot.html, второй сервер), приходит
   409 Conflict — именно из-за него «бот не работает при запущенном сервере».

   Проверяем, что сервер ведёт себя правильно:
     1. видит занятую очередь, объясняет это человеческим языком и не спамит
        в лог (пауза нарастает);
     2. по /api/health сообщает «обновления забираю я», чтобы разовый бот
        (GitHub Actions) и панель уступили, а не спорили;
     3. забирает очередь, как только она освободилась, — заявка доходит;
     4. если появился вебхук (его поставил другой сервер), останавливает опрос;
     5. --doctor объясняет, кто забирает обновления.

   Telegram подменяется заглушкой: сеть не нужна, токен не нужен.
   ========================================================================= */

var assert = require("assert");
var path = require("path");

var ROOT = path.join(__dirname, "..");

/* --- заглушка Telegram и журнал сервера ---------------------------------- */

var calls = [];
var queue = [];              /* обновления, которые отдаст getUpdates */
var holder = { conflict: true, webhookUrl: "" };
var logs = [];
var realFetch = globalThis.fetch;
var realLog = console.log;

globalThis.fetch = function (url, options) {
  var method = String(url).replace(/^.*\//, "");
  var body = JSON.parse((options && options.body) || "{}");
  calls.push({ method: method, body: body });
  if (method === "getMe") return json({ ok: true, result: { id: 1, username: "testbot" } });
  if (method === "getWebhookInfo") {
    return json({ ok: true, result: { url: holder.webhookUrl, pending_update_count: 0 } });
  }
  if (method === "getUpdates") {
    if (holder.conflict) {
      return json({
        ok: false, error_code: 409,
        description: "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running"
      });
    }
    var batch = queue.slice();
    queue = [];
    return json({ ok: true, result: batch });
  }
  if (method === "sendMessage") return json({ ok: true, result: { message_id: calls.length } });
  return json({ ok: true, result: {} });
};

function json(payload) {
  return Promise.resolve({
    ok: payload.ok, status: payload.ok ? 200 : (payload.error_code || 400),
    json: function () { return Promise.resolve(payload); },
    text: function () { return Promise.resolve(JSON.stringify(payload)); }
  });
}

/* Весь вывод сервера собираем, но не печатаем: проверяем его тексты. */
console.log = console.error = function () {
  logs.push(Array.prototype.map.call(arguments, String).join(" "));
};
function say(text) { realLog(text); }

/* --- конфигурация сервера под тесты -------------------------------------- */

process.env.BOT_TOKEN = "123456:TEST-TOKEN";
process.env.MODERATOR_ID = "7114829971";
process.env.DRY_RUN = "0";
process.env.LOG_ORDERS = "0";
process.env.POLL = "1";                 /* всегда слушаем getUpdates */
process.env.WEBHOOK_AUTO = "0";
process.env.PORT = "0";

require(path.join(ROOT, "pricing.js"));
require(path.join(ROOT, "orderlink.js"));
/* Паузы при 409 в бою растут до минуты — в тесте делаем их короткими. */
var Core = require(path.join(ROOT, "botcore.js"));
Core.conflictBackoffMs = function () { return 20; };

var server = require(path.join(ROOT, "server.js"));

var failures = 0;
function check(name, fn) {
  try { fn(); say("  ok   " + name); }
  catch (error) { failures++; say("  FAIL " + name + " → " + error.message); }
}
function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function logText() { return logs.join("\n"); }
function health(port) {
  return realFetch("http://127.0.0.1:" + port + "/api/health").then(function (r) { return r.json(); });
}
function lastToModerator() {
  for (var i = calls.length - 1; i >= 0; i--) {
    if (calls[i].method === "sendMessage" && String(calls[i].body.chat_id) === process.env.MODERATOR_ID) return calls[i];
  }
  return null;
}

var ORDER = {
  v: 2, film: "matte", design: "own", color: "black", shape: "circle",
  w: 10, h: 10, qty: 10, name: "Иван", contact: "@ivan_2281",
  delivery: "Москва, СДЭК", comment: "нужно к пятнице", client_total: 4100
};

function miniAppUpdate(order) {
  return {
    update_id: 7001,
    message: {
      message_id: 11,
      from: { id: 777001, is_bot: false, first_name: "Пётр", username: "petr" },
      chat: { id: 777001, type: "private" },
      date: Math.floor(Date.now() / 1000),
      web_app_data: { data: JSON.stringify(order), button_text: "Отправить" }
    }
  };
}

server.startServer();

setTimeout(function () { main(); }, 200);

function main() {
  var port = server.server.address().port;
  say("\nОдин бот — один потребитель обновлений (порт " + port + ")\n");

  var chain = Promise.resolve();

  /* 1. Очередь занята: сервер понимает это и не spamит лог. */
  chain = chain.then(function () {
    say("1. Очередь getUpdates занята другим потребителем");
    return wait(400).then(function () { return health(port); }).then(function (h) {
      check("сервер зафиксировал 409, а не сделал вид, что всё хорошо", function () {
        assert.ok(server.updates().conflicts >= 1, "конфликтов: " + server.updates().conflicts);
        assert.strictEqual(h.updates, "poll");
      });
      check("в логе сказано, кто именно держит очередь", function () {
        var text = logText();
        assert.ok(text.indexOf("409") !== -1, "нет упоминания 409");
        assert.ok(text.indexOf("другой потребитель") !== -1, "не сказано, что очередь занята");
        assert.ok(text.indexOf("GitHub Actions") !== -1, "не названы виновники");
        assert.ok(text.indexOf("вкладка bot.html") !== -1, "не названы виновники");
      });
      check("сервер не забивает лог: повтор не раньше, чем через паузу", function () {
        var conflictLines = logs.filter(function (line) { return line.indexOf("другой потребитель") !== -1; });
        assert.strictEqual(conflictLines.length, 1, "подробное сообщение печатается один раз, а не на каждый 409");
      });
      check("заявки с сайта при занятой очереди всё равно доходят (напрямую модератору)", function () {
        assert.ok(logText().indexOf("напрямую") !== -1, "нет подсказки про заявки с сайта");
      });
    });
  });

  /* 2. /api/health — сигнал для бота на GitHub Actions и панели. */
  chain = chain.then(function () {
    say("\n2. /api/health: «обновления забираю я»");
    return health(port).then(function (h) {
      check("в ответе есть подробности приёма обновлений", function () {
        assert.strictEqual(h.updates_detail.mode, "poll");
        assert.strictEqual(h.updates_detail.alive, true);
        assert.ok(h.updates_detail.conflict_age_ms !== null, "нет возраста последнего 409");
        assert.ok(h.updates_detail.conflicts >= 1);
      });
      check("признак «сервер сам принимает обновления» выставлен", function () {
        assert.strictEqual(h.takes_updates, true);
        assert.strictEqual(Core.serverTakesUpdates(h), true);
      });
      check("здоровье читается с любого сайта (иначе панель не проверит)", function () {
        return realFetch("http://127.0.0.1:" + port + "/api/health").then(function (r) {
          assert.strictEqual(r.headers.get("access-control-allow-origin"), "*");
        });
      });
    });
  });

  /* 3. --doctor объясняет, кто забирает обновления. */
  chain = chain.then(function () {
    say("\n3. node server.js --doctor");
    logs.length = 0;
    return server.doctor().then(function () {
      check("доктор говорит, что очередь занята, и что с этим делать", function () {
        var text = logText();
        assert.ok(text.indexOf("занята") !== -1, text.slice(0, 200));
        assert.ok(text.indexOf("SERVER_URL") !== -1, "не подсказано, как заставить Actions уступать");
      });
    });
  });

  /* 4. Очередь освободилась — сервер забирает её сам. */
  chain = chain.then(function () {
    say("\n4. Очередь освободилась");
    holder.conflict = false;
    queue.push(miniAppUpdate(ORDER));
    calls.length = 0;
    return wait(500).then(function () {
      check("сервер вернулся к приёму обновлений", function () {
        assert.ok(logText().indexOf("очередь свободна") !== -1, "нет сообщения о возврате");
      });
      check("заявка из Mini App дошла до модератора", function () {
        var sent = lastToModerator();
        assert.ok(sent, "sendMessage модератору не вызывался");
        assert.ok(sent.body.text.indexOf("Иван") !== -1, "заявка без имени");
      });
      return health(port).then(function (h) {
        check("здоровье показывает свежий успешный опрос", function () {
          assert.strictEqual(h.updates_detail.alive, true);
          assert.ok(h.updates_detail.last_ok_age_ms !== null, "нет last_ok_age_ms");
          assert.ok(h.updates_detail.last_ok_age_ms < 5000, "возраст: " + h.updates_detail.last_ok_age_ms);
        });
      });
    });
  });

  /* 5. Появился вебхук — спорить за getUpdates больше незачем. */
  chain = chain.then(function () {
    say("\n5. Появился вебхук (его поставил другой сервер)");
    holder.conflict = true;
    holder.webhookUrl = "https://other.example.com/api/tg-webhook";
    return wait(1500).then(function () {
      calls.length = 0;
      return wait(500).then(function () {
        check("сервер переключился на вебхук и остановил опрос", function () {
          assert.strictEqual(server.updates().mode, "webhook");
          assert.ok(logText().indexOf("опрос останавливаю") !== -1, "нет сообщения об остановке");
          assert.strictEqual(calls.length, 0, "опрос продолжается: " + calls.length + " запросов");
        });
        return health(port).then(function (h) {
          check("здоровье показывает вебхук", function () {
            assert.strictEqual(h.updates, "webhook");
            assert.strictEqual(h.updates_detail.alive, true);
            assert.strictEqual(Core.serverTakesUpdates(h), true);
          });
        });
      });
    });
  });

  chain.then(function () {
    say("\n" + (failures ? "ПРОВАЛЕНО ПРОВЕРОК: " + failures : "Все проверки пройдены ✅") + "\n");
    process.exit(failures ? 1 : 0);
  }).catch(function (error) {
    say("\nТест упал: " + (error && error.stack || error));
    process.exit(1);
  });
}
