/**
 * Живой замер ИИ: настоящие вопросы → настоящая модель через воркер → оценка.
 *
 *   node test/ai_eval.js [чат|оверлей|оба] [серверы через запятую] [фильтр вопросов]
 *   node test/ai_eval.js оба orlando,dallas,houston
 *
 * ⚠ ХОДИТ В МОДЕЛЬ И СТОИТ ДЕНЕГ. Один прогон «оба» на трёх серверах — около
 * 130 ответов, ~250 запросов и ~3,5 млн символов на входе модели. Частые
 * прогоны подряд упираются в лимит провайдера (HTTP 429) — так было
 * 03.11.2026 после ~5 тыс. запросов за вечер. Нужен ai_config.js рядом.
 *
 * Зачем. Поиск мерится test/search_bench.js, путь запроса без сети —
 * test/ai_pipeline_test.js, но верно ли в итоге отвечает модель, видно только
 * живьём. Любую правку промптов (ai_prompts.js) и подборки статей
 * (ai_engine.js → gather) проверять этим замером: константы взаимозависимы.
 *
 * Оценка. «Верно» — в ответе есть настоящий номер (сверка с базой) статьи,
 * чьё название или начало текста подходит под образец вопроса. Для «статьи
 * нет на сервере» и общих вопросов верно — не выдумать номер. Образцы
 * нарочно широкие: «убегал от полиции» — и «уклонение», и «неповиновение».
 *
 * Итог 06.11.2026 (оставшиеся 10 серверов, чат, без «спасибо» и «погоды»):
 * 194/199 — 97 %, выдуманных номеров 0, 398 запросов.
 * Итог 03.11.2026 (девять серверов, 396 ответов): чат 97 %, оверлей 95 %,
 * выдуманных номеров 0. Прежний путь (перевод сленга + поиск по словам) на
 * тех же вопросах: чат 86–91 %, оверлей 70 %.
 */
'use strict';
const fs = require('fs');
const path = require('path');

// база: PROTOCOL_DATA → соседний Protocol-Data (хаб автора) → встроенная app/data (клон с GitHub)
const DATA = process.env.PROTOCOL_DATA || [path.join(__dirname, '..', '..', 'Protocol-Data', 'data'), path.join(__dirname, '..', 'data')].find((d) => fs.existsSync(path.join(d, 'manifest.json')));
global.window = {};
for (const f of ['ai_config.js', 'ai_engine.js', 'ai_prompts.js']) {
  const p = path.join(__dirname, '..', f);
  if (!fs.existsSync(p)) { console.log('нет ' + f + ' — без него замер невозможен'); process.exit(2); }
  new Function('window', fs.readFileSync(p, 'utf8'))(global.window);
}
const CFG = global.window.AI_CONFIG || {}, PA = global.window.ProtocolAI, SYS = global.window.AI_SYS;

// Предел запросов на прогон (AI_EVAL_MAX, по умолчанию 450): запросы тратят
// общий баланс всех пользователей — 03.11.2026 замеры без предела съели его целиком.
const MAX_CALLS = Number(process.env.AI_EVAL_MAX) || 450;
let calls = 0;
async function llm(system, user) {
  if (++calls > MAX_CALLS) { console.log('\nпредел ' + MAX_CALLS + ' запросов — замер остановлен'); process.exit(1); }
  for (let attempt = 0; attempt < 3; attempt++) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 60000);
    try {
      const r = await fetch(CFG.PROXY_URL, {
        method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json', 'x-app-secret': CFG.APP_SECRET || '' },
        body: JSON.stringify({ system, user, model: CFG.MODEL || 'gpt-4o-mini' }),
      });
      if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 5000 * (attempt + 1))); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return (await r.json()).text || '';
    } finally { clearTimeout(t); }
  }
  throw new Error('HTTP 429 — лимит провайдера, замер прерван');
}

const RULE = /^rules:/;
// [вопрос, тип, образец кода, образец названия статьи]
//   null — закон (не правила), RULE — правила проекта,
//   'none' — номеров быть не должно, 'absent' — статьи на сервере нет: верно, если номер не выдуман
const QS = [
  ['угнал тачку', 'qualify', null, /завладени|угон/i],
  ['напал на копа с кулаками', 'qualify', null, /(насили|посягательств|нападени|телесн)[^]{0,80}(сотрудник|представител|должностн|госслужащ|государственн\w* служащ)|(сотрудник|представител)[^]{0,60}(насили|посягательств)/i],
  ['отказался выйти из машины по требованию полиции', 'qualify', null, /неповиновени|неподчинени|невыполнени|законн\w* (требовани|распоряжени)|покину/i],
  ['убегал от полиции на машине', 'qualify', null, /уклонени|преследовани|побег|остановиться по требованию|скрыт|неповиновени|неподчинени|невыполнени/i],
  ['оскорбил сотрудника при исполнении', 'qualify', null, /оскорблени/i],
  ['ношение оружия без лицензии', 'qualify', null, /оружи/i],
  ['спёр кошелёк', 'qualify', null, /краж|хищени/i],
  ['дал взятку копу', 'qualify', null, /взятк|подкуп/i],
  ['проехал на красный', 'absent', 'absent', null],
  ['в маске ограбил магазин с пистолетом', 'qualify', null, /грабеж|разбо/i],
  ['что такое субъект?', 'define', 'absent', null],
  ['что такое соучастие', 'define', null, /соучасти/i],
  ['что значит необходимая оборона', 'define', null, /оборон/i],
  ['какой порядок задержания?', 'procedure', null, /задержани/i],
  ['сколько можно держать задержанного', 'procedure', null, /задержани|срок/i],
  ['может ли полицейский обыскать машину без ордера', 'procedure', null, /обыск|досмотр/i],
  ['когда задержанному положен адвокат', 'procedure', null, /адвокат|защитник|прав\w* задержанн|задержани/i],
  ['когда сотрудник полиции может применить оружие', 'procedure', null, /оружи|спецсредств|специальн\w* средств|сил/i],
  ['что такое DM', 'rules', RULE, /./],
  ['можно ли грабить банк в одиночку', 'rules', RULE, /./],
  ['спасибо, понял', 'chat', 'none', null],
  ['какая сегодня погода в Лос-Сантосе', 'general', 'none', null],
];

