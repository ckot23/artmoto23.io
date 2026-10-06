#!/usr/bin/env node
"use strict";
/* ============================================================================
   Сквозная проверка бота без сервера — «заявка с сайта дойдёт до модератора?»

   Запуск:  node tests/bot.js   (или npm run test:bot)

   Telegram подменяется заглушкой, интернет не нужен. Проверяем все три пути,
   которыми заявка попадает к боту, и что он пересылает её модератору:

     1. ссылка с сайта   — /start <параметр> из orderlink.js;
     2. Mini App         — update с web_app_data (tg.sendData);
     3. «Поделиться»     — сообщение с меткой #STICKERS:.

   Отдельно проверяется главное: формат, который собирает САМ САЙТ
   (index.html), бот понимает правильно — иначе заявки молча терялись бы.
   ========================================================================= */

var assert = require("assert");
var fs = require("fs");
var path = require("path");

var ROOT = path.join(__dirname, "..");

/* --- заглушка Telegram до загрузки бота ---------------------------------- */

var sent = [];                  /* куда и что бот отправил */
var updates = [];               /* очередь для getUpdates */
var failure = null;             /* если задано — sendMessage отвечает ошибкой */
var calls = [];                 /* какие методы Bot API вызывались */
var webhook = { url: "", last_error_message: "", last_error_date: 0 };
var serverHealth = null;        /* что отвечает /api/health сервера (null — не отвечает) */
var getUpdatesAnswer = null;    /* если задано — getUpdates отвечает этой ошибкой */
var realFetch = globalThis.fetch;

globalThis.fetch = function (url, options) {
  var method = String(url).replace(/^.*\//, "");
  var body = JSON.parse((options && options.body) || "{}");
  calls.push(method);
  if (method === "health") {
    /* Проверка сервера: он либо отвечает, либо недоступен. */
    if (!serverHealth) return Promise.reject(new TypeError("Failed to fetch"));
    return json(serverHealth);
  }
  if (method === "getMe") return json({ ok: true, result: { id: 1, username: "testbot" } });
  if (method === "getWebhookInfo") return json({ ok: true, result: webhook });
  if (method === "deleteWebhook") return json({ ok: true, result: true });
  if (method === "getUpdates") {
    if (getUpdatesAnswer) return json(getUpdatesAnswer);
    var batch = updates.slice();
    updates = [];
    return json({ ok: true, result: batch });
  }
  if (method === "sendMessage") {
    sent.push(body);
    if (failure) return json({ ok: false, error_code: failure.code, description: failure.description });
    return json({ ok: true, result: { message_id: sent.length } });
  }
  return json({ ok: true, result: {} });
};

function json(payload) {
  return Promise.resolve({
    ok: payload.ok, status: payload.ok ? 200 : (payload.error_code || 400),
    json: function () { return Promise.resolve(payload); },
    text: function () { return Promise.resolve(JSON.stringify(payload)); }
  });
}

/* --- конфигурация бота под тесты ----------------------------------------- */

process.env.BOT_TOKEN = "123456:TEST-TOKEN";
process.env.MODERATOR_ID = "7114829971";
process.env.PUBLIC_URL = "https://ckot23.github.io/artmoto23.io/";
process.env.DRY_RUN = "0";

var bot = require(path.join(ROOT, "bot.js"));
var L = require(path.join(ROOT, "orderlink.js"));

var failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok   " + name); }
  catch (error) { failures++; console.log("  FAIL " + name + " → " + error.message); }
}
function toModerator() {
  for (var i = sent.length - 1; i >= 0; i--) {
    if (String(sent[i].chat_id) === process.env.MODERATOR_ID) return sent[i];
  }
  return null;
}
function toClient(chatId) {
  for (var i = sent.length - 1; i >= 0; i--) {
    if (String(sent[i].chat_id) === String(chatId)) return sent[i];
  }
  return null;
}
function message(chatId, text, options) {
  var opts = options || {};
  return {
    update_id: opts.updateId || Math.floor(Math.random() * 100000),
    message: {
      message_id: 1,
      from: {
        id: chatId, is_bot: false,
        first_name: opts.firstName === undefined ? "Пётр" : opts.firstName,
        username: opts.username === undefined ? "petr_777" : opts.username
      },
      chat: { id: chatId, type: "private" },
      date: Math.floor(Date.now() / 1000),
      text: text,
      web_app_data: opts.webAppData ? { data: opts.webAppData, button_text: "Отправить" } : undefined
    }
  };
}

