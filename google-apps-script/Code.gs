/* ============================================================================
   Приём заявок сайта в Google Таблицу и Telegram.

   Установка: в таблице откройте Расширения → Apps Script, вставьте этот файл,
   задайте BOT_TOKEN, MODERATOR_CHAT_ID и SPREADSHEET_ID в «Настройки проекта →
   Свойства скрипта» и разверните как веб-приложение от имени владельца таблицы.

   Токен хранится только в свойствах Apps Script и не попадает в исходный код
   сайта или публичный репозиторий. Сайт отправляет сюда JSON:
     {action:"order", order_id, columns, rows}

   • Лист «Заказы» — одна строка на заявку, первые 6 колонок соответствуют
     формату: имя, контакты, продукт заказа, цена, способ получения, комментарий.
   • Лист «Заявки» — подробная расшифровка: по строке на каждую позицию.
   • Telegram — текстовое уведомление с теми же полями и деталями позиций.
   • Повторный запрос с тем же номером безопасен: строки не дублируются,
     а успешно отправленные части сообщения повторно не отправляются.
   ========================================================================= */

var SUMMARY_SHEET_NAME = "Заказы";
var DETAIL_SHEET_NAME = "Заявки";
var SUMMARY_COLUMNS = [
  "Имя", "Контакты", "Продукт заказа", "Цена", "Способ получения",
  "Комментарий к заказу", "Номер заявки", "Дата (МСК)"
];
var MAX_ROWS_PER_ORDER = 50;
var MAX_COLUMNS = 64;
var MAX_BODY_LENGTH = 200000;
var TELEGRAM_MESSAGE_LIMIT = 4000;  // запас до лимита Bot API 4096
var TELEGRAM_STATE_PREFIX = "telegram_sent_";

function doGet() {
  var props = scriptProperties_();
  var configured = !!(props && props.getProperty("BOT_TOKEN") && props.getProperty("MODERATOR_CHAT_ID"));
  return json_({
    ok: true,
    service: "kontur-orders",
    summarySheet: SUMMARY_SHEET_NAME,
    detailSheet: DETAIL_SHEET_NAME,
    telegramConfigured: configured
  });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return json_({ ok: false, error: "Скрипт занят, повторите отправку." });
  }

  try {
    var raw = (e && e.postData && e.postData.contents) || "{}";
    if (raw.length > MAX_BODY_LENGTH) return json_({ ok: false, error: "Заявка слишком большая." });

    var body;
    try {
      body = JSON.parse(raw);
    } catch (parseError) {
      return json_({ ok: false, error: "Не удалось прочитать заявку: нужен JSON." });
    }

    var checked = validateOrder_(body);
    if (!checked.ok) return json_({ ok: false, error: checked.error });

    var orderId = checked.orderId;
    var summaryResult = { ok: false, error: "Не удалось записать сводку." };
    var detailResult = { ok: false, error: "Не удалось записать состав заказа." };

    /* Каналы независимы: ошибка записи в таблицу не мешает отправить Telegram. */
    try {
      var summarySheet = getSheet_(SUMMARY_SHEET_NAME, SUMMARY_COLUMNS);
      var summaryRow = summaryRow_(checked).map(cell_);
      summaryResult = appendOnce_(summarySheet, orderId, SUMMARY_COLUMNS.length - 1, [summaryRow]);
    } catch (summaryError) {
      summaryResult = { ok: false, error: safeError_(summaryError, "Ошибка листа «Заказы».") };
    }

    try {
      var detailSheet = getSheet_(DETAIL_SHEET_NAME, checked.columns);
      var detailRows = checked.rows.map(function (row) {
        return checked.columns.map(function (unused, index) { return cell_(row[index]); });
      });
      detailResult = appendOnce_(detailSheet, orderId, 1, detailRows);
    } catch (detailError) {
      detailResult = { ok: false, error: safeError_(detailError, "Ошибка листа «Заявки».") };
    }

    var telegramResult;
    try {
      telegramResult = sendTelegramOrder_(checked);
    } catch (telegramError) {
      telegramResult = { ok: false, error: safeError_(telegramError, "Не удалось отправить Telegram-уведомление.") };
    }
    var ok = summaryResult.ok || telegramResult.ok;
    return json_({
      ok: ok,
      order_id: orderId,
      duplicate: !!(summaryResult.duplicate && detailResult.duplicate),
      sheetOk: summaryResult.ok,
      detailsOk: detailResult.ok,
      telegramOk: telegramResult.ok,
      sheetError: summaryResult.ok ? "" : summaryResult.error,
      detailsError: detailResult.ok ? "" : detailResult.error,
      telegramError: telegramResult.ok ? "" : telegramResult.error
    });
  } catch (err) {
    return json_({ ok: false, error: safeError_(err, "Не удалось обработать заявку.") });
  } finally {
    lock.releaseLock();
  }
}

