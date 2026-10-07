#!/usr/bin/env node
"use strict";
/* ============================================================================
   Проверка галереи шаблонов (templates.js + templatesync.js).

   Запуск:  node tests/templates.js   (или npm run test:templates)

   GitHub подменяется заглушкой: интернет и токен не нужны. Проверяем:
     • id и настройки шаблона: подстановка, отсев мусора, русские названия;
     • что в каталог нельзя протащить чужой путь вместо фото;
     • файл каталога: записали → прочитали → то же самое;
     • слияние и порядок (новые сверху, без задвоений);
     • цену шаблона считает прайс, а не галерея;
     • архив для ручной загрузки: настоящий ZIP с картинками и каталогом;
     • публикацию через GitHub API: что грузится, что пропускается, что удаляется.
   ========================================================================= */

var assert = require("assert");
var fs = require("fs");
var path = require("path");

var ROOT = path.join(__dirname, "..");

var Pricing = require(path.join(ROOT, "pricing.js"));
var T = require(path.join(ROOT, "templates.js"));
var S = require(path.join(ROOT, "templatesync.js"));

var failures = 0;
var chain = Promise.resolve();
function check(name, fn) {
  chain = chain.then(function () {
    return Promise.resolve().then(fn).then(function () {
      console.log("  ok   " + name);
    }, function (error) {
      failures++;
      console.log("  FAIL " + name + " → " + (error && error.message || error));
    });
  });
}

function photoDataUrl(kind) {
  /* 1×1 пиксель — этого достаточно, чтобы проверить путь и тип файла. */
  var png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
  var jpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
  return kind === "png" ? png : jpeg;
}

function settings(over) {
  return Object.assign({ film: "matte", design: "catalog", color: "black", shape: "rectangle",
    width: 20, height: 15, quantity: 10 }, over || {});
}

function template(over) {
  return Object.assign({
    id: "kofeynya-open", title: "Кофейня: Open 24/7", note: "Витрина, 20 × 15 см",
    img: "templates/img/kofeynya-open.jpg", created: "2026-10-06T10:00:00.000Z",
    settings: settings()
  }, over || {});
}

/* --- заглушка GitHub API ------------------------------------------------- */

function makeGithub(options) {
  var opts = options || {};
  var repo = {};                       /* path → { sha, base64 } */
  (opts.files || []).forEach(function (file) {
    repo[file.path] = { sha: "sha-" + file.path, base64: file.base64 || S.textToBase64("старое") };
  });
  var log = [];

  function answer(status, payload) {
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status: status,
      json: function () { return Promise.resolve(payload); },
      text: function () { return Promise.resolve(JSON.stringify(payload)); }
    });
  }

  function fetchStub(url, init) {
    var method = (init && init.method) || "GET";
    var body = init && init.body ? JSON.parse(init.body) : null;
    var clean = String(url).split("?")[0];
    var tail = clean.replace("https://api.github.com/repos/o/r", "");
    log.push({ method: method, tail: tail, body: body });
    if (opts.unauthorized) return answer(401, { message: "Bad credentials" });
    if (tail === "") return answer(200, { full_name: "o/r", private: false, permissions: { push: true } });

    if (method === "GET" && tail === "/contents/templates/img") {
      var names = Object.keys(repo).filter(function (p) { return p.indexOf("templates/img/") === 0; });
      if (!names.length) return answer(404, { message: "Not Found" });
      return answer(200, names.map(function (p) {
        return { name: p.replace("templates/img/", ""), path: p, sha: repo[p].sha, size: 1234 };
      }));
    }
    if (method === "GET" && tail === "/contents/templates/catalog.js") {
      if (!repo["templates/catalog.js"]) return answer(404, { message: "Not Found" });
      return answer(200, { sha: repo["templates/catalog.js"].sha, content: repo["templates/catalog.js"].base64 });
    }
    if (method === "PUT") {
      var putPath = tail.replace("/contents/", "");
      repo[putPath] = { sha: "sha-" + putPath + "-new", base64: body.content };
      return answer(201, { commit: { sha: "commit-1" } });
    }
    if (method === "DELETE") {
      var delPath = tail.replace("/contents/", "");
      delete repo[delPath];
      return answer(200, { commit: { sha: "commit-2" } });
    }
    return answer(404, { message: "Not Found" });
  }

  return { fetch: fetchStub, repo: repo, log: log };
}

