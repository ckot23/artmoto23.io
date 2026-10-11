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
    template: document.getElementById("order-template"),
    cartAdd: document.getElementById("cart-add"),
    cartAddStatus: document.getElementById("cart-add-status"),
    cartList: document.getElementById("cart-list"),
    cartEmpty: document.getElementById("cart-empty"),
    cartTotal: document.getElementById("cart-total"),
    cartCount: document.getElementById("cart-count"),
    cartCountLabel: document.getElementById("cart-count-label"),
    cartSubtotal: document.getElementById("cart-subtotal"),
    cartMinRow: document.getElementById("cart-min-row"),
    cartMinValue: document.getElementById("cart-min-value"),
    cartTotalSum: document.getElementById("cart-total-sum"),
    cartClear: document.getElementById("cart-clear"),
    cartBadge: document.getElementById("cart-badge")
  };

  /* Корзина (cart.js). Если модуль не подключён, страница остаётся калькулятором. */
  var cartModule = window.Cart || (typeof globalThis !== "undefined" ? globalThis.Cart : null);
  var cart = cartModule && typeof cartModule.create === "function" ? cartModule.create() : null;

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
    if (elements.cartAdd) elements.cartAdd.disabled = true;
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
    /* Цена самой наклейки: минимальный заказ считается на всю корзину. */
    var lineTotal = result.lineTotal != null ? result.lineTotal : result.total;
    elements.total.textContent = formatMoney(lineTotal);
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
        elements.minValue.textContent = "на весь заказ";
      } else {
        elements.minRow.hidden = true;
      }
    }

    if (elements.cartAdd) elements.cartAdd.disabled = false;
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
  function updateSummary() {
    if (!elements.summary) return;
    var sum = cart ? cart.summary() : null;
    if (!sum || !sum.count) {
      elements.summary.textContent = "Корзина пуста — добавьте хотя бы одну наклейку.";
      return;
    }
    var parts = [
      sum.count + " " + plural(sum.count, "позиция", "позиции", "позиций"),
      integerFormatter.format(sum.pieces) + " шт"
    ];
    elements.summary.textContent = parts.join(" · ") + " — " + formatMoney(sum.total);
  }

  function plural(n, one, few, many) {
    if (pricing && typeof pricing.plural === "function") return pricing.plural(n, one, few, many);
    return n === 1 ? one : many;
  }

  /* Подсказка над формой: какой эскиз сейчас выбран. */
  function updateSketchNote() {
    if (!elements.sketchNote) return;
    var sketchTitle = text(elements.sketch);
    elements.sketchNote.textContent = sketchTitle ? "Эскиз: " + sketchTitle : "";
    elements.sketchNote.hidden = !sketchTitle;
  }

  /* --------------------------------------------------------------------------
     КОРЗИНА
     ----------------------------------------------------------------------- */

  function node(tag, className, content) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (content != null) el.textContent = content;
    return el;
  }

  function cartButton(className, label, attr, id, aria) {
    var button = node("button", className, label);
    button.type = "button";
    button.setAttribute(attr, id);
    if (aria) button.setAttribute("aria-label", aria);
    return button;
  }

  function renderCartItem(line, index) {
    var item = line.item;
    var li = node("li", "cart-item");
    li.setAttribute("data-cart-item", line.id);

    li.appendChild(node("span", "cart-item__num", String(index + 1)));

    var body = node("div", "cart-item__body");
    body.appendChild(node("p", "cart-item__title", item.filmName + " · " + item.designName + " · " + item.colorName + " · " + item.shapeName));
    var meta = formatNumber(item.w) + " × " + formatNumber(item.h) + " см";
    if (item.sketch) meta += " · эскиз «" + item.sketch + "»";
    body.appendChild(node("p", "cart-item__meta", meta));
    li.appendChild(body);

    li.appendChild(node("span", "cart-item__price", formatMoney(line.total)));

    var tools = node("div", "cart-item__tools");
    var stepper = node("div", "qty-stepper");
    stepper.appendChild(cartButton("", "−", "data-cart-dec", line.id, "Уменьшить количество"));
    var input = node("input");
    input.type = "number";
    input.min = "1";
    input.max = String(QTY_MAX);
    input.step = "1";
    input.value = String(item.qty);
    input.setAttribute("inputmode", "numeric");
    input.setAttribute("aria-label", "Количество, шт");
    input.setAttribute("data-cart-qty", line.id);
    stepper.appendChild(input);
    stepper.appendChild(cartButton("", "+", "data-cart-inc", line.id, "Увеличить количество"));
    tools.appendChild(stepper);

    var unit = formatMoney(line.unit) + " за шт";
    if (line.discountPercent > 0) unit += " · скидка −" + line.discountPercent + "%";
    if (line.setup > 0) unit += " · макет " + formatMoney(line.setup);
    tools.appendChild(node("span", "cart-item__unit", unit));
    tools.appendChild(cartButton("cart-item__remove", "Удалить", "data-cart-remove", line.id));
    li.appendChild(tools);
    return li;
  }

  function renderCart() {
    if (!cart) return;
    var sum = cart.summary();
    var has = sum.count > 0;

    if (elements.cartList) {
      elements.cartList.textContent = "";
      sum.lines.forEach(function (line, index) {
        elements.cartList.appendChild(renderCartItem(line, index));
      });
    }
    if (elements.cartEmpty) elements.cartEmpty.hidden = has;
    if (elements.cartClear) elements.cartClear.hidden = !has;
    if (elements.cartTotal) elements.cartTotal.hidden = !has;
    if (has) {
      if (elements.cartCount) elements.cartCount.textContent = sum.count + " · " + integerFormatter.format(sum.pieces) + " шт";
      if (elements.cartCountLabel) elements.cartCountLabel.textContent = plural(sum.count, "Позиция", "Позиции", "Позиций");
      if (elements.cartSubtotal) elements.cartSubtotal.textContent = formatMoney(sum.subtotal);
      if (elements.cartMinRow) elements.cartMinRow.hidden = !sum.minApplied;
      if (elements.cartMinValue) elements.cartMinValue.textContent = "доплата " + formatMoney(sum.toMin);
      if (elements.cartTotalSum) elements.cartTotalSum.textContent = formatMoney(sum.total);
    }
    if (elements.cartBadge) {
      elements.cartBadge.hidden = !has;
      elements.cartBadge.textContent = String(sum.count);
    }
    if (elements.send && !busy) elements.send.disabled = !has;
    updateSummary();
  }

  function cartNotice(message, withLink) {
    var box = elements.cartAddStatus;
    if (!box) return;
    box.hidden = false;
    box.textContent = message;
    if (withLink) {
      var link = node("a", "", "Открыть корзину ↓");
      link.href = "#cart";
      box.appendChild(document.createTextNode(" "));
      box.appendChild(link);
    }
  }

  /* Подтверждение наклейки: параметры из калькулятора → позиция корзины. */
  function addToCart() {
    if (!cart) return;
    if (!last) {
      showError(elements.error && elements.error.textContent ? elements.error.textContent : "Сначала укажите размеры и количество.");
      return;
    }
    var result = cart.add({
      film: elements.film.value,
      design: value(elements.design, "own"),
      color: value(elements.color, "black"),
      shape: value(elements.shape, "rectangle"),
      sketch: text(elements.sketch),
      w: Number(last.width),
      h: Number(last.height),
      qty: Number(last.quantity)
    });
    if (!result.ok) {
      showError(result.error);
      return;
    }
    showError("");
    clearStatus();

    var count = cart.count();
    cartNotice((result.merged
      ? "Такая наклейка уже была в корзине — тираж увеличен. "
      : "Наклейка добавлена в корзину. ") +
      "В заявке: " + count + " " + plural(count, "позиция", "позиции", "позиций") + ".", true);

    /* Эскиз и шаблон относились к только что подтверждённой наклейке —
       следующую клиент собирает с чистого листа, размеры оставляем. */
    if (elements.template) {
      elements.template.textContent = "";
      elements.template.hidden = true;
    }
    var gallery = globalThis.SiteSketches;
    if (gallery && typeof gallery.clear === "function") gallery.clear();
    else if (elements.sketch) elements.sketch.value = "";
    updateSketchNote();
  }

  function cartAction(target) {
    if (!cart || !target || typeof target.closest !== "function") return false;
    var node_ = target.closest("[data-cart-dec], [data-cart-inc], [data-cart-remove]");
    if (!node_) return false;
    var id = node_.getAttribute("data-cart-dec") || node_.getAttribute("data-cart-inc") || node_.getAttribute("data-cart-remove");
    var item = cart.get(id);
    if (!item) return true;
    if (node_.hasAttribute("data-cart-remove")) cart.remove(id);
    else if (node_.hasAttribute("data-cart-dec")) cart.setQty(id, Math.max(1, item.qty - 1));
    else cart.setQty(id, Math.min(QTY_MAX, item.qty + 1));
    clearStatus();
    return true;
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
    return loadScriptOnce("tgdirect.js?v=5", hasDirect);
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

  var busy = false;

  function setBusy(isBusy) {
    busy = isBusy;
    if (elements.send) {
      elements.send.disabled = isBusy || !(cart && cart.count() > 0);
      elements.send.textContent = isBusy ? "Отправляем…" : "Отправить заявку";
      if (!isBusy) {
        var icon = elements.sendIcon;
        if (icon) elements.send.appendChild(icon);
      }
    }
  }

  function text(input) {
    return input ? String(input.value || "").trim() : "";
  }

  /* Заявка = все позиции корзины + контакты клиента. */
  function buildOrder() {
    var sum = cart.summary();
    return {
      items: cart.toOrderItems(),
      name: text(elements.name),
      contact: text(elements.contact),
      delivery: text(elements.delivery),
      comment: text(elements.comment),
      /* Что клиент увидел на экране — модератор увидит это в заявке */
      client_total: sum.total
    };
  }

  /* Заявка простым текстом — для запасного пути, когда прямая отправка
     в Telegram не прошла: клиент копирует её или пересылает менеджеру. */
  function plainText(order) {
    var sum = cart.summary();
    var lines = ["Заявка на наклейки", ""];
    sum.lines.forEach(function (line, index) {
      var item = line.item;
      lines.push((index + 1) + ". " + item.filmName + ", " + item.designName + ", " + item.colorName + ", " + item.shapeName +
        (item.sketch ? ", эскиз «" + item.sketch + "»" : ""));
      lines.push("   " + item.w + " × " + item.h + " см, " + item.qty + " шт — " + formatMoney(line.total));
    });
    lines.push("");
    lines.push("Итого: " + formatMoney(sum.total));
    lines.push("");
    lines.push("Имя: " + order.name);
    lines.push("Контакт: " + order.contact);
    if (order.delivery) lines.push("Получение: " + order.delivery);
    if (order.comment) lines.push("Комментарий: " + order.comment);
    return lines.join("\n");
  }

  function copyText(value, button) {
    function done(ok) { button.textContent = ok ? "Скопировано ✓" : "Выделите и скопируйте текст вручную"; }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(value).then(function () { done(true); }, function () { done(false); });
    } else {
      done(false);
    }
  }

  /* Если прямой запрос к Telegram не прошёл (сеть, VPN, блокировщик),
     даём клиенту запасной путь: корзина остаётся на месте, заявку можно
     скопировать и переслать менеджеру. Для заявки из одной наклейки, как
     раньше, есть ещё и ссылка на бота с собранным заказом. */
  function showFallback(order, hint) {
    if (!elements.status) return;
    elements.status.hidden = false;
    elements.status.className = "order-status order-status--warn";
    elements.status.textContent = hint || "Не удалось отправить заявку напрямую.";

    var body = plainText(order);
    var copy = node("button", "order-status__link", "Скопировать заявку");
    copy.type = "button";
    copy.style.cssText = "background:none;border:0;padding:0;font:inherit;cursor:pointer";
    copy.addEventListener("click", function () { copyText(body, copy); });
    elements.status.appendChild(document.createElement("br"));
    elements.status.appendChild(copy);

    var share = node("a", "order-status__link", "Переслать в Telegram ↗");
    share.href = "https://t.me/share/url?url=" + encodeURIComponent(" ") + "&text=" + encodeURIComponent(body);
    share.target = "_blank";
    share.rel = "noopener";
    elements.status.appendChild(document.createTextNode(" · "));
    elements.status.appendChild(share);

    if (!config.botUsername || order.items.length !== 1) return;

    /* Редкий запасной путь: код ссылки загружаем только при ошибке отправки. */
    var one = order.items[0];
    loadOrderLink().then(function () {
      var orderLink = window.OrderLink || (typeof globalThis !== "undefined" ? globalThis.OrderLink : null);
      if (!orderLink || typeof orderLink.botLink !== "function") return;
      var link = orderLink.botLink(config.botUsername, {
        film: one.film, design: one.design, color: one.color, shape: one.shape,
        w: one.w, h: one.h, qty: one.qty,
        name: order.name, delivery: order.delivery, comment: order.comment
      });
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
    var warnings = Array.isArray(reply.warnings) ? reply.warnings.filter(Boolean) : [];
    elements.status.className = warnings.length ? "order-status order-status--warn" : "order-status order-status--ok";
    var count = reply.count || 1;
    var message = "Заявка " + reply.order_id + " принята (" + count + " " +
      plural(count, "позиция", "позиции", "позиций") + ", " + formatMoney(reply.total) + ") — мы свяжемся с вами."
      + (config.replyTime ? " " + config.replyTime + "." : "");
    if (warnings.length) {
      message += " Предупреждение: " + warnings.join("; ") + ". Если с вами не связались, пожалуйста, напишите менеджеру.";
      if (typeof console !== "undefined") console.warn("Заявка принята с предупреждениями: " + warnings.join("; "));
    }
    elements.status.textContent = message;
    if (elements.form) elements.form.reset();
    if (cart) cart.clear();            /* перерисует корзину и сводку */
    if (elements.cartAddStatus) elements.cartAddStatus.hidden = true;
    updateSketchNote();
  }

  function submit() {
    if (!elements.form || !cart) {
      fieldError("Корзина недоступна — обновите страницу.");
      return;
    }
    if (!cart.count()) {
      fieldError("Корзина пуста: настройте наклейку и нажмите «Подтвердить и добавить в корзину».");
      return;
    }

    var order = buildOrder();

    /* Проверяем на клиенте то же, что проверит отправка: понятная ошибка
       без похода в Telegram. */
    if (order.name.length < 2) { fieldError("Укажите имя — минимум 2 символа."); return; }
    if (!order.contact) { fieldError("Оставьте телефон, Telegram или e-mail для связи."); return; }

    if (pricing && typeof pricing.validateCart === "function") {
      var checked = pricing.validateCart(order);
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
  /* Эскиз цену не меняет — обновляем только подсказку. */
  if (elements.sketch) elements.sketch.addEventListener("change", updateSketchNote);

  /* Корзина: добавление, тираж и удаление позиций. */
  if (cart) {
    if (elements.cartAdd) elements.cartAdd.addEventListener("click", addToCart);
    if (elements.cartClear) elements.cartClear.addEventListener("click", function () {
      cart.clear();
      clearStatus();
    });
    if (elements.cartList) {
      elements.cartList.addEventListener("click", function (event) { cartAction(event.target); });
      elements.cartList.addEventListener("change", function (event) {
        var input = event.target;
        var id = input && typeof input.getAttribute === "function" ? input.getAttribute("data-cart-qty") : null;
        if (!id) return;
        var qty = Number(String(input.value).replace(",", "."));
        var ok = isFinite(qty) && Math.floor(qty) === qty && cart.setQty(id, qty);
        if (!ok) renderCart();         /* неверное число — возвращаем прежний тираж */
        clearStatus();
      });
    }
    cart.subscribe(renderCart);
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
  if (elements.send) elements.sendIcon = elements.send.querySelector ? elements.send.querySelector("svg") : null;
  render();
  renderCart();
  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  if (elements.form) elements.form.addEventListener("submit", function (event) {
    event.preventDefault();
    submit();
  });
})();