function validateOrder_(body) {
  if (!body || body.action !== "order") return { ok: false, error: "Неизвестное действие." };

  var orderId = String(body.order_id || "").trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(orderId)) return { ok: false, error: "Номер заявки пустой или неверный." };

  var columns = body.columns;
  var rows = body.rows;
  if (!Array.isArray(columns) || !columns.length || columns.length > MAX_COLUMNS ||
      !Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS_PER_ORDER) {
    return { ok: false, error: "В заявке нет строк или её формат неверный." };
  }

  var normalizedRows = [];
  for (var i = 0; i < rows.length; i++) {
    if (!Array.isArray(rows[i]) || rows[i].length > columns.length) {
      return { ok: false, error: "Неверный формат строки заявки." };
    }
    var row = rows[i].slice();
    while (row.length < columns.length) row.push("");
    if (String(row[0] || "").trim() !== orderId) {
      return { ok: false, error: "Номер заявки в строках не совпадает." };
    }
    normalizedRows.push(row);
  }

  return {
    ok: true,
    orderId: orderId,
    columns: columns.map(function (name) { return String(name || "").slice(0, 100); }),
    rows: normalizedRows
  };
}

function getSheet_(name, headers) {
  var props = scriptProperties_();
  var spreadsheetId = props && String(props.getProperty("SPREADSHEET_ID") || "").trim();
  var book = spreadsheetId
    ? SpreadsheetApp.openById(spreadsheetId)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!book) throw new Error("Не найдена таблица. Укажите SPREADSHEET_ID в свойствах Apps Script.");

  var sheet = book.getSheetByName(name);
  if (!sheet) sheet = book.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers.map(cell_)])
      .setFontWeight("bold").setBackground("#e8eaf6");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function appendOnce_(sheet, orderId, idColumn, rows) {
  if (alreadyHas_(sheet, orderId, idColumn)) return { ok: true, duplicate: true };
  if (!rows.length) return { ok: false, duplicate: false, error: "В заявке нет строк." };

  var width = rows[0].length;
  var values = rows.map(function (row) {
    var copy = row.slice();
    while (copy.length < width) copy.push("");
    return copy;
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, values.length, width).setValues(values);
  SpreadsheetApp.flush();
  return { ok: true, duplicate: false };
}

function alreadyHas_(sheet, orderId, idColumn) {
  var last = sheet.getLastRow();
  if (last < 2) return false;
  var ids = sheet.getRange(2, idColumn, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === orderId) return true;
  }
  return false;
}

function summaryRow_(order) {
  var columns = order.columns;
  var first = order.rows[0];
  var time = getValue_(columns, first, "Дата (МСК)");
  return [
    getValue_(columns, first, "Имя"),
    getValue_(columns, first, "Контакт"),
    productSummary_(columns, order.rows),
    orderTotal_(columns, order.rows),
    getValue_(columns, first, "Получение"),
    getValue_(columns, first, "Комментарий"),
    order.orderId,
    time
  ];
}

function productSummary_(columns, rows) {
  var items = rows.map(function (row, index) {
    var product = ["Плёнка", "Дизайн", "Цвет", "Форма"].map(function (name) {
      return getValue_(columns, row, name);
    }).filter(function (value) { return value !== ""; }).join(" · ");

    var sketch = getValue_(columns, row, "Эскиз");
    if (sketch) product += (product ? " · " : "") + "эскиз: " + sketch;

    var width = getValue_(columns, row, "Ширина, см");
    var height = getValue_(columns, row, "Высота, см");
    var quantity = getValue_(columns, row, "Тираж, шт");
    var linePrice = getValue_(columns, row, "Сумма позиции, ₽");
    var dimensions = width !== "" && height !== "" ? width + " × " + height + " см" : "";
    var details = [dimensions, quantity !== "" ? quantity + " шт" : ""].filter(Boolean).join(", ");
    var text = (index + 1) + ". " + (product || "Позиция заказа");
    if (details) text += " — " + details;
    if (linePrice !== "") text += "; цена позиции: " + formatMoney_(linePrice);
    return text;
  });
  return items.join("\n");
}