/* ========================================================================== */

console.log("\n1. Шаблон: id, название, настройки");
check("русское название превращается в адрес файла", function () {
  assert.strictEqual(T.slug("Кофейня: Open 24/7"), "kofeynya-open-24-7");
  assert.strictEqual(T.slug("Ёлка — Новый год!"), "elka-novyy-god");
});
check("id не повторяется", function () {
  assert.strictEqual(T.uniqueId("Кофейня", []), "kofeynya");
  assert.strictEqual(T.uniqueId("Кофейня", ["kofeynya"]), "kofeynya-2");
  assert.strictEqual(T.uniqueId("Кофейня", ["kofeynya", "kofeynya-2"]), "kofeynya-3");
});
check("недопустимые настройки заменяются, а не ломают галерею", function () {
  var clean = T.normalizeSettings({ film: "нет такой", design: "catalog", color: "полноцвет",
    shape: "круглая", width: 9999, height: -5, quantity: 7.6 });
  assert.strictEqual(clean.film, "matte");
  assert.strictEqual(clean.color, "black");
  assert.strictEqual(clean.shape, "rectangle");
  assert.strictEqual(clean.width, 500);
  assert.strictEqual(clean.height, 1);
  assert.strictEqual(clean.quantity, 8);
});
check("шаблон без названия или без фото не проходит", function () {
  assert.strictEqual(T.normalizeTemplate({ title: "", img: "templates/img/a.jpg" }), null);
  assert.strictEqual(T.normalizeTemplate({ title: "Есть", img: "" }), null);
});
check("чужой путь вместо фото отсекается", function () {
  ["../../etc/passwd", "https://злой-сайт/фото.jpg", "templates/img/../../secret.jpg",
    "templates/img/подкаталог/фото.jpg", "templates/img/фото.php"].forEach(function (bad) {
    assert.strictEqual(T.normalizeTemplate({ title: "Плохой", img: bad }), null, bad);
  });
});
check("фото из браузера (data:) принимается", function () {
  var item = T.normalizeTemplate({ title: "Из браузера", img: photoDataUrl("png") });
  assert.ok(item, "шаблон с data:-фото не принят");
  assert.strictEqual(T.extFromDataUrl(item.img), "png");
});
check("длинное название и описание обрезаются", function () {
  var item = T.normalizeTemplate({ title: new Array(200).join("я"), img: "templates/img/a.jpg" });
  assert.strictEqual(item.title.length, T.TITLE_MAX);
});
check("каталог из мусора не падает", function () {
  assert.deepStrictEqual(T.normalizeCatalog([null, 42, {}, template()]).length, 1);
  assert.deepStrictEqual(T.normalizeCatalog("не массив"), []);
});

console.log("\n2. Файл каталога: записали и прочитали");
check("каталог переживает запись и чтение", function () {
  var list = [template(), template({ id: "avto", title: "Авто: дракон", img: "templates/img/avto.jpg" })];
  var text = T.serializeCatalog(list);
  assert.ok(text.indexOf("globalThis.SITE_TEMPLATES") !== -1, "нет объявления каталога");
  assert.ok(text.indexOf("templates/img/avto.jpg") !== -1, "нет пути к фото");
  var back = T.parseCatalog(text);
  assert.strictEqual(back.length, 2);
  assert.strictEqual(back[0].id, "kofeynya-open");
  assert.deepStrictEqual(back[0].settings, settings());
});
check("битый файл каталога читается как пустой, а не роняет сайт", function () {
  assert.deepStrictEqual(T.parseCatalog("тут нет каталога"), []);
  assert.deepStrictEqual(T.parseCatalog("globalThis.SITE_TEMPLATES = [ { не json };"), []);
});
check("порядок: новые сверху", function () {
  var old = template({ id: "staryy", created: "2026-01-01T00:00:00.000Z" });
  var fresh = template({ id: "novyy", created: "2026-10-06T00:00:00.000Z" });
  assert.deepStrictEqual(T.sortCatalog([old, fresh]).map(function (t) { return t.id; }), ["novyy", "staryy"]);
});
check("слияние не задваивает шаблоны, а обновляет их", function () {
  var base = [template({ title: "Старое имя" }), template({ id: "avto", title: "Авто" })];
  var incoming = [template({ title: "Новое имя" })];
  var merged = T.mergeCatalog(base, incoming);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(T.findById(merged, "kofeynya-open").title, "Новое имя");
  assert.strictEqual(T.withoutIds(merged, ["avto"]).length, 1);
});

