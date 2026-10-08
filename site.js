(function () {
  "use strict";

  var pricing = window.Pricing || (typeof globalThis !== "undefined" ? globalThis.Pricing : null);
  var config = window.SITE || (typeof globalThis !== "undefined" ? globalThis.SITE : null) || {};
  var fallbackFilms = [
    { id: "matte", name: "Матовая", rate: 3 },
    { id: "gloss", name: "Глянцевая", rate: 4 },
    { id: "metallic", name: "Металлик", rate: 6 }
  ];
  var films = pricing && Array.isArray(pricing.FILMS) ? pricing.FILMS : fallbackFilms;

  var elements = {
    film: document.getElementById("film-type"),
    width: document.getElementById("width"),
    height: document.getElementById("height"),
    quantity: document.getElementById("quantity"),
    error: document.getElementById("calc-error"),
    total: document.getElementById("total-price"),
    subtitle: document.getElementById("result-subtitle"),
    area: document.getElementById("area-value"),
    rate: document.getElementById("rate-value"),
    unit: document.getElementById("unit-price"),
    minRow: document.getElementById("min-row"),
    minValue: document.getElementById("min-value"),
    discountRow: document.getElementById("discount-row"),
    discountValue: document.getElementById("discount-value"),
    calculator: document.getElementById("calculator"),
    form: document.getElementById("order-form"),
    name: document.getElementById("order-name"),
    contact: document.getElementById("order-contact"),
    delivery: document.getElementById("order-delivery"),
    comment: document.getElementById("order-comment"),
    design: document.getElementById("order-design"),
    color: document.getElementById("order-color"),
    shape: document.getElementById("order-shape"),
    sketch: document.getElementById("order-sketch"),
    sketchNote: document.getElementById("order-sketch-note"),
    send: document.getElementById("order-send"),
    status: document.getElementById("order-status"),
    summary: document.getElementById("order-summary"),
    template: document.getElementById("order-template")
  };

  var DIM_MIN = 1;
  var DIM_MAX = 500;
  var QTY_MAX = 10000;
  var last = null;              /* последний удачный расчёт — источник для заявки */

  if (!elements.film || !elements.width || !elements.height || !elements.quantity) return;

  /* --------------------------------------------------------------------------
     ФОРМАТ ЧИСЕЛ
     ----------------------------------------------------------------------- */

  var numberFormatter = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
  var integerFormatter = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

  function formatNumber(value) {
    return numberFormatter.format(Number(value));
  }

  function formatMoney(value) {
    return formatNumber(value) + " ₽";
  }

  function filmById(id) {
    if (pricing && typeof pricing.byId === "function") return pricing.byId(films, id);
    for (var i = 0; i < films.length; i++) if (films[i].id === id) return films[i];
    return null;
  }

  /* --------------------------------------------------------------------------
     КАЛЬКУЛЯТОР
     ----------------------------------------------------------------------- */

  function updateRates() {
    films.forEach(function (film) {
      var rateText = formatNumber(film.rate) + " ₽/см²";
      var cardRate = document.querySelector('[data-film-rate="' + film.id + '"]');
      if (cardRate) cardRate.textContent = rateText;
    });

    var options = elements.film.options;
    for (var i = 0; i < options.length; i++) {
      var film = filmById(options[i].value);
      if (film) options[i].textContent = film.name + " — " + formatNumber(film.rate) + " ₽/см²";
    }
  }

  function readNumber(input) {
    var value = String(input.value || "").trim().replace(",", ".");
    return value === "" ? NaN : Number(value);
  }

  function setInvalid(input, invalid) {
    input.setAttribute("aria-invalid", invalid ? "true" : "false");
  }

  function showError(message) {
    if (!elements.error) return;
    elements.error.hidden = !message;
    elements.error.textContent = message || "";
  }

  function clearResult() {
    last = null;
    elements.total.textContent = "—";
    elements.subtitle.textContent = "Проверьте параметры расчёта";
    elements.area.textContent = "—";
    elements.rate.textContent = "—";
    elements.unit.textContent = "—";
    if (elements.minRow) elements.minRow.hidden = true;
    if (elements.discountRow) elements.discountRow.hidden = true;
    updateSummary(null);
  }

  function estimate(input) {
    if (pricing && typeof pricing.calculateEstimate === "function") {
      return pricing.calculateEstimate(input);
    }

    var film = filmById(input.film);
    if (!film) return { ok: false, error: "Выберите тип плёнки" };
    var area = Math.round(input.w * input.h * 100) / 100;
    var unit = Math.round((area * film.rate + 1e-10) * 100) / 100;
    return {
      ok: true,
      film: film.id,
      filmName: film.name,
      rate: film.rate,
      width: input.w,
      height: input.h,
      quantity: input.qty,
      area: area,
      unit: unit,
      total: Math.round((unit * input.qty + 1e-10) * 100) / 100
    };
  }

  function render() {
    var width = readNumber(elements.width);
    var height = readNumber(elements.height);
    var quantity = readNumber(elements.quantity);
    var inputError = null;

    var invalidWidth = !isFinite(width) || width < DIM_MIN || width > DIM_MAX;
    var invalidHeight = !isFinite(height) || height < DIM_MIN || height > DIM_MAX;
    var invalidQuantity = !isFinite(quantity) || quantity < 1 || quantity > QTY_MAX || Math.floor(quantity) !== quantity;
    setInvalid(elements.width, invalidWidth);
    setInvalid(elements.height, invalidHeight);
    setInvalid(elements.quantity, invalidQuantity);

    if (invalidWidth) inputError = "Ширина должна быть от " + DIM_MIN + " до " + DIM_MAX + " см.";
    else if (invalidHeight) inputError = "Высота должна быть от " + DIM_MIN + " до " + DIM_MAX + " см.";
    else if (invalidQuantity) inputError = "Количество должно быть целым числом от 1 до 10 000 шт.";

    if (inputError) {
      showError(inputError);
      clearResult();
      return;
    }

    var result = estimate({
      film: elements.film.value,
      design: value(elements.design, "own"),
      color: value(elements.color, "black"),
      w: width, h: height, qty: quantity
    });
    if (!result || result.ok === false) {
      showError(result && result.error ? result.error : "Не удалось выполнить расчёт.");
      clearResult();
      return;
    }

    var selectedFilm = filmById(result.film);
    showError("");
    last = result;
    elements.total.textContent = formatMoney(result.total);
    elements.subtitle.textContent = integerFormatter.format(result.quantity) + " шт. · " + (selectedFilm ? selectedFilm.name.toLowerCase() : "плёнка");
    elements.area.textContent = formatNumber(result.area) + " см²";
    elements.rate.textContent = formatMoney(result.rate);
    elements.unit.textContent = formatMoney(result.unit);

    /* Скидка за тираж: показываем, сколько клиент экономит. */
    if (elements.discountRow && elements.discountValue) {
      if (result.discountPercent > 0) {
        elements.discountRow.hidden = false;
        elements.discountValue.textContent = "−" + result.discountPercent + "% · " + formatMoney(result.withoutDiscount);
      } else {
        elements.discountRow.hidden = true;
      }
    }

    /* Минимальный заказ виден отдельной строкой — иначе выглядит как ошибка расчёта. */
    if (elements.minRow && elements.minValue) {
      if (result.minApplied) {
        elements.minRow.hidden = false;
        elements.minValue.textContent = "доплата " + formatMoney(result.toMin);
      } else {
        elements.minRow.hidden = true;
      }
    }

    updateSummary(result);
  }

  function bindInput(input) {
    input.addEventListener("input", render);
    input.addEventListener("change", render);
  }

  /* --------------------------------------------------------------------------
     ЗАЯВКА
     ----------------------------------------------------------------------- */

  function option(value, label) {
    return { value: value, label: label };
  }

  function fillSelect(select, items) {
    if (!select) return;
    select.textContent = "";
    items.forEach(function (item) {
      var node = document.createElement("option");
      node.value = item.value;
      node.textContent = item.label;
      select.appendChild(node);
    });
  }

  /* Варианты дизайна, цвета и формы берём из прайса, чтобы страница и
     заявка модератору не могли разойтись. Эскизы — из sketches/catalog.js:
     они на цену не влияют, в расчёт не подставляются. */
  function fillOptions() {
    if (pricing && Array.isArray(pricing.DESIGNS)) {
      fillSelect(elements.design, pricing.DESIGNS.map(function (item) { return option(item.id, item.name); }));
    }
    if (pricing && Array.isArray(pricing.COLORS)) {
      fillSelect(elements.color, pricing.COLORS.map(function (item) { return option(item.id, item.name); }));
    }
    if (pricing && pricing.SHAPES) {
      fillSelect(elements.shape, Object.keys(pricing.SHAPES).map(function (id) {
        return option(id, pricing.SHAPES[id]);
      }));
    }
    fillSketches();
  }

  /* Список «Эскиз» в форме: «Свой эскиз» плюс названия из каталога примеров.
     Выбранный эскиз уходит модератору строкой в заявке. */
  function sketchList() {
    var items = globalThis.SITE_SKETCHES;
    return Array.isArray(items) ? items : [];
  }

  function fillSketches() {
    if (!elements.sketch) return;
    var items = sketchList().map(function (item) {
      return option(String(item && item.title || "").trim(), String(item && item.title || "").trim());
    }).filter(function (item) { return item.value; });
    /* Селект уже заполнен витриной эскизов — не дублируем. */
    if (elements.sketch.options.length > 1) return;
    fillSelect(elements.sketch, [option("", "Свой эскиз")].concat(items));
  }

  function value(select, fallback) {
    return select && select.value ? select.value : fallback;
  }

  /* Сводка заказа под формой: что именно мы отправим модератору. */
  function updateSummary(result) {
    if (!elements.summary) return;
    if (!result) {
      elements.summary.textContent = "Укажите размеры — и мы соберём заявку.";
      return;
    }
    var film = filmById(result.film);
    var design = null;
    if (pricing && typeof pricing.byId === "function") design = pricing.byId(pricing.DESIGNS, result.design);
    var parts = [
      film ? film.name : "плёнка",
      result.width + " × " + result.height + " см",
      result.quantity + " шт"
    ];
    if (design) parts.push(design.name.toLowerCase());
    /* Эскиз на цену не влияет — в сводке просто напоминание о выборе. */
    var sketchTitle = text(elements.sketch);
    if (sketchTitle) parts.push("эскиз «" + sketchTitle + "»");
    if (result.setup > 0) parts.push("макет " + formatMoney(result.setup));
    elements.summary.textContent = parts.join(" · ") + " — " + formatMoney(result.total);
  }

  /* Подсказка над формой: какой эскиз сейчас выбран. */
  function updateSketchNote() {
    if (!elements.sketchNote) return;
    var sketchTitle = text(elements.sketch);
    elements.sketchNote.textContent = sketchTitle ? "Эскиз: " + sketchTitle : "";
    elements.sketchNote.hidden = !sketchTitle;
  }

  var scriptPromises = Object.create(null);

  function hasDirect() {
    var direct = window.TgDirect || (typeof globalThis !== "undefined" ? globalThis.TgDirect : null);
    return !!(direct && typeof direct.send === "function");
  }

  function hasOrderLink() {
    var orderLink = window.OrderLink || (typeof globalThis !== "undefined" ? globalThis.OrderLink : null);
    return !!(orderLink && typeof orderLink.botLink === "function");
  }

  function loadScriptOnce(src, ready) {
    if (ready()) return Promise.resolve();
    if (scriptPromises[src]) return scriptPromises[src];

    scriptPromises[src] = new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = function () {
        if (ready()) resolve();
        else reject(new Error("Скрипт загрузился, но модуль не запустился."));
      };
      script.onerror = function () { reject(new Error("Не удалось загрузить модуль.")); };
      (document.head || document.body).appendChild(script);
    }).catch(function (error) {
      delete scriptPromises[src];
      throw error;
    });

    return scriptPromises[src];
  }

  function loadDirect() {
    return loadScriptOnce("tgdirect.js?v=4", hasDirect);
  }

  function loadOrderLink() {
    return loadScriptOnce("orderlink.js?v=4", hasOrderLink);
  }

  function fieldError(message) {
    if (!elements.status) return;
    elements.status.hidden = false;
    elements.status.className = "order-status order-status--error";
    elements.status.textContent = message;
  }

  function clearStatus() {
    if (!elements.status) return;
    elements.status.hidden = true;
    elements.status.textContent = "";
  }

  function setBusy(busy) {
    if (elements.send) {
      elements.send.disabled = busy;
      elements.send.textContent = busy ? "Отправляем…" : "Отправить заявку в Telegram";
    }
  }

  function text(input) {
    return input ? String(input.value || "").trim() : "";
  }

  function buildOrder() {
    return {
      film: elements.film.value,
      design: value(elements.design, "own"),
      color: value(elements.color, "black"),
      shape: value(elements.shape, "rectangle"),
      sketch: text(elements.sketch),
      w: Number(last.width),
      h: Number(last.height),
      qty: Number(last.quantity),
      name: text(elements.name),
      contact: text(elements.contact),
      delivery: text(elements.delivery),
      comment: text(elements.comment),
      /* Что клиент увидел на экране — модератор увидит это в заявке */
      client_total: last.total
    };
  }

  /* Если прямой запрос к Telegram не прошёл (сеть, VPN, блокировщик),
     даём клиенту запасной путь: открыть бота с уже собранным заказом. */
  function showFallback(order, hint) {
    if (!elements.status) return;
    elements.status.hidden = false;
    elements.status.className = "order-status order-status--warn";
    elements.status.textContent = hint || "Не удалось отправить заявку напрямую.";
    if (!config.botUsername) return;

    /* Редкий запасной путь: код ссылки загружаем только при ошибке отправки. */
    loadOrderLink().then(function () {
      var orderLink = window.OrderLink || (typeof globalThis !== "undefined" ? globalThis.OrderLink : null);
      if (!orderLink || typeof orderLink.botLink !== "function") return;
      var link = orderLink.botLink(config.botUsername, order);
      if (!link) return;

      var button = document.createElement("a");
      button.className = "order-status__link";
      button.href = link;
      button.target = "_blank";
      button.rel = "noopener";
      button.textContent = "Открыть бота и отправить заказ вручную ↗";
      elements.status.appendChild(document.createElement("br"));
      elements.status.appendChild(button);
    }).catch(function () {
      /* Подсказка об ошибке уже видна; прямой адрес бота есть в шапке. */
    });
  }

  function showSuccess(reply) {
    if (!elements.status) return;
    elements.status.hidden = false;
    elements.status.className = "order-status order-status--ok";
    elements.status.textContent = "Заявка " + reply.order_id + " принята — мы напишем вам в Telegram."
      + (config.replyTime ? " " + config.replyTime + "." : "");
    if (elements.form) elements.form.reset();
    if (elements.template) {
      elements.template.textContent = "";
      elements.template.hidden = true;
    }
    /* reset() не вызывает change: снимаем выбор эскиза сами. */
    updateSketchNote();
    var gallery = globalThis.SiteSketches;
    if (gallery && typeof gallery.clear === "function") gallery.clear();
    updateSummary(last);
  }

  function submit() {
    if (!elements.form || !last) {
      fieldError("Сначала посчитайте стоимость: укажите размеры и количество.");
      return;
    }

    var order = buildOrder();

    /* Проверяем на клиенте то же, что проверит сервер: понятная ошибка
       без похода в Telegram. */
    if (order.name.length < 2) { fieldError("Укажите имя — минимум 2 символа."); return; }
    if (!order.contact) { fieldError("Оставьте телефон, Telegram или e-mail для связи."); return; }

    if (pricing && typeof pricing.validate === "function") {
      var checked = pricing.validate(order);
      if (!checked.ok) { fieldError(checked.error); return; }
    }

    clearStatus();
    setBusy(true);

    loadDirect().then(function () {
      var direct = window.TgDirect || (typeof globalThis !== "undefined" ? globalThis.TgDirect : null);
      if (!direct || typeof direct.send !== "function") throw new Error("Модуль отправки не запустился.");
      return direct.send(order);
    }).then(function (reply) {
      setBusy(false);
      if (reply && reply.ok) {
        showSuccess(reply);
        return;
      }
      var hint = (reply && reply.hint) ? " " + reply.hint : "";
      if (reply && reply.kind === "field") fieldError(reply.error);
      else showFallback(order, ((reply && reply.error) || "Заявка не отправлена.") + hint);
    }, function (error) {
      setBusy(false);
      var prefix = hasDirect() ? "Нет связи с Telegram." : "Не удалось загрузить отправку заявки.";
      showFallback(order, prefix + (error && error.message ? " " + error.message : ""));
    });
  }

  /* --------------------------------------------------------------------------
     ЗАПУСК
     ----------------------------------------------------------------------- */

  elements.film.addEventListener("change", render);
  bindInput(elements.width);
  bindInput(elements.height);
  bindInput(elements.quantity);
  /* Дизайн и цвет меняют цену, поэтому пересчитываем полностью. */
  if (elements.design) bindInput(elements.design);
  if (elements.color) bindInput(elements.color);
  /* Эскиз цену не меняет — обновляем только подсказку и сводку заказа. */
  if (elements.sketch) {
    var sketchPicked = function () {
      updateSketchNote();
      updateSummary(last);
    };
    elements.sketch.addEventListener("change", sketchPicked);
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    var button = target && typeof target.closest === "function" ? target.closest("[data-select-film]") : null;
    if (!button) return;

    var film = filmById(button.getAttribute("data-select-film"));
    if (!film) return;

    elements.film.value = film.id;
    render();
    if (elements.calculator && typeof elements.calculator.scrollIntoView === "function") {
      elements.calculator.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    if (typeof elements.film.focus === "function") elements.film.focus();
  });

  fillOptions();
  updateRates();
  render();
  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  if (elements.form) elements.form.addEventListener("submit", function (event) {
    event.preventDefault();
    submit();
  });
})();