function orderTotal_(columns, rows) {
  var totalIndex = columns.indexOf("Итого заказа, ₽");
  var firstTotal = totalIndex >= 0 && rows[0] ? rows[0][totalIndex] : "";
  if (firstTotal !== "" && firstTotal !== null && firstTotal !== undefined) {
    var totalValue = Number(firstTotal);
    return isFinite(totalValue) ? totalValue : String(firstTotal);
  }

  var index = columns.indexOf("Сумма позиции, ₽");
  if (index < 0) return "";
  var total = 0;
  var found = false;
  rows.forEach(function (row) {
    var amount = Number(row[index]);
    if (isFinite(amount)) { total += amount; found = true; }
  });
  return found ? total : "";
}

function getValue_(columns, row, name) {
  var index = columns.indexOf(name);
  if (index < 0 || !row || row[index] === null || row[index] === undefined) return "";
  return String(row[index]).trim();
}

function buildTelegramMessage_(order) {
  var values = summaryRow_(order);
  var lines = [
    "Новая заявка №" + order.orderId,
    "Имя: " + (values[0] || "не указано"),
    "Контакты: " + (values[1] || "не указаны"),
    "Продукт заказа:",
    values[2] || "не указан",
    "Цена: " + (values[3] !== "" ? formatMoney_(values[3]) : "не указана"),
    "Способ получения: " + (values[4] || "не указан"),
    "Комментарий к заказу: " + (values[5] || "нет")
  ];
  return lines.join("\n");
}

function splitTelegramMessage_(text, orderId) {
  var continuation = "Продолжение заявки №" + String(orderId || "") + ":\n";
  var blocks = String(text || "").split("\n");
  var messages = [];
  var current = "";
  blocks.forEach(function (line) {
    var next = current ? current + "\n" + line : line;
    if (next.length > TELEGRAM_MESSAGE_LIMIT && current) {
      messages.push(current);
      current = continuation + line;
    } else if (next.length > TELEGRAM_MESSAGE_LIMIT) {
      /* На случай очень длинного поля отсекаем его безопасно для лимита API. */
      messages.push(line.slice(0, TELEGRAM_MESSAGE_LIMIT));
      current = "";
    } else {
      current = next;
    }
  });
  if (current) messages.push(current);
  return messages;
}

function sendTelegramOrder_(order) {
  var properties = scriptProperties_();
  if (!properties) return { ok: false, error: "Не доступны свойства Apps Script." };

  var token = String(properties.getProperty("BOT_TOKEN") || "").trim();
  var chatId = String(properties.getProperty("MODERATOR_CHAT_ID") || "").trim();
  if (!token || !chatId) {
    return { ok: false, error: "В Apps Script не заданы BOT_TOKEN и MODERATOR_CHAT_ID." };
  }

  var messages = splitTelegramMessage_(buildTelegramMessage_(order), order.orderId);
  var stateKey = TELEGRAM_STATE_PREFIX + order.orderId;
  var state = readTelegramState_(properties, stateKey);
  if (state.done) return { ok: true, duplicate: true };

  for (var i = 0; i < messages.length; i++) {
    if (state.sent[i]) continue;
    var result = callTelegram_(token, chatId, messages[i]);
    if (!result.ok) return { ok: false, error: result.error };
    state.sent[i] = true;
    properties.setProperty(stateKey, JSON.stringify(state));
  }

  state.done = true;
  properties.setProperty(stateKey, JSON.stringify(state));
  cleanupTelegramStates_(properties);
  return { ok: true, duplicate: false };
}

function readTelegramState_(properties, key) {
  var value = properties.getProperty(key);
  if (!value) return { sent: {}, done: false };
  try {
    var parsed = JSON.parse(value);
    return { sent: parsed.sent || {}, done: parsed.done === true };
  } catch (err) {
    return { sent: {}, done: false };
  }
}

