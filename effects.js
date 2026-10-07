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
  var supportsReveal = typeof IntersectionObserver === "function";

  /* Reveal is progressive enhancement: leave everything visible if this file or
     IntersectionObserver is unavailable, instead of hiding page content. */
  if (!reduce && supportsReveal) document.documentElement.classList.add("effects-ready");

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
    if (typeof window.matchMedia !== "function" ||
        !window.matchMedia("(hover: hover) and (pointer: fine) and (min-width: 761px)").matches) return;

    cards.forEach(function (card) {
      var raf = 0;
      var tx = 0;
      var ty = 0;
      var bounds = null;

      function apply() {
        raf = 0;
        card.style.setProperty("--tilt-x", ty.toFixed(2) + "deg");
        card.style.setProperty("--tilt-y", tx.toFixed(2) + "deg");
      }

      function update(event) {
        if (!bounds || !bounds.width || !bounds.height || event.pointerType === "touch") return;
        /* Bounds читаем только при входе в карточку, не на каждом движении мыши. */
        tx = Math.max(-1, Math.min(1, ((event.clientX - bounds.left) / bounds.width - 0.5) * 2));
        ty = -Math.max(-1, Math.min(1, ((event.clientY - bounds.top) / bounds.height - 0.5) * 2));
        if (!raf) raf = window.requestAnimationFrame(apply);
      }

      card.addEventListener("pointerenter", function (event) {
        if (event.pointerType === "touch") return;
        bounds = card.getBoundingClientRect();
        update(event);
      }, { passive: true });

      card.addEventListener("pointermove", update, { passive: true });

      card.addEventListener("pointerleave", function () {
        bounds = null;
        tx = 0;
        ty = 0;
        if (!raf) raf = window.requestAnimationFrame(apply);
      }, { passive: true });
    });
  }

  /* --------------------------------------------------------------------------
     3. Подсветка за курсором и мягкое свечение за карточкой
     ----------------------------------------------------------------------- */

  function cursorGlow() {
    var glow = document.getElementById("cursor-glow");
    if (!glow || reduce || typeof window.matchMedia !== "function" ||
        !window.matchMedia("(hover: hover) and (pointer: fine) and (min-width: 761px)").matches) return;

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