var ORDER = {
  film: "matte", design: "own", color: "black", shape: "circle",
  w: 10, h: 10, qty: 10, name: "Пётр", contact: "@petr_777",
  delivery: "Рига, СДЭК", comment: "нужно к пятнице", client_total: 4100
};

var chain = Promise.resolve();

/* 1. Ссылка с сайта: посетитель нажал «Отправить заявку боту». */
chain = chain.then(function () {
  console.log("\n1. Заявка из ссылки сайта → /start <параметр>");
  sent = [];
  var param = L.startParam(ORDER);
  return bot.handleUpdate(message(777001, "/start " + param)).then(function () {
    var toMod = toModerator();
    check("бот переслал заявку модератору", function () {
      assert.ok(toMod, "sendMessage модератору не вызывался");
      assert.ok(toMod.text.indexOf("Пётр") !== -1, "нет имени");
      assert.ok(toMod.text.indexOf("10 × 10 см") !== -1, "нет размера");
      /* В суммах — неразрывный пробел, поэтому сравниваем нормализованный текст. */
      assert.ok(toMod.text.replace(/\u00A0/g, " ").indexOf("4 100 ₽") !== -1, "нет цены");
    });
    check("цена посчитана ботом, а не взята из ссылки", function () {
      var P = require(path.join(ROOT, "pricing.js"));
      var expected = P.money(P.calculate(L.unpack(param)).total).replace(/\u00A0/g, " ");
      var plain = toMod.text.replace(/\u00A0/g, " ");
      assert.ok(plain.indexOf("Итого: " + expected) !== -1,
        "ожидали «" + expected + "», в заявке: " + plain.split("\n").slice(-6).join(" | "));
    });
    check("в заявке есть ссылка «написать клиенту»", function () {
      assert.ok(toMod.text.indexOf("tg://user?id=777001") !== -1);
    });
    check("клиент получил номер заявки и просьбу уточнить доставку", function () {
      var reply = toClient(777001);
      assert.ok(reply, "бот не ответил клиенту");
      assert.ok(/Заявка №\d{6}-/.test(reply.text), reply.text.slice(0, 120));
    });
  });
});

/* 2. Заявка с комментарием, которую посетитель отправил «Поделиться». */
chain = chain.then(function () {
  console.log("\n2. Заявка сообщением → #STICKERS:<данные>");
  sent = [];
  var text = "Заявка с сайта\n\nМатериал: Глянцевая\n\n" + L.toToken(ORDER);
  return bot.handleUpdate(message(777002, text, { username: "anna_k" })).then(function () {
    var toMod = toModerator();
    check("заявка дошла целиком, вместе с комментарием", function () {
      assert.ok(toMod, "sendMessage модератору не вызывался");
      assert.ok(toMod.text.indexOf("нужно к пятнице") !== -1, "потерялся комментарий");
      assert.ok(toMod.text.indexOf("@petr_777") !== -1, "потерялся контакт");
    });
  });
});

