/*
 * Загружает витрины раздела «Примеры» только тогда, когда есть что показывать:
 * эскизы из sketches/catalog.js и/или шаблоны из templates/catalog.js.
 * Пустой раздел — обычное состояние сайта, поэтому тяжёлый код галереи не
 * нужен ни для первого отображения, ни для работы калькулятора.
 */
(function () {
  "use strict";

  var section = document.getElementById("templates");
  var sketches = globalThis.SITE_SKETCHES;
  var catalog = globalThis.SITE_TEMPLATES;
  if (!section) return;

  var sketchesEmpty = !Array.isArray(sketches) || sketches.length === 0;
  var templatesEmpty = !Array.isArray(catalog) || catalog.length === 0;
  if (sketchesEmpty && templatesEmpty) {
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

  /* Шаблоны рисуем первыми: витрина эскизов только дополняет сетку. */
  var chain = Promise.resolve();
  if (!templatesEmpty) {
    chain = chain
      .then(function () { return loadScript("templates.js?v=4"); })
      .then(function () { return loadScript("gallery.js?v=4"); });
  }
  if (!sketchesEmpty) {
    chain = chain.then(function () { return loadScript("sketch-gallery.js?v=1"); });
  }

  chain.catch(function (error) {
    /* Прячем раздел, только если в нём так и не появилось карточек. */
    var grid = document.getElementById("templates-grid");
    if (!grid || !grid.children.length) section.hidden = true;
    if (window.console && typeof window.console.warn === "function") window.console.warn(error);
  });
})();