function callTelegram_(token, chatId, text) {
  if (typeof UrlFetchApp === "undefined") return { ok: false, error: "UrlFetchApp недоступен." };
  var response;
  try {
    response = UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ chat_id: chatId, text: text, disable_web_page_preview: true }),
      muteHttpExceptions: true
    });
  } catch (err) {
    /* Не возвращаем текст исключения: он может содержать URL с токеном. */
    return { ok: false, error: "Не удалось связаться с Telegram API. Проверьте доступ Apps Script к интернету." };
  }

  var data;
  try {
    data = JSON.parse(response.getContentText() || "{}");
  } catch (parseError) {
    return { ok: false, error: "Telegram вернул некорректный ответ." };
  }
  if (data && data.ok) return { ok: true };

  var code = Number((data && data.error_code) || response.getResponseCode() || 0);
  if (code === 401) return { ok: false, error: "Telegram отклонил токен (401). Проверьте BOT_TOKEN в свойствах Apps Script." };
  if (code === 403) return { ok: false, error: "Бот не может написать модератору (403). Откройте бота и нажмите Start." };
  if (code === 400 && /chat not found/i.test(String(data && data.description || ""))) {
    return { ok: false, error: "Не найден чат модератора. Проверьте MODERATOR_CHAT_ID." };
  }
  var description = String((data && data.description) || "ошибка Telegram").slice(0, 250);
  return { ok: false, error: "Telegram API: " + description + " (" + code + ")." };
}

function testTelegram() {
  var properties = scriptProperties_();
  if (!properties) throw new Error("Не доступны свойства Apps Script.");
  var token = String(properties.getProperty("BOT_TOKEN") || "").trim();
  var chatId = String(properties.getProperty("MODERATOR_CHAT_ID") || "").trim();
  if (!token || !chatId) throw new Error("Добавьте BOT_TOKEN и MODERATOR_CHAT_ID в свойства скрипта.");

  var result = callTelegram_(token, chatId, "✅ Тест: Google Apps Script подключён к Telegram.");
  if (!result.ok) throw new Error(result.error);
  if (typeof Logger !== "undefined") Logger.log("Тестовое сообщение отправлено модератору.");
  return { ok: true };
}

function cleanupTelegramStates_(properties) {
  try {
    if (typeof CacheService !== "undefined") {
      var cache = CacheService.getScriptCache();
      if (cache.get("telegram_state_cleanup_done")) return;
    }
    var all = properties.getProperties();
    var cutoff = new Date().getTime() - 45 * 24 * 60 * 60 * 1000;
    Object.keys(all).forEach(function (key) {
      if (key.indexOf(TELEGRAM_STATE_PREFIX) !== 0) return;
      var date = orderDateFromId_(key.slice(TELEGRAM_STATE_PREFIX.length));
      if (date && date.getTime() < cutoff) properties.deleteProperty(key);
    });
    if (typeof CacheService !== "undefined") {
      CacheService.getScriptCache().put("telegram_state_cleanup_done", "1", 21600);
    }
  } catch (err) {
    /* Очистка служебных статусов не должна мешать приёму заказа. */
  }
}

function orderDateFromId_(orderId) {
  var match = /^(\d{2})(\d{2})(\d{2})-/.exec(String(orderId || ""));
  if (!match) return null;
  var date = new Date(2000 + Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getFullYear() !== 2000 + Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) return null;
  return date;
}

/* Значения вида «=ФОРМУЛА» и номера, начинающиеся с «+», храним как текст. */
function cell_(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return isFinite(value) ? value : "";
  var text = String(value).slice(0, 50000);
  if (/^[=+\-@]/.test(text)) return "'" + text;
  return text;
}

function formatMoney_(value) {
  var number = Number(value);
  if (!isFinite(number)) return String(value || "");
  return Math.round(number).toLocaleString("ru-RU").replace(/\u00a0/g, " ") + " ₽";
}

function scriptProperties_() {
  if (typeof PropertiesService === "undefined" || !PropertiesService.getScriptProperties) return null;
  return PropertiesService.getScriptProperties();
}

function safeError_(err, fallback) {
  var text = String(err && err.message || err || fallback || "Ошибка.");
  /* Защита от случайного возврата токена при ошибке внешнего запроса. */
  var properties = scriptProperties_();
  var token = properties && properties.getProperty("BOT_TOKEN");
  if (token) text = text.split(token).join("[скрыто]");
  return text.slice(0, 300) || fallback || "Ошибка.";
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
