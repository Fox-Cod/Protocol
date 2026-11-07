// Прокси ИИ для Protocol — образец для Cloudflare Workers.
//
// Приложение шлёт сюда POST с JSON {system, user, model} и заголовком
// x-app-secret, ждёт в ответ {text}. Ключ модели хранится здесь, в секретах
// воркера, и в приложение не попадает.
//
// Секреты и настройки (Settings → Variables and Secrets или wrangler):
//   OPENAI_API_KEY  — ключ OpenAI (секрет, обязательно)
//   APP_SECRET      — пароль, который приложение шлёт в x-app-secret
//                     (секрет; длинный случайный, 32+ символа)
//   ALLOWED_MODELS  — через запятую, какие модели можно просить
//                     (например "gpt-4o-mini"); первая — по умолчанию
//   MAX_CHARS       — предел размера запроса в символах (по умолчанию 60000)
//
// Пароль лежит и в собранном .exe — его оттуда достанут. Баланс защищает
// не он, а предел расходов в кабинете OpenAI (Limits → Budget) и правило
// Rate limiting в Cloudflare. Поставьте оба.

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return json({ error: 'нужен POST' }, 405);
    if (!env.APP_SECRET || request.headers.get('x-app-secret') !== env.APP_SECRET) {
      return json({ error: 'неверный пароль' }, 403);
    }
    if (!env.OPENAI_API_KEY) return json({ error: 'на прокси не задан ключ модели' }, 500);

    const raw = await request.text();
    if (raw.length > (Number(env.MAX_CHARS) || 60000)) return json({ error: 'запрос слишком большой' }, 413);
    let body;
    try { body = JSON.parse(raw); } catch (e) { return json({ error: 'не JSON' }, 400); }

    const allowed = String(env.ALLOWED_MODELS || 'gpt-4o-mini').split(',').map((s) => s.trim()).filter(Boolean);
    const model = allowed.includes(body.model) ? body.model : allowed[0];

    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.OPENAI_API_KEY },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: String(body.system || '') },
          { role: 'user', content: String(body.user || '') },
        ],
      }),
    });
    // 429 приложение показывает как «ИИ перегружен» — передаём как есть
    if (upstream.status === 429) return json({ error: 'лимит провайдера' }, 429);
    if (!upstream.ok) return json({ error: 'провайдер ответил ' + upstream.status }, 502);
    const data = await upstream.json();
    const text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    return json({ text });
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
