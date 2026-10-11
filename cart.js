"use strict";
/* ============================================================================
   cart.js — виртуальная корзина заказа.

   Клиент настраивает наклейку в калькуляторе, подтверждает её — и она ложится
   в корзину. Так в одной заявке могут быть разные наклейки: свой размер, своя
   плёнка, цвет, форма и тираж у каждой. Из корзины уходит одна заявка.

   Модуль не знает про страницу: только список позиций, подсчёт и хранение.
   Цены он не хранит, а берёт у Pricing.quoteCart() при каждом обращении, поэтому
   сумма в корзине всегда совпадает с суммой в сообщении модератору.

   Корзина переживает перезагрузку страницы (localStorage). Если хранилище
   недоступно (приватный режим, запрет cookies) — работает в памяти.
   ========================================================================= */
(function (root) {
  var IN_NODE = typeof require === "function" && typeof module !== "undefined" && module.exports;
  var P = root.Pricing || (IN_NODE ? require("./pricing.js") : null);
  if (!P) throw new Error("cart.js: не загружен pricing.js (подключите его перед этим файлом)");

  var STORAGE_KEY = "kontur.cart.v1";
  var FIELDS = ["film", "design", "color", "shape", "sketch", "w", "h", "qty"];

  /* storage подменяется в тестах; в браузере — localStorage, если он доступен. */
  function defaultStorage() {
    try {
      if (typeof localStorage !== "undefined" && localStorage) {
        var probe = "__kontur_probe__";
        localStorage.setItem(probe, "1");
        localStorage.removeItem(probe);
        return localStorage;
      }
    } catch (e) { /* приватный режим */ }
    return null;
  }

  function create(options) {
    var opts = options || {};
    var storage = opts.storage !== undefined ? opts.storage : defaultStorage();
    var items = [];
    var listeners = [];
    var counter = 0;

    function newId() {
      counter += 1;
      return "i" + Date.now().toString(36) + counter.toString(36);
    }

    /* Оставляем только поля наклейки: всё лишнее из хранилища отбрасывается. */
    function pick(raw) {
      var out = {};
      FIELDS.forEach(function (key) { out[key] = raw[key]; });
      out.sketch = String(out.sketch || "").trim();
      out.w = Number(out.w);
      out.h = Number(out.h);
      out.qty = Math.round(Number(out.qty));
      return out;
    }

    function sameSticker(a, b) {
      return a.film === b.film && a.design === b.design && a.color === b.color &&
        a.shape === b.shape && a.sketch === b.sketch && a.w === b.w && a.h === b.h;
    }

    function save() {
      if (!storage) return;
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(items.map(function (item) {
          return Object.assign({ id: item.id }, pick(item));
        })));
      } catch (e) { /* место закончилось — корзина останется в памяти */ }
    }

    function emit() {
      listeners.slice().forEach(function (listener) {
        try { listener(api); } catch (e) { /* подписчик не должен ломать корзину */ }
      });
    }

    function changed() {
      save();
      emit();
    }

    function find(id) {
      for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
      return null;
    }

    /* Добавить наклейку. Возвращает {ok, item, merged} или {ok:false, error}.
       Такая же наклейка (все параметры, кроме тиража) не плодит строку:
       тираж прибавляется к уже лежащей — скидка за тираж считается по сумме. */
    function add(raw) {
      var checked = P.validateItem(raw);
      if (!checked.ok) return { ok: false, error: checked.error };
      var value = pick(checked.value);

      for (var i = 0; i < items.length; i++) {
        if (sameSticker(items[i], value)) {
          var total = items[i].qty + value.qty;
          if (total > P.QTY_MAX) {
            return { ok: false, error: "В одной позиции не больше " + P.QTY_MAX + " шт" };
          }
          items[i].qty = total;
          changed();
          return { ok: true, item: items[i], merged: true };
        }
      }
      if (items.length >= P.CART_MAX_ITEMS) {
        return { ok: false, error: "В заявке не больше " + P.CART_MAX_ITEMS + " позиций — отправьте эту и оформите следующую отдельно" };
      }
      value.id = newId();
      items.push(value);
      changed();
      return { ok: true, item: value, merged: false };
    }

    function remove(id) {
      var before = items.length;
      items = items.filter(function (item) { return item.id !== id; });
      if (items.length !== before) changed();
      return items.length !== before;
    }

    /* Новый тираж позиции (кнопки − и + в корзине). Скидка пересчитается сама. */
    function setQty(id, qty) {
      var item = find(id);
      var next = Math.round(Number(qty));
      if (!item || !isFinite(next) || next < P.QTY_MIN || next > P.QTY_MAX) return false;
      item.qty = next;
      changed();
      return true;
    }

    function clear() {
      if (!items.length) return;
      items = [];
      changed();
    }

    /* Позиции + цены по строкам + итог с минимальным заказом. */
    function summary() {
      var plain = items.map(function (item) { return Object.assign({}, pick(item)); });
      var validItems = [];
      var ids = [];
      plain.forEach(function (item, index) {
        var checked = P.validateItem(item);
        if (!checked.ok) return;
        validItems.push(checked.value);
        ids.push(items[index].id);
      });
      var quote = P.quoteCart(validItems) || P.quoteCart([]);
      quote.lines.forEach(function (line, index) { line.id = ids[index]; });
      return quote;
    }

    function load() {
      if (!storage) return;
      var parsed;
      try { parsed = JSON.parse(storage.getItem(STORAGE_KEY) || "[]"); } catch (e) { parsed = []; }
      if (!Array.isArray(parsed)) return;
      items = [];
      parsed.slice(0, P.CART_MAX_ITEMS).forEach(function (raw) {
        if (!raw || typeof raw !== "object") return;
        var checked = P.validateItem(raw);
        if (!checked.ok) return;       /* повреждённые или устаревшие позиции пропускаем */
        var value = pick(checked.value);
        value.id = typeof raw.id === "string" && raw.id ? raw.id : newId();
        items.push(value);
      });
    }

    function subscribe(listener) {
      if (typeof listener === "function") listeners.push(listener);
    }

    /* Позиции для заявки (без внутренних id). */
    function toOrderItems() {
      return items.map(function (item) { return pick(item); });
    }

    var api = {
      add: add,
      remove: remove,
      setQty: setQty,
      clear: clear,
      summary: summary,
      subscribe: subscribe,
      toOrderItems: toOrderItems,
      get: function (id) { return find(id); },
      list: function () { return items.map(function (item) { return Object.assign({}, item); }); },
      count: function () { return items.length; },
      load: load
    };

    load();
    return api;
  }

  var API = { create: create, STORAGE_KEY: STORAGE_KEY };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.Cart = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