console.log("\n3. Галерея и прайс не расходятся");
check("настройки галереи перекладываются в формат прайса ядра", function () {
  var order = T.toOrder(settings({ width: 20, height: 15, quantity: 10 }));
  assert.strictEqual(order.w, 20);
  assert.strictEqual(order.h, 15);
  assert.strictEqual(order.qty, 10);
  assert.strictEqual(order.width, undefined);
});
check("цена шаблона считается прайсом, а не галереей", function () {
  function calculateFromPricing(config) { return Pricing.calculate(T.toOrder(config)); }
  var price = T.priceOf(settings({ width: 20, height: 15, quantity: 10 }), calculateFromPricing);
  assert.ok(price && price.total > 0, "цена не посчиталась");
  assert.strictEqual(price.total, Pricing.calculate({ film: "matte", design: "catalog", color: "black",
    shape: "rectangle", w: 20, h: 15, qty: 10 }).total);
});
check("галерея не считает цену сама", function () {
  assert.strictEqual(T.priceOf(settings(), null), null);
  assert.ok(!/rate\s*[:*]/.test(fs.readFileSync(path.join(ROOT, "templates.js"), "utf8")), "в галерее завелась ставка плёнки");
});
check("допустимые значения берутся из прайса, а не из своих списков", function () {
  var dicts = T.dictsFromPricing(Pricing);
  assert.deepStrictEqual(dicts.films, Pricing.FILMS.map(function (f) { return f.id; }));
  assert.deepStrictEqual(dicts.colors, Pricing.COLORS.map(function (c) { return c.id; }));
  assert.deepStrictEqual(dicts.designs, Pricing.DESIGNS.map(function (d) { return d.id; }));
});
check("шаблон подставляет в конструктор допустимые значения", function () {
  var item = T.normalizeTemplate(template({ settings: settings({ film: "gloss", design: "own" }) }));
  assert.strictEqual(item.settings.film, "gloss");
  assert.strictEqual(item.settings.design, "own");
});

console.log("\n4. Архив для ручной загрузки");
check("ZIP собирается: подпись, имена файлов, CRC", function () {
  assert.strictEqual(T.crc32(T.toBytes("123456789")), 0xCBF43926);   /* контрольное значение */
  var files = [
    { name: "templates/catalog.js", data: T.serializeCatalog([template()]) },
    { name: "templates/img/kofeynya-open.jpg", data: "фото" }
  ];
  var zip = T.buildZip(files, new Date(2026, 9, 6, 12, 0, 0));
  var head = Array.prototype.slice.call(zip.subarray(0, 4));
  assert.deepStrictEqual(head, [0x50, 0x4B, 0x03, 0x04], "нет подписи ZIP");
  var tail = Array.prototype.slice.call(zip.subarray(zip.length - 22, zip.length - 18));
  assert.deepStrictEqual(tail, [0x50, 0x4B, 0x05, 0x06], "нет конца каталога ZIP");
  var text = Buffer.from(zip).toString("utf8");
  assert.ok(text.indexOf("templates/catalog.js") !== -1);
  assert.ok(text.indexOf("templates/img/kofeynya-open.jpg") !== -1);
});
check("файлы в архиве — ровно то, что просили", function () {
  var zip = T.buildZip([{ name: "a.txt", data: "привет" }]);
  var buffer = Buffer.from(zip);
  var end = buffer.length - 22;
  assert.strictEqual(buffer.readUInt16LE(end + 10), 1, "в архиве не один файл");
  assert.ok(buffer.readUInt32LE(end + 12) > 0, "размер каталога нулевой");
});

