#!/usr/bin/env node
"use strict";
/* ============================================================================
   Загрузка настроек из окружения и файла .env.

   Один и тот же код используют server.js (приём заявок по HTTP) и bot.js
   (бот без сервера). Файл .env в git не попадает, на GitHub Actions его роль
   играют секреты репозитория.
   ========================================================================= */

var fs = require("fs");
var path = require("path");

var ROOT = __dirname;

function loadEnvFile(file) {
  var out = {};
  var text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { return out; }
  text.split(/\r?\n/).forEach(function (line) {
    var trimmed = line.trim();
    if (!trimmed || trimmed.charAt(0) === "#") return;
    var eq = trimmed.indexOf("=");
    if (eq < 1) return;
    var key = trimmed.slice(0, eq).trim();
    var value = trimmed.slice(eq + 1).trim();
    if ((value.charAt(0) === '"' && value.slice(-1) === '"') ||
        (value.charAt(0) === "'" && value.slice(-1) === "'")) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  });
  return out;
}

var fileEnv = loadEnvFile(path.join(ROOT, ".env"));

/* Значение из окружения важнее файла: в Actions секреты приходят именно так. */
function env(name, fallback) {
  var value = process.env[name];
  if (value === undefined || value === "") value = fileEnv[name];
  return value === undefined || value === "" ? fallback : value;
}

function envBool(name, fallback) {
  var raw = env(name, null);
  if (raw === null) return fallback;
  raw = String(raw).trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

module.exports = {
  ROOT: ROOT,
  env: env,
  envBool: envBool,
  loadEnvFile: loadEnvFile
};
