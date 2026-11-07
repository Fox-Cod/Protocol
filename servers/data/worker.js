// Раздача базы законов для Protocol — образец для Cloudflare Workers.
//
// Приложение спрашивает GET <адрес>/?file=manifest.json, потом
// GET <адрес>/?file=<сервер>.json, с заголовком x-app-secret, и ждёт сам файл.
// Воркер берёт файлы из папки data/ вашего репозитория на GitHub — например,
// своего форка github.com/Fox-Cod/Protocol-Data.
//
// Настройки (Settings → Variables and Secrets или wrangler):
//   DATA_REPO    — «владелец/репозиторий», например "you/Protocol-Data" (обязательно)
//   DATA_BRANCH  — ветка, по умолчанию "main"
//   APP_SECRET   — пароль из DATA_APP_SECRET в main.js (секрет; можно пустой —
//                  тогда раздача открыта всем, данные и так публичные)
//
// ВАЖНО: manifest.json со servers: {} — не «пустое обновление», а поломка:
// приложение его не примет, но не выкладывайте такой манифест вовсе.

export default {
  async fetch(request, env) {
    if (request.method !== 'GET') return new Response('нужен GET', { status: 405 });
    if (env.APP_SECRET && request.headers.get('x-app-secret') !== env.APP_SECRET) {
      return new Response('неверный пароль', { status: 403 });
    }
    if (!env.DATA_REPO) return new Response('не задан DATA_REPO', { status: 500 });
    const file = new URL(request.url).searchParams.get('file') || '';
    // только имена файлов базы: никаких путей и чужих файлов репозитория
    if (!/^[a-z0-9_-]{1,40}\.json$/i.test(file)) return new Response('нет такого файла', { status: 400 });

    const src = 'https://raw.githubusercontent.com/' + env.DATA_REPO + '/' + (env.DATA_BRANCH || 'main') + '/data/' + file;
    const upstream = await fetch(src, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (upstream.status === 404) return new Response('нет такого файла', { status: 404 });
    if (!upstream.ok) return new Response('GitHub ответил ' + upstream.status, { status: 502 });
    return new Response(upstream.body, {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' },
    });
  },
};
