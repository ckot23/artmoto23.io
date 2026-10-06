/* ============================================================================
   templates.js — каталог шаблонов галереи.

   Один и тот же код используют:
     • index.html   — показать галерею и подставить настройки в конструктор;
     • admin.html   — отредактировать шаблон, собрать архив для GitHub;
     • templatesync.js — опубликовать каталог и фото в репозиторий;
     • tests/templates.js — проверки.

   Поэтому модуль выдаётся и в module.exports (Node), и в globalThis (браузер),
   как pricing.js и orderlink.js. Никаких зависимостей и никакого DOM:
   здесь только данные шаблона, его цена и упаковка файлов.

   Формат шаблона:
     {
       id: "kofeynya-open",            // имя файла фото и ключ шаблона
       title: "Кофейня: Open 24/7",    // подпись на карточке
       note: "Витрина, 20 × 30 см",    // необязательное описание
       img: "templates/img/….jpg",     // путь к фото на сайте
       created: "2026-10-06T12:00:00.000Z",
       settings: { film, design, color, shape, width, height, quantity }
     }

   Настройки — те же поля, что в конструкторе: клик по шаблону подставляет их
   в заказ, поэтому «шаблон» здесь не картинка ради картинки, а готовый заказ.
   ========================================================================= */
(function () {
  "use strict";

  var VERSION = "1";
  var CATALOG_PATH = "templates/catalog.js";
  var IMG_DIR = "templates/img/";
  var CATALOG_KEY = "SITE_TEMPLATES";

  var TITLE_MAX = 56;
  var NOTE_MAX = 240;
  var ID_MAX = 48;
  var MAX_ITEMS = 120;                /* больше и не нужно, и архив тяжёлый */

  /* Значения по умолчанию — как в конструкторе сайта. */
  var DEFAULTS = {
    film: "matte", design: "catalog", color: "black", shape: "rectangle",
    width: 10, height: 10, quantity: 10
  };

  /* Справочники id на случай, если рядом нет Pricing.
     Основной источник — Pricing.FILMS / Pricing.DESIGNS / Pricing.COLORS. */
  var FALLBACK_IDS = {
    films: ["matte", "gloss", "transparent", "metallic", "reflective"],
    designs: ["own", "text", "logo", "catalog"],
    colors: ["black", "white", "red", "blue", "green", "yellow", "orange", "silver", "gold", "fullcolor"],
    shapes: ["rectangle", "rounded", "circle"]
  };

  var DIM_MIN = 1;
  var DIM_MAX = 500;
  var QTY_MIN = 1;
  var QTY_MAX = 10000;

  /* ==========================================================================
     МЕЛОЧИ
     ====================================================================== */

  function has(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function clampNum(value, min, max, fallback) {
    var parsed = parseFloat(String(value == null ? "" : value).replace(",", "."));
    if (!isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  function oneOf(list, value, fallback) {
    for (var i = 0; i < list.length; i++) if (list[i] === value) return value;
    return fallback;
  }

  function text(value, max) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
  }

  function dictsFrom(source) {
    var out = { films: FALLBACK_IDS.films, designs: FALLBACK_IDS.designs,
      colors: FALLBACK_IDS.colors, shapes: FALLBACK_IDS.shapes };
    if (!source) return out;
    ["films", "designs", "colors", "shapes"].forEach(function (key) {
      var list = source[key];
      if (Array.isArray(list) && list.length) out[key] = list;
    });
    return out;
  }

  /* Справочники id из Pricing, чтобы админка и сайт не разошлись. */
  function dictsFromPricing(Pricing) {
    if (!Pricing) return dictsFrom(null);
    function ids(list) {
      if (!Array.isArray(list)) return null;
      return list.map(function (item) {
        return item && (item.id == null ? String(item) : String(item.id));
      });
    }
    return dictsFrom({
      films: ids(Pricing.FILMS), designs: ids(Pricing.DESIGNS),
      colors: ids(Pricing.COLORS), shapes: Object.keys(Pricing.SHAPES || {})
    });
  }

  /* ==========================================================================
     ID: из русского названия делаем латинский адрес
     ====================================================================== */

  var TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh",
    "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o",
    "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "c",
    "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu",
    "я": "ya", " ": "-", "—": "-", "–": "-", "_": "-", "/": "-", "\\": "-"
  };

  function slug(value, maxLength) {
    var source = String(value == null ? "" : value).toLowerCase();
    var out = "";
    for (var i = 0; i < source.length; i++) {
      var symbol = source.charAt(i);
      var mapped = has(TRANSLIT, symbol) ? TRANSLIT[symbol]
        : (/[a-z0-9-]/.test(symbol) ? symbol : "-");
      out += mapped;
    }
    out = out.replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, maxLength || ID_MAX);
    out = out.replace(/-+$/, "");
    return out;
  }

  /* Уникальный id: имя из названия, при совпадении — «-2», «-3», … */
  function uniqueId(seed, taken) {
    var base = slug(seed) || "shablon";
    var used = {};
    (taken || []).forEach(function (id) { used[String(id)] = true; });
    if (!used[base]) return base;
    for (var n = 2; n < 500; n++) {
      var candidate = base + "-" + n;
      if (!used[candidate]) return candidate;
    }
    return base + "-" + Date.now().toString(36);
  }

  /* ==========================================================================
     НОРМАЛИЗАЦИЯ
     ====================================================================== */

  function normalizeSettings(raw, dicts) {
    var d = dictsFrom(dicts);
    var source = raw && typeof raw === "object" ? raw : {};
    return {
      film: oneOf(d.films, source.film, DEFAULTS.film),
      design: oneOf(d.designs, source.design, DEFAULTS.design),
      color: oneOf(d.colors, source.color, DEFAULTS.color),
      shape: oneOf(d.shapes, source.shape, DEFAULTS.shape),
      width: clampNum(source.width, DIM_MIN, DIM_MAX, DEFAULTS.width),
      height: clampNum(source.height, DIM_MIN, DIM_MAX, DEFAULTS.height),
      quantity: Math.round(clampNum(source.quantity, QTY_MIN, QTY_MAX, DEFAULTS.quantity))
    };
  }

  function isSafeImagePath(value) {
    var path = String(value == null ? "" : value);
    if (!path || path.length > 200) return false;
    if (path.indexOf("..") !== -1) return false;
    if (path.indexOf("//") !== -1) return false;
    /* Фото галереи лежит только в templates/img или приходит из браузера
       как data: — публичные адреса не принимаем, чтобы не отдать чужое. */
    return new RegExp("^" + IMG_DIR + "[A-Za-z0-9._-]+$").test(path) || /^data:image\//.test(path);
  }

  function normalizeTemplate(raw, dicts, taken) {
    var source = raw && typeof raw === "object" ? raw : {};
    var title = text(source.title, TITLE_MAX);
    var img = String(source.img == null ? "" : source.img).trim().slice(0, 200);
    if (!title) return null;
    if (!isSafeImagePath(img)) return null;
    var id = slug(source.id || title);
    if (!id || (taken || []).indexOf(id) !== -1) id = uniqueId(source.id || title, taken);
    return {
      id: id,
      title: title,
      note: text(source.note, NOTE_MAX),
      img: img,
      created: /^\d{4}-\d{2}-\d{2}T/.test(String(source.created)) ? String(source.created) : new Date().toISOString(),
      settings: normalizeSettings(source.settings, dicts)
    };
  }

  function normalizeCatalog(list, dicts) {
    var out = [];
    var taken = [];
    (Array.isArray(list) ? list : []).forEach(function (item) {
      if (out.length >= MAX_ITEMS) return;
      var template = normalizeTemplate(item, dicts, taken);
      if (!template) return;
      taken.push(template.id);
      out.push(template);
    });
    return out;
  }

  function findById(list, id) {
    for (var i = 0; i < (list || []).length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function withoutIds(list, ids) {
    var remove = {};
    (ids || []).forEach(function (id) { remove[id] = true; });
    return (list || []).filter(function (item) { return !remove[item.id]; });
  }

  /* Новые сверху, старые ниже; внутри одной даты — по названию. */
  function sortCatalog(list) {
    return (list || []).slice().sort(function (a, b) {
      if (a.created !== b.created) return a.created < b.created ? 1 : -1;
      return a.title.localeCompare(b.title, "ru");
    });
  }

  function mergeCatalog(base, incoming) {
    var out = [];
    var index = {};
    (base || []).forEach(function (item) {
      index[item.id] = out.length;
      out.push(item);
    });
    (incoming || []).forEach(function (item) {
      if (has(index, item.id)) out[index[item.id]] = item;
      else { index[item.id] = out.length; out.push(item); }
    });
    return sortCatalog(out);
  }

  /* ==========================================================================
     ФАЙЛ КАТАЛОГА
     ====================================================================== */

  function serializeCatalog(list) {
    var body = JSON.stringify(normalizeCatalog(list), null, 2).replace(/\n/g, "\n  ");
    return "/* Каталог шаблонов галереи на сайте.\n"
      + "   Файл обновляет меню админа (admin.html) — кнопкой «Опубликовать»\n"
      + "   или архивом для ручной загрузки. Правки руками возможны, но тогда\n"
      + "   следите за форматом: путь к фото лежит в templates/img/.\n"
      + "   Пустой список — галерея на сайте просто не показывается. */\n"
      + "globalThis." + CATALOG_KEY + " = " + body + ";\n";
  }

  /* Читаем то, что сами и записали: от первой «[» до последней «]». */
  function parseCatalog(source) {
    var text = String(source == null ? "" : source);
    var start = text.indexOf("[");
    var end = text.lastIndexOf("]");
    if (start === -1 || end === -1 || end < start) return [];
    var data;
    try {
      data = JSON.parse(text.slice(start, end + 1));
    } catch (e) {
      return [];
    }
    return normalizeCatalog(data);
  }

  function catalogFromGlobal(scope) {
    var host = scope || (typeof globalThis !== "undefined" ? globalThis : null);
    if (!host) return [];
    return normalizeCatalog(host[CATALOG_KEY]);
  }

  /* ==========================================================================
     ФОТО
     ====================================================================== */

  var EXT_BY_MIME = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp" };

  function extFromMime(mime) {
    return EXT_BY_MIME[String(mime || "").toLowerCase()] || "jpg";
  }

  function extFromDataUrl(dataUrl) {
    var match = /^data:image\/([a-z+]+);base64,/i.exec(String(dataUrl || ""));
    if (!match) return "jpg";
    return extFromMime("image/" + match[1].toLowerCase());
  }

  /* "templates/img/avto.png" → "png" (пригодится, когда фото уже в репозитории). */
  function extFromPath(path) {
    var match = /\.([A-Za-z0-9]+)$/.exec(String(path == null ? "" : path));
    if (!match) return "jpg";
    var ext = match[1].toLowerCase();
    return EXT_BY_MIME["image/" + ext] || (ext === "jpeg" ? "jpg" : ext);
  }

  /* Подгоняем фото под галерею: длинная сторона не больше maxPx, но и не
     растягиваем маленькое. Возвращает { width, height, scale }. */
  function fitPhotoSize(width, height, maxPx) {
    var w = Math.max(1, Math.round(Number(width) || 0));
    var h = Math.max(1, Math.round(Number(height) || 0));
    var limit = maxPx || 1280;
    var scale = Math.min(1, limit / Math.max(w, h));
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scale: scale };
  }

  function imgPath(id, ext) {
    return IMG_DIR + String(id) + "." + (ext || "jpg");
  }

  function imgPathForFile(template, drafts) {
    /* У черновика фото может быть png/webp — путь берём из dataUrl, а не гадаем. */
    var draft = null;
    for (var i = 0; i < (drafts || []).length; i++) if (drafts[i].id === template.id) draft = drafts[i];
    if (draft && draft.photo) return imgPath(template.id, extFromDataUrl(draft.photo));
    return imgPath(template.id, "jpg");
  }

  function base64FromDataUrl(dataUrl) {
    var text = String(dataUrl || "");
    var comma = text.indexOf(",");
    return comma === -1 ? "" : text.slice(comma + 1).replace(/\s+/g, "");
  }

  /* ==========================================================================
     ЦЕНА
     ====================================================================== */

  /* Прайс ядра (pricing.js, server.js, bot.js) называет поля иначе:
     w/h/qty против width/height/quantity. Галерея хранит настройки как
     конструктор, поэтому перед расчётом их нужно переложить. */
  function toOrder(settings, extra) {
    var clean = normalizeSettings(settings);
    var order = Object.assign({}, extra || {}, {
      film: clean.film, design: clean.design, color: clean.color, shape: clean.shape,
      w: clean.width, h: clean.height, qty: clean.quantity
    });
    if (extra && extra.comment) delete order.__comment;
    return order;
  }

  /* Цену считает сайт или прайс — здесь только вызов, без второй копии формулы. */
  function priceOf(settings, calculate) {
    if (typeof calculate !== "function") return null;
    var result = calculate(normalizeSettings(settings));
    if (!result || !isFinite(result.total)) return null;
    return result;
  }

  /* ==========================================================================
     ZIP (без сжатия: JPEG и так сжат, а формату нужен только CRC32)
     ====================================================================== */

  var CRC_TABLE = null;

  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    var table = new Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    CRC_TABLE = table;
    return table;
  }

  function crc32(data) {
    var table = crcTable();
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (typeof Buffer !== "undefined" && Buffer.isBuffer && Buffer.isBuffer(data)) return new Uint8Array(data);
    var source = String(data == null ? "" : data);
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(source);
    var out = [];
    for (var i = 0; i < source.length; i++) {
      var code = source.charCodeAt(i);
      if (code < 0x80) out.push(code);
      else if (code < 0x800) out.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
      else out.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
    }
    return new Uint8Array(out);
  }

  function joinBytes(parts) {
    var total = 0;
    parts.forEach(function (part) { total += part.length; });
    var out = new Uint8Array(total);
    var at = 0;
    parts.forEach(function (part) { out.set(part, at); at += part.length; });
    return out;
  }

  function u16(value) { return new Uint8Array([value & 0xFF, (value >> 8) & 0xFF]); }
  function u32(value) {
    return new Uint8Array([value & 0xFF, (value >> 8) & 0xFF, (value >> 16) & 0xFF, (value >>> 24) & 0xFF]);
  }

  /* files: [{ name: "templates/img/x.jpg", data: <строка|Uint8Array> }] */
  function buildZip(files, now) {
    var stamp = now instanceof Date ? now : new Date();
    var time = ((stamp.getHours() << 11) | (stamp.getMinutes() << 5) | (stamp.getSeconds() >> 1)) & 0xFFFF;
    var date = (((stamp.getFullYear() - 1980) << 9) | ((stamp.getMonth() + 1) << 5) | stamp.getDate()) & 0xFFFF;

    var chunks = [];
    var central = [];
    var offset = 0;

    files.forEach(function (file) {
      var name = toBytes(file.name);
      var data = toBytes(file.data);
      var crc = crc32(data);
      var head = joinBytes([
        u32(0x04034B50), u16(20), u16(0x0800), u16(0), u16(time), u16(date),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0)
      ]);
      var local = joinBytes([head, name, data]);
      chunks.push(local);
      central.push(joinBytes([
        u32(0x02014B50), u16(20), u16(20), u16(0x0800), u16(0), u16(time), u16(date),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0),
        u16(0), u16(0), u16(0), u32(0), u32(offset), name
      ]));
      offset += local.length;
    });

    var directory = joinBytes(central);
    var end = joinBytes([
      u32(0x06054B50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(directory.length), u32(offset), u16(0)
    ]);
    return joinBytes(chunks.concat([directory, end]));
  }

  var API = {
    VERSION: VERSION,
    CATALOG_PATH: CATALOG_PATH,
    IMG_DIR: IMG_DIR,
    CATALOG_KEY: CATALOG_KEY,
    DEFAULTS: DEFAULTS,
    TITLE_MAX: TITLE_MAX,
    NOTE_MAX: NOTE_MAX,
    MAX_ITEMS: MAX_ITEMS,
    dictsFromPricing: dictsFromPricing,
    normalizeSettings: normalizeSettings,
    normalizeTemplate: normalizeTemplate,
    normalizeCatalog: normalizeCatalog,
    slug: slug,
    uniqueId: uniqueId,
    findById: findById,
    withoutIds: withoutIds,
    sortCatalog: sortCatalog,
    mergeCatalog: mergeCatalog,
    serializeCatalog: serializeCatalog,
    parseCatalog: parseCatalog,
    catalogFromGlobal: catalogFromGlobal,
    isSafeImagePath: isSafeImagePath,
    extFromMime: extFromMime,
    extFromPath: extFromPath,
    fitPhotoSize: fitPhotoSize,
    extFromDataUrl: extFromDataUrl,
    imgPath: imgPath,
    imgPathForFile: imgPathForFile,
    base64FromDataUrl: base64FromDataUrl,
    toOrder: toOrder,
    priceOf: priceOf,
    crc32: crc32,
    toBytes: toBytes,
    buildZip: buildZip
  };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  if (typeof globalThis !== "undefined") globalThis.Templates = API;
})();
