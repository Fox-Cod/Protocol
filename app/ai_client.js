/**
 * ai_client.js — клиент прокси для приложения.
 *
 * Шлёт запросы к вашему Cloudflare Worker (адрес и пароль — в ai_config.js).
 * Ключа OpenAI здесь нет: он на воркере. В приложение ключ не попадает.
 *
 * Экспортирует window.makeProxyLLM() -> async (system, user) -> text,
 * совместимую с движком ai_engine.js (Assistant ждёт такую функцию).
 */

(function () {
  "use strict";

  function makeProxyLLM() {
    var cfg = window.AI_CONFIG || {};
    var url = cfg.PROXY_URL;
    if (!url) return null;             // не настроен — движок покажет только поиск

    return async function (system, user) {
      var headers = { "Content-Type": "application/json" };
      if (cfg.APP_SECRET) headers["x-app-secret"] = cfg.APP_SECRET;

      // Ограничение по времени: зависший воркер раньше держал «ИИ думает»
      // бесконечно. Сбой сети и временные 502/503/504 — один повтор:
      // по замеру 03.11.2026 такое случается, и со второго раза проходит.
      var resp;
      for (var attempt = 0; attempt < 2; attempt++) {
        var ac = typeof AbortController === "function" ? new AbortController() : null;
        var timer = ac ? setTimeout(function () { ac.abort(); }, 50000) : null;
        try {
          resp = await fetch(url, {
            method: "POST",
            headers: headers,
            signal: ac ? ac.signal : undefined,
            body: JSON.stringify({
              system: system,
              user: user,
              model: cfg.MODEL || "gpt-4o-mini",
            }),
          });
        } catch (e) {
          if (e && e.name === "AbortError") throw new Error("ИИ не ответил за 50 с");
          if (attempt === 0) continue;
          throw new Error("не удалось связаться с прокси: " + e);
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (attempt === 0 && (resp.status === 502 || resp.status === 503 || resp.status === 504)) continue;
        // 429 — лимит запросов у провайдера: короткая пауза и ещё раз
        if (attempt === 0 && resp.status === 429) { await new Promise(function (r) { setTimeout(r, 2500); }); continue; }
        break;
      }

      if (!resp.ok) {
        var detail = "";
        try { detail = (await resp.json()).error || ""; } catch (e) {}
        if (resp.status === 403)
          throw new Error("прокси отклонил запрос (проверьте APP_SECRET)");
        if (resp.status === 500)
          throw new Error("на прокси не задан ключ OpenAI");
        if (resp.status === 429)
          throw new Error("ИИ перегружен: у провайдера кончился лимит запросов (429). Подождите минуту");
        // предел воркера — около 24 тыс. символов на запрос
        if (resp.status === 413)
          throw new Error("запрос слишком большой для ИИ (413)");
        throw new Error("прокси HTTP " + resp.status + " " + detail);
      }

      var data = await resp.json();
      return data.text || "";
    };
  }

  window.makeProxyLLM = makeProxyLLM;
})();