console.log("\n5. Публикация в GitHub");
check("шаблон с data:-фото публикуется как файл в templates/img", function () {
  var github = makeGithub();
  var sync = S.createSync({ token: "ghp_test", owner: "o", repo: "r", branch: "main", fetch: github.fetch });
  var item = T.normalizeTemplate({ title: "Новый", img: photoDataUrl("png") });
  var base64 = S.base64FromDataUrl(item.img);
  return sync.publish({
    catalogText: T.serializeCatalog([item]),
    photos: [{ id: item.id, base64: base64, ext: "png", size: S.sizeFromDataUrl(item.img) }]
  }).then(function (result) {
    assert.deepStrictEqual(result.uploaded, ["novyy.png"]);
    assert.ok(github.repo["templates/img/novyy.png"], "фото не попало в репозиторий");
    assert.ok(github.repo["templates/catalog.js"], "каталог не обновился");
    assert.strictEqual(T.parseCatalog(S.base64ToText(github.repo["templates/catalog.js"].base64)).length, 1);
    assert.strictEqual(result.removed.length, 0);
  });
});
check("фото, которое не менялось, повторно не грузится", function () {
  var github = makeGithub({ files: [{ path: "templates/img/kofeynya-open.jpg" }] });
  var sync = S.createSync({ token: "ghp_test", owner: "o", repo: "r", fetch: github.fetch });
  return sync.publish({
    catalogText: T.serializeCatalog([template()]),
    photos: [{ id: "kofeynya-open", base64: "старое", ext: "jpg", size: 1234 }]
  }).then(function (result) {
    assert.deepStrictEqual(result.skipped, ["kofeynya-open"]);
    assert.strictEqual(result.uploaded.length, 0);
  });
});
check("заменённое фото грузится принудительно", function () {
  var github = makeGithub({ files: [{ path: "templates/img/kofeynya-open.jpg" }] });
  var sync = S.createSync({ token: "ghp_test", owner: "o", repo: "r", fetch: github.fetch });
  return sync.publish({
    catalogText: T.serializeCatalog([template()]),
    photos: [{ id: "kofeynya-open", base64: "новое", ext: "jpg", size: 1234, force: true }]
  }).then(function (result) {
    assert.deepStrictEqual(result.uploaded, ["kofeynya-open.jpg"]);
  });
});
check("фото, удалённое из галереи, убирается и из репозитория", function () {
  var github = makeGithub({ files: [
    { path: "templates/img/kofeynya-open.jpg" },
    { path: "templates/img/staroe.jpg" }
  ] });
  var sync = S.createSync({ token: "ghp_test", owner: "o", repo: "r", fetch: github.fetch });
  return sync.publish({
    catalogText: T.serializeCatalog([template()]),
    photos: [{ id: "kofeynya-open", base64: "старое", ext: "jpg", size: 1234 }]
  }).then(function (result) {
    assert.deepStrictEqual(result.removed, ["staroe.jpg"]);
    assert.ok(!github.repo["templates/img/staroe.jpg"], "лишнее фото осталось в репозитории");
  });
});
check("пустая галерея не стирает фото из репозитория", function () {
  var github = makeGithub({ files: [{ path: "templates/img/kofeynya-open.jpg" }] });
  var sync = S.createSync({ token: "ghp_test", owner: "o", repo: "r", fetch: github.fetch });
  return sync.publish({ catalogText: T.serializeCatalog([]), photos: [] }).then(function (result) {
    assert.strictEqual(result.removed.length, 0);
    assert.ok(github.repo["templates/img/kofeynya-open.jpg"], "фото пропало при пустом каталоге");
  });
});
check("проверка доступа говорит про право на запись", function () {
  var github = makeGithub();
  var sync = S.createSync({ token: "ghp_test", owner: "o", repo: "r", fetch: github.fetch });
  return sync.check().then(function (info) {
    assert.strictEqual(info.repo, "o/r");
    assert.strictEqual(info.canPush, true);
    assert.strictEqual(info.branch, "main");
  });
});
check("неверный токен объясняется по-человечески", function () {
  var github = makeGithub({ unauthorized: true });
  var sync = S.createSync({ token: "плохой", owner: "o", repo: "r", fetch: github.fetch });
  return sync.check().then(function () {
    throw new Error("ошибка не всплыла");
  }).catch(function (error) {
    assert.strictEqual(error.status, 401);
    assert.ok(/Токен GitHub не подошёл/.test(error.message), error.message);
  });
});
check("без токена понятно, что делать", function () {
  var sync = S.createSync({ token: "", owner: "o", repo: "r", fetch: makeGithub().fetch });
  return sync.check().then(function () {
    throw new Error("ошибка не всплыла");
  }).catch(function (error) {
    assert.ok(/токена GitHub/.test(error.message), error.message);
  });
});

