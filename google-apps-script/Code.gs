/* ============================================================================
   Приём заявок с сайта в Google-таблицу.

   Это НЕ часть сайта: код нужно один раз вставить в Google Apps Script и
   опубликовать как веб-приложение (пошагово — в README, раздел «Заявки в
   Google-таблицу»). Полученный адрес /exec вписывается в SHEET_URL в tgdirect.js.

   Что делает:
     • doPost — принимает JSON от сайта {action:"order", order_id, columns, rows},
       дописывает строки на лист «Заявки» (по строке на каждую наклейку);
     • сам создаёт лист и шапку, если их нет;
     • игнорирует повторную отправку того же номера заявки (сайт может повторить
       запрос, если браузер не дал прочитать ответ) — дублей не будет;
     • doGet — проверка «живой ли скрипт»: откройте адрес /exec в браузере.
   ========================================================================= */

var SHEET_NAME = "Заявки";
var ID_COLUMN = 1;          // «Номер заявки» — первая колонка
var MAX_ROWS_PER_ORDER = 50;

function doGet() {
  return json_({ ok: true, service: "kontur-orders", sheet: SHEET_NAME });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);               // две заявки одновременно не перепутают строки
  } catch (err) {
    return json_({ ok: false, error: "таблица занята, повторите" });
  }

  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    if (body.action !== "order") return json_({ ok: false, error: "неизвестное действие" });

    var orderId = String(body.order_id || "").trim();
    var rows = body.rows;
    if (!orderId || !Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS_PER_ORDER) {
      return json_({ ok: false, error: "пустая или неверная заявка" });
    }

    var sheet = getSheet_(body.columns);
    if (alreadyHas_(sheet, orderId)) return json_({ ok: true, duplicate: true });

    var values = rows.map(function (row) { return row.map(cell_); });
    var width = Math.max.apply(null, values.map(function (r) { return r.length; }));
    values.forEach(function (r) { while (r.length < width) r.push(""); });  // setValues ждёт прямоугольник
    sheet.getRange(sheet.getLastRow() + 1, 1, values.length, width).setValues(values);
    SpreadsheetApp.flush();

    return json_({ ok: true, rows: values.length });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function getSheet_(columns) {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = book.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = book.insertSheet(SHEET_NAME);

  if (sheet.getLastRow() === 0 && Array.isArray(columns) && columns.length) {
    sheet.getRange(1, 1, 1, columns.length).setValues([columns.map(cell_)])
      .setFontWeight("bold").setBackground("#e8eaf6");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function alreadyHas_(sheet, orderId) {
  var last = sheet.getLastRow();
  if (last < 2) return false;
  var ids = sheet.getRange(2, ID_COLUMN, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === orderId) return true;
  }
  return false;
}

/* Значения вида «=ФОРМУЛА» или «+7…» таблица не должна выполнять как формулу
   (клиент может вписать что угодно в комментарий): ставим апостроф. */
function cell_(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return value;
  var text = String(value);
  if (/^[=+\-@]/.test(text)) return "'" + text;
  return text;
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
