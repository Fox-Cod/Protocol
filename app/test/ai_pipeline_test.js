/**
 * Путь запроса ИИ без сети: ProtocolAI.ask с поддельной моделью.
 *
 *   node test/ai_pipeline_test.js
 *
 * Что проверяется (ai_engine.js → «путь запроса: оглавление → главы → ответ»):
 *   - оглавление каждого из 19 серверов не длиннее TOC_MAX, и НИ ОДИН запрос
 *     к модели (план, ответ, исправление номеров) не длиннее предела воркера:
 *     больше ~24 тыс. символов воркер отвечает 413, и человек видит «ИИ не
 *     отвечает»;
 *   - план с выдуманными метками глав отбрасывает их, мусор вместо JSON —
 *     поиск по словам без плана;
 *   - статьи выбранных глав попадают в подборку, сильное совпадение поиска —
 *     тоже, даже если модель выбрала не ту главу;
 *   - номер, которого нет в базе, помечается; модель получает одну попытку
 *     исправиться; пустой ответ — повтор; «[УК ст. 1]» — без скобок;
 *   - «спасибо» (kind chat) — без статей.
 *
 * Качество самих ответов этим не мерится — для этого живой замер
 * test/ai_eval.js (ходит в модель, стоит денег).
 */
'use strict';
const fs = require('fs');
const path = require('path');

// база: PROTOCOL_DATA → соседний Protocol-Data (хаб автора) → встроенная app/data (клон с GitHub)
const DATA = process.env.PROTOCOL_DATA || [path.join(__dirname, '..', '..', 'Protocol-Data', 'data'), path.join(__dirname, '..', 'data')].find((d) => fs.existsSync(path.join(d, 'manifest.json')));
global.window = {};
require(path.join(__dirname, '..', 'ai_engine.js'));
require(path.join(__dirname, '..', 'ai_prompts.js'));
const PA = global.window.ProtocolAI, SYS = global.window.AI_SYS;
const LIMIT = 24000;   // замер 03.11.2026: 23 219 проходит, 24 688 — 413

let fails = 0, oks = 0;
function ok(c, m) { if (c) oks++; else { fails++; console.log('  ПРОВАЛ  ' + m); } }

function codesOf(sv) {
  const L = JSON.parse(fs.readFileSync(path.join(DATA, sv + '.json'), 'utf8'));
  const codes = {};
  Object.keys(L).forEach((k) => { codes['law:' + k] = L[k]; });
  const rf = path.join(DATA, 'rules.json');
  if (fs.existsSync(rf)) { const R = JSON.parse(fs.readFileSync(rf, 'utf8')); Object.keys(R).forEach((k) => { codes['rules:' + k] = R[k]; }); }
  return codes;
}
// модель-заглушка: ответы по очереди, каждый запрос проверяется на длину
function fake(answers, log) {
  let i = 0;
  return async (system, user) => {
    log.push({ system, user, len: system.length + user.length });
    const a = answers[Math.min(i++, answers.length - 1)];
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? a(system, user) : a;
  };
}