console.log("\n6. Страницы и файлы");
check("главная страница загружает галерею шаблонов по необходимости", function () {
  var index = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  ["templates/catalog.js", "gallery-loader.js"].forEach(function (marker) {
    assert.ok(index.indexOf(marker) !== -1, "главная не подключает " + marker);
  });
  assert.ok(index.indexOf('id="templates-grid"') !== -1, "нет сетки для карточек");
  assert.strictEqual(index.indexOf('src="templates.js'), -1, "код каталога загружается заранее");
  assert.strictEqual(index.indexOf('src="gallery.js'), -1, "код галереи загружается заранее");
  /* Витрина спрятана в разметке: пока каталог пуст, на сайте пустых каркасов нет. */
  assert.ok(/id="templates"[^>]*hidden/.test(index), "витрина не спрятана, пока каталог пуст");
  var loader = fs.readFileSync(path.join(ROOT, "gallery-loader.js"), "utf8");
  assert.ok(loader.indexOf("templates.js?v=4") !== -1 && loader.indexOf("gallery.js?v=4") !== -1,
    "галерея не подгружает нужные модули при заполненном каталоге");
  assert.ok(fs.readFileSync(path.join(ROOT, "gallery.js"), "utf8").indexOf("section.hidden = true") !== -1,
    "пустой каталог должен прятать витрину");
  var admin = fs.readFileSync(path.join(ROOT, "admin.html"), "utf8");
  assert.ok(admin.indexOf('src="templatesync.js"') !== -1, "внутренние инструменты публикации не загрузились");
});
check("каталог пуст и демо-фото удалены", function () {
  assert.ok(fs.existsSync(path.join(ROOT, "templates", "catalog.js")), "нет файла каталога");
  var list = T.parseCatalog(fs.readFileSync(path.join(ROOT, "templates", "catalog.js"), "utf8"));
  assert.deepStrictEqual(list, [], "в публичном каталоге остались примеры");
  var imgDir = path.join(ROOT, "templates", "img");
  assert.ok(fs.existsSync(imgDir), "нет папки фото");
  var photos = fs.readdirSync(imgDir).filter(function (file) { return /\.(?:jpg|jpeg|png|webp)$/i.test(file); });
  assert.deepStrictEqual(photos, [], "в папке остались демо-фото");
});
check("галерея умеет показать опубликованный шаблон", function () {
  /* Один настоящий шаблон должен был бы отрисоваться: проверяем, что
     витрина читает каталог, строит карточку и подставляет настройки. */
  var gallery = fs.readFileSync(path.join(ROOT, "gallery.js"), "utf8");
  ["catalogFromGlobal", "templates-grid", "card(", "data-template", "applySettings"]
    .forEach(function (marker) {
      assert.ok(gallery.indexOf(marker) !== -1, "в галерее нет " + marker);
    });
  var list = T.parseCatalog(T.serializeCatalog([template()]));
  assert.strictEqual(list.length, 1, "шаблон не проходит нормализацию");
  assert.strictEqual(list[0].settings.film, "matte");
});
check("в админке есть галерея: фото, список и публикация", function () {
  var admin = fs.readFileSync(path.join(ROOT, "admin.html"), "utf8");
  ["gallery-card", "t-photo", "t-title", "t-film", "t-color", "t-save", "t-list",
    "t-zip", "t-publish", "t-load", "s-ghToken"].forEach(function (id) {
    assert.ok(admin.indexOf('id="' + id + '"') !== -1, "в админке нет элемента " + id);
  });
  assert.ok(admin.indexOf("templatesync.js") !== -1, "админка не подключает синхронизацию");
  assert.ok(admin.indexOf("compressPhoto") !== -1, "фото не сжимается в браузере");
  assert.ok(admin.indexOf("buildZip") !== -1, "нет архива для ручной загрузки");
});
check("в админке можно публиковать и одним кликом, и архивом", function () {
  var admin = fs.readFileSync(path.join(ROOT, "admin.html"), "utf8");
  assert.ok(admin.indexOf("Скачать архив для GitHub") !== -1, "нет кнопки архива");
  assert.ok(admin.indexOf("Опубликовать в GitHub") !== -1, "нет кнопки публикации");
  ["Add file", "Upload files", "Commit changes"].forEach(function (step) {
    assert.ok(admin.indexOf(step) !== -1, "нет шага ручной загрузки: " + step);
  });
});
check("токен GitHub хранится вместе с остальными настройками и шифруется", function () {
  var admin = fs.readFileSync(path.join(ROOT, "admin.html"), "utf8");
  assert.ok(admin.indexOf("ghToken") !== -1, "нет поля токена GitHub");
  assert.ok(/vault\.save\(settings/.test(admin), "настройки не идут через замок");
  assert.ok(!/localStorage\.setItem\([^)]*ghToken/.test(admin), "токен GitHub кладётся в хранилище напрямую");
});
check("шаблоны в админке не содержат токенов и паролей", function () {
  var admin = fs.readFileSync(path.join(ROOT, "admin.html"), "utf8");
  assert.ok(!/\d{8,}:[A-Za-z0-9_-]{30,}/.test(admin), "в админке завёлся токен бота");
  assert.ok(!/github_pat_[A-Za-z0-9_]{20,}/.test(admin), "в админке завёлся токен GitHub");
});
check("в каталоге нет опубликованных примеров", function () {
  var list = T.parseCatalog(fs.readFileSync(path.join(ROOT, "templates", "catalog.js"), "utf8"));
  assert.deepStrictEqual(list, [], "каталог должен быть пустым, пока владелец не опубликует шаблоны");
  var index = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.ok(index.indexOf("templates/catalog.js") !== -1, "главная должна читать каталог");
  assert.ok(index.indexOf("SITE_TEMPLATES") === -1, "каталог не объявляется вручную в разметке");
});
check("в галерее не бывает своих копий прайса и токенов", function () {
  var text = fs.readFileSync(path.join(ROOT, "templates.js"), "utf8")
    + fs.readFileSync(path.join(ROOT, "templatesync.js"), "utf8")
    + fs.readFileSync(path.join(ROOT, "gallery.js"), "utf8");
  assert.ok(!/rate:\s*\d/.test(text), "в шаблонах завелись ставки плёнки");
  assert.ok(!/\d{8,}:[A-Za-z0-9_-]{30,}/.test(text), "в шаблонах завёлся токен");
  assert.ok(!/password\s*[:=]\s*"/.test(text), "в шаблонах завёлся пароль");
});

chain.then(function () {
  console.log("\n" + (failures ? "ПРОВАЛЕНО ПРОВЕРОК: " + failures : "Все проверки пройдены ✅") + "\n");
  process.exit(failures ? 1 : 0);
}).catch(function (error) {
  console.error("\nТест упал: " + (error && error.stack || error));
  process.exit(1);
});
