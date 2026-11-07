/**
 * Проверка voice_brain.js на настоящей базе.
 *
 * Сцена подаётся репликами, как её отдаёт служба распознавания: с дорожкой,
 * временем и отметкой уверенности. Проверяется не «похоже ли на правду», а
 * три вещи, от которых зависит, можно ли этим пользоваться:
 *
 *   1. Отмечается ли то, что прозвучало.
 *   2. НЕ отмечается ли то, что не звучало. Ложная отметка обманывает
 *      офицера в суде, и это хуже пропущенной.
 *   3. Указывает ли приложение на статью этого сервера, а не на похожую.
 *
 * Запуск: node test/voice_brain_test.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const VB = require('../voice_brain.js');

const APP = path.join(__dirname, '..');

function load(server) {
	const j = path.join(APP, 'data', server + '.json');
	const br = j + '.br';
	const raw = fs.existsSync(j)
		? fs.readFileSync(j, 'utf8')
		: zlib.brotliDecompressSync(fs.readFileSync(br)).toString('utf8');
	const doc = JSON.parse(raw);
	const sets = doc.sets || doc;
	return Object.keys(sets).map((k) => Object.assign({ id: k }, sets[k]))
		.filter((l) => l && l.parts);
}

let fails = 0;
function ok(cond, what) {
	if (!cond) { fails++; console.log('  ПРОВАЛ  ' + what); }
	else console.log('  ок      ' + what);
}

// ── сцена ───────────────────────────────────────────────────────────────────
const MIRANDA = 'Вы имеете право хранить молчание. Всё, что вы скажете, может и будет '
	+ 'использовано против вас в суде. Вы имеете право на один телефонный звонок. '
	+ 'Также вы имеете право на адвоката. Если вам необходим адвокат, он будет для вас запрошен. '
	+ 'Вы понимаете свои права?';

function utt(track, t, text, sure) {
	return { n: ++utt.n, track, t0: t, t1: t + 2, text, sure: sure !== false };
}
utt.n = 0;

const SCENE = [
	utt('you', 2, 'Остановите машину и заглушите двигатель.'),
	utt('you', 6, 'Предъявите документы, удостоверяющие личность.'),
	utt('around', 9, 'Да пошёл ты, мент поганый, ты никто без своего значка.'),
	utt('you', 14, 'Вы задержаны по подозрению в угоне автомобиля у отделения банка.'),
	utt('around', 18, 'Я не буду выходить из машины, ничего ты мне не сделаешь.'),
	utt('you', 22, MIRANDA),
	utt('around', 40, 'Этот козёл вон там меня ограбил, а вы ко мне пристали.'),
	utt('around', 46, 'На каком основании вы задержали моего подзащитного?'),
	utt('you', 52, 'Вас доставят в участок, там будут реализованы ваши права.')
];

const CALM = [
	utt('you', 2, 'Добрый день, предъявите документы пожалуйста.'),
	utt('around', 5, 'Да, конечно, вот они, что-то случилось?'),
	utt('around', 9, 'Я просто ехал домой, ничего не нарушал.')
];

// ── прогон ──────────────────────────────────────────────────────────────────
const laws = load('orlando');
console.log('загружено кодексов orlando: ' + laws.length);

const brain = VB.create({ server: 'orlando', laws });
const cat = brain.catalogue();
console.log('\nстатьи, найденные в базе сервера:');
Object.keys(cat).forEach((k) => {
	console.log('  ' + k.padEnd(13) + ' → ' + cat[k].short + ' ст.' + cat[k].num + ' — ' + cat[k].title.slice(0, 52));
});

SCENE.forEach((u) => brain.feed(u));
const st = brain.state();

console.log('\n── лента сцены ──');
st.line.forEach((l) => {
	const m = l.marks.map((x) => '[' + x.label + ']').join(' ');
	console.log('  ' + brain.mmss(l.t0) + ' ' + (l.track === 'you' ? 'ВЫ    ' : 'ВОКРУГ') + ' ' + l.text.slice(0, 62) + ' ' + m);
});

console.log('\n── что понял ──');
console.log('  фабула: ' + (st.fabula ? st.fabula.text : '—'));
if (st.fabula && st.fabula.articles.length) {
	st.fabula.articles.forEach((a) => console.log('     → ' + a.short + ' ст.' + a.num + ' ' + (a.title || '').slice(0, 48)));
}
console.log('  шаги: ' + st.steps.filter((s) => s.done).length + ' из ' + st.steps.length);
st.steps.forEach((s) => console.log('    ' + (s.done ? '[v]' : '[ ]') + ' ' + s.title.padEnd(34) + ' ' + (s.done ? brain.mmss(s.at) : '')));
const mdone = st.miranda.points.filter((p) => p.done).length;
console.log('  права: ' + mdone + ' из ' + st.miranda.points.length + ' (' + st.miranda.ref + ')');
console.log('  услышанные статьи:');
st.hits.forEach((h) => console.log('    ' + brain.mmss(h.at) + ' ' + h.kind.padEnd(14) + ' ' + (h.who||'').padEnd(22) + ' ' + (h.article ? (h.article.short + ' ст.' + h.article.num) : 'статьи в базе нет')));
console.log('  вопросы: ' + st.questions.length);

console.log('\n── заготовка ответа адвокату ──');
const q = brain.answerQuestion('q0');
console.log('  ' + (q ? q.answer : '—'));

// ── утверждения ─────────────────────────────────────────────────────────────
console.log('\n── проверки ──');
ok(st.fabula && /угон/.test(st.fabula.text), 'фабула взята из объявленного основания');
ok(mdone === st.miranda.points.length, 'все пункты прав отмечены (' + mdone + ')');
// Порядок задержания — из кодекса Орландо (ПК ст.17, пункты а–и), а не из кода.
const view = brain.steps();
const byKey = (k) => view.find((s) => s.key === k);
ok(st.proc.source === 'ПК ст.17', 'порядок задержания прочитан из кодекса: ' + st.proc.source);
ok(byKey('г').done && byKey('д').done && byKey('ж').done && byKey('и').done,
	'отмечены пункты, которые прозвучали: г (основание+права), д, ж, и');
// В сцене офицер не представился. По кодексу это пункт «б» — и он должен
// всплыть как непрозвучавший, с номером, который назовёт и адвокат.
ok(byKey('б').status === 'missed' && brain.missed().length === 1,
	'не прозвучало ровно одно: ПК ст.17 п.б — представиться');
// Наручники надевают через игровое меню, молча. Тревога за них — ложная.
ok(byKey('а').status === 'passed', 'наручники (действие) пройдены молча, без тревоги');

// Зачитывание прав упоминает и звонок, и адвоката. Отметить по этому
// «права реализованы» или запустить срок звонка значит соврать офицеру.
const rd = VB.create({ server: 'orlando', laws });
rd.feed(utt('you', 1, 'Вы задержаны по подозрению в угоне.'));
rd.feed(utt('you', 5, MIRANDA));
ok(!rd.steps().find((s) => s.key === 'ж').done, 'чтение прав НЕ отмечает реализацию прав');
ok(!rd.timers().find((t) => t.id === 'call').running, 'чтение прав НЕ запускает срок звонка');
const insult = st.hits.filter((h) => h.kind === 'оскорбление');
ok(insult.length === 2, 'оскорблений найдено 2, найдено: ' + insult.length);
const toOfficer = insult.find((h) => h.who === 'в адрес сотрудника');
const toOther = insult.find((h) => h.who === 'в адрес другого лица');
ok(!!toOfficer && toOfficer.article && toOfficer.article.short === 'УК',
	'оскорбление сотрудника → уголовная статья');
ok(!!toOther && toOther.article && toOther.article.short !== toOfficer.article.short,
	'оскорбление гражданина → другая, административная статья');
ok(st.hits.some((h) => h.kind === 'неповиновение'), 'неповиновение найдено');
ok(st.questions.length === 1, 'вопрос адвоката замечен, найдено: ' + st.questions.length);

// спокойная сцена не должна давать ничего
const calm = VB.create({ server: 'orlando', laws });
CALM.forEach((u) => calm.feed(u));
const cs = calm.state();
ok(cs.hits.length === 0, 'на спокойной сцене статей не найдено');
ok(cs.miranda.points.every((p) => !p.done), 'на спокойной сцене права не отмечены');
ok(!cs.fabula, 'на спокойной сцене фабула не выдумана');

// неуверенная реплика не должна порождать обвинение
const shaky = VB.create({ server: 'orlando', laws });
shaky.feed(utt('around', 3, 'Да пошёл ты, мент поганый.', false));
ok(shaky.state().hits.length === 0, 'по неуверенно распознанной фразе статья не вменяется');

// сленг
const sl = VB.deslang('он свистнул тачку и достал ствол');
ok(/угон/.test(sl.text) && /транспортное средство/.test(sl.text) && /оружие/.test(sl.text),
	'сленг переведён: ' + sl.terms.join(', '));

// ── сводка для окна поверх игры ─────────────────────────────────────────────
// Ради неё всё и делалось: посреди сцены офицер смотрит только туда.
console.log('\n── окно поверх игры ──');
const ov = VB.create({ server: 'orlando', laws });
const step = (u) => { if (u) ov.feed(u); return ov.overlay(); };
utt.n = 0;

const o0 = step(null);
ok(o0.next.id === 'а' && /любом порядке/.test(o0.next.hint),
	'в начале — наручники, и видно, что кодекс разрешает начать с удостоверения');

// Документы на остановке ДО задержания: засчитываются, но порядок не нарушают.
const oDocs = step(utt('you', 4, 'Добрый день, предъявите документы.'));
ok(oDocs.missed.length === 0, 'проверка документов до задержания не поднимает тревогу о порядке');

const oG = step(utt('you', 14, 'Вы задержаны по подозрению в угоне автомобиля.'));
ok(oG.next.id === 'г' && oG.next.lines.length === 6,
	'после «вы задержаны» подсказка ведёт к правам и даёт все шесть пунктов текстом');
ok(/угон/.test(oG.fabula), 'обстоятельства попали в сводку');
ok(oG.missed.length === 1 && oG.missed[0].key === 'б' && /ПК ст\.17 п\.б/.test(oG.missed[0].ref),
	'офицер не представился — в окне «не прозвучало: ПК ст.17 п.б»');
const det = oG.timers.find((t) => t.id === 'detention');
ok(det && det.minutes === 60 && /ПК/.test(det.ref), 'пошёл срок задержания из кодекса: ' + (det && det.minutes) + ' мин, ' + (det && det.ref));

const oHalf = step(utt('you', 20, 'Вы имеете право хранить молчание. Всё, что вы скажете, может и будет использовано против вас в суде.'));
ok(oHalf.next.lines.length === 4 && /телефонный звонок/.test(oHalf.next.lines[0]),
	'прочитанные пункты уходят из подсказки, остаются непрозвучавшие');

const oAll = step(utt('you', 26, 'Вы имеете право на один телефонный звонок. Также вы имеете право на адвоката. '
	+ 'Если вам необходим адвокат, он будет для вас запрошен. Вы понимаете свои права?'));
// Доставка в Орландо — «при необходимости» (п.е), но везут почти всегда, и
// права реализуют уже в участке. Порядок подтвердил офицер.
ok(oAll.rights.done === 6 && oAll.next.id === 'е' && /участок/i.test(oAll.next.title),
	'после прав подсказка ведёт к доставке в участок (личность уже установлена на остановке)');

const oCall = step(utt('you', 30, 'Можете позвонить, у вас три минуты.'));
const call = oCall.timers.find((t) => t.id === 'call');
ok(call && call.minutes === 3, 'звонок запустил свой срок из кодекса: ' + (call && call.minutes) + ' мин');
ok(ov.overlay(30 + 4 * 60).timers.find((t) => t.id === 'call').left < 0,
	'через 4 минуты срок звонка показан просроченным');

ov.markManual('б');
ok(ov.overlay().missed.length === 0, 'офицер отметил «представился» вручную — тревога снята');

// Права читают своими словами и не целиком — в игре на это закрывают глаза
// (решение пользователя 30.10). Пока офицер читает, подсказка держит текст
// оставшихся пунктов перед глазами. Пошла сцена дальше (дан звонок, п.ж) —
// права засчитаны с временем начала чтения: ни «дочитайте», ни «не
// закончено», ни «зачитаны частично» в ответе адвокату.
const ic = VB.create({ server: 'orlando', laws });
ic.setWall(new Date(2026, 9, 30, 21, 30, 0).getTime());
ic.feed(utt('you', 10, 'Вы задержаны по подозрению в угоне.'));
ic.feed(utt('you', 15, 'Вы имеете право хранить молчание. Всё, что вы скажете, может и будет использовано против вас в суде.'));
ok(ic.nextAction().id === 'г' && ic.nextAction().lines.length === 4,
	'пока читают — подсказка держит текст оставшихся 4 пунктов');
ic.feed(utt('you', 75, 'Можете позвонить, у вас три минуты.'));
const icv = ic.steps();
ok(icv.find((s) => s.key === 'г').done, 'сцена пошла дальше — начатые права засчитаны');
ok(ic.missed().every((s) => s.key !== 'г') && icv.every((s) => s.status !== 'incomplete'),
	'ни «не прозвучало», ни «не закончено» за права своими словами');
ok(ic.nextAction().id !== 'г', 'подсказка не тянет назад «дочитать права»: ' + ic.nextAction().title);
ic.feed(utt('around', 90, 'Я адвокат. Когда вы зачитали права моему клиенту?', true));
const icq = ic.overlay(95).questions[0];
ok(icq && /Права зачитаны в 21:30/.test(icq.answer) && !/частично|из \d|Дочитайте/.test(icq.answer),
	'ответ адвокату — время прав, без «частично 2 из 6»: «' + (icq && icq.answer) + '»');
ok(!/из \d+ пунктов|частично/.test(ic.aiContext(icq.id).user), 'в контекст ИИ счёт пунктов не уходит');

const oQ = step(utt('around', 40, 'На каком основании вы задержали моего подзащитного?'));
ok(oQ.question && oQ.question.answer && /угон/.test(oQ.question.answer),
	'вопрос приходит в окно уже с готовым ответом из сцены');

const oH = step(utt('around', 44, 'Да пошёл ты, мент поганый.'));
ok(oH.hits.length === 1 && oH.hits[0].ref.indexOf('17.3') !== -1,
	'услышанная статья попадает в окно со ссылкой');
ov.setHit(oH.hits[0].id, 'dropped');
ok(ov.overlay().hits.length === 0, 'отклонённая статья исчезает из окна');
ok(oH.last && oH.last.track === 'around', 'в окне видно последнюю реплику — что ИИ слышит сейчас');

// ── клавиша этапа ───────────────────────────────────────────────────────────
// Наручники и доставку голосом не узнать — они делаются через меню игры.
// Офицер нажимает одну клавишу: «сделано то, что в „Сейчас“».
console.log('\n── клавиша этапа ──');
const kb = VB.create({ server: 'orlando', laws });
const titles = [];
let t = 0;
for (let g = 0; g < 20; g++) {
	const r = kb.stage(t += 10);
	if (!r) break;
	titles.push(r.title);
}
console.log('  нажатия: ' + titles.join(' → '));
ok(titles.slice(0, 7).join('|') === ['Наденьте наручники', 'Представьтесь и предъявите удостоверение',
	'Объявите основание задержания', 'Зачитайте права', 'Установите личность задержанного',
	'Доставьте в участок', 'Предложите реализовать права'].join('|'),
	'порядок нажатий — как у офицера: наручники, удостоверение, основание, Миранда, личность, участок, права');
ok(titles.length === 9 && /адвокат/i.test(titles[7]) && /адвокат/i.test(titles[8]),
	'после прав — два этапа адвоката, потом конец');
ok(kb.nextAction().kind === 'done' && kb.stage(200) === null, 'после последнего этапа клавиша ничего не отмечает');
ok(kb.steps().find((s) => s.key === 'и').done, 'одно нажатие «в участок» закрыло оба пункта доставки (п.е и п.и)');
ok(!kb.steps().find((s) => s.key === 'в').done, 'необязательный обыск клавиша пропускает');
const kt = kb.timers();
ok(kt.find((x) => x.id === 'detention').startedAt === 10, 'срок задержания пошёл с первого нажатия');
ok(kt.find((x) => x.id === 'lawyerWait').startedAt === 80 && kt.find((x) => x.id === 'lawyerMeet').startedAt === 90,
	'«адвокат вызван» и «адвокат прибыл» запустили свои сроки из кодекса');
ok(kb.missed().length === 0, 'пройдя всё клавишей, «не прозвучало» пусто');

// ошибка и отмена
const kb2 = VB.create({ server: 'orlando', laws });
kb2.stage(5); kb2.stage(6);
ok(kb2.nextAction().title === 'Объявите основание задержания', 'два нажатия — курсор на основании');
ok(kb2.stageBack() && kb2.nextAction().title === 'Представьтесь и предъявите удостоверение', 'отмена вернула удостоверение');
kb2.stageBack();
ok(kb2.nextAction().id === 'а' && kb2.timers().find((x) => x.id === 'detention').startedAt == null,
	'отмена первого нажатия сняла и начало задержания, и его срок');
ok(kb2.stageBack() === false, 'отменять больше нечего — так и сказано');

// голос и клавиша вместе: прозвучавшее курсор проходит сам
const kb3 = VB.create({ server: 'orlando', laws });
kb3.stage(3);                                                  // наручники
kb3.feed(utt('you', 6, 'Офицер Смит, полиция, вот мой жетон.'));  // удостоверение голосом
kb3.feed(utt('you', 9, 'Вы задержаны по подозрению в угоне.'));    // основание голосом
const n3 = kb3.nextAction();
ok(n3.title === 'Зачитайте права' && n3.lines.length === 6, 'услышанное голосом клавишу не ждёт: сразу «Зачитайте права»');
kb3.stage(30);
ok(kb3.steps().find((s) => s.key === 'г').done && kb3.nextAction().title === 'Установите личность задержанного',
	'права отмечены клавишей, дальше — личность');

// Сиэтл: в кодексе «установить личность» и «реализовать права» записаны дважды
const sk = VB.create({ server: 'seattle', laws: load('seattle') });
const sTitles = sk.stages().map((x) => x.title);
ok(sTitles.filter((x) => /личност/.test(x)).length === 1 && sTitles.filter((x) => /реализовать/.test(x)).length === 1,
	'Сиэтл: повторы пунктов — один этап, а не два нажатия подряд');

// ── адвокат, часы, сводка, ответы ───────────────────────────────────────────
console.log('\n── адвокат, сводка, ответы ──');
const bc = VB.create({ server: 'orlando', laws });
const T0 = new Date(2026, 9, 28, 21, 30, 0).getTime();
bc.setWall(T0);
for (let g = 0; g < 7; g++) bc.stage(10 + g * 30);     // наручники 21:30:10 … права 21:33:10
bc.stage(300);                                           // адвокат вызван 21:35:00
let tm = bc.timers();
const ansT = tm.find((x) => x.id === 'lawyerAnswer');
ok(ansT && ansT.minutes === 3 && ansT.running && /типовой/.test(ansT.ref),
	'Орландо: срока ответа адвоката в кодексе нет — типовые 3 мин, честно подписано: ' + (ansT && ansT.ref));
ok(tm.find((x) => x.id === 'lawyerWait').running, '«адвокат вызван» запустил и срок прибытия (10 мин по ПК ст.17)');
ok(bc.overlay(300).detainedAt === '21:30:10', 'время задержания по часам — с первого этапа: ' + bc.overlay(300).detainedAt);
bc.feed(utt('around', 320, 'Когда вы зачитали права моему клиенту?'));
bc.feed(utt('around', 330, 'Вы вызвали адвоката?'));
let ov2 = bc.overlay(330);
ok(/вызван в 21:35/.test(ov2.question.answer) && /ответ — до 21:38/.test(ov2.question.answer) && /прибытие — до 21:45/.test(ov2.question.answer),
	'ответ про адвоката называет, до скольки ждать ответа и прибытия');
const qR = bc.state().questions.find((x) => /права/.test(x.text));
ok(qR.topic === 'rights' && /Права зачитаны в 21:31/.test(bc.draftAnswer(qR)), 'на «когда зачитали права» — время прав: ' + bc.draftAnswer(qR));
bc.stage(600);                                           // адвокат прибыл 21:40:00
tm = bc.timers();
ok(!tm.find((x) => x.id === 'lawyerAnswer').running && !tm.find((x) => x.id === 'lawyerWait').running
	&& tm.find((x) => x.id === 'lawyerMeet').running, 'адвокат прибыл: сроки ожидания остановлены, пошла встреча');
ok(bc.nextAction().kind === 'done', 'после этапа «беседа с адвокатом» — процедура пройдена');
const sum = bc.summary();
const sv = (k) => (sum.find((r) => r.k === k) || {}).v;
ok(sv('Задержан') === '21:30:10' && sv('Наручники') === '21:30' && sv('Права') === '21:31' && /прибыл 21:40/.test(sv('Адвокат')),
	'сводка Bodycam: ' + sum.map((r) => r.k + ' ' + r.v).join(' · '));
// вопрос без «?», но по сути вопрос
const nq = VB.create({ server: 'orlando', laws });
nq.feed(utt('around', 5, 'сколько времени мой клиент уже задержан'));
ok(nq.state().questions.length === 1 && nq.state().questions[0].topic === 'time', 'вопрос без знака вопроса узнан по сути: «сколько времени»');

// ── голоса и роли ───────────────────────────────────────────────────────────
// Служба метит голоса S1, S2…; кто есть кто — видно из сказанного.
console.log('\n── голоса и роли ──');
const vr = VB.create({ server: 'orlando', laws });
vr.setWall(new Date(2026, 9, 28, 21, 30, 0).getTime());
const us = (t, text, spk, track) => Object.assign(utt(track || 'around', t, text), { spk });
vr.stage(5);
vr.feed(us(10, 'Да за что меня, я ничего не делал!', 'S1'));
vr.feed(us(20, 'Добрый день, я адвокат задержанного.', 'S2'));
vr.feed(us(30, 'Какое основание задержания моего клиента?', 'S2'));
vr.feed(us(40, 'Ну и погодка сегодня.', 'S3'));
vr.feed(us(45, 'Субтитры создавал DimaTorzok', 'S3'));
const lab = (spk) => vr.who({ track: 'around', spk }).label;
ok(lab('S1') === 'Задержанный' && lab('S2') === 'Адвокат' && lab('S3') === 'Неизвестный 3',
	'роли по сказанному: S1 ' + lab('S1') + ', S2 ' + lab('S2') + ', S3 ' + lab('S3'));
ok(vr.state().line.every((l) => !/DimaTorzok/.test(l.text)), '«Субтитры создавал DimaTorzok» в ленту не попадает');
const qv = vr.overlay(50).questions;
ok(qv.length === 2 && qv[0].who === 'Адвокат' && qv[1].who === 'Задержанный',
	'вопросы лентой, свежий сверху, подписаны ролью: ' + qv.map((x) => x.who + ' «' + x.text + '»').join(' / '));
// офицер говорит своими словами, не по шпаргалке (живая запись 29.10): роль
// всё равно узнаётся, а его «какая статья?» не остаётся вопросом к нему же
const ow = VB.create({ server: 'orlando', laws });
ow.feed(us(5, 'Да какая статья, куда его?', 'S1', 'mix'));
ow.feed(us(9, 'Имеете право на телефонный звонок, на адвоката.', 'S1', 'mix'));
ow.feed(us(14, 'Будете реализовывать свои права?', 'S1', 'mix'));
ow.feed(us(18, 'Прижмитесь к обочине и заглушите двигатель.', 'S2', 'mix'));
ow.feed(us(22, 'Да отпусти меня лучше.', 'S3', 'mix'));
const owl = (spk) => ow.who({ track: 'mix', spk }).label;
ok(owl('S1') === 'Офицер' && owl('S2') === 'Офицер' && owl('S3') === 'Задержанный',
	'офицер узнан по живым фразам (права, звонок, «прижмитесь к обочине»): ' + [owl('S1'), owl('S2'), owl('S3')].join(', '));
ok(ow.overlay(30).questions.length === 0, 'вопрос, заданный голосом офицера, из окна убран задним числом');

// игровая болтовня со знаком вопроса — не вопрос к офицеру (живая запись 29.10)
const chat = VB.create({ server: 'orlando', laws });
['А можете броню кинуть?', 'Что?', 'Ну кореш подставил, да?', 'А чё, кореш ваш вышел?'].forEach((t, i) => chat.feed(us(10 + i * 5, t, 'S1')));
ok(chat.state().questions.length === 0, 'болтовня («броню кинуть?», «что?») не попадает в вопросы и не тратит ИИ');
chat.feed(us(40, 'Вы зачитали ему права?', 'S1'));
chat.feed(us(45, 'Я адвокат. А где мы вообще находимся?', 'S2'));
ok(chat.state().questions.length === 2, 'вопрос про процедуру и любой вопрос адвоката — остаются');
ok(chat.overlay(50).feed.every((l) => !/Неизвестный/.test(l.who)), 'в окне «Неизвестный» не подписывается');
ok(chat.overlay(50).feed.length === 3, 'субтитры в окне — три последние реплики');

// в записи с ПК известный адвокат не отмечает шагов офицера, а офицер не «спрашивает» сам себя
const vm = VB.create({ server: 'orlando', laws });
vm.feed(us(5, 'Я адвокат, мой подзащитный ни в чём не виноват.', 'S2', 'mix'));
vm.feed(us(9, 'Вы задержаны по подозрению в угоне? Так и запишите.', 'S2', 'mix'));
ok(!vm.state().fabula, 'запись: слова адвоката не становятся основанием задержания');
vm.feed(us(12, 'Вы задержаны по подозрению в угоне автомобиля.', 'S1', 'mix'));
vm.feed(us(15, 'Руки за спину. Ваши документы?', 'S1', 'mix'));
ok(vm.state().fabula && vm.who({ track: 'mix', spk: 'S1' }).label === 'Офицер'
	&& !vm.state().questions.some((x) => x.spk === 'S1'), 'запись: офицер узнан, его вопрос «ваши документы?» не считается вопросом к нему');

// ответ ИИ: контекст из записи и отбраковка выдуманной статьи
const ai = VB.create({ server: 'orlando', laws });
ai.setWall(new Date(2026, 9, 28, 21, 30, 0).getTime());
ai.stage(5);
ai.feed(utt('you', 10, 'Вы задержаны по подозрению в угоне автомобиля.'));
ai.feed(us(30, 'Я адвокат. Почему мой клиент в наручниках?', 'S2'));
const aq = ai.state().questions[0];
const ctx = ai.aiContext(aq.id);
ok(ctx && /Задержан: 21:30:05/.test(ctx.user) && /Адвокат спрашивает: «Я адвокат/.test(ctx.user) && /угон/.test(ctx.user),
	'контекст для ИИ: время задержания, основание, кто спрашивает');
// чужая речь в ИИ не уходит: только факты и сам вопрос
ai.feed(us(25, 'Да пошёл ты, мент поганый, я ничего не делал!', 'S1'));
const ctx2 = ai.aiContext(ai.state().questions[0].id);
ok(!/мент поганый/.test(ctx2.user) && !/ничего не делал/.test(ctx2.user) && /оскорбление/.test(ctx2.user),
	'в запрос к ИИ не уходят слова других игроков — только факт «оскорбление» и статья');
ok(ai.setAi(aq.id, 'Наручники надеты при задержании в 21:30 по ПК ст.17.') && aq.aiState === 'ready', 'ответ ИИ со статьёй из записи принят');
ok(!ai.setAi(aq.id, 'Это предусмотрено статьёй 228 УК.') && aq.aiState === 'rejected', 'ответ ИИ с выдуманной статьёй отброшен');

// ── режим записи ────────────────────────────────────────────────────────────
// Видео задержания на ПК: офицер и все остальные звучат одним звуком.
// Реплика 'mix' обязана работать и как речь офицера, и как речь вокруг —
// иначе по записи не отметится ни один шаг.
console.log('\n── режим записи (видео на ПК) ──');
const mx = VB.create({ server: 'orlando', laws });
mx.feed(utt('mix', 3, 'Вы задержаны по подозрению в угоне автомобиля.'));
mx.feed(utt('mix', 8, MIRANDA));
mx.feed(utt('mix', 30, 'Да пошёл ты, мент поганый.'));
const mxs = mx.state();
ok(mxs.fabula && /угон/.test(mxs.fabula.text) && mx.steps().find((s) => s.key === 'г').done,
	'запись: основание и права (п.г) отмечены как прозвучавшие');
ok(mxs.miranda.points.every((p) => p.done), 'запись: права засчитаны по звуку с ПК');
ok(mxs.hits.some((h) => h.kind === 'оскорбление'), 'запись: оскорбление найдено на той же дорожке');
ok(VB.create({ server: 'orlando', laws }).feed(utt('around', 3, 'Вы задержаны по подозрению в угоне.')).length === 0,
	'обычный режим: речь вокруг шаги офицера по-прежнему не отмечает');

// ── другие серверы ──────────────────────────────────────────────────────────
console.log('\n── другие серверы ──');
// Финикс: порядок в кодексе явным списком не записан. Общий порядок мы
// составили сами, поэтому требовать его соблюдения и кричать «пропущено»
// нечестно — но и перескакивать через непрочитанные права нельзя.
// (До 31.10.2026 эта проверка шла на Атланте; теперь её порядок читается.)
const ph = VB.create({ server: 'phoenix', laws: load('phoenix') });
ok(!ph.state().proc.strict, 'Финикс: порядка в кодексе нет — работает общий, нестрогий');
ph.feed(utt('you', 3, 'Вы задержаны по подозрению в угоне.'));
ph.feed(utt('you', 9, 'Предъявите документы.'));
ok(ph.missed().length === 0, 'Финикс: при общем порядке тревог «не прозвучало» нет');
ok(/права/i.test(ph.nextAction().title), 'Финикс: подсказка не перепрыгнула через непрочитанные права');

// Атланта: список «1)…11)» парсер разложил по частям статьи, а внутри
// четвёртого пункта стоит ссылка «ч.1 статьи 16» — она обрывала список.
const atb = VB.create({ server: 'atlanta', laws: load('atlanta') });
const atp = atb.state().proc, ats = atb.steps();
ok(atp.strict && atp.source === 'ПК ст.16' && ats.length === 11 && /наручник/i.test(ats[0].text)
	&& ats.some((s) => /миранд/i.test(s.text)),
	'Атланта: порядок из ПК ст.16 — 11 шагов, первым наручники (' + ats.length + ')');

// Лос-Анджелес: шаги на форуме — список без номеров, в тексте только «;».
const lax = VB.create({ server: 'losangeles', laws: load('losangeles') });
const lap = lax.state().proc, las = lax.steps();
ok(lap.strict && lap.source === 'ПК ст.4' && las.length >= 10
	&& las.some((s) => /вызвать прокурора/i.test(s.text) && !/\(см$/.test(s.text)),
	'Лос-Анджелес: порядок из ПК ст.4 без номеров — ' + las.length + ' шагов, фразы целиком');

// Сиэтл: поиск Миранды по кавычкам захватывал кусок между двумя разными
// цитатами — «время на принятие вызова адвокатом 3 минуты» становилось
// «пунктом прав». Пункты обязаны начинаться с права хранить молчание.
const se = VB.create({ server: 'seattle', laws: load('seattle') }).state().miranda;
ok(se.available && /хранить молчание/.test(se.points[0].text) && /прав[а-я]*\s*\?$/.test(se.points[se.points.length - 1].text),
	'Сиэтл: права извлечены от «хранить молчание» до «ясны ли права?», без мусора (' + se.points.length + ' пунктов)');

// ── задержание госслужащего и по ордеру (с 02.11.2026) ─────────────────────
// Сроки у каждого сервера свои, и путать их нельзя: «не ответил за 3
// минуты» и «за 15» — разница между законным задержанием и освобождением.
function govProfile(server) {
	const b = VB.create({ server, laws: load(server) });
	b.setMode({ gov: true });
	const t = {};
	b.state().timers.forEach((x) => { t[x.id] = x.minutes; });
	return { b, t, m: b.modes() };
}
let gp = govProfile('seattle');
ok(gp.m.gov.source === 'ПК ст.19' && gp.t.prosAnswer === 10 && gp.t.prosWait === 10 && gp.t.bossWait === 20,
	'Сиэтл: госслужащий по ПК ст.19 — прокурору 10 на ответ и 10 на приезд, начальству 10+10');
gp = govProfile('miami');
ok(gp.t.prosAnswer === 3 && gp.t.prosWait === 10 && gp.t.bossWait === 13, 'Майами: ответ «каждого из указанных лиц» 3 мин, приезд 10');
gp = govProfile('sanfrancisco');
ok(gp.t.prosAnswer === 3, 'Сан-Франциско: срок прокурора (3 мин) точнее общего «указанных лиц» (10)');
gp = govProfile('atlanta');
ok(gp.t.prosAnswer === 3 && gp.t.prosWait === 10 && /отсутствия ответа от сотрудника Прокуратуры/.test(gp.m.gov.items.map((i) => i.quote).join(' ')),
	'Атланта: 3/10 мин, неявка прокурора — освободить (ч. 2.9), а не «по требованию прокурора»');
gp = govProfile('dallas');
ok(gp.m.gov.items.some((i) => /право, не обязанность/.test(i.t)) && gp.m.gov.items.some((i) => /Арест — только после/.test(i.t)),
	'Даллас: начальство — право офицера, арест — только после решения прокурора');
gp = govProfile('losangeles');
ok(gp.t.prosAnswer == null && gp.t.prosWait == null, 'Лос-Анджелес: сроки «5 и 7 минут» — не прокурора (кроме него), не подставлены');

// Сцена: прокурор вызван — срок задержания стоит, пока он не приедет
gp = govProfile('seattle');
let sb = gp.b, tt = 0;
for (let i = 0; i < 30 && sb.nextAction().kind === 'step'; i++) { tt += 20; sb.stage(tt); }
ok(sb.nextAction().id === 'prosCalled', 'госслужащий: после процедуры — «Вызовите прокурора»');
sb.feed({ n: 1, track: 'you', t0: tt + 10, t1: tt + 12, text: 'Вызываю прокурора' });
let gdet = sb.timers(tt + 130).filter((x) => x.id === 'detention')[0];
ok(gdet.paused && gdet.pause === 120, 'срок задержания стоит, пока ждём прокурора (' + gdet.pause + ' с)');
gdet = sb.timers(tt + 10 + 700).filter((x) => x.id === 'detention')[0];
ok(!gdet.paused && gdet.pause === 600, 'прокурор не ответил за 10 мин — срок снова идёт (стоял ' + gdet.pause + ' с)');
ok(/прокурор вызван/i.test(sb.draftAnswer({ topic: 'pros' })), 'ответ «вызвали ли прокурора» — по записи сцены');
// без режима «вызываю прокурора» сроки госслужащего не запускает
const plain = VB.create({ server: 'seattle', laws: load('seattle') });
plain.feed({ n: 1, track: 'you', t0: 10, t1: 12, text: 'Вызываю прокурора' });
ok(plain.state().seen.prosCalled == null && !plain.stages().some((s) => s.id === 'prosCalled'),
	'обычное задержание: «вызываю прокурора» не включает ветку госслужащего');

// Адвокат: у Далласа срок стоит и на «вызов и разбирательство с адвокатом»
const da = VB.create({ server: 'dallas', laws: load('dallas') });
da.stage(0);
da.feed({ n: 1, track: 'you', t0: 100, t1: 102, text: 'Вызываю адвоката' });
gdet = da.timers(400).filter((x) => x.id === 'detention')[0];
ok(gdet && gdet.paused && gdet.pause === 300, 'Даллас: пока ждём адвоката, срок задержания стоит (ПК ст.20)');

// Ордер
const lw = VB.create({ server: 'losangeles', laws: load('losangeles') });
const mir0 = lw.state().miranda.points.length;
lw.setMode({ warrant: true, gov: true });
const lst = lw.stages().map((s) => s.id);
ok(!lst.includes('lawyerCalled') && !lst.includes('prosCalled') && lw.state().miranda.ref === 'ПК ст.1.1' && lw.state().miranda.points.length < mir0,
	'Лос-Анджелес, ордер AS: без адвоката и прокурора, Миранда своя (ПК ст.1.1)');
lw.setMode({ warrant: false });
ok(lw.state().miranda.ref !== 'ПК ст.1.1' && lw.stages().some((s) => s.id === 'lawyerCalled'), 'ордер выключен — всё как было');
const sw = VB.create({ server: 'seattle', laws: load('seattle') });
sw.setMode({ warrant: true });
ok(sw.stages().some((s) => s.id === 'lawyerCalled') && sw.modes().warrant.items.some((i) => /можно не предлагать/.test(i.t)),
	'Сиэтл, ордер: адвоката «вправе не предлагать» — этап остаётся, с пометкой');
const orw = VB.create({ server: 'orlando', laws: load('orlando') });
orw.setMode({ warrant: true });
ok(!orw.modes().warrant.items.length && orw.stages().some((s) => s.id === 'lawyerCalled'),
	'Орландо: кодекс исключений для ордера не делает — порядок обычный');
orw.reset();
ok(!orw.state().mode.warrant, 'сброс сцены выключает режимы');

// ── роли голосов: отмечает офицер, подсказывает ход сцены (с 03.11.2026) ──
{
	const rb = VB.create({ server: 'orlando', laws: load('orlando') });
	let k = 0;
	const say = (t, text, track, spk) => rb.feed({ n: ++k, track: track || 'you', spk, t0: t, t1: t + 2, text, sure: true });
	const lab = (spk) => rb.who({ track: 'around', spk }).label;
	// «Задержанный?» — тот, кто отвечает сразу после слов задержания
	say(10, 'Вы задержаны по подозрению в угоне автомобиля.');
	say(14, 'Да ладно, серьёзно?', 'around', 'S2');
	say(16, 'Вы имеете право хранить молчание.');
	say(19, 'Ну и что дальше', 'around', 'S2');
	say(40, 'Красивая машина у вас', 'around', 'S6');
	ok(lab('S2') === 'Задержанный?' && lab('S6') === 'Неизвестный 6',
		'догадка по ходу сцены: отвечает на слова задержания — «' + lab('S2') + '», посторонний — «' + lab('S6') + '»');
	// «Адвокат?» — первый новый голос после вызова, второй — нет
	say(100, 'Вызываю адвоката');
	say(200, 'Добрый вечер, что тут у вас', 'around', 'S4');
	say(210, 'Я просто мимо шёл', 'around', 'S5');
	ok(lab('S4') === 'Адвокат?' && lab('S5') === 'Неизвестный 5', 'после «вызываю адвоката» — первый новый голос «' + lab('S4') + '», следующий — «' + lab('S5') + '»');
	// офицер поправил сам — это главнее догадки и прибытие отмечено
	ok(rb.setVoiceRole('S4', 'lawyer') && lab('S4') === 'Адвокат' && rb.state().seen.lawyerMeet === 200,
		'щелчок «это адвокат»: подпись без «?», адвокат прибыл в 200 с (первая его фраза после вызова)');
	rb.setVoiceRole('S5', 'other');
	say(215, 'А вы на каком основании его держите?', 'around', 'S5');
	ok(!rb.overlay(220).questions.some((q) => /основании/.test(q.text)), 'вопрос постороннего — не вопрос к офицеру');
	rb.setVoiceRole('S2', '');
	ok(lab('S2') === 'Задержанный?', 'роль снята — снова догадка');
	ok(!rb.setVoiceRole('S2', 'judge') && !rb.setVoiceRole('S99', 'lawyer'), 'чужая роль или незнакомый голос — отказ');
	// госслужащий: новый голос после вызова прокурора — «Прокурор?»; щелчок отмечает прибытие
	const gp2 = VB.create({ server: 'orlando', laws: load('orlando') });
	gp2.setMode({ gov: true });
	gp2.feed({ n: 1, track: 'you', t0: 300, t1: 302, text: 'Вызываю прокурора', sure: true });
	gp2.feed({ n: 2, track: 'around', spk: 'S7', t0: 400, t1: 402, text: 'Добрый вечер, слушаю вас', sure: true });
	ok(gp2.who({ track: 'around', spk: 'S7' }).label === 'Прокурор?', 'госслужащий: новый голос после вызова — «Прокурор?»');
	gp2.setVoiceRole('S7', 'prosecutor');
	ok(gp2.state().seen.prosArrived === 400, 'щелчок «это прокурор» — прокурор прибыл в 400 с');
}

// Подсказка распознавателю: раньше в ней сидело слово «undefined» вместо сленга.
const voc = brain.vocab();
ok(!/undefined/.test(voc) && /огнестрельное оружие/.test(voc), 'подсказка распознавателю без «undefined», со сленгом');

console.log('\n' + (fails ? 'ПРОВАЛОВ: ' + fails : 'все проверки пройдены'));
process.exit(fails ? 1 : 0);
