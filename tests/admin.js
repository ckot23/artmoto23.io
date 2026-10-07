#!/usr/bin/env node
"use strict";
/* ============================================================================
   Проверка входа в админку по паролю.

   Запуск:  node tests/admin.js   (или npm run test:admin)

   Проверяем:
     • пароль не хранится ни в одном файле (в браузере — только отпечаток);
     • токен в настройках лежит зашифрованным и без пароля не читается;
     • неверный пароль не пускает, 5 попыток → временная блокировка;
     • смена пароля перешифровывает настройки, старый пароль перестаёт работать;
     • страницы админки и панели требуют вход, в коде нет пароля-«заглушки»;
     • сессия живёт только во вкладке (закрыли вкладку — вход заново).
   ========================================================================= */

var assert = require("assert");
var fs = require("fs");
var path = require("path");

var ROOT = path.join(__dirname, "..");
var A = require(path.join(ROOT, "adminlock.js"));

var failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok   " + name); }
  catch (error) { failures++; console.log("  FAIL " + name + " → " + error.message); }
}
function checkAsync(name, fn) {
  return Promise.resolve().then(fn).then(function () {
    console.log("  ok   " + name);
  }, function (error) {
    failures++;
    console.log("  FAIL " + name + " → " + error.message);
  });
}

var SETTINGS = { token: "1234567890:AAF-TEST-TOKEN-VALUE", moderator: "7114829971", publicUrl: "https://example.com/" };
var PASSWORD = "мой-пароль-2026";
var FAST = { iterations: 1000 };          /* в тестах — меньше итераций, быстрее */

function newVault(extra) {
  var storage = A.memoryStorage();
  var session = A.memoryStorage();
  var vault = A.createVault(Object.assign({
    storage: storage, session: session, iterations: FAST.iterations, maxAttempts: 5, lockMs: 1000
  }, extra || {}));
  return { vault: vault, storage: storage, session: session };
}

var chain = Promise.resolve();

/* 1. Криптография. */
chain = chain.then(function () {
  console.log("\n1. Пароль и шифрование");
  return checkAsync("отпечаток пароля не совпадает с самим паролем", function () {
    return A.makePasswordRecord(PASSWORD, FAST).then(function (record) {
      assert.strictEqual(record.hash.indexOf(PASSWORD), -1, "пароль виден в отпечатке");
      assert.ok(record.salt && record.hash && record.iterations, "нет соли или хеша");
    });
  });
});

chain = chain.then(function () {
  return checkAsync("верный пароль проходит проверку, неверный — нет", function () {
    return A.makePasswordRecord(PASSWORD, FAST).then(function (record) {
      return Promise.all([
        A.verifyPassword(PASSWORD, record),
        A.verifyPassword("другой-пароль", record),
        A.verifyPassword("", record)
      ]);
    }).then(function (results) {
      assert.deepStrictEqual(results, [true, false, false]);
    });
  });
});

chain = chain.then(function () {
  return checkAsync("токен расшифровывается только своим паролем", function () {
    return A.encryptText("секрет", PASSWORD, FAST).then(function (payload) {
      assert.strictEqual(payload.indexOf("секрет"), -1, "текст не зашифрован");
      return A.decryptText(payload, PASSWORD, FAST).then(function (text) {
        assert.strictEqual(text, "секрет");
        return A.decryptText(payload, "не тот пароль", FAST).then(function () {
          throw new Error("чужим паролем расшифровалось!");
        }, function (error) {
          assert.strictEqual(error.message, "Неверный пароль");
        });
      });
    });
  });
});

chain = chain.then(function () {
  return checkAsync("два шифрования одного текста дают разные шифры (случайный iv)", function () {
    return Promise.all([
      A.encryptText("секрет", PASSWORD, FAST),
      A.encryptText("секрет", PASSWORD, FAST)
    ]).then(function (pair) {
      assert.notStrictEqual(pair[0], pair[1]);
    });
  });
});

