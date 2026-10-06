#!/usr/bin/env node
"use strict";
/* ============================================================================
   Сквозная проверка приёма заказов — «бот работает правильно?»

   Запуск:  node tests/e2e.js   (или npm run test:e2e)

   Telegram не нужен: запросы к api.telegram.org перехватываются заглушкой,
   которая записывает вызовы и умеет отвечать ошибкой. Проверяем три пути,
   которыми заявка может попасть к модератору:

     1. сайт      — POST /api/order на настоящий http-сервер;
     2. mini app  — tg.sendData() → update с web_app_data → getUpdates/webhook;
     3. вебхук    — POST /api/tg-webhook с секретом.

   И отдельно — что при неисправном боте заявка НЕ выглядит отправленной.
   ========================================================================= */

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var http = require("http");

var ROOT = path.join(__dirname, "..");

/* --- заглушка Telegram до загрузки сервера ------------------------------- */

var calls = [];          // вызовы Bot API с момента последней очистки
var log = [];            // журнал всех вызовов — не очищается (для проверок старта)
var reply = { ok: true, error_code: 0, description: "OK" };
var pending = [];        // очередь обновлений для getUpdates
var registeredWebhook = "";
var realFetch = globalThis.fetch;

globalThis.fetch = function (url, options) {
  var method = String(url).replace(/^.*\//, "");
  var entry = { method: method, body: JSON.parse((options && options.body) || "{}") };
  calls.push(entry);
  log.push(entry);
  if (method === "getMe") return json(reply.badToken ? fail(401, "Unauthorized") : ok({ id: 1, username: "testbot" }));
  if (method === "setWebhook") { registeredWebhook = entry.body.url || ""; return json(ok(true)); }
  if (method === "deleteWebhook") { registeredWebhook = ""; return json(ok(true)); }
  if (method === "getWebhookInfo") return json(ok({ url: registeredWebhook, pending_update_count: 0 }));
  if (method === "getUpdates") {
    var batch = pending.slice();
    pending = [];
    return json(ok(batch));
  }
  if (method === "sendMessage") return json(reply.badToken ? fail(401, "Unauthorized") : ok({ message_id: calls.length }));
  return json(ok({}));
};

function ok(result) { return { ok: true, result: result }; }
function fail(code, description) { return { ok: false, error_code: code, description: description }; }
function json(payload) {
  return Promise.resolve({
    ok: payload.ok, status: payload.ok ? 200 : (payload.error_code || 400),
    json: function () { return Promise.resolve(payload); },
    text: function () { return Promise.resolve(JSON.stringify(payload)); }
  });
}

/* --- конфигурация сервера под тесты -------------------------------------- */

process.env.BOT_TOKEN = "123456:TEST-TOKEN";
process.env.MODERATOR_ID = "7114829971";
process.env.DRY_RUN = "0";
process.env.LOG_ORDERS = "0";
process.env.WEBHOOK_SECRET = "test-secret";
/* Конфигурация как на хостинге: сервер сам ставит вебхук на своём адресе. */
process.env.WEBHOOK_AUTO = "1";
process.env.SERVER_URL = "https://test-orders.example.com";
process.env.POLL = "auto";
process.env.PORT = "0";

var server = require(path.join(ROOT, "server.js"));

var failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok   " + name); }
  catch (error) { failures++; console.log("  FAIL " + name + " → " + error.message); }
}
function lastSend() {
  for (var i = calls.length - 1; i >= 0; i--) if (calls[i].method === "sendMessage") return calls[i];
  return null;
}
function post(port, url, body, headers) {
  return realFetch("http://127.0.0.1:" + port + url, {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
    body: JSON.stringify(body)
  }).then(function (response) {
    return response.text().then(function (text) {
      var data = null;
      try { data = JSON.parse(text); } catch (e) { data = null; }
      return { status: response.status, data: data, text: text };
    });
  });
}

