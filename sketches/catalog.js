/* ============================================================================
   sketches/catalog.js — примеры эскизов на сайте.

   Это статичный список вязок «карточка → картинка». Клиент выбирает эскиз
   при заказе (карточкой в разделе «Примеры» или селектом «Эскиз» в форме),
   и название уходит модератору строкой в заявке.

   ЦЕН У ЭСКИЗОВ НЕТ И НЕ ДОЛЖНО БЫТЬ: стоимость наклейки считается только
   по плёнке, размеру и тиражу в калькуляторе. Добавляя эскиз, положите
   картинку в sketches/img/ и скопируйте блок ниже — этого достаточно.
   ========================================================================= */

var SITE_SKETCHES = [
  {
    id: "volk-siluet",
    title: "Волк — силуэт",
    img: "sketches/img/volk-siluet.jpg"
  },
  {
    id: "lisa",
    title: "Лиса",
    img: "sketches/img/lisa.jpg"
  },
  {
    id: "kogti",
    title: "Когти",
    img: "sketches/img/kogti.jpg"
  },
  {
    id: "maska-s-podtekami",
    title: "Маска с подтёками",
    img: "sketches/img/maska-s-podtekami.jpg"
  },
  {
    id: "nozh-s-maskoy",
    title: "Нож с маской",
    img: "sketches/img/nozh-s-maskoy.jpg"
  },
  {
    id: "demonica",
    title: "Демоница",
    img: "sketches/img/demonica.jpg"
  },
  {
    id: "korona-i-krest",
    title: "Корона и крест",
    img: "sketches/img/korona-i-krest.jpg"
  },
  {
    id: "grut",
    title: "Грут",
    img: "sketches/img/grut.jpg"
  },
  {
    id: "logotip-s-podtekami",
    title: "Логотип с подтёками",
    img: "sketches/img/logotip-s-podtekami.jpg"
  }
];

if (typeof globalThis !== "undefined") globalThis.SITE_SKETCHES = SITE_SKETCHES;