/* 3. Mini App: сайт вызвал tg.sendData(). */
chain = chain.then(function () {
  console.log("\n3. Заявка из Mini App → web_app_data");
  sent = [];
  return bot.handleUpdate(message(777003, "", { webAppData: JSON.stringify(ORDER) })).then(function () {
    var toMod = toModerator();
    check("заявка из Mini App дошла до модератора", function () {
      assert.ok(toMod, "sendMessage модератору не вызывался");
      assert.ok(toMod.text.indexOf("Пётр") !== -1);
      assert.ok(toMod.text.indexOf("нужно к пятнице") !== -1);
    });
    check("бот ответил клиенту в чате Telegram", function () {
      assert.ok(toClient(777003), "клиент не получил подтверждение");
    });
  });
});

/* 4. Клиент без @username: контакт берётся из профиля Telegram. */
chain = chain.then(function () {
  console.log("\n4. Посетитель без @username");
  sent = [];
  var param = L.startParam(Object.assign({}, ORDER, { name: "" }));
  return bot.handleUpdate(message(777004, "/start " + param, { username: "", firstName: "Иван" }))
    .then(function () {
      var toMod = toModerator();
      check("заявка всё равно дошла до модератора", function () {
        assert.ok(toMod, "sendMessage модератору не вызывался");
        assert.ok(toMod.text.indexOf("id777004") !== -1, "нет контакта из профиля");
      });
      check("модератор может написать клиенту прямо из заявки", function () {
        assert.ok(toMod.text.indexOf("tg://user?id=777004") !== -1);
      });
      check("имя взято из профиля Telegram", function () {
        assert.ok(toMod.text.indexOf("Иван") !== -1);
      });
    });
});

/* 5. Служебные команды и мусор. */
chain = chain.then(function () {
  console.log("\n5. Команды и защита от мусора");
  sent = [];
  return bot.handleUpdate(message(777005, "/id"))
    .then(function () {
      check("/id отвечает chat_id", function () {
        assert.ok(toClient(777005).text.indexOf("777005") !== -1);
      });
      return bot.handleUpdate(message(777005, "/start"));
    })
    .then(function () {
      check("/start показывает приветствие с адресом сайта", function () {
        var reply = toClient(777005);
        assert.ok(reply.text.indexOf("https://ckot23.github.io") !== -1, reply.text.slice(0, 120));
      });
      return bot.handleUpdate(message(777005, "просто болтовня"));
    })
    .then(function () {
      check("посторонний текст не превращается в заявку", function () {
        assert.strictEqual(toModerator(), null);
      });
      return bot.handleUpdate(message(777006, "/start " + L.base64url("9|m|o|k|r|1|1|1")));
    })
    .then(function () {
      check("заявка чужого формата не уходит модератору", function () {
        assert.strictEqual(toModerator(), null);
      });
    });
});

/* 6. Дополнения клиента (город, комментарий) пересылаются отдельно —
      но только от того, кто уже оформил заявку в этом проходе. */
chain = chain.then(function () {
  console.log("\n6. Дополнение к заявке");
  sent = [];
  return bot.handleUpdate(message(777007, "/start " + L.startParam(ORDER)))
    .then(function () {
      sent = [];
      return bot.handleUpdate(message(777007, "Рига, самовывоз, нужен макет с котиком"));
    })
    .then(function () {
    var toMod = toModerator();
    check("текст клиента переслан модератору как дополнение", function () {
      assert.ok(toMod, "модератор ничего не получил");
      assert.ok(toMod.text.indexOf("Дополнение") !== -1);
      assert.ok(toMod.text.indexOf("котиком") !== -1);
    });
    check("клиенту пришло подтверждение", function () {
      assert.ok(toClient(777007).text.indexOf("Передал") !== -1);
    });
  });
});

/* 7. Ошибка Telegram не теряется молча. */
chain = chain.then(function () {
  console.log("\n7. Сломанный токен");
  sent = [];
  failure = { code: 401, description: "Unauthorized" };
  return bot.handleUpdate(message(777008, "/start " + L.startParam(ORDER))).then(function () {
    failure = null;
    check("клиент узнаёт, что заявка не прошла", function () {
      var reply = toClient(777008);
      assert.ok(reply, "клиенту ничего не ответили");
      assert.ok(reply.text.indexOf("Не удалось передать заявку") !== -1, reply.text.slice(0, 120));
      assert.ok(reply.text.indexOf("t.me/ckot_23") !== -1, "нет запасного контакта");
    });
  });
});

