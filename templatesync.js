/* ============================================================================
   templatesync.js — публикация галереи в репозиторий GitHub.

   Зачем: сайт статический (GitHub Pages), поэтому «загрузить фото» из браузера
   владельца = положить файл в репозиторий. Это делает GitHub REST API по
   личному токену владельца (fine-grained, право Contents: Read and write).

   Токен живёт только в браузере — в настройках админки, зашифрованный паролем
   (см. adminlock.js). Здесь нет ни одного секрета: модуль только ходит в API.

   Модуль работает и в Node (проверки подменяют fetch), и в браузере.
   ========================================================================= */
(function () {
  "use strict";

  var API_BASE = "https://api.github.com";
  var API_VERSION = "2022-11-28";
  var MAX_BYTES = 8 * 1024 * 1024;      /* одно фото: больше GitHub не любит */

  var EXT_BY_MIME = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp" };

  function has(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  /* ==========================================================================
     base64 без Buffer: нужен и в браузере (каталог), и в Node (тесты)
     ====================================================================== */

  function bytesToBase64(bytes) {
    if (typeof Buffer !== "undefined" && Buffer.from) {
      return Buffer.from(bytes).toString("base64");
    }
    var binary = "";
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function textToBase64(text) {
    var source = String(text == null ? "" : text);
    if (typeof TextEncoder !== "undefined") return bytesToBase64(new TextEncoder().encode(source));
    return bytesToBase64(new Uint8Array(unescape(encodeURIComponent(source)).split("").map(function (c) {
      return c.charCodeAt(0);
    })));
  }

  function base64ToText(base64) {
    var clean = String(base64 == null ? "" : base64).replace(/\s+/g, "");
    if (typeof Buffer !== "undefined" && Buffer.from) return Buffer.from(clean, "base64").toString("utf8");
    return decodeURIComponent(escape(atob(clean)));
  }

  function base64FromDataUrl(dataUrl) {
    var text = String(dataUrl == null ? "" : dataUrl);
    var comma = text.indexOf(",");
    return comma === -1 ? "" : text.slice(comma + 1).replace(/\s+/g, "");
  }

  function bytesFromBase64(base64) {
    var clean = String(base64 == null ? "" : base64).replace(/\s+/g, "");
    if (typeof Buffer !== "undefined" && Buffer.from) return new Uint8Array(Buffer.from(clean, "base64"));
    var binary = atob(clean);
    var out = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  function extFromDataUrl(dataUrl) {
    var match = /^data:image\/([a-z+]+);base64,/i.exec(String(dataUrl || ""));
    if (!match) return "jpg";
    return EXT_BY_MIME["image/" + match[1].toLowerCase()] || "jpg";
  }

  function sizeFromDataUrl(dataUrl) {
    var base64 = base64FromDataUrl(dataUrl);
    var padding = base64.slice(-2).replace(/[^=]/g, "").length;
    return Math.max(0, Math.floor(base64.length * 3 / 4) - padding);
  }

  /* ==========================================================================
     ОШИБКИ: человеку должно быть понятно, что делать
     ====================================================================== */

  function hintFor(status, body) {
    var message = "";
    try { message = String((body || {}).message || ""); } catch (e) { message = ""; }
    if (status === 401) return "Токен GitHub не подошёл. Проверьте, что скопирован весь токен и срок его действия не истёк.";
    if (status === 403) return "GitHub отказал: у токена нет права «Contents: Read and write» на этот репозиторий"
      + (message ? " (" + message + ")" : "") + ".";
    if (status === 404) return "Репозиторий или ветка не найдены. Проверьте владельца, название и ветку — и что у токена есть доступ именно к этому репозиторию.";
    if (status === 409) return "Файл успел измениться снаружи. Нажмите «Опубликовать» ещё раз.";
    if (status === 422) return "GitHub не принял данные файла" + (message ? " (" + message + ")" : "") + ".";
    if (status === 429 || status === 451) return "GitHub просит подождать: слишком много запросов. Повторите через минуту.";
    if (status >= 500) return "GitHub сейчас недоступен (" + status + "). Это на их стороне — повторите позже.";
    return "GitHub ответил ошибкой " + status + (message ? ": " + message : "") + ".";
  }

  function friendlyError(status, body) {
    var error = new Error(hintFor(status, body));
    error.status = status;
    return error;
  }

  /* ==========================================================================
     КЛИЕНТ
     ====================================================================== */

  function createSync(options) {
    var config = options || {};
    var request = config.fetch || (typeof fetch !== "undefined" ? fetch : null);
    var base = String(config.base || API_BASE).replace(/\/+$/, "");
    var token = String(config.token || "").trim();
    var owner = String(config.owner || "").trim();
    var repo = String(config.repo || "").trim();
    var branch = String(config.branch || "main").trim() || "main";
    var maxBytes = config.maxBytes || MAX_BYTES;

    function ready() {
      if (!request) throw new Error("Нет доступа к сети (fetch недоступен).");
      if (!token) throw new Error("Не хватает токена GitHub — впишите его в настройках админа.");
      if (!owner || !repo) throw new Error("Не хватает владельца и названия репозитория — впишите их в настройках админа.");
    }

    function call(method, path, payload) {
      /* Отказываем промисом, а не исключением: вызывающий код везде .catch(). */
      try { ready(); } catch (error) { return Promise.reject(error); }
      var url = base + "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo) + path;
      var init = {
        method: method,
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": "Bearer " + token,
          "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": "artmoto23-admin"
        }
      };
      if (payload !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(payload);
      }
      return request(url, init).then(function (response) {
        return response.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
          if (!response.ok) throw friendlyError(response.status, data);
          return data;
        });
      });
    }

    /* Список файлов в папке: один запрос вместо запроса на каждый файл. */
    function listDir(path) {
      var query = "?ref=" + encodeURIComponent(branch);
      return call("GET", "/contents/" + encodePath(path) + query).then(function (data) {
        if (!Array.isArray(data)) return [];
        return data.map(function (item) {
          return { name: item.name, path: item.path, sha: item.sha, size: item.size };
        });
      }).catch(function (error) {
        if (error.status === 404) return [];      /* папки ещё нет */
        throw error;
      });
    }

    function readFile(path) {
      var query = "?ref=" + encodeURIComponent(branch);
      return call("GET", "/contents/" + encodePath(path) + query).then(function (data) {
        return { path: path, sha: data.sha, text: base64ToText(data.content || ""), exists: true };
      }).catch(function (error) {
        if (error.status === 404) return { path: path, sha: null, text: "", exists: false };
        throw error;
      });
    }

    function putFile(path, base64OrText, message, sha, isBase64) {
      var content = isBase64 ? String(base64OrText) : textToBase64(base64OrText);
      var payload = { message: message || ("Обновить " + path), content: content, branch: branch };
      if (sha) payload.sha = sha;
      return call("PUT", "/contents/" + encodePath(path), payload);
    }

    function deleteFile(path, sha, message) {
      return call("DELETE", "/contents/" + encodePath(path), {
        message: message || ("Удалить " + path), sha: sha, branch: branch
      });
    }

    /* Проверка токена и доступа — для кнопки «Проверить GitHub». */
    function check() {
      return call("GET", "").then(function (data) {
        return {
          repo: data.full_name || (owner + "/" + repo),
          branch: branch,
          canPush: Boolean(data.permissions && data.permissions.push),
          private: Boolean(data.private)
        };
      });
    }

    /* ------------------------------------------------------------------
       Публикация: привести templates/ в репозитории в соответствие с тем,
       что сейчас в админке.
         catalogText — содержимое templates/catalog.js;
         photos      — [{ id, base64, force }];
         prune       — удалять ли фото, которых нет в каталоге (по умолчанию да,
                       но только если каталог не пуст: страховка от затирания).
       ------------------------------------------------------------------ */
    function publish(options) {
      var plan = options || {};
      var catalogText = String(plan.catalogText || "");
      var photos = plan.photos || [];
      var progress = plan.progress || function () {};
      var prune = plan.prune !== false;
      var message = plan.message || "Галерея шаблонов: обновление из админки";
      var result = { uploaded: [], skipped: [], removed: [], commit: null };

      var known = {};
      photos.forEach(function (photo) { known[photo.id] = photo; });

      return listDir("templates/img").then(function (existing) {
        var byName = {};
        existing.forEach(function (file) { byName[file.name] = file; });

        var queue = photos.filter(function (photo) {
          if (photo.keep) return false;          /* фото уже в репозитории и не менялось */
          var name = photo.id + "." + (photo.ext || "jpg");
          var found = byName[name];
          return !found || found.size !== photo.size || photo.force;
        });
        result.skipped = photos.filter(function (photo) { return queue.indexOf(photo) === -1; })
          .map(function (photo) { return photo.id; });

        function uploadNext(index) {
          if (index >= queue.length) return Promise.resolve();
          var photo = queue[index];
          var name = photo.id + "." + (photo.ext || "jpg");
          var found = byName[name];
          progress({ step: "photo", path: name, index: index, total: queue.length });
          return putFile("templates/img/" + name, photo.base64, message + ": " + name, found && found.sha, true)
            .then(function () {
              result.uploaded.push(name);
              return uploadNext(index + 1);
            });
        }

        return uploadNext(0).then(function () {
          return readFile("templates/catalog.js");
        }).then(function (file) {
          progress({ step: "catalog", path: "templates/catalog.js" });
          return putFile("templates/catalog.js", catalogText, message, file.sha, false);
        }).then(function (data) {
          if (data && data.commit) result.commit = data.commit.sha;
          if (!prune || !photos.length) return null;

          /* Фото, которых больше нет в каталоге, — убираем, чтобы репозиторий
             не пух. При пустом каталоге не трогаем ничего (страховка). */
          var keep = {};
          photos.forEach(function (photo) {
            keep[photo.id + "." + (photo.ext || "jpg")] = true;
            ["jpg", "jpeg", "png", "webp"].forEach(function (ext) {
              keep[photo.id + "." + ext] = true;
            });
          });
          var orphans = (Array.isArray(existing) ? existing : []).filter(function (file) {
            return !keep[file.name] && /\.(jpg|jpeg|png|webp)$/i.test(file.name);
          });
          function removeNext(index) {
            if (index >= orphans.length) return Promise.resolve();
            progress({ step: "remove", path: orphans[index].name, index: index, total: orphans.length });
            return deleteFile("templates/img/" + orphans[index].name, orphans[index].sha,
              message + ": удалить " + orphans[index].name)
              .then(function () {
                result.removed.push(orphans[index].name);
                return removeNext(index + 1);
              });
          }
          return removeNext(0);
        }).then(function () {
          return result;
        });
      });
    }

    return {
      owner: owner, repo: repo, branch: branch,
      check: check,
      listDir: listDir,
      readFile: readFile,
      putFile: putFile,
      deleteFile: deleteFile,
      publish: publish
    };
  }

  function encodePath(path) {
    return String(path || "").split("/").map(encodeURIComponent).join("/");
  }

  /* Что нужно владельцу, чтобы это заработало — показываем прямо в админке. */
  var TOKEN_HELP = [
    "Откройте github.com/settings/personal-access-tokens/new",
    "Repository access → Only select repositories → выберите репозиторий сайта",
    "Permissions → Repository permissions → Contents: Read and write",
    "Срок действия — любой; сгенерируйте и скопируйте токен (он показывается один раз)",
    "Вставьте токен в поле «Токен GitHub» и нажмите «Проверить GitHub»"
  ];

  var API = {
    API_BASE: API_BASE,
    VERSION: API_VERSION,
    MAX_BYTES: MAX_BYTES,
    TOKEN_HELP: TOKEN_HELP,
    createSync: createSync,
    hintFor: hintFor,
    textToBase64: textToBase64,
    base64ToText: base64ToText,
    bytesToBase64: bytesToBase64,
    bytesFromBase64: bytesFromBase64,
    base64FromDataUrl: base64FromDataUrl,
    extFromDataUrl: extFromDataUrl,
    sizeFromDataUrl: sizeFromDataUrl,
    encodePath: encodePath
  };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  if (typeof globalThis !== "undefined") globalThis.TemplateSync = API;
})();
