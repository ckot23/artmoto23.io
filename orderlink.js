#!/usr/bin/env node
"use strict";
/* ============================================================================
   Передача заявки в Telegram без сервера.

   Два формата — оба кладутся в ссылку на бота, которую открывает посетитель:

   1. Компактный (ссылка t.me/бот?start=...) — Telegram разрешает в параметре
      start не больше 64 символов base64url, то есть 48 байт данных. Поэтому
      заявка упаковывается в строку вида
          1|m|o|k|r|10|10|10|Пётр|Рига, СДЭК|к пятнице
      (коды материала, дизайна, цвета и формы — по одному символу), а имя,
      доставка и комментарий занимают остаток места: что не влезло — бот
      уточнит в чате. Так заявка уходит одним нажатием кнопки START.

   2. Полный (сообщение, которым делятся через t.me/share/url) — заявка целиком
      в base64url-JSON с меткой #STICKERS:. Лимит сообщения 4096 символов,
      поэтому здесь ничего не теряется.

   Компактный формат собирает и сайт (index.html), поэтому версия стоит первой:
   при расхождении версий бот попросит собрать заявку заново вместо того, чтобы
   отправить модератору мусор. Сквозную проверку «сайт → бот» делает npm test.
   ========================================================================= */

var VERSION = "1";
var SEP = "|";
var START_LIMIT = 64;                 /* символов в параметре ?start= */
var RAW_LIMIT = 48;                   /* 48 байт → ровно 64 символа base64url */

/* Однобуквенные коды значений прайса. */
var CODES = {
  film: { matte: "m", gloss: "g", transparent: "t", metallic: "M", reflective: "r" },
  design: { own: "o", text: "t", logo: "l", catalog: "c" },
  color: { black: "k", white: "w", red: "r", blue: "b", green: "g", yellow: "y", orange: "o", silver: "s", gold: "z", fullcolor: "f" },
  shape: { rectangle: "r", rounded: "d", circle: "c" }
};

function flip(table) {
  var out = {};
  Object.keys(table).forEach(function (id) { out[table[id]] = id; });
  return out;
}
var IDS = {
  film: flip(CODES.film),
  design: flip(CODES.design),
  color: flip(CODES.color),
  shape: flip(CODES.shape)
};

function base64url(text) {
  return Buffer.from(text, "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value) {
  var text = String(value).replace(/-/g, "+").replace(/_/g, "/");
  while (text.length % 4) text += "=";
  return Buffer.from(text, "base64").toString("utf8");
}

function num(value) {
  var n = Number(value);
  if (!isFinite(n)) return "0";
  return String(Math.round(n * 10) / 10);      /* 10 и 10.5 — без хвостовых нулей */
}

/* «|» занят как разделитель, переводы строк в ссылку не помещаются. */
function clean(value) {
  return String(value == null ? "" : value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\|/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

/* Обрезает строку до maxBytes байт UTF-8, не разрезая символ пополам. */
function short(value, maxBytes) {
  var text = String(value);
  var out = "";
  for (var i = 0; i < text.length; i++) {
    var next = out + text.charAt(i);
    if (Buffer.byteLength(next, "utf8") > maxBytes) break;
    out = next;
  }
  return out;
}

/* Заявка → компактная строка → base64url (≤ 64 символа). */
function pack(order) {
  var head = [
    VERSION,
    CODES.film[order.film] || "m",
    CODES.design[order.design] || "o",
    CODES.color[order.color] || "k",
    CODES.shape[order.shape] || "r",
    num(order.w), num(order.h), num(order.qty)
  ];
  var headText = head.join(SEP);
  var budget = RAW_LIMIT - Buffer.byteLength(headText + SEP, "utf8");
  var tail = [clean(order.name), clean(order.delivery), clean(order.comment)];

  var parts = head.slice();
  for (var i = 0; i < tail.length && budget > 0; i++) {
    if (!tail[i]) { parts.push(""); budget -= 1; continue; }   /* позиция сохраняется */
    var room = budget - 1;
    var fits = Buffer.byteLength(tail[i], "utf8") <= room;
    var piece = fits ? tail[i] : short(tail[i], room);
    /* Обрывок из пары букв бесполезен: лучше не включать поле совсем. */
    if (!piece || (!fits && Buffer.byteLength(piece, "utf8") < 8)) break;
    parts.push(piece);
    budget -= 1 + Buffer.byteLength(piece, "utf8");
  }
  while (parts.length > 8 && parts[parts.length - 1] === "") parts.pop();

  var text = parts.join(SEP);
  if (Buffer.byteLength(text, "utf8") > RAW_LIMIT) {          /* страховка */
    text = short(text, RAW_LIMIT);
  }
  return base64url(text);
}

/* Компактная строка → заявка (то, что бот получает в «/start <параметр>»). */
function unpack(payload) {
  var text;
  try { text = fromBase64url(payload); } catch (e) { return null; }
  var parts = String(text).split(SEP);
  if (parts[0] !== VERSION) return null;
  var film = IDS.film[parts[1]];
  var design = IDS.design[parts[2]];
  var color = IDS.color[parts[3]];
  var shape = IDS.shape[parts[4]] || "rectangle";
  var w = Number(parts[5]);
  var h = Number(parts[6]);
  var qty = Number(parts[7]);
  if (!film || !design || !color) return null;
  if (!isFinite(w) || !isFinite(h) || !isFinite(qty) || w <= 0 || h <= 0 || qty <= 0) return null;
  return {
    film: film, design: design, color: color, shape: shape,
    w: w, h: h, qty: qty,
    name: parts[8] || "", delivery: parts[9] || "", comment: parts[10] || ""
  };
}

/* Полный формат для сообщения: #STICKERS:<base64url json>. */
function toToken(order) {
  return "#STICKERS:" + base64url(JSON.stringify(order));
}

function fromToken(text) {
  var found = String(text || "").match(/#STICKERS:([A-Za-z0-9_-]+)/);
  if (!found) return null;
  var order;
  try { order = JSON.parse(fromBase64url(found[1])); } catch (e) { return null; }
  return order && typeof order === "object" ? order : null;
}

/* Параметр для ссылки t.me/бот?start=... — гарантированно влезает в лимит. */
function startParam(order) {
  var param = pack(order);
  while (param.length > START_LIMIT) param = param.slice(0, param.length - 4);
  return param;
}

function botLink(botUsername, order) {
  return "https://t.me/" + String(botUsername).replace(/^@/, "") + "?start=" + startParam(order);
}

module.exports = {
  VERSION: VERSION,
  START_LIMIT: START_LIMIT,
  RAW_LIMIT: RAW_LIMIT,
  CODES: CODES,
  pack: pack,
  unpack: unpack,
  toToken: toToken,
  fromToken: fromToken,
  startParam: startParam,
  botLink: botLink,
  base64url: base64url,
  fromBase64url: fromBase64url
};
