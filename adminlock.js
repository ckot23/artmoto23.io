#!/usr/bin/env node
"use strict";
/* ============================================================================
   Замок админки: вход по паролю и шифрование токена бота.

   Что это даёт:
     • пароль НЕ хранится в файлах — его задаёте вы сами на своём устройстве,
       хранится только «отпечаток» (PBKDF2-SHA256, 150 000 итераций + соль);
     • токен бота лежит в localStorage зашифрованным (AES-GCM), ключ выводится
       из пароля — без пароля файл настроек ничего не значит;
     • после 5 неверных попыток вход блокируется на минуту.

   Чего это не даёт (важно понимать):
     • страница статическая, поэтому пароль защищает доступ на устройстве, а не
       «читаемость» кода: секрета в исходниках нет, но и охранять нечего, кроме
       ваших настроек. Настоящий ключ от бота — сам токен, и он не уходит никуда,
       кроме api.telegram.org;
     • если токен попал к кому-то ещё, пароль не поможет: токен нужно отозвать
       у @BotFather.

   Работает и в браузере (WebCrypto), и в Node 18+ (globalThis.crypto.subtle) —
   поэтому проверяется тестами без запуска браузера.
   ========================================================================= */

var KEY = "stickers:admin:v1";
var SESSION_KEY = "stickers:session:v1";

var DEFAULTS = {
  iterations: 150000,
  maxAttempts: 5,
  lockMs: 60 * 1000
};

/* Есть ли в этом окружении WebCrypto. Нужен https (или localhost) и браузер
   посвежее: на http-страницах браузеры его не дают. */
function isAvailable() {
  try {
    return Boolean(globalThis.crypto && globalThis.crypto.subtle && globalThis.crypto.getRandomValues);
  } catch (e) {
    return false;
  }
}

var UNAVAILABLE = "Вход по паролю требует https и современный браузер. "
  + "Откройте страницу по адресу https://… (не http://) или в другом браузере.";

function cryptoApi() {
  var api = (typeof globalThis !== "undefined" && globalThis.crypto) || null;
  if (!api || !api.subtle) throw new Error(UNAVAILABLE);
  return api;
}

/* --- кодирование ---------------------------------------------------------- */

function bytesToBase64(bytes) {
  var out = "";
  if (typeof Buffer !== "undefined" && Buffer.from) return Buffer.from(bytes).toString("base64");
  for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return btoa(out);
}

function base64ToBytes(text) {
  if (typeof Buffer !== "undefined" && Buffer.from) return Buffer.from(text, "base64");
  var binary = atob(text);
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text) {
  var value = String(text).replace(/-/g, "+").replace(/_/g, "/");
  while (value.length % 4) value += "=";
  return base64ToBytes(value);
}

function utf8(text) {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text);
  return new Uint8Array(Buffer.from(text, "utf8"));
}

function fromUtf8(bytes) {
  if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(bytes);
  return Buffer.from(bytes).toString("utf8");
}

function randomBytes(length) {
  var api = cryptoApi();
  var bytes = new Uint8Array(length);
  api.getRandomValues(bytes);
  return bytes;
}

/* Сравнение без «раннего выхода» — чтобы по времени ответа нельзя было
   подбирать пароль посимвольно. */
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* --- криптография --------------------------------------------------------- */

function deriveBits(password, salt, iterations) {
  var api = cryptoApi();
  return api.subtle.importKey("raw", utf8(String(password)), { name: "PBKDF2" }, false, ["deriveBits"])
    .then(function (baseKey) {
      return api.subtle.deriveBits({
        name: "PBKDF2",
        salt: salt,
        iterations: iterations,
        hash: "SHA-256"
      }, baseKey, 256);
    })
    .then(function (bits) { return new Uint8Array(bits); });
}