(async () => {
  const servers = fs.readdirSync(DATA).filter((f) => f.endsWith('.json') && !/manifest|rules/.test(f)).map((f) => f.replace('.json', ''));
  ok(servers.length >= 19, 'серверов с базой: ' + servers.length);

  // ── на каждом сервере: оглавление и длина запросов ──
  let maxLen = 0;
  for (const sv of servers) {
    const idx = new PA.ServerIndex(sv, codesOf(sv));
    const toc = idx.toc();
    ok(toc.text.length <= 15000, sv + ': оглавление ' + toc.text.length + ' символов');
    const labels = Object.keys(toc.refs);
    ok(labels.some((l) => /^УК(\/|$)/.test(l)), sv + ': в оглавлении есть УК');
    // план выбирает пять самых больших глав — самый тяжёлый случай для объёма
    const big = labels.filter((l) => l.indexOf('/') > 0).sort((a, b) => toc.refs[b].length - toc.refs[a].length).slice(0, 5);
    const dialog = 'РАНЕЕ В ДИАЛОГЕ:\n' + ('Игрок: длинная реплика про задержание и права. '.repeat(60)).slice(0, 3000) + '\n\n';
    const log = [];
    const plan = JSON.stringify({ kind: 'procedure', read: big, terms: ['порядок задержания', 'права задержанного'] });
    // ответ с выдуманным номером — заставляем пройти и запрос-исправление
    const res = await PA.ask({ index: idx, llm: fake([plan, 'ОТВЕТ: так.\nОСНОВАНИЕ: УК ст. 999.9 — нет такой', 'ОТВЕТ: так.'], log), sys: SYS,
      question: 'какой порядок задержания и какие права у задержанного, если он молчит и требует адвоката?', dialog });
    log.forEach((c) => { maxLen = Math.max(maxLen, c.len); });
    ok(log.every((c) => c.len <= LIMIT - 500), sv + ': запросы не длиннее предела воркера (самый длинный ' + Math.max.apply(null, log.map((c) => c.len)) + ')');
    ok(log.length === 3, sv + ': план + ответ + исправление номера (' + log.length + ' запроса)');
    ok(res.docs.length >= 5, sv + ': подборка не пустая (' + res.docs.length + ')');
  }
  console.log('  самый длинный запрос на всех серверах: ' + maxLen + ' символов (предел ~' + LIMIT + ')');

  // ── разбор плана, подборка, сверка — на Орландо ──
  const idx = new PA.ServerIndex('orlando', codesOf('orlando'));
  const toc = idx.toc();
  const p1 = PA.parsePlan('```json\n{"kind":"qualify","read":["ук/17","НЕТ/9","УК/17"," ПК/3 "],"terms":["насилие"]}\n```', toc);
  ok(p1 && p1.kind === 'qualify' && p1.read.join() === 'УК/17,ПК/3', 'план: выдуманные метки и повторы отброшены, регистр и пробелы не мешают (' + (p1 && p1.read) + ')');
  ok(PA.parsePlan('я не знаю', toc) === null, 'план: не JSON — null');
  ok(PA.parsePlan('{"kind":"странный","read":[]}', toc).kind === 'qualify', 'план: неизвестный тип — qualify');

  // выбранная глава поднимает свои статьи
  const uk17 = toc.refs['УК/17'].map((di) => idx.docs[di]);
  ok(uk17.some((d) => d.num === '17.2'), 'УК/17 Орландо — глава с 17.2');
  const g1 = idx.gather('напал на сотрудника', { kind: 'qualify', read: ['УК/17'], terms: ['применение насилия в отношении представителя власти'] }, { max: 12, budget: 9000, overlay: true });
  ok(g1.slice(0, 4).some((p) => p.doc.code_short === 'УК' && p.doc.num === '17.2'), 'подборка: УК 17.2 в первой четвёрке при верной главе');
  // модель ошиблась главой — сильное совпадение поиска всё равно в подборке
  const g2 = idx.gather('напал на копа с кулаками', { kind: 'qualify', read: ['ПК/3', 'УК/15'], terms: ['применение насилия в отношении представителя власти', 'нападение на сотрудника правоохранительных органов'] }, { max: 30, budget: 15000 });
  ok(g2.some((p) => p.doc.code_short === 'УК' && p.doc.num === '17.2'), 'подборка: УК 17.2 есть и при неверной главе плана');
  // один документ — не больше трети подборки
  const per = {};
  g2.forEach((p) => { per[p.doc.code_id] = (per[p.doc.code_id] || 0) + 1; });
  ok(Math.max.apply(null, Object.values(per)) <= Math.max(10, Math.ceil(g2.length / 2)), 'подборка: один документ её не занимает');
  // слова самого вопроса — «порядок задержания» → ПК 17
  const g3 = idx.gather('какой порядок задержания?', { kind: 'procedure', read: ['ПК/3', 'ПК/4', 'ПК/5'], terms: ['меры административного принуждения', 'административное задержание'] }, { max: 12, budget: 9000, overlay: true });
  ok(g3.slice(0, 5).some((p) => p.doc.code_short === 'ПК' && p.doc.num === '17'), 'подборка: ПК 17 «Порядок задержания» в первой пятёрке (' + g3.slice(0, 5).map((p) => p.doc.code_short + ' ' + p.doc.num).join(', ') + ')');

  // сверка номеров
  const c = idx.citeRefs('ГЛАВНОЕ: УК ст. 17.2 — насилие. ТАКЖЕ: УК 12.8.2, ПК ст.17 п.г и ОПП п. 5.1, до 3 лет');
  const m = {}; c.forEach((x) => { m[x.code + ' ' + x.num] = x.ok; });
  ok(m['УК 17.2'] === true && m['ПК 17'] === true && m['ОПП 5.1'] === true, 'сверка: настоящие номера узнаны (' + JSON.stringify(m) + ')');
  ok(m['УК 12.8.2'] === false, 'сверка: «УК 12.8.2» помечен как несуществующий');
  ok(!Object.keys(m).some((k) => /^ДО /.test(k)), 'сверка: «до 3 лет» не принят за ссылку');

  // ── поведение ask ──
  let log = [];
  let r = await PA.ask({ index: idx, llm: fake(['{"kind":"chat","read":[],"terms":[]}', 'Пожалуйста!'], log), sys: SYS, question: 'спасибо' });
  ok(r.docs.length === 0 && /статей к этому вопросу не нашлось/.test(log[1].user), 'chat: без статей');

  log = [];
  r = await PA.ask({ index: idx, llm: fake(['{"kind":"qualify","read":["УК/17"],"terms":["насилие"]}', '', 'ГЛАВНОЕ: [УК ст. 17.2] — насилие'], log), sys: SYS, question: 'ударил копа' });
  ok(log.length === 3 && r.text === 'ГЛАВНОЕ: УК ст. 17.2 — насилие', 'пустой ответ — повтор; скобки вокруг номера сняты (' + JSON.stringify(r.text) + ')');

  log = [];
  r = await PA.ask({ index: idx, llm: fake(['{"kind":"qualify","read":["УК/12"],"terms":["оружие"]}', 'ГЛАВНОЕ: УК ст. 12.8.7 — ношение', 'ГЛАВНОЕ: УК ст. 12.8 — оборот оружия'], log), sys: SYS, question: 'ношение оружия' });
  ok(r.text.indexOf('12.8 —') > 0 && r.cites.every((x) => x.ok), 'чужой номер: модель исправилась — берётся исправленный ответ');
  ok(/Похожие номера, которые в списке есть: УК 12\.8/.test(log[2].user), 'чужой номер: в запросе-исправлении названы похожие настоящие');

  log = [];
  r = await PA.ask({ index: idx, llm: fake(['{"kind":"qualify","read":[],"terms":[]}', 'ГЛАВНОЕ: УК ст. 12.8.7 — ношение', 'ГЛАВНОЕ: УК ст. 12.8.7 — всё равно'], log), sys: SYS, question: 'ношение оружия' });
  ok(r.cites.some((x) => !x.ok), 'чужой номер: не исправилась — номер остаётся помеченным');

  log = [];
  r = await PA.ask({ index: idx, llm: fake([new Error('сеть'), 'ГЛАВНОЕ: УК ст. 10.5 — угон'], log), sys: SYS, question: 'угнал тачку' });
  ok(r.plan === null && r.docs.some((d) => d.num === '10.5'), 'план не пришёл — ответ по поиску слов');

  log = [];
  const cache = {};
  await PA.ask({ index: idx, llm: fake(['{"kind":"qualify","read":["УК/10"],"terms":["угон"]}', 'ГЛАВНОЕ: УК ст. 10.5 — угон'], log), sys: SYS, question: 'Угнал тачку', cache });
  await PA.ask({ index: idx, llm: fake(['ГЛАВНОЕ: УК ст. 10.5 — угон'], log), sys: SYS, question: 'угнал тачку ', cache, overlay: true });
  ok(log.length === 3, 'план из памяти: второй раз (оверлей) без запроса плана');

  let err = null;
  try { await PA.ask({ index: idx, llm: fake(['{"kind":"qualify"}', '', ''], []), sys: SYS, question: 'x' }); } catch (e) { err = e; }
  ok(err && /пустой ответ/.test(err.message), 'дважды пусто — понятная ошибка');

  console.log('\n' + (fails ? 'ПРОВАЛ: ' + fails + ' из ' + (fails + oks) : 'OK: ' + oks + ' проверок'));
  process.exit(fails ? 1 : 0);
})();
