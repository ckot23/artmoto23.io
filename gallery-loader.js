/*
 * Загружает витрину только тогда, когда в каталоге действительно есть шаблоны.
 * Пустой каталог — обычное состояние сайта, поэтому тяжёлый код галереи не
 * нужен ни для первого отображения, ни для работы калькулятора.
 */
(function () {
  "use strict";

  var section = document.getElementById("templates");
  var catalog = globalThis.SITE_TEMPLATES;
  if (!section) return;

  if (!Array.isArray(catalog) || catalog.length === 0) {
    section.hidden = true;
    return;
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = src;
      script.async = false;
      script.onload = resolve;
      script.onerror = function () { reject(new Error("Не удалось загрузить " + src)); };
      (document.head || document.body).appendChild(script);
    });
  }

  loadScript("templates.js?v=4")
    .then(function () { return loadScript("gallery.js?v=4"); })
    .catch(function (error) {
      section.hidden = true;
      if (window.console && typeof window.console.warn === "function") window.console.warn(error);
    });
})();