/* 8. Режим GitHub Actions: один проход забирает накопившиеся команды. */
chain = chain.then(function () {
  console.log("\n8. Режим --once (GitHub Actions)");
  sent = [];
  updates = [
    message(777009, "/start " + L.startParam(ORDER), { updateId: 900001 }),
    message(777010, "/id", { updateId: 900002 })
  ];
  return bot.drainOnce({ once: true, budgetSeconds: 0 }).then(function (processed) {
    check("за один проход обработаны все обновления", function () {
      assert.strictEqual(processed, 2);
    });
    check("заявка из очереди ушла модератору", function () {
      assert.ok(toModerator(), "sendMessage модератору не вызывался");
    });
    check("очередь пуста и повторно не отдаётся", function () {
      assert.strictEqual(updates.length, 0);
    });
  });
});

/* 9. Главное: формат, который собирает сам сайт, бот понимает. */
chain = chain.then(function () {
  console.log("\n9. Сайт → бот: формат совпадает");
  var html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

  check("на сайте есть упаковка заявки и ссылка на бота", function () {
    assert.ok(html.indexOf("function packStart(order)") !== -1, "нет packStart");
    assert.ok(html.indexOf("meta name=\"tg-bot\"") !== -1, "нет meta tg-bot");
    assert.ok(html.indexOf("orderBotLink(payload)") !== -1, "кнопка бота не подключена");
  });

  check("параметр, собранный сайтом, бот читает без потерь", function () {
    var source = extractFunction(html, "function packStart(order) {");
    var packStart = new Function("return " + source)();
    var siteParam = packStart(ORDER);
    assert.ok(siteParam.length <= 64, "сайт собрал " + siteParam.length + " символов (лимит 64)");
    assert.ok(/^[A-Za-z0-9_-]+$/.test(siteParam), "недопустимые символы в параметре");
    var decoded = L.unpack(siteParam);
    assert.ok(decoded, "бот не смог разобрать параметр с сайта");
    assert.strictEqual(decoded.film, ORDER.film);
    assert.strictEqual(decoded.design, ORDER.design);
    assert.strictEqual(decoded.color, ORDER.color);
    assert.strictEqual(decoded.shape, ORDER.shape);
    assert.strictEqual(decoded.w, ORDER.w);
    assert.strictEqual(decoded.h, ORDER.h);
    assert.strictEqual(decoded.qty, ORDER.qty);
    assert.strictEqual(decoded.name, ORDER.name);
    assert.strictEqual(decoded.delivery, ORDER.delivery);
  });

  check("сборка сайта совпадает с orderlink.js посимвольно", function () {
    var source = extractFunction(html, "function packStart(order) {");
    var packStart = new Function("return " + source)();
    var orders = [
      ORDER,
      { film: "metallic", design: "logo", color: "gold", shape: "rounded", w: 300, h: 200, qty: 1, name: "Александра Петровна", delivery: "Москва, самовывоз из офиса", comment: "макет согласовать" },
      { film: "reflective", design: "catalog", color: "fullcolor", shape: "rectangle", w: 10.5, h: 7.5, qty: 100, name: "Иван", delivery: "Казань", comment: "срочно" },
      { film: "gloss", design: "text", color: "white", shape: "rectangle", w: 1, h: 1, qty: 10000, name: "Ян", delivery: "", comment: "" }
    ];
    orders.forEach(function (order) {
      assert.strictEqual(packStart(order), L.pack(order),
        "расходятся для " + JSON.stringify(order).slice(0, 80));
    });
  });

  check("текст заявки для «Поделиться» бот тоже понимает", function () {
    var source = extractFunction(html, "function orderPlainText(payload) {");
    var orderPlainText = new Function("FILMS", "DESIGNS", "COLORS", "SHAPE_NAMES", "trimNum", "money", "byId",
      "return " + source)([
        { id: "matte", name: "Матовая", rate: 5 },
        { id: "gloss", name: "Глянцевая", rate: 5.5 },
        { id: "transparent", name: "Прозрачная", rate: 6 },
        { id: "metallic", name: "Металлик", rate: 7 },
        { id: "reflective", name: "Светоотражающая", rate: 8 }
      ], [
        { id: "own", name: "Свой файл" }, { id: "text", name: "Надпись" },
        { id: "logo", name: "Макет под ключ" }, { id: "catalog", name: "Из каталога" }
      ], [
        { id: "black", name: "Чёрный" }, { id: "white", name: "Белый" }
      ], { rectangle: "Прямоугольник", rounded: "Скруглённая", circle: "Круглая" },
      function (v) { return String(v); }, function (v) { return v + " ₽"; },
      function (list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return list[0]; });
    var text = orderPlainText(ORDER);
    assert.ok(text.indexOf("Имя: Пётр") !== -1, text.slice(0, 120));
    assert.ok(text.indexOf("Материал: Матовая") !== -1);
    assert.ok(text.indexOf("Итого на сайте: 4100 ₽") !== -1);
  });
});