function deriveKey(password, salt, iterations) {
  var api = cryptoApi();
  return api.subtle.importKey("raw", utf8(String(password)), { name: "PBKDF2" }, false, ["deriveKey"])
    .then(function (baseKey) {
      return api.subtle.deriveKey({
        name: "PBKDF2",
        salt: salt,
        iterations: iterations,
        hash: "SHA-256"
      }, baseKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    });
}

/* Отпечаток пароля: соль + итерации + хеш. Сам пароль не сохраняется. */
function makePasswordRecord(password, options) {
  var opts = options || {};
  var iterations = opts.iterations || DEFAULTS.iterations;
  var salt = opts.salt || randomBytes(16);
  return deriveBits(password, salt, iterations).then(function (hash) {
    return {
      v: 1,
      salt: toBase64Url(salt),
      iterations: iterations,
      hash: toBase64Url(hash)
    };
  });
}

function verifyPassword(password, record) {
  if (!record || !record.salt || !record.hash) return Promise.resolve(false);
  return deriveBits(password, fromBase64Url(record.salt), record.iterations || DEFAULTS.iterations)
    .then(function (hash) {
      return sameBytes(hash, fromBase64Url(record.hash));
    })
    .catch(function () { return false; });
}

/* Шифруем настройки паролем: строка вида v1.<соль>.<iv>.<шифр> */
function encryptText(plainText, password, record) {
  var opts = record || {};
  var iterations = opts.iterations || DEFAULTS.iterations;
  var salt = opts.salt ? fromBase64Url(opts.salt) : randomBytes(16);
  var iv = randomBytes(12);
  return deriveKey(password, salt, iterations).then(function (key) {
    return cryptoApi().subtle.encrypt({ name: "AES-GCM", iv: iv }, key, utf8(plainText));
  }).then(function (cipher) {
    return ["v1", toBase64Url(salt), toBase64Url(iv), toBase64Url(new Uint8Array(cipher))].join(".");
  });
}

/* record — запись пароля: из неё берём число итераций, иначе ключ не сойдётся
   (итерации настраиваются, в тестах они меньше ради скорости). */
function decryptText(payload, password, record) {
  var parts = String(payload || "").split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    return Promise.reject(new Error("Настройки повреждены: не удалось прочитать формат"));
  }
  var salt = fromBase64Url(parts[1]);
  var iv = fromBase64Url(parts[2]);
  var cipher = fromBase64Url(parts[3]);
  var iterations = (record && record.iterations) || DEFAULTS.iterations;
  return deriveKey(password, salt, iterations).then(function (key) {
    return cryptoApi().subtle.decrypt({ name: "AES-GCM", iv: iv }, key, cipher);
  }).then(function (plain) {
    return fromUtf8(new Uint8Array(plain));
  }).catch(function () {
    throw new Error("Неверный пароль");
  });
}

/* ---------------------------------------------------------------------------
   Хранилище: пароль + зашифрованные настройки
   ------------------------------------------------------------------------ */

function memoryStorage() {
  var data = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem: function (k, v) { data[k] = String(v); },
    removeItem: function (k) { delete data[k]; }
  };
}

