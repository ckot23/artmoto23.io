"use strict";
/* ============================================================================
   Единый прайс материалов и расчёты.

   На сайте три плёнки: матовая, глянцевая и металлик. Любой расчёт — и в
   калькуляторе, и в заявке модератору — проходит через минимальную сумму
   заказа, поэтому цифры на странице и в Telegram всегда совпадают.

   Остальные функции (calculate, validate, orderMessage) сохраняют совместимость
   с внутренними инструментами проекта.
   ========================================================================= */

/* Только три фактуры — всё, что реально печатаем и клеим. */
var FILMS = [
  { id: "matte",    name: "Матовая",   rate: 3.0 },
  { id: "gloss",    name: "Глянцевая", rate: 4.0 },
  { id: "metallic", name: "Металлик",  rate: 6.0 }
];

var DESIGNS = [
  { id: "own",     name: "Свой файл",      mult: 1.0,  setup: 0 },
  { id: "text",    name: "Надпись",        mult: 1.1,  setup: 0 },
  { id: "logo",    name: "Макет под ключ", mult: 1.25, setup: 1500 },
  { id: "catalog", name: "Из каталога",    mult: 1.0,  setup: 0 }
];

var COLORS = [
  { id: "black",     name: "Чёрный" },
  { id: "white",     name: "Белый" },
  { id: "red",       name: "Красный" },
  { id: "blue",      name: "Синий" },
  { id: "green",     name: "Зелёный" },
  { id: "yellow",    name: "Жёлтый" },
  { id: "orange",    name: "Оранжевый" },
  { id: "silver",    name: "Серебро" },
  { id: "gold",      name: "Золото" },
  { id: "fullcolor", name: "Полноцветная печать" }
];

var SHAPES = { rectangle: "Прямоугольник", rounded: "Скруглённая", circle: "Круглая" };

var COLOR_MULT = { fullcolor: 1.3, gold: 1.15, silver: 1.15 };
var TIERS = [[100, 0.6], [50, 0.68], [25, 0.75], [10, 0.82], [5, 0.9], [1, 1]];

/* Минимальный заказ: ниже этой суммы не работаем ни с одним материалом. */
var MIN_ORDER_PRICE = 500;

var DIM_MIN = 1;
var DIM_MAX = 500;
var QTY_MIN = 1;
var QTY_MAX = 10000;