/* 10. Документация должна объяснять, что бот требует запуска. */
chain = chain.then(function () {
  console.log("\n10. Инструкция");
  var readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  check("в README есть раздел про бота без хостинга", function () {
    assert.ok(readme.indexOf("GitHub Actions") !== -1, "нет описания запуска через Actions");
    assert.ok(readme.indexOf("MODERATOR_ID") !== -1, "не сказано про секреты");
  });
  check("workflow лежит в репозитории", function () {
    var workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/bot.yml"), "utf8");
    assert.ok(workflow.indexOf("bot.js --once") !== -1, "workflow не запускает бота");
    assert.ok(workflow.indexOf("secrets.BOT_TOKEN") !== -1, "нет токена из секретов");
  });
});

/* 11. Один бот — один потребитель: если сервер сайта на связи и сам забирает
      обновления, бот уступает — иначе оба ловят 409 Conflict. */
chain = chain.then(function () {
  console.log("\n11. Сервер сайта и бот не спорят за getUpdates");
  bot.CONFIG.serverUrl = "https://orders.example.com";
  bot.CONFIG.force = false;
  bot.CONFIG.yieldToServer = true;
  calls.length = 0;
  updates = [message(777011, "/start " + L.startParam(ORDER), { updateId: 910001 })];
  serverHealth = { ok: true, updates: "poll", updates_detail: { mode: "poll", alive: true, last_ok_age_ms: 3000 } };
  return bot.drainOnce({ once: true }).then(function (processed) {
    check("живой сервер: бот пропускает запуск, а не спорит за очередь", function () {
      assert.strictEqual(processed, 0, "бот забрал обновления при работающем сервере");
      assert.ok(/сервер/.test(bot.lastRun().skipped), "причина: " + bot.lastRun().skipped);
      assert.strictEqual(calls.indexOf("getUpdates"), -1, "бот всё равно вызвал getUpdates");
    });

    /* Сервер жив, но обновления не принимает (POLL=0) — работать должен бот. */
    serverHealth = { ok: true, updates: "off", updates_detail: { mode: "off", alive: false } };
    calls.length = 0;
    updates = [message(777012, "/start " + L.startParam(ORDER), { updateId: 910002 })];
    return bot.drainOnce({ once: true }).then(function (processed2) {
      check("сервер обновления не принимает — бот работает сам", function () {
        assert.strictEqual(processed2, 1, "обработано: " + processed2);
        assert.ok(toModerator(), "заявка не ушла модератору");
      });

      /* Сервер не отвечает (выключен, спит) — забирает бот. */
      serverHealth = null;
      calls.length = 0;
      updates = [message(777013, "/start " + L.startParam(ORDER), { updateId: 910003 })];
      return bot.drainOnce({ once: true }).then(function (processed3) {
        check("сервер недоступен — бот забирает заявки", function () {
          assert.strictEqual(processed3, 1, "обработано: " + processed3);
        });
      });
    });
  });
});