function createVault(options) {
  var opts = options || {};
  var storage = opts.storage || (typeof localStorage !== "undefined" ? localStorage : memoryStorage());
  var session = opts.session || (typeof sessionStorage !== "undefined" ? sessionStorage : memoryStorage());
  var iterations = opts.iterations || DEFAULTS.iterations;
  var maxAttempts = opts.maxAttempts || DEFAULTS.maxAttempts;
  var lockMs = opts.lockMs || DEFAULTS.lockMs;
  var now = opts.now || function () { return Date.now(); };

  function read() {
    try {
      var raw = storage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function write(data) {
    try { storage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* приватный режим */ }
    return data;
  }

  function lockedFor() {
    var data = read();
    if (!data || !data.lockedUntil) return 0;
    return Math.max(0, data.lockedUntil - now());
  }

  /* Настройки, которые нужны боту: токен, chat_id, адрес сайта. */
  function saveSettings(settings, password) {
    var data = read();
    if (!data || !data.pass) return Promise.reject(new Error("Сначала задайте пароль"));
    return makePasswordRecord(password, { iterations: iterations, salt: fromBase64Url(data.pass.salt) })
      .then(function (record) {
        /* Соль та же, поэтому ключ выводится из того же пароля. */
        return encryptText(JSON.stringify(settings), password, record);
      })
      .then(function (secret) {
        data.secret = secret;
        data.attempts = 0;
        data.lockedUntil = 0;
        write(data);
        return true;
      });
  }

  return {
    /* Есть ли уже пароль на этом устройстве. */
    hasPassword: function () {
      var data = read();
      return Boolean(data && data.pass);
    },

    isLocked: function () { return lockedFor() > 0; },
    lockedSeconds: function () { return Math.ceil(lockedFor() / 1000); },

    /* Первый запуск: задаём пароль и (необязательно) сразу настройки. */
    setup: function (password, settings) {
      if (String(password || "").length < 6) {
        return Promise.reject(new Error("Пароль должен быть не короче 6 символов"));
      }
      return makePasswordRecord(password, { iterations: iterations }).then(function (record) {
        write({ v: 1, pass: record, secret: null, attempts: 0, lockedUntil: 0 });
        if (!settings) return { ok: true, settings: null };
        return saveSettings(settings, password).then(function () {
          openSession(settings);
          return { ok: true, settings: settings };
        });
      });
    },

    /* Вход: проверяем пароль, отдаём расшифрованные настройки. */
    unlock: function (password) {
      var data = read();
      if (!data || !data.pass) return Promise.reject(new Error("Пароль ещё не задан"));
      var left = lockedFor();
      if (left > 0) {
        return Promise.reject(new Error("Слишком много попыток. Подождите " + Math.ceil(left / 1000) + " с."));
      }
      return verifyPassword(password, data.pass).then(function (ok) {
        if (!ok) {
          data.attempts = (data.attempts || 0) + 1;
          if (data.attempts >= maxAttempts) {
            data.lockedUntil = now() + lockMs;
            data.attempts = 0;
            write(data);
            return Promise.reject(new Error("Неверный пароль. Вход заблокирован на " + Math.round(lockMs / 1000) + " с."));
          }
          write(data);
          return Promise.reject(new Error("Неверный пароль. Осталось попыток: " + (maxAttempts - data.attempts)));
        }
        data.attempts = 0;
        data.lockedUntil = 0;
        write(data);
        if (!data.secret) return { settings: null };
        return decryptText(data.secret, password, data.pass).then(function (text) {
          var settings = JSON.parse(text);
          openSession(settings);
          return { settings: settings };
        });
      });
    },

    /* Сохранение настроек: нужен пароль (он же ключ шифрования). */
    save: function (settings, password) {
      return saveSettings(settings, password).then(function () {
        openSession(settings);
        return true;
      });
    },

    /* Смена пароля: перешифровываем настройки под новый ключ. */
    changePassword: function (oldPassword, newPassword) {
      if (String(newPassword || "").length < 6) {
        return Promise.reject(new Error("Новый пароль должен быть не короче 6 символов"));
      }
      return this.unlock(oldPassword).then(function (opened) {
        var settings = opened.settings;
        return makePasswordRecord(newPassword, { iterations: iterations }).then(function (record) {
          write({ v: 1, pass: record, secret: null, attempts: 0, lockedUntil: 0 });
          if (!settings) return true;
          return saveSettings(settings, newPassword);
        });
      });
    },

    /* Забыть всё: пароль, настройки и сессию. Токен придётся взять у @BotFather. */
    clear: function () {
      try { storage.removeItem(KEY); } catch (e) { /* ok */ }
      closeSession();
    },

    /* Пароль в памяти не держим: сессия живёт в sessionStorage вкладки и
       исчезает, когда вкладку закрывают. */
    session: function () { return openSession(); },
    hasSession: function () { return Boolean(readSession()); },
    closeSession: function () { return closeSession(); }
  };

  function openSession(settings) {
    if (settings === undefined) {
      var saved = readSession();
      return saved ? saved.settings : null;
    }
    try { session.setItem(SESSION_KEY, JSON.stringify({ settings: settings, at: now() })); } catch (e) { /* ok */ }
    return settings;
  }

  function readSession() {
    try {
      var raw = session.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function closeSession() {
    try { session.removeItem(SESSION_KEY); } catch (e) { /* ok */ }
  }
}

var API = {
  isAvailable: isAvailable,
  UNAVAILABLE: UNAVAILABLE,
  KEY: KEY,
  SESSION_KEY: SESSION_KEY,
  DEFAULTS: DEFAULTS,
  createVault: createVault,
  memoryStorage: memoryStorage,
  makePasswordRecord: makePasswordRecord,
  verifyPassword: verifyPassword,
  encryptText: encryptText,
  decryptText: decryptText,
  toBase64Url: toBase64Url,
  fromBase64Url: fromBase64Url
};

if (typeof module !== "undefined" && module.exports) module.exports = API;
if (typeof globalThis !== "undefined") globalThis.AdminLock = API;