/* 2. Хранилище настроек. */
chain = chain.then(function () {
  console.log("\n2. Настройки администратора");
  var t = newVault();
  return checkAsync("сначала пароля нет, потом появляется", function () {
    assert.strictEqual(t.vault.hasPassword(), false);
    return t.vault.setup(PASSWORD, SETTINGS).then(function () {
      assert.strictEqual(t.vault.hasPassword(), true);
    });
  }).then(function () {
    return checkAsync("токен не лежит в браузере открытым текстом", function () {
      var raw = t.storage.getItem(A.KEY);
      assert.ok(raw, "настройки не сохранены");
      assert.strictEqual(raw.indexOf(SETTINGS.token), -1, "токен виден в хранилище!");
      assert.strictEqual(raw.indexOf(PASSWORD), -1, "пароль виден в хранилище!");
      assert.ok(raw.indexOf("secret") !== -1 && raw.indexOf("pass") !== -1, "не тот формат записи");
    });
  }).then(function () {
    return checkAsync("вход возвращает сохранённые настройки", function () {
      return t.vault.unlock(PASSWORD).then(function (opened) {
        assert.strictEqual(opened.settings.token, SETTINGS.token);
        assert.strictEqual(opened.settings.moderator, SETTINGS.moderator);
      });
    });
  }).then(function () {
    return checkAsync("короткий пароль не принимается", function () {
      var other = newVault();
      return other.vault.setup("12345", SETTINGS).then(function () {
        throw new Error("короткий пароль приняли");
      }, function (error) {
        assert.ok(error.message.indexOf("6 символов") !== -1, error.message);
      });
    });
  });
});

/* 3. Блокировка после неверных попыток. */
chain = chain.then(function () {
  console.log("\n3. Защита от подбора пароля");
  var t = newVault();
  return t.vault.setup(PASSWORD, SETTINGS).then(function () {
    var attempts = [];
    var chainInside = Promise.resolve();
    for (var i = 0; i < 5; i++) {
      chainInside = chainInside.then(function () {
        return t.vault.unlock("неверный").catch(function (error) { attempts.push(error.message); });
      });
    }
    return chainInside.then(function () {
      return checkAsync("после 5 попыток вход блокируется", function () {
        assert.ok(attempts[0].indexOf("Осталось попыток: 4") !== -1, attempts[0]);
        assert.ok(attempts[4].indexOf("заблокирован") !== -1, attempts[4]);
        assert.strictEqual(t.vault.isLocked(), true);
        assert.ok(t.vault.lockedSeconds() > 0);
        return t.vault.unlock(PASSWORD).then(function () {
          throw new Error("пустили во время блокировки");
        }, function (error) {
          assert.ok(error.message.indexOf("Подождите") !== -1, error.message);
        });
      });
    });
  });
});

chain = chain.then(function () {
  var now = 1000;
  var storage = A.memoryStorage();
  var t = A.createVault({
    storage: storage, session: A.memoryStorage(), iterations: FAST.iterations,
    maxAttempts: 2, lockMs: 1000, now: function () { return now; }
  });
  return t.setup(PASSWORD, SETTINGS).then(function () {
    /* две неудачные попытки (лимит в этом хранилище — 2) → блокировка */
    return t.unlock("плохо").catch(function () {}).then(function () {
      return t.unlock("плохо").catch(function () {});
    });
  }).then(function () {
    now += 1500;                                  /* время прошло */
    return checkAsync("после паузы вход снова работает", function () {
      assert.strictEqual(t.isLocked(), false);
      return t.unlock(PASSWORD).then(function (opened) {
        assert.strictEqual(opened.settings.token, SETTINGS.token);
      });
    });
  });
});

/* 4. Смена пароля и сброс. */
chain = chain.then(function () {
  console.log("\n4. Смена пароля и сброс доступа");
  var t = newVault();
  return t.vault.setup(PASSWORD, SETTINGS).then(function () {
    return checkAsync("новый пароль работает, старый — нет", function () {
      return t.vault.changePassword(PASSWORD, "новый-пароль-2026").then(function () {
        return t.vault.unlock("новый-пароль-2026").then(function (opened) {
          assert.strictEqual(opened.settings.token, SETTINGS.token, "настройки потерялись при смене пароля");
          return t.vault.unlock(PASSWORD).then(function () {
            throw new Error("старый пароль всё ещё пускает");
          }, function (error) {
            assert.ok(error.message.indexOf("Неверный пароль") !== -1, error.message);
          });
        });
      });
    });
  }).then(function () {
    return checkAsync("сброс доступа стирает пароль и настройки", function () {
      t.vault.clear();
      assert.strictEqual(t.vault.hasPassword(), false);
      assert.strictEqual(t.storage.getItem(A.KEY), null);
      assert.strictEqual(t.vault.hasSession(), false);
    });
  });
});