/* 12. Вебхук: живой снимать нельзя — по нему работает сервер. */
chain = chain.then(function () {
  console.log("\n12. Вебхук сервера");
  bot.CONFIG.serverUrl = "";
  webhook = { url: "https://orders.example.com/api/tg-webhook", last_error_message: "", last_error_date: 0 };
  serverHealth = { ok: true, updates: "webhook", updates_detail: { mode: "webhook", alive: true } };
  calls.length = 0;
  updates = [];
  return bot.drainOnce({ once: true }).then(function (processed) {
    check("живой вебхук работающего сервера бот не снимает", function () {
      assert.strictEqual(processed, 0);
      assert.strictEqual(calls.indexOf("deleteWebhook"), -1, "бот снял чужой вебхук");
      assert.ok(/вебхук/.test(bot.lastRun().skipped), "причина: " + bot.lastRun().skipped);
    });

    /* Сломанный вебхук: Telegram не может доставить обновления. */
    webhook = {
      url: "https://old.example.com/api/tg-webhook",
      last_error_message: "Wrong response from the webhook: 404 Not Found",
      last_error_date: Math.floor(Date.now() / 1000) - 120
    };
    serverHealth = null;
    calls.length = 0;
    updates = [message(777014, "/start " + L.startParam(ORDER), { updateId: 910004 })];
    return bot.drainOnce({ once: true }).then(function (processed2) {
      check("сломанный вебхук бот снимает и забирает заявку", function () {
        assert.ok(calls.indexOf("deleteWebhook") !== -1, "старый вебхук не снят");
        assert.strictEqual(processed2, 1, "обработано: " + processed2);
      });
    });
  });
});

/* 13. Очередь занята: разовый бот уступает, а не тратит весь бюджет впустую. */
chain = chain.then(function () {
  console.log("\n13. Очередь getUpdates занята");
  webhook = { url: "", last_error_message: "", last_error_date: 0 };
  serverHealth = null;
  getUpdatesAnswer = {
    ok: false, error_code: 409,
    description: "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running"
  };
  calls.length = 0;
  var startedAt = Date.now();
  return bot.drainOnce({ once: true, conflictGiveUpMs: 100 }).then(function (processed) {
    getUpdatesAnswer = null;
    check("при 409 бот быстро уступает и завершает запуск", function () {
      assert.strictEqual(processed, 0);
      assert.ok(/другой потребитель/.test(bot.lastRun().skipped), "причина: " + bot.lastRun().skipped);
      assert.ok(bot.lastRun().conflicts >= 2, "конфликтов: " + bot.lastRun().conflicts);
      assert.ok(Date.now() - startedAt < 10000, "спор занял " + (Date.now() - startedAt) + " мс");
    });
  });
});

/* --- вспомогательное: достать функцию из index.html целиком -------------- */

function extractFunction(source, marker) {
  var start = source.indexOf(marker);
  if (start === -1) throw new Error("в index.html не найдена " + marker);
  var depth = 0;
  for (var i = start; i < source.length; i++) {
    var ch = source.charAt(i);
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("не закрыта " + marker);
}

chain.then(function () {
  console.log("\n" + (failures ? "ПРОВАЛЕНО ПРОВЕРОК: " + failures : "Все проверки пройдены ✅") + "\n");
  process.exit(failures ? 1 : 0);
}).catch(function (error) {
  console.error("\nТест упал: " + (error && error.stack || error));
  process.exit(1);
});
