/* ============================================================================
   effects.js — движение на сайте: появление блоков, 3D-наклон карточек и
   живая подсветка за курсором.

   Здесь нет ничего, без чего сайт перестал бы работать: если браузер не
   знает IntersectionObserver или prefers-reduced-motion, блоки просто будут
   видны сразу, а наклон не включится. Поэтому весь модуль — «украшения»,
   и его можно вырезать без последствий.
   ========================================================================= */
(function () {
  "use strict";

  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* --------------------------------------------------------------------------
     1. Появление блоков при прокрутке
     ----------------------------------------------------------------------- */

  function revealOnScroll() {
    var targets = document.querySelectorAll("[data-reveal]");
    if (!targets.length) return;

    if (reduce || typeof IntersectionObserver !== "function") {
      targets.forEach(function (node) { node.classList.add("is-visible"); });
      return;
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });

    targets.forEach(function (node) { observer.observe(node); });
  }

  /* --------------------------------------------------------------------------
     2. 3D-наклон карточек за курсором
     ----------------------------------------------------------------------- */

  function tiltCards() {
    var cards = document.querySelectorAll("[data-tilt]");
    if (!cards.length || reduce) return;
    if (typeof window.matchMedia !== "function" || !window.matchMedia("(hover: hover)").matches) return;

    cards.forEach(function (card) {
      var raf = 0;
      var tx = 0;
      var ty = 0;

      function apply() {
        raf = 0;
        card.style.setProperty("--tilt-x", ty.toFixed(2) + "deg");
        card.style.setProperty("--tilt-y", tx.toFixed(2) + "deg");
      }

      card.addEventListener("pointermove", function (event) {
        var box = card.getBoundingClientRect();
        /* −0.5…0.5: центр карточки — ноль, край — единица */
        tx = ((event.clientX - box.left) / box.width - 0.5) * 2;
        ty = -((event.clientY - box.top) / box.height - 0.5) * 2;
        if (!raf) raf = window.requestAnimationFrame(apply);
      });

      card.addEventListener("pointerleave", function () {
        tx = 0;
        ty = 0;
        if (!raf) raf = window.requestAnimationFrame(apply);
      });
    });
  }

  /* --------------------------------------------------------------------------
     3. Подсветка за курсором и мягкое свечение за карточкой
     ----------------------------------------------------------------------- */

  function cursorGlow() {
    var glow = document.getElementById("cursor-glow");
    if (!glow || reduce) return;

    var x = window.innerWidth / 2;
    var y = window.innerHeight / 3;
    var raf = 0;

    function apply() {
      raf = 0;
      glow.style.transform = "translate3d(" + x.toFixed(1) + "px," + y.toFixed(1) + "px,0)";
    }

    window.addEventListener("pointermove", function (event) {
      if (event.pointerType === "touch") return;
      x = event.clientX;
      y = event.clientY;
      if (!raf) raf = window.requestAnimationFrame(apply);
    }, { passive: true });
  }

  /* --------------------------------------------------------------------------
     4. Счётчики в шапке — число докручивается до значения
     ----------------------------------------------------------------------- */

  function countUp() {
    var nodes = document.querySelectorAll("[data-count]");
    if (!nodes.length) return;
    if (reduce || typeof IntersectionObserver !== "function") {
      nodes.forEach(function (node) { node.textContent = node.getAttribute("data-count"); });
      return;
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var node = entry.target;
        observer.unobserve(node);
        var target = Number(node.getAttribute("data-count"));
        if (!isFinite(target)) { node.textContent = node.getAttribute("data-count"); return; }
        var start = performance.now();
        var span = 900;

        function step(now) {
          var progress = Math.min(1, (now - start) / span);
          /* Плавное затухание, чтобы число не дёргалось в начале */
          var eased = 1 - Math.pow(1 - progress, 3);
          node.textContent = String(Math.round(target * eased));
          if (progress < 1) window.requestAnimationFrame(step);
        }
        window.requestAnimationFrame(step);
      });
    }, { threshold: 0.6 });

    nodes.forEach(function (node) { observer.observe(node); });
  }

  /* --------------------------------------------------------------------------
     5. Год в подвале — чтобы не пришлось менять его каждый январь
     ----------------------------------------------------------------------- */

  function currentYear() {
    var node = document.getElementById("year");
    if (node) node.textContent = String(new Date().getFullYear());
  }

  function start() {
    revealOnScroll();
    tiltCards();
    cursorGlow();
    countUp();
    currentYear();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