/* 5. Сессия: живёт во вкладке. */
chain = chain.then(function () {
  console.log("\n5. Сессия вкладки");
  var t = newVault();
  return t.vault.setup(PASSWORD, SETTINGS).then(function () {
    return checkAsync("после входа настройки доступны в этой вкладке", function () {
      assert.strictEqual(t.vault.hasSession(), true);
      assert.strictEqual(t.vault.session().token, SETTINGS.token);
      assert.strictEqual(t.storage.getItem(A.KEY).indexOf(SETTINGS.token), -1, "токен попал в localStorage!");
    });
  }).then(function () {
    return checkAsync("выход закрывает сессию", function () {
      t.vault.closeSession();
      assert.strictEqual(t.vault.hasSession(), false);
      assert.strictEqual(t.vault.hasPassword(), true, "пароль должен остаться");
    });
  });
});

/* 6. Страницы админки. */
chain = chain.then(function () {
  console.log("\n6. Страницы");
  var admin = fs.readFileSync(path.join(ROOT, "admin.html"), "utf8");
  var panel = fs.readFileSync(path.join(ROOT, "bot.html"), "utf8");
  var lock = fs.readFileSync(path.join(ROOT, "adminlock.js"), "utf8");
  var index = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

  check("в админке есть экран входа и меню", function () {
    assert.ok(admin.indexOf('id="lock"') !== -1 && admin.indexOf('id="menu"') !== -1, "нет входа или меню");
    assert.ok(admin.indexOf("Войти") !== -1 && admin.indexOf("Сбросить доступ") !== -1);
  });
  check("меню админа ведёт в панель бота, настройки и смену пароля", function () {
    assert.ok(admin.indexOf('href="bot.html"') !== -1, "нет перехода в панель");
    assert.ok(admin.indexOf('id="show-settings"') !== -1, "нет настроек");
    assert.ok(admin.indexOf('id="show-password"') !== -1, "нет смены пароля");
  });
  check("панель бота тоже просит пароль", function () {
    assert.ok(panel.indexOf('id="lock"') !== -1, "панель открывается без пароля");
    assert.ok(panel.indexOf("vault.unlock") !== -1, "панель не проверяет пароль");
    assert.ok(panel.indexOf("AdminLock.createVault") !== -1, "панель не использует замок");
  });
  check("панель больше не хранит токен открытым текстом", function () {
    assert.strictEqual(panel.indexOf('id="token"'), -1, "в панели осталось поле токена");
    assert.strictEqual(panel.indexOf("localStorage.setItem"), -1, "панель пишет настройки в localStorage");
  });
  check("пароль не зашит в файлах", function () {
    ["admin.html", "bot.html", "adminlock.js", "botpanel.js", "botcore.js", "index.html"].forEach(function (file) {
      var text = fs.readFileSync(path.join(ROOT, file), "utf8");
      assert.ok(!/password\s*[:=]\s*["'][^"']+["']/.test(text.replace(/autocomplete="[^"]*"/g, "")),
        file + ": похоже на пароль, записанный в код");
    });
  });
  check("стойкость пароля заявлена честно: PBKDF2 150 000 итераций и AES-GCM", function () {
    assert.ok(lock.indexOf("PBKDF2") !== -1 && lock.indexOf("AES-GCM") !== -1);
    assert.ok(lock.indexOf("150000") !== -1, "не задано число итераций");
    assert.ok(lock.indexOf("SHA-256") !== -1);
  });
  check("публичная страница не раскрывает ссылку на внутреннюю админку", function () {
    assert.strictEqual(index.indexOf("admin.html"), -1, "главная страница ссылается на меню админа");
    assert.strictEqual(index.indexOf('href="bot.html"'), -1, "сайт ведёт прямо в панель, минуя пароль");
  });
  check("страницы админки закрыты от индексации", function () {
    assert.ok(admin.indexOf('name="robots" content="noindex"') !== -1);
    assert.ok(panel.indexOf('name="robots" content="noindex"') !== -1);
  });
});

chain.then(function () {
  console.log("\n" + (failures ? "ПРОВАЛЕНО ПРОВЕРОК: " + failures : "Все проверки пройдены ✅") + "\n");
  process.exit(failures ? 1 : 0);
}).catch(function (error) {
  console.error("\nТест упал: " + (error && error.stack || error));
  process.exit(1);
});