function byId(list, id) {
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

function quantityMultiplier(qty) {
  for (var i = 0; i < TIERS.length; i++) if (qty >= TIERS[i][0]) return TIERS[i][1];
  return 1;
}

function round5(value) {
  return Math.round(value / 5) * 5;
}

/* ---------------------------------------------------------------------------
   quote() — единственная формула цены во всём проекте.

   Её зовут и калькулятор на сайте, и панель бота, и проверка заявки, поэтому
   цифра на экране клиента и цифра в сообщении модератору не могут разойтись:
   площадь × ставка × множители → округление до 5 ₽ → скидка за тираж →
   подготовка макета → минимум 500 ₽.

   Значения, которых нет в запросе, берутся дефолтными: «Свой файл» без
   надбавки и обычный чёрный цвет без множителя.
   ------------------------------------------------------------------------ */
function quote(input) {
  var film = byId(FILMS, input.film);
  if (!film) return null;
  var design = byId(DESIGNS, input.design) || byId(DESIGNS, "own");
  var colorMult = COLOR_MULT[input.color] || 1;

  var w = Number(input.w);
  var h = Number(input.h);
  var qty = Number(input.qty);
  if (!isFinite(w) || !isFinite(h) || !isFinite(qty)) return null;

  var area = w * h;
  var unit = Math.max(0, round5(area * film.rate * design.mult * colorMult));
  var discount = quantityMultiplier(qty);
  var gross = round5(unit * qty * discount) + design.setup;
  var total = Math.max(MIN_ORDER_PRICE, gross);

  return {
    film: film,
    design: design,
    colorMult: colorMult,
    area: area,
    unit: unit,
    setup: design.setup,
    discountPercent: Math.round((1 - discount) * 100),
    gross: gross,
    total: total,
    minApplied: total > gross,
    /* Сколько не хватает до минимального заказа — для подсказки на сайте. */
    toMin: Math.max(0, MIN_ORDER_PRICE - gross),
    minOrder: MIN_ORDER_PRICE
  };
}

/* Совместимый расчёт для внутренних инструментов работы с заявками.
   Публичная страница использует calculateEstimate() ниже. */
function calculate(order) {
  var price = quote(order);
  return {
    unit: price.unit,
    setup: price.setup,
    discountPercent: price.discountPercent,
    total: price.total,
    gross: price.gross,
    minApplied: price.minApplied,
    minOrder: price.minOrder,
    area: price.area
  };
}

function round2(value) {
  return Math.round((value + 1e-10) * 100) / 100;
}

/* Расчёт для калькулятора на главной странице. Формула та же, что и в заявке
   (quote выше), поэтому показанная сумма и сумма в Telegram совпадают.
   Дизайн и цвет необязательны: без них считаем «Свой файл» и обычный цвет. */
function calculateEstimate(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Не указаны параметры расчёта" };

  if (!byId(FILMS, raw.film)) return { ok: false, error: "Выберите тип плёнки" };

  var w = Number(raw.w);
  var h = Number(raw.h);
  var qty = Number(raw.qty);
  if (!isFinite(w) || w < DIM_MIN || w > DIM_MAX) return { ok: false, error: "Ширина должна быть от 1 до 500 см" };
  if (!isFinite(h) || h < DIM_MIN || h > DIM_MAX) return { ok: false, error: "Высота должна быть от 1 до 500 см" };
  if (!isFinite(qty) || qty < QTY_MIN || qty > QTY_MAX || Math.floor(qty) !== qty) {
    return { ok: false, error: "Количество должно быть целым числом от 1 до 10 000 шт" };
  }

  var price = quote({
    film: raw.film, design: raw.design, color: raw.color, shape: raw.shape,
    w: w, h: h, qty: qty
  });
  if (!price) return { ok: false, error: "Не удалось рассчитать стоимость" };

  return {
    ok: true,
    film: price.film.id,
    filmName: price.film.name,
    design: price.design.id,
    designName: price.design.name,
    rate: price.film.rate,
    width: w,
    height: h,
    quantity: qty,
    area: round2(price.area),
    unit: price.unit,
    setup: price.setup,
    discountPercent: price.discountPercent,
    /* Цена без скидки — чтобы показать клиенту, сколько он экономит. */
    withoutDiscount: round5(price.unit * qty),
    minOrder: price.minOrder,
    minApplied: price.minApplied,
    toMin: price.toMin,
    total: price.total
  };
}

/* Форматы контакта, которые понимают внутренние инструменты обработки заявок. */
var CONTACT_RE = /^(?:@[A-Za-z0-9_]{5,32}|[A-Za-z0-9_]{5,32}|\+?\d[\d\s().-]{8,20}|\S+@\S+\.\S{2,})$/;

function contactKind(value) {
  var v = String(value || "").trim();
  if (/^\S+@\S+\.\S{2,}$/.test(v)) return "e-mail";
  if (/^\+?[\d\s().-]{10,}$/.test(v)) return "телефон";
  return "Telegram";
}

/* Проверка полей заказа. Возвращает {ok, error, value} — value уже
   нормализовано и содержит только известные серверу значения. */
function validate(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Пустой запрос" };

  var film = byId(FILMS, raw.film);
  var design = byId(DESIGNS, raw.design);
  var color = byId(COLORS, raw.color);
  if (!film) return { ok: false, error: "Неизвестный материал" };
  if (!design) return { ok: false, error: "Неизвестный вариант дизайна" };
  if (!color) return { ok: false, error: "Неизвестный цвет" };

  var w = Number(raw.w);
  var h = Number(raw.h);
  var qty = Math.round(Number(raw.qty));
  if (!isFinite(w) || w < DIM_MIN || w > DIM_MAX) return { ok: false, error: "Ширина: от 1 до 500 см" };
  if (!isFinite(h) || h < DIM_MIN || h > DIM_MAX) return { ok: false, error: "Высота: от 1 до 500 см" };
  if (!isFinite(qty) || qty < QTY_MIN || qty > QTY_MAX) return { ok: false, error: "Тираж: от 1 до 10 000 шт" };

  var name = String(raw.name || "").trim().slice(0, 80);
  var contact = String(raw.contact || "").trim().slice(0, 64);
  var delivery = String(raw.delivery || "").trim().slice(0, 160);
  var comment = String(raw.comment || "").trim().slice(0, 600);

  if (name.length < 2) return { ok: false, error: "Укажите имя (минимум 2 символа)" };
  if (!CONTACT_RE.test(contact)) return { ok: false, error: "Укажите контакт: @username, телефон или e-mail" };

  return {
    ok: true,
    value: {
      film: film.id, filmName: film.name, filmRate: film.rate,
      design: design.id, designName: design.name,
      color: color.id, colorName: color.name,
      shape: SHAPES[raw.shape] ? raw.shape : "rectangle",
      shapeName: SHAPES[SHAPES[raw.shape] ? raw.shape : "rectangle"],
      w: w, h: h, qty: qty,
      name: name, contact: contact, contactKind: contactKind(contact),
      delivery: delivery, comment: comment,
      clientTotal: isFinite(Number(raw.client_total)) ? Math.round(Number(raw.client_total)) : null
    }
  };
}

/* Экранирование для parse_mode=HTML в Telegram. */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function money(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00A0") + " ₽";
}

/* Текст заявки для модератора. */
function orderMessage(order, price, meta) {
  var m = meta || {};
  var lines = [];
  lines.push("🆕 <b>Заказ №" + escapeHtml(m.orderId) + "</b>");
  lines.push("");
  lines.push("👤 <b>Имя:</b> " + escapeHtml(order.name));
  lines.push("📞 <b>Контакт:</b> " + escapeHtml(order.contact) + " (" + escapeHtml(order.contactKind) + ")");
  if (order.delivery) lines.push("🚚 <b>Получение:</b> " + escapeHtml(order.delivery));
  lines.push("");
  lines.push("🧩 <b>Конфигурация</b>");
  lines.push("• Материал: " + escapeHtml(order.filmName) + " (" + order.filmRate + " ₽/см²)");
  lines.push("• Дизайн: " + escapeHtml(order.designName));
  lines.push("• Цвет: " + escapeHtml(order.colorName));
  lines.push("• Форма: " + escapeHtml(order.shapeName));
  lines.push("• Размер: " + order.w + " × " + order.h + " см (" + Math.round(price.area) + " см²)");
  lines.push("• Тираж: " + order.qty + " шт");
  if (price.discountPercent > 0) lines.push("• Скидка за тираж: −" + price.discountPercent + "%");
  if (price.setup > 0) lines.push("• Разработка макета: " + money(price.setup));
  lines.push("");
  lines.push("💰 <b>Итого: " + money(price.total) + "</b> (" + money(price.unit) + "/шт)");
  if (price.minApplied) {
    lines.push("📌 Материал вышел дешевле минимума — принято по минимуму " + money(price.minOrder || MIN_ORDER_PRICE));
  }
  /* Сайт и заявка считают по одной формуле, поэтому строка появляется только
     если сумму в заявке подменили — тогда цифру нужно пересчитать. */
  if (order.clientTotal != null && order.clientTotal !== price.total) {
    lines.push("⚠️ В заявке указана другая сумма: " + money(order.clientTotal) + " — пересчитайте по прайсу");
  }
  if (order.comment) {
    lines.push("");
    lines.push("💬 <b>Комментарий:</b> " + escapeHtml(order.comment));
  }
  if (m.userId) {
    lines.push("");
    lines.push("🔗 <a href=\"tg://user?id=" + Number(m.userId) + "\">Написать клиенту в Telegram</a>");
  }
  lines.push("");
  lines.push("<i>" + escapeHtml(m.time) + (m.dryRun ? " · тестовый режим" : "") + "</i>");
  return lines.join("\n");
}

var API = {
  FILMS: FILMS,
  DESIGNS: DESIGNS,
  COLORS: COLORS,
  SHAPES: SHAPES,
  COLOR_MULT: COLOR_MULT,
  TIERS: TIERS,
  MIN_ORDER_PRICE: MIN_ORDER_PRICE,
  DIM_MIN: DIM_MIN,
  DIM_MAX: DIM_MAX,
  QTY_MIN: QTY_MIN,
  QTY_MAX: QTY_MAX,
  byId: byId,
  quote: quote,
  calculate: calculate,
  calculateEstimate: calculateEstimate,
  validate: validate,
  contactKind: contactKind,
  escapeHtml: escapeHtml,
  orderMessage: orderMessage,
  money: money
};

/* Один и тот же код используют Node (server.js, bot.js) и браузер
   (панель бота, bot.html) — поэтому прайс выдаётся и в модуль, и в globalThis. */
if (typeof module !== "undefined" && module.exports) module.exports = API;
if (typeof globalThis !== "undefined") globalThis.Pricing = API;
if (typeof window !== "undefined") window.Pricing = API;
