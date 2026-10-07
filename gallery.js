/* ============================================================================
   gallery.js — витрина шаблонов на главной странице.

   Каталог лежит в templates/catalog.js и объявляет globalThis.SITE_TEMPLATES.
   Его наполняет и публикует владелец сайта; здесь мы только показываем
   результат: карточка, цена от прайса и кнопка «взять в расчёт».

   Правила простые:
     • шаблон не нашёлся или каталог пуст — витрина прячется целиком, чтобы
       на странице не было пустых каркасов;
     • цена считается Pricing.calculate(), а не самой галереей;
     • клик по карточке подставляет настройки в калькулятор и ведёт к нему.
   ========================================================================= */
(function () {
  "use strict";

  var templates = globalThis.Templates || null;
  var pricing = globalThis.Pricing || null;

  function byId(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function filmName(id) {
    if (pricing && typeof pricing.byId === "function") {
      var film = pricing.byId(pricing.FILMS, id);
      if (film) return film.name;
    }
    return "";
  }

  function money(value) {
    return Number(value).toLocaleString("ru-RU", { maximumFractionDigits: 0 }) + " ₽";
  }

  /* Цена карточки — та же формула, что и в заявке модератору. */
  function priceOf(item) {
    if (!pricing || typeof pricing.calculate !== "function") return null;
    return pricing.calculate({ film: item.settings.film, design: item.settings.design,
      color: item.settings.color, shape: item.settings.shape,
      w: item.settings.width, h: item.settings.height, qty: item.settings.quantity });
  }

  /* Шаблон → форма заказа. Имена полей у конструктора и у прайса различаются
     (width/height/quantity против w/h/qty), поэтому раскладываем по местам. */
  function applySettings(item) {
    var settings = item.settings;
    var film = byId((pricing && pricing.FILMS) || [], settings.film);
    if (!film) return;

    var set = function (id, value) {
      var input = document.getElementById(id);
      if (!input) return;
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };

    set("film-type", settings.film);
    set("width", settings.width);
    set("height", settings.height);
    set("quantity", settings.quantity);
    set("order-shape", settings.shape);
    set("order-design", settings.design);
    set("order-color", settings.color);

    var note = document.getElementById("order-template");
    if (note) {
      note.textContent = "Выбран шаблон — " + item.title;
      note.hidden = false;
    }

    var calculator = document.getElementById("calculator");
    if (calculator && typeof calculator.scrollIntoView === "function") {
      calculator.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function card(item) {
    var node = document.createElement("article");
    node.className = "tpl-card";
    node.setAttribute("data-template", item.id);

    var price = priceOf(item);
    var film = filmName(item.settings.film);

    if (item.img) {
      var photo = document.createElement("img");
      photo.className = "tpl-card__photo";
      photo.src = item.img;
      photo.alt = item.title;
      photo.loading = "lazy";
      photo.decoding = "async";
      /* Фото может ещё не попасть в репозиторий: показываем карточку с
         плашкой, а не сломанную картинку. */
      photo.addEventListener("error", function () {
        photo.remove();
        node.classList.add("tpl-card--no-photo");
      });
      node.appendChild(photo);
    } else {
      node.classList.add("tpl-card--no-photo");
    }

    var body = document.createElement("div");
    body.className = "tpl-card__body";

    var heading = document.createElement("h3");
    heading.className = "tpl-card__title";
    heading.textContent = item.title;
    body.appendChild(heading);

    if (item.note) {
      var note = document.createElement("p");
      note.className = "tpl-card__note";
      note.textContent = item.note;
      body.appendChild(note);
    }

    var spec = document.createElement("p");
    spec.className = "tpl-card__spec";
    spec.textContent = [
      film.toLowerCase(),
      item.settings.width + " × " + item.settings.height + " см",
      item.settings.quantity + " шт"
    ].join(" · ");
    body.appendChild(spec);

    var footer = document.createElement("div");
    footer.className = "tpl-card__foot";

    var cost = document.createElement("span");
    cost.className = "tpl-card__price";
    cost.textContent = price ? "от " + money(price.total) : "—";
    footer.appendChild(cost);

    var pick = document.createElement("button");
    pick.type = "button";
    pick.className = "tpl-card__pick";
    pick.textContent = "В расчёт ↗";
    pick.addEventListener("click", function () { applySettings(item); });
    footer.appendChild(pick);

    body.appendChild(footer);
    node.appendChild(body);
    return node;
  }

  /* Каталога нет — витрину не показываем вовсе: пустые каркасы на странице
     выглядят хуже, чем их отсутствие. */
  function render() {
    var section = document.getElementById("templates");
    var grid = document.getElementById("templates-grid");
    if (!section || !grid) return;

    var list = [];
    if (templates && typeof templates.catalogFromGlobal === "function") {
      list = templates.catalogFromGlobal(globalThis);
    }

    if (!list.length) {
      grid.textContent = "";
      section.hidden = true;
      return;
    }

    grid.textContent = "";
    list.forEach(function (item) { grid.appendChild(card(item)); });
    section.hidden = false;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }

  globalThis.SiteGallery = { render: render, priceOf: priceOf };
})();