var ORDER = {
  v: 2, film: "matte", design: "own", color: "black", shape: "circle",
  w: 10, h: 10, qty: 10, name: "Иван", contact: "@ivan_2281",
  delivery: "Москва, СДЭК", comment: "нужно к пятнице", client_total: 4100
};

server.startServer();

setTimeout(function () { main(); }, 300);

function main() {
  var port = server.server.address().port;
  console.log("\nСквозная проверка приёма заказов (порт " + port + ")\n");

  var chain = Promise.resolve();

  /* 1. Заявка с сайта по HTTP. */
  chain = chain.then(function () {
    console.log("1. Заявка с сайта → POST /api/order");
    calls.length = 0;
    return post(port, "/api/order", ORDER).then(function (res) {
      check("сервер ответил ok и номером заявки", function () {
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.ok, true);
        assert.ok(/^\d{6}-[0-9A-F]{4}\d{2}$/.test(res.data.order_id), "номер: " + res.data.order_id);
        assert.strictEqual(res.data.total, 4100);
      });
      var sent = lastSend();
      check("sendMessage ушёл модератору " + process.env.MODERATOR_ID, function () {
        assert.ok(sent, "sendMessage не вызывался");
        assert.strictEqual(String(sent.body.chat_id), process.env.MODERATOR_ID);
      });
      check("в заявке есть имя, контакт, размер и цена", function () {
        var text = sent.body.text.replace(/\u00A0/g, " ");   /* в сумме — неразрывный пробел */
        assert.ok(text.indexOf("Иван") !== -1);
        assert.ok(text.indexOf("@ivan_2281") !== -1);
        assert.ok(text.indexOf("10 × 10 см") !== -1);
        assert.ok(text.indexOf("4 100 ₽") !== -1);
        assert.strictEqual(sent.body.parse_mode, "HTML");
      });
      check("текст не превышает лимит Telegram", function () {
        assert.ok(sent.body.text.length < 4096, sent.body.text.length + " символов");
      });
    });
  });

  /* 2. Заявка из Mini App: сайт вызвал tg.sendData, update пришёл в getUpdates. */
  chain = chain.then(function () {
    console.log("\n2. Заявка из Mini App → getUpdates → web_app_data");
    calls.length = 0;
    pending.push({
      update_id: 501,
      message: {
        message_id: 10,
        from: { id: 777001, is_bot: false, first_name: "Пётр", username: "petr" },
        chat: { id: 777001, type: "private" },
        date: Math.floor(Date.now() / 1000),
        web_app_data: { data: JSON.stringify(ORDER), button_text: "Отправить" }
      }
    });
    return server.handleUpdate(pending.pop()).then(function () {
      var sent = lastSend();
      check("заявка из Mini App дошла до модератора", function () {
        assert.ok(sent, "sendMessage не вызывался");
        assert.strictEqual(String(sent.body.chat_id), process.env.MODERATOR_ID);
        assert.ok(sent.body.text.indexOf("Иван") !== -1);
      });
      check("в заявке есть ссылка «написать клиенту»", function () {
        assert.ok(sent.body.text.indexOf("tg://user?id=777001") !== -1);
      });
    });
  });

  /* 3. Заявка из Mini App через вебхук. */
  chain = chain.then(function () {
    console.log("\n3. Заявка из Mini App → вебхук /api/tg-webhook");
    calls.length = 0;
    var update = {
      update_id: 502,
      message: {
        message_id: 11,
        from: { id: 777002, is_bot: false, first_name: "Анна" },
        chat: { id: 777002, type: "private" },
        date: Math.floor(Date.now() / 1000),
        web_app_data: { data: JSON.stringify(Object.assign({}, ORDER, { name: "Анна", contact: "+7 999 123-45-67" })) }
      }
    };
    return post(port, "/api/tg-webhook", update, { "X-Telegram-Bot-Api-Secret-Token": "test-secret" })
      .then(function (res) {
        check("вебхук принят", function () { assert.strictEqual(res.status, 200); });
        return new Promise(function (resolve) { setTimeout(resolve, 50); });
      })
      .then(function () {
        var sent = lastSend();
        check("заявка из вебхука дошла до модератора", function () {
          assert.ok(sent, "sendMessage не вызывался");
          assert.ok(sent.body.text.indexOf("Анна") !== -1);
          assert.ok(sent.body.text.indexOf("телефон") !== -1);
        });
      });
  });

  /* 4. Без секрета вебхук недоступен. */
  chain = chain.then(function () {
    console.log("\n4. Защита вебхука");
    calls.length = 0;
    return post(port, "/api/tg-webhook", { update_id: 503 }).then(function (res) {
      check("без секрета вебхук отвечает 403 и заявку не отправляет", function () {
        assert.strictEqual(res.status, 403);
        assert.strictEqual(lastSend(), null);
      });
    });
  });

  /* 5. Некорректная заявка не уходит модератору. */
  chain = chain.then(function () {
    console.log("\n5. Некорректная заявка");
    calls.length = 0;
    return post(port, "/api/order", Object.assign({}, ORDER, { contact: "" })).then(function (res) {
      check("отклонена с понятной ошибкой и без sendMessage", function () {
        assert.strictEqual(res.status, 502);
        assert.strictEqual(res.data.ok, false);
        assert.ok(res.data.error.indexOf("контакт") !== -1, res.data.error);
        assert.strictEqual(lastSend(), null);
      });
    });
  });

  /* 6. Сломанный бот: сайт должен получить ошибку, а не «успех». */
  chain = chain.then(function () {
    console.log("\n6. Недействительный токен бота");
    calls.length = 0;
    reply.badToken = true;
    return post(port, "/api/order", ORDER).then(function (res) {
      check("сервер вернул ok:false с подсказкой писать напрямую", function () {
        assert.strictEqual(res.status, 502);
        assert.strictEqual(res.data.ok, false);
        assert.ok(res.data.error.indexOf("t.me/ckot_23") !== -1, res.data.error);
      });
      reply.badToken = false;
    });
  });

  /* 7. Health и подсказки по ошибкам Telegram. */
  chain = chain.then(function () {
    console.log("\n7. Диагностика");
    return realFetch("http://127.0.0.1:" + port + "/api/health").then(function (r) { return r.json(); })
      .then(function (health) {
        check("/api/health показывает, куда уходят заявки", function () {
          assert.strictEqual(health.ok, true);
          assert.strictEqual(health.dry_run, false);
          assert.strictEqual(health.updates, "webhook");
          assert.strictEqual(health.order_path, "телеграм модератору");
        });
        check("вебхук зарегистрирован автоматически на адресе сервера", function () {
          var setWebhook = log.filter(function (c) { return c.method === "setWebhook"; })[0];
          assert.ok(setWebhook, "setWebhook не вызывался");
          assert.strictEqual(setWebhook.body.url, "https://test-orders.example.com/api/tg-webhook");
          assert.strictEqual(setWebhook.body.secret_token, "test-secret");
        });
        check("ошибки Telegram расшифровываются", function () {
          assert.ok(server.telegramHint(401, "Unauthorized").indexOf("@BotFather") !== -1);
          assert.ok(server.telegramHint(400, "Bad Request: chat not found").indexOf("MODERATOR_ID") !== -1);
          assert.ok(server.telegramHint(403, "Forbidden: bot was blocked by the user").indexOf("Start") !== -1);
        });
      });
  });

  /* 8. Проверки по исходникам: чтобы «ложный успех» не вернулся. */
  chain = chain.then(function () {
    console.log("\n8. Защита от ложного «заявка отправлена»");
    var html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    check("sendViaMiniApp работает только внутри Telegram", function () {
      var body = html.slice(html.indexOf("function sendViaMiniApp"), html.indexOf("function submit()"));
      assert.ok(body.indexOf("insideTelegram()") !== -1, "нет проверки insideTelegram()");
    });
    check("ответ сервера с ошибкой показывается клиенту", function () {
      var body = html.slice(html.indexOf("fetch(apiUrl(\"api/order\")"), html.indexOf("el.submit.addEventListener"));
      assert.ok(body.indexOf("reply.data.error") !== -1, "ошибка сервера игнорируется");
    });
    check("при недоступном сервере есть отправка заявки в Telegram готовым текстом", function () {
      assert.ok(html.indexOf("?text=") !== -1, "нет ссылки с текстом заявки");
      assert.ok(html.indexOf("showTelegramFallback(payload") !== -1, "запасной путь не вызывается");
      assert.ok(html.indexOf("function orderPlainText(payload)") !== -1, "нет текста заявки для ручной отправки");
    });
    check("нигде в исходниках нет токена бота", function () {
      /* Токен в коде = токен опубликован: сайт и репозиторий видны всем,
         а Telegram отзывает засветившиеся токены. Живой токен должен лежать
         только в .env (локально) или в GitHub Secrets (для Actions). */
      var files = ["index.html", "server.js", "bot.js", "env.js", "pricing.js", "orderlink.js",
        ".env.example", "render.yaml", "Dockerfile", "package.json"];
      var found = [];
      files.forEach(function (name) {
        var text;
        try { text = fs.readFileSync(path.join(ROOT, name), "utf8"); } catch (e) { return; }
        if (/\d{8,}:[A-Za-z0-9_-]{30,}/.test(text)) found.push(name);
      });
      assert.strictEqual(found.length, 0, "токен найден в: " + found.join(", ") + " — его нужно отозвать");
    });
    check("панель получает свои скрипты, а служебные файлы закрыты", function () {
      /* bot.html в браузере подключает pricing.js, orderlink.js, botcore.js и
         botpanel.js — если их закрыть, панель не заработает. */
      var deny = /var DENY_FILES = \[([^\]]+)\]/.exec(fs.readFileSync(path.join(ROOT, "server.js"), "utf8"));
      assert.ok(deny, "не нашёл список запрещённых файлов");
      var denied = deny[1];
      ["pricing.js", "orderlink.js", "botcore.js", "botpanel.js", "bot.html", "admin.html",
        "adminlock.js", "templates.js", "templatesync.js", "templates/catalog.js"].forEach(function (file) {
        assert.ok(denied.indexOf('"' + file.split("/").pop() + '"') === -1, file + " закрыт, а он нужен страницам");
      });
      ["server.js", "orders.jsonl", "env.js", "bot.js", "package.json"].forEach(function (file) {
        assert.ok(denied.indexOf('"' + file + '"') !== -1, file + " не закрыт от посетителей");
      });
    });
    check("в workflow токен берётся из секретов, а не из файла", function () {
      var workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/bot.yml"), "utf8");
      assert.ok(workflow.indexOf("secrets.BOT_TOKEN") !== -1, "токен не из секретов");
      assert.ok(!/\d{8,}:[A-Za-z0-9_-]{30,}/.test(workflow), "токен вписан в workflow");
    });
    check(".env и orders.jsonl исключены из git", function () {
      var ignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
      assert.ok(/^\.env$/m.test(ignore), ".env не в .gitignore");
      assert.ok(/orders\.jsonl/.test(ignore), "orders.jsonl не в .gitignore");
    });
  });

  /* 9. Проверка бота «по требованию» (то, что открывает владелец после деплоя). */
  chain = chain.then(function () {
    console.log("\n9. /api/tg-check");
    return realFetch("http://127.0.0.1:" + port + "/api/tg-check").then(function (r) { return r.json(); })
      .then(function (data) {
        check("показывает живого бота и не раскрывает токен", function () {
          assert.strictEqual(data.ok, true);
          assert.strictEqual(data.bot, "@testbot");
          assert.ok(JSON.stringify(data).indexOf("123456:TEST-TOKEN") === -1, "токен утёк в ответ!");
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
}
