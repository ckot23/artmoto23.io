/* ============================================================================
   sketch-gallery.js — витрина примеров эскизов на главной странице.

   Эскизы заданы в sketches/catalog.js (globalThis.SITE_SKETCHES): это
   картинки-подсказки, которые клиент может взять за основу наклейки.
   Цен у эскизов нет — стоимость зависит от плёнки, размера и тиража
   и считается калькулятором, поэтому этот модуль прайс не трогает.

   Выбор эскиза:
     • карточка подсвечивается, селект «Эскиз» в форме заявки синхронизируется;
     • выбранное название уходит модератору отдельной строкой заявки;
     • повторный клик по карточке или «Свой эскиз» в селекте — выбор сброшен.
   ========================================================================= */
(function () {
  "use strict";

  var scope = typeof globalThis !== "undefined" ? globalThis : window;

  function sketches() {
    var list = scope.SITE_SKETCHES;
    if (!Array.isArray(list)) return [];

    var seen = {};
    var out = [];
    list.forEach(function (item) {
      var id = String(item && item.id || "").trim();
      if (!id || seen[id]) return;
      seen[id] = true;
      out.push({
        id: id,
        title: String(item && item.title || "Эскиз").trim(),
        img: String(item && item.img || "").trim()
      });
    });
    return out;
  }

  /* Ищем и по id (карточки), и по названию (значение селекта). */
  function find(idOrTitle) {
    var key = String(idOrTitle || "").trim();
    if (!key) return null;
    var list = sketches();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === key || list[i].title === key) return list[i];
    }
    return null;
  }

  var state = { selectedId: "" };

  /* Выбор эскиза: подсветка карточки, синхронизация селекта и подсказки
     в форме. Пустая строка — «Свой эскиз», выбор сброшен. */
  function apply(idOrTitle) {
    var sketch = find(idOrTitle);
    state.selectedId = sketch ? sketch.id : "";

    var nodes = document.querySelectorAll ? document.querySelectorAll("[data-sketch-card]") : [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var picked = node.getAttribute("data-sketch-card") === state.selectedId;
      node.classList.toggle("tpl-card--picked", picked);
      var pick = node.querySelector ? node.querySelector("[data-sketch-pick]") : null;
      if (pick) {
        pick.setAttribute("aria-pressed", picked ? "true" : "false");
        pick.textContent = picked ? "Выбрано ✓" : "Выбрать ✓";
      }
    }

    var select = document.getElementById("order-sketch");
    if (select) {
      var next = sketch ? sketch.title : "";
      if (select.value !== next) {
        select.value = next;
        /* Форма пересоберёт сводку заказа так же, как при ручном выборе. */
        if (typeof select.dispatchEvent === "function" && typeof Event === "function") {
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
    }

    return sketch;
  }

  function clear() { return apply(""); }

  function card(item) {
    var node = document.createElement("article");
    node.className = "tpl-card tpl-card--sketch";
    node.setAttribute("data-sketch-card", item.id);

    if (item.img) {
      var photo = document.createElement("img");
      photo.className = "tpl-card__photo";
      photo.src = item.img;
      photo.alt = "Эскиз наклейки — " + item.title;
      photo.loading = "lazy";
      photo.decoding = "async";
      /* Картинка могла не доехать до репозитория: показываем карточку
         с неоновой плашкой вместо сломанного изображения. */
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

    var spec = document.createElement("p");
    spec.className = "tpl-card__spec";
    spec.textContent = "эскиз · возьмём за основу вашей наклейки";
    body.appendChild(spec);

    var footer = document.createElement("div");
    footer.className = "tpl-card__foot";

    var hint = document.createElement("span");
    hint.className = "tpl-card__sketch-hint";
    hint.textContent = "Цена — по вашему размеру";
    footer.appendChild(hint);

    var pick = document.createElement("button");
    pick.type = "button";
    pick.className = "tpl-card__pick";
    pick.setAttribute("data-sketch-pick", "");
    pick.setAttribute("aria-pressed", "false");
    pick.textContent = "Выбрать ✓";
    pick.addEventListener("click", function () {
      var again = state.selectedId === item.id;
      var sketch = apply(again ? "" : item.id);
      if (sketch && !again) {
        var calculator = document.getElementById("calculator");
        if (calculator && typeof calculator.scrollIntoView === "function") {
          calculator.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }
    });
    footer.appendChild(pick);

    body.appendChild(footer);
    node.appendChild(body);
    return node;
  }

  /* Витрина дополняет сетку примеров: карточки уже могли быть отрисованы
     галереей шаблонов, поэтому сетку не очищаем. */
  function render() {
    var section = document.getElementById("templates");
    var grid = document.getElementById("templates-grid");
    if (!section || !grid) return { sketches: [], selected: "" };

    var list = sketches();
    if (!list.length) return { sketches: [], selected: "" };

    list.forEach(function (item) { grid.appendChild(card(item)); });
    section.hidden = false;

    /* Эскиз мог быть выбран до перерисовки (возврат на страницу) —
       восстанавливаем подсветку по селекту формы. */
    var select = document.getElementById("order-sketch");
    if (select && select.value) apply(select.value);

    /* Выбор в селекте «Эскиз» подсвечивает карточку — и наоборот. */
    if (select) {
      select.addEventListener("change", function () {
        if ((select.value ? find(select.value) : null) || !select.value) apply(select.value);
      });
    }

    return { sketches: list, selected: state.selectedId };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }

  scope.SiteSketches = {
    render: render,
    apply: apply,
    clear: clear,
    sketches: sketches,
    find: find,
    selectedId: function () { return state.selectedId; }
  };
})();