function codesOf(sv) {
  const L = JSON.parse(fs.readFileSync(path.join(DATA, sv + '.json'), 'utf8'));
  const R = JSON.parse(fs.readFileSync(path.join(DATA, 'rules.json'), 'utf8'));
  const c = {};
  Object.keys(L).forEach((k) => { c['law:' + k] = L[k]; });
  Object.keys(R).forEach((k) => { c['rules:' + k] = R[k]; });
  return c;
}
// у части статей название пустое или обрезано (дефект разбора) — смотрим и начало текста
const match = (d, code, re) => d && re && (code === RULE ? RULE.test(d.code_id) : !RULE.test(d.code_id)) &&
  re.test((d.title || '') + ' ' + (((d.parts || [])[0] || {}).t || ''));

(async () => {
  if (!CFG.PROXY_URL) { console.log('в ai_config.js нет PROXY_URL'); process.exit(2); }
  const mode = process.argv[2] || 'оба';
  const modes = mode === 'оба' ? ['chat', 'overlay'] : [mode === 'оверлей' ? 'overlay' : 'chat'];
  const servers = (process.argv[3] || 'orlando,newyork,houston').split(',');
  const filt = process.argv[4] ? new RegExp(process.argv[4], 'i') : null;
  const jobs = [];
  for (const sv of servers) {
    const idx = new PA.ServerIndex(sv, codesOf(sv)), cache = {};
    for (const [q, kind, code, re] of QS) {
      if (filt && !filt.test(q)) continue;
      if (re && !idx.docs.some((d) => match(d, code, re))) continue;   // такой статьи у сервера нет
      for (const m of modes) jobs.push({ sv, idx, cache, q, kind, code, re, overlay: m === 'overlay' });
    }
  }
  console.log('ответов: ' + jobs.length + ', модель ' + (CFG.MODEL || 'gpt-4o-mini'));
  let i = 0;
  // три потока: больше — быстрее упираемся в лимит провайдера
  await Promise.all([0, 1, 2].map(async () => {
    while (i < jobs.length) {
      const j = jobs[i++], t0 = Date.now();
      try {
        const r = await PA.ask({ index: j.idx, llm, sys: SYS, question: j.q, overlay: j.overlay, cache: j.cache });
        j.text = r.text; j.cites = r.cites; j.plan = r.plan;
      } catch (e) { j.err = String(e.message || e); j.cites = []; }
      j.ms = Date.now() - t0;
      if (/429/.test(j.err || '')) { console.log('\n' + j.err); process.exit(1); }
    }
  }));
  const sum = {};
  for (const j of jobs) {
    const bad = j.cites.filter((c) => !c.ok).length;
    j.ok = !!j.text && (j.code === 'none' ? j.cites.length === 0
      : j.code === 'absent' ? bad === 0
      : j.cites.some((c) => c.ok && match(c.doc, j.code, j.re)));
    const k = j.overlay ? 'оверлей' : 'чат';
    const s = sum[k] = sum[k] || { n: 0, ok: 0, ans: 0, bad: 0, ms: 0, miss: [] };
    s.n++; if (j.ok) s.ok++; if (j.text) s.ans++; s.bad += bad; s.ms += j.ms;
    if (!j.ok) s.miss.push(j.sv + ' | ' + j.q + ' → ' + (j.err || j.text.replace(/\s+/g, ' ').slice(0, 110)));
  }
  for (const k of Object.keys(sum)) {
    const s = sum[k];
    console.log('\n' + k + ': верно ' + s.ok + '/' + s.n + ' (' + Math.round(s.ok / s.n * 100) + ' %), ответили ' + s.ans + ', выдуманных номеров ' + s.bad + ', в среднем ' + (s.ms / s.n / 1000).toFixed(1) + ' с');
    s.miss.forEach((m) => console.log('  ✗ ' + m));
  }
  console.log('\nзапросов к ИИ за прогон: ' + calls + ' (предел ' + MAX_CALLS + ')');
})();
