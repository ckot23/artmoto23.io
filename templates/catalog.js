/* Каталог шаблонов галереи на сайте.
   Файл обновляет меню админа (admin.html) — кнопкой «Опубликовать»
   или архивом для ручной загрузки. Правки руками возможны, но тогда
   следите за форматом: путь к фото лежит в templates/img/.
   Пустой список — галерея на сайте просто не показывается. */
globalThis.SITE_TEMPLATES = [
    {
      "id": "demo-vitrina-elka",
      "title": "Витрина: новогодняя ёлка",
      "note": "Пример шаблона — замените своим фото",
      "img": "templates/img/demo-vitrina-elka.jpg",
      "created": "2026-10-06T12:00:00.000Z",
      "settings": {
        "film": "gloss",
        "design": "catalog",
        "color": "fullcolor",
        "shape": "circle",
        "width": 40,
        "height": 60,
        "quantity": 2
      }
    },
    {
      "id": "demo-avto-drakon",
      "title": "Авто: дракон",
      "note": "Пример шаблона — замените своим фото",
      "img": "templates/img/demo-avto-drakon.jpg",
      "created": "2026-10-06T11:00:00.000Z",
      "settings": {
        "film": "matte",
        "design": "own",
        "color": "red",
        "shape": "rectangle",
        "width": 30,
        "height": 30,
        "quantity": 2
      }
    },
    {
      "id": "demo-kofeynya-open",
      "title": "Кофейня: Open 24/7",
      "note": "Пример шаблона — замените своим фото",
      "img": "templates/img/demo-kofeynya-open.jpg",
      "created": "2026-10-06T10:00:00.000Z",
      "settings": {
        "film": "gloss",
        "design": "catalog",
        "color": "gold",
        "shape": "rounded",
        "width": 30,
        "height": 20,
        "quantity": 10
      }
    }
  ];
