(function () {
  "use strict";

  var pricing = window.Pricing || (typeof globalThis !== "undefined" ? globalThis.Pricing : null);
  var fallbackFilms = [
    { id: "matte", name: "Матовая", rate: 3 },
    { id: "gloss", name: "Глянцевая", rate: 5.5 },
    { id: "transparent", name: "Прозрачная", rate: 6 },
    { id: "metallic", name: "Металлик", rate: 7 },
    { id: "reflective", name: "Светоотражающая", rate: 8 }
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
    unit: document.getElementById("unit-price")
  };

  if (!elements.film || !elements.width || !elements.height || !elements.quantity) return;

  function formatNumber(value) {
    return Number(value).toLocaleString("ru-RU", { maximumFractionDigits: 2 });
  }

  function formatMoney(value) {
    return formatNumber(value) + " ₽";
  }

  function filmById(id) {
    if (pricing && typeof pricing.byId === "function") return pricing.byId(films, id);
    for (var i = 0; i < films.length; i++) if (films[i].id === id) return films[i];
    return null;
  }

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
    elements.total.textContent = "—";
    elements.subtitle.textContent = "Проверьте параметры расчёта";
    elements.area.textContent = "—";
    elements.rate.textContent = "—";
    elements.unit.textContent = "—";
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

    var invalidWidth = !isFinite(width) || width < 1 || width > 500;
    var invalidHeight = !isFinite(height) || height < 1 || height > 500;
    var invalidQuantity = !isFinite(quantity) || quantity < 1 || quantity > 10000 || Math.floor(quantity) !== quantity;
    setInvalid(elements.width, invalidWidth);
    setInvalid(elements.height, invalidHeight);
    setInvalid(elements.quantity, invalidQuantity);

    if (invalidWidth) inputError = "Ширина должна быть от 1 до 500 см.";
    else if (invalidHeight) inputError = "Высота должна быть от 1 до 500 см.";
    else if (invalidQuantity) inputError = "Количество должно быть целым числом от 1 до 10 000 шт.";

    if (inputError) {
      showError(inputError);
      clearResult();
      return;
    }

    var result = estimate({ film: elements.film.value, w: width, h: height, qty: quantity });
    if (!result || result.ok === false) {
      showError(result && result.error ? result.error : "Не удалось выполнить расчёт.");
      clearResult();
      return;
    }

    var selectedFilm = filmById(result.film);
    showError("");
    elements.total.textContent = formatMoney(result.total);
    elements.subtitle.textContent = result.quantity.toLocaleString("ru-RU") + " шт. · " + (selectedFilm ? selectedFilm.name.toLowerCase() : "плёнка");
    elements.area.textContent = formatNumber(result.area) + " см²";
    elements.rate.textContent = formatMoney(result.rate);
    elements.unit.textContent = formatMoney(result.unit);
  }

  function bindInput(input) {
    input.addEventListener("input", render);
    input.addEventListener("change", render);
  }

  elements.film.addEventListener("change", render);
  bindInput(elements.width);
  bindInput(elements.height);
  bindInput(elements.quantity);

  document.addEventListener("click", function (event) {
    var target = event.target;
    var button = target && typeof target.closest === "function" ? target.closest("[data-select-film]") : null;
    if (!button) return;
    var film = filmById(button.getAttribute("data-select-film"));
    if (!film) return;
    elements.film.value = film.id;
    render();
    var calculator = document.getElementById("calculator");
    if (calculator && typeof calculator.scrollIntoView === "function") {
      calculator.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    if (typeof elements.film.focus === "function") elements.film.focus();
  });

  updateRates();
  render();
})();
