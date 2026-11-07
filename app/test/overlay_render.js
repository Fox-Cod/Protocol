/**
 * Проверка окна поверх игры (scene-overlay.html) на настоящей сводке.
 *
 *   npm run test:overlay        (= electron test/overlay_render.js)
 *
 * Зачем отдельно от voice_brain_test.js. Разбор может работать идеально, а
 * окно — показывать не то: забытый блок, цитата без числа, сроки, которые не
 * тикают. Глазами это ловится только в игре, а в игре проверять поздно.
 *
 * Сводка не пишется руками: сцена прогоняется через voice_brain.js на базе
 * Орландо, и окну отдаётся ровно то, что отдало бы приложение. Окно не
 * показывается на экране. Всё, на что ругается отрисовка (в том числе
 * нарушения политики безопасности), считается провалом.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { app, BrowserWindow, ipcMain } = require('electron');

const APP = path.join(__dirname, '..');
const VB = require(path.join(APP, 'voice_brain.js'));

let fails = 0;
const out = [];
function say(s) { out.push(s); }
function ok(cond, what) { if (!cond) fails++; say((cond ? '  ок      ' : '  ПРОВАЛ  ') + what); }

function load(server) {
	const j = path.join(APP, 'data', server + '.json');
	const raw = fs.existsSync(j) ? fs.readFileSync(j, 'utf8')
		: zlib.brotliDecompressSync(fs.readFileSync(j + '.br')).toString('utf8');
	const doc = JSON.parse(raw);
	const sets = doc.sets || doc;
	return Object.keys(sets).map((k) => Object.assign({ id: k }, sets[k])).filter((l) => l && l.parts);
}

let brain = null;
function scenePayload(now) {
	if (!brain) {
		brain = VB.create({ server: 'orlando', laws: load('orlando') });
		let n = 0;
		const u = (t, text, track) => ({ n: ++n, track: track || 'you', t0: t, t1: t + 2, text, sure: true });
		// офицер не представился (п.б) и прочитал половину прав
		brain.feed(u(14, 'Вы задержаны по подозрению в угоне автомобиля.'));
		brain.feed(u(20, 'Вы имеете право хранить молчание. Всё, что вы скажете, может и будет использовано против вас в суде.'));
		brain.feed(u(40, 'Да пошёл ты, мент поганый.', 'around'));
		brain.feed(u(46, 'На каком основании вы задержали моего подзащитного?', 'around'));
	}
	const d = brain.overlay(now);
	d.running = true; d.server = 'Orlando'; d.wall = Date.now();
	d.keys = { stage: 'Alt+E', back: 'Alt+Shift+E' };
	return d;
}

const PROBE = `JSON.stringify({
	now: document.getElementById('nowT').textContent,
	ref: document.getElementById('nowRef').textContent,
	stageN: document.getElementById('nowN').textContent,
	keyHint: document.getElementById('keyHint').textContent,
	lines: Number((document.querySelector('#nowL div') || { dataset: {} }).dataset.n || 0),
	blocks: document.getElementById('nowL').children.length,
	linesText: document.getElementById('nowL').textContent,
	miss: document.getElementById('miss').classList.contains('hide') ? 0 : document.querySelectorAll('#missL .missI').length,
	missRef: (document.querySelector('#missL .missR') || {}).textContent || '',
	ask: !document.getElementById('ask').classList.contains('hide'),
	answer: document.getElementById('askA').textContent,
	hits: document.querySelectorAll('.hit').length,
	askButtons: document.querySelectorAll('#ask button').length,
	subs: [].map.call(document.querySelectorAll('#subs .fl'), function (x) { return x.textContent; }),
	timers: [].map.call(document.querySelectorAll('#timers .tm'), function (x) { return { t: x.textContent, over: x.classList.contains('over') }; }),
	green: document.querySelectorAll('.pd.on').length,
	red: document.querySelectorAll('.pd.miss').length
})`;

app.whenReady().then(() => {
	const w = new BrowserWindow({
		width: 360, height: 520, show: false, frame: false,
		webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(APP, 'preload.js') },
	});
	// С Electron 35 уровень и текст лежат в самом событии (level — строка);
	// старая сигнатура (e, level, msg) с числом — у прежних версий.
	w.webContents.on('console-message', (e, level, msg) => {
		const lv = typeof e.level === 'string' ? e.level : (level >= 3 ? 'error' : level >= 2 ? 'warning' : 'info');
		const text = e.message != null ? e.message : msg;
		if (lv === 'warning' || lv === 'error') { fails++; say('  ПРОВАЛ  окно ругается: ' + text); }
	});
	w.webContents.on('did-fail-load', (e, code, desc) => { fails++; say('  ПРОВАЛ  не загрузилось: ' + desc); });
	const sizes = [];
	ipcMain.on('scene-resize', (e, p) => { sizes.push(p); });
	let readyHeard = false;
	ipcMain.on('scene-ready', () => { readyHeard = true; });
	const acts = [];
	ipcMain.on('scene-action', (e, a) => { acts.push(a || {}); });
	w.loadFile(path.join(APP, 'scene-overlay.html'));
	const probe = () => w.webContents.executeJavaScript(PROBE).then((json) => JSON.parse(json));
	const wait = (ms) => new Promise((r) => setTimeout(r, ms));
	w.webContents.once('did-finish-load', async () => {
		try {
			// 1) середина сцены: 200-я секунда
			w.webContents.send('scene-data', scenePayload(200));
			await wait(1400);
			let r = await probe();
			say('окно поверх игры, сцена Орландо, 3:20:');
			ok(readyHeard, 'окно доложило о готовности');
			ok(r.now === 'Дочитайте права' && r.ref === 'ПК ст.17 п.г', '«Сейчас»: ' + r.now + ' — ' + r.ref);
			ok(r.lines === 4, 'непрочитанных пунктов прав в подсказке: ' + r.lines + ' (ждали 4)');
			ok(r.blocks === 1 && /телефонный звонок.*понимаете/i.test(r.linesText),
				'права — одним абзацем, а не блоком на пункт: «' + r.linesText.slice(0, 60) + '…»');
			ok(r.miss === 1 && /п\.б/.test(r.missRef), '«Не прозвучало»: ' + r.miss + ' — ' + r.missRef);
			ok(r.ask && /угон/.test(r.answer), 'вопрос адвоката показан с ответом из сцены');
			ok(r.hits === 0, '«Услышано» в окне нет — журнал в приложении');
			ok(r.askButtons === 0, 'у вопроса нет кнопок «копировать» и «скрыть»');
			ok(r.subs.length === 3 && /подзащитного/.test(r.subs[2]) && /пошёл/.test(r.subs[1]),
				'субтитры: три строки, свежая внизу: ' + r.subs.map((x) => x.slice(5, 30)).join(' | '));
			const det = r.timers.find((t) => /задержан/i.test(t.t));
			ok(det && !det.over && /^5\d:\d\d/.test(det.t), 'срок задержания тикает: ' + (det && det.t));
			ok(r.red === 1, 'на полоске прогресса одна красная отметка — пропущенный п.б');
			ok(/4\/9/.test(r.stageN), 'номер этапа виден: «' + r.stageN + '»');
			const rec = JSON.parse(await w.webContents.executeJavaScript("JSON.stringify({ on: document.getElementById('rec').className, w: document.getElementById('recW').textContent, t: document.getElementById('recT').textContent, cur: document.querySelectorAll('.pd.cur').length })"));
			ok(rec.on === 'on' && rec.w === 'REC' && /^3:2\d$/.test(rec.t), 'в шапке идёт запись и её время: ' + rec.w + ' ' + rec.t);
			ok(rec.cur === 1, 'на полоске этапов подсвечен текущий');
			// модель ещё грузится: не «REC», а «ЗАПУСК», и «Стоп» уже можно нажать — он отменит запуск
			const bootD = scenePayload(200); bootD.running = false; bootD.starting = true;
			w.webContents.send('scene-data', bootD);
			await wait(1200);
			const boot = JSON.parse(await w.webContents.executeJavaScript("JSON.stringify({ w: document.getElementById('recW').textContent, t: document.getElementById('recT').textContent, stop: getComputedStyle(document.getElementById('rec')).display, title: document.getElementById('rec').title })"));
			ok(boot.w === 'ЗАПУСК' && !boot.t && boot.stop !== 'none' && /Отменить запуск/.test(boot.title),
				'во время запуска: «' + boot.w + '», щелчок по нему отменяет запуск');
			w.webContents.send('scene-data', scenePayload(200));
			await wait(300);

			// модели не было — она скачивается: «СКАЧИВАНИЕ 43%» и сколько уже, а не безликое «ЗАПУСК»
			const dlD = scenePayload(200); dlD.running = false; dlD.starting = true;
			dlD.download = { label: 'turbo', got: '0,7 ГБ', total: '~1,6 ГБ', pct: 43 };
			w.webContents.send('scene-data', dlD);
			await wait(1200);
			const dlr = JSON.parse(await w.webContents.executeJavaScript("JSON.stringify({ w: document.getElementById('recW').textContent, dl: document.getElementById('dl').textContent, shown: !document.getElementById('dl').classList.contains('hide'), title: document.getElementById('rec').title })"));
			ok(dlr.w === '43%' && dlr.shown && /turbo.*0,7 ГБ из ~1,6 ГБ/.test(dlr.dl) && /Отменить скачивание/.test(dlr.title),
				'во время скачивания: «' + dlr.w + '», «' + dlr.dl.slice(0, 50) + '…»');
			w.webContents.send('scene-data', scenePayload(200));
			await wait(300);
			ok(await w.webContents.executeJavaScript("document.getElementById('dl').classList.contains('hide')"), 'скачалась — строка о скачивании убрана');

			// «не слышу» — жёлтым под сбоем; клавиша «стоп» — в подсказке: в фокусе до кнопки не дотянуться
			const wd = scenePayload(200);
			wd.warns = ['голоса других игроков не слышны: со звука игры — ни одной фразы, ваших — 5'];
			wd.keys = { stage: 'Alt+E', back: 'Alt+Shift+E', stop: 'Alt+Shift+S' };
			w.webContents.send('scene-data', wd);
			await wait(300);
			const wr = JSON.parse(await w.webContents.executeJavaScript("JSON.stringify({ warn: document.getElementById('warn').textContent, hint: document.getElementById('keyHint').textContent, title: document.getElementById('rec').title, order: [].map.call(document.getElementById('body').children, function (x) { return x.id }).slice(0, 2) })"));
			ok(/Не слышу:.*голоса других игроков/.test(wr.warn) && wr.order[1] === 'warn', 'предупреждение «не слышу» видно, сразу под сбоем');
			ok(!wr.hint && /Alt\+Shift\+S/.test(wr.title), 'посреди сцены подсказка клавиш не занимает место, «стоп» — у REC: «' + wr.title + '»');
			w.webContents.send('scene-data', scenePayload(200));
			await wait(300);
			ok(await w.webContents.executeJavaScript("document.getElementById('warn').children.length === 0"), 'звук вернулся — предупреждение исчезло');
			ok(await w.webContents.executeJavaScript("document.getElementById('stageKey').textContent") === 'Alt+E', 'клавиша этапа — в самой кнопке «Сделано»');
			// сцена ещё не началась — подсказка клавиш целиком, с «стоп»
			const fresh = VB.create({ server: 'orlando', laws: load('orlando') }).overlay(5);
			Object.assign(fresh, { running: true, server: 'Orlando', wall: Date.now(), keys: { stage: 'Alt+E', back: 'Alt+Shift+E', stop: 'Alt+Shift+S' } });
			w.webContents.send('scene-data', fresh);
			await wait(250);
			const kh = await w.webContents.executeJavaScript("document.getElementById('keyHint').textContent");
			ok(/Alt\+E/.test(kh) && /отмена/.test(kh) && /Alt\+Shift\+S стоп/.test(kh), 'до начала задержания — подсказка клавиш: «' + kh + '»');
			// режим госслужащего — меткой в шапке, видна и в узком окне
			const gb = VB.create({ server: 'orlando', laws: load('orlando') }); gb.setMode({ gov: true });
			const gd = gb.overlay(5); Object.assign(gd, { running: true, server: 'Orlando', wall: Date.now() });
			w.webContents.send('scene-data', gd);
			await wait(250);
			// во время записи режим — переключателями под шапкой (05.11.2026)
			const mt = JSON.parse(await w.webContents.executeJavaScript("JSON.stringify({ bar: document.getElementById('modes').getBoundingClientRect().height > 0, gov: document.querySelector('.mtg[data-mode=gov]').classList.contains('on'), war: document.querySelector('.mtg[data-mode=warrant]').classList.contains('on'), dis: document.querySelector('.mtg[data-mode=gov]').disabled })"));
			ok(mt.bar && mt.gov && !mt.war && !mt.dis, 'во время записи — переключатели «Госслужащий / По ордеру» в шапке, включённый подсвечен');
			const acts0 = acts.length;
			await w.webContents.executeJavaScript("document.querySelector('.mtg[data-mode=warrant]').click(); 1");
			await wait(150);
			ok(acts.slice(acts0).some((a) => a.type === 'mode' && a.mode === 'warrant'), 'щелчок по «По ордеру» — действие в главное окно');
			const gs = gb.overlay(5); Object.assign(gs, { running: false, server: 'Orlando', wall: Date.now() });
			w.webContents.send('scene-data', gs);
			await wait(250);
			const ms = JSON.parse(await w.webContents.executeJavaScript("JSON.stringify({ gov: document.querySelector('.mtg[data-mode=gov]').getBoundingClientRect().width > 0, govOn: document.querySelector('.mtg[data-mode=gov]').classList.contains('on'), war: document.querySelector('.mtg[data-mode=warrant]').getBoundingClientRect().width > 0, dis: document.querySelector('.mtg[data-mode=gov]').disabled })"));
			ok(ms.gov && ms.govOn && !ms.war && ms.dis, 'запись остановлена — переключать нельзя, остался только включённый режим (меткой): ' + JSON.stringify(ms));
			// запись остановлена — короткий итог вместо «Сейчас»
			const sd = scenePayload(200); sd.running = false;
			w.webContents.send('scene-data', sd);
			await wait(250);
			const so = JSON.parse(await w.webContents.executeJavaScript("JSON.stringify({ st: !document.getElementById('stopped').classList.contains('hide'), now: !document.getElementById('now').classList.contains('hide'), s: document.getElementById('stopS').textContent })"));
			ok(so.st && !so.now && /этапов \d+ из \d+/.test(so.s), 'остановлено — итог вместо «Сейчас»: «' + so.s + '»');
			// REC — кнопка записи: остановлено — новая запись; сцена не пустая —
			// первый щелчок переспрашивает («НОВАЯ?»), второй запускает
			const recSt = () => w.webContents.executeJavaScript("JSON.stringify({ c: document.getElementById('rec').className, h: document.getElementById('recH').textContent, t: document.getElementById('rec').title })").then(JSON.parse);
			let a0 = acts.length;
			await w.webContents.executeJavaScript("document.getElementById('rec').click(); 1");
			await wait(120);
			let rs = await recSt();
			ok(acts.length === a0 && /arm/.test(rs.c) && rs.h === 'НОВАЯ?', 'остановлено, сцена не пустая: первый щелчок по REC — «НОВАЯ?», запись не начата');
			await w.webContents.executeJavaScript("document.getElementById('rec').click(); 1");
			await wait(120);
			ok(acts.length === a0 + 1 && acts[a0].type === 'start', 'второй щелчок — новая запись: ' + JSON.stringify(acts.slice(a0)));
			await w.webContents.executeJavaScript("document.getElementById('rec').click(); 1");
			await wait(3300);
			rs = await recSt();
			ok(acts.length === a0 + 1 && !/arm/.test(rs.c) && rs.h === 'ЗАПИСЬ', 'переспрос гаснет сам через 3 с: «' + rs.h + '»');
			const empty = VB.create({ server: 'orlando', laws: load('orlando') }).overlay(0);
			Object.assign(empty, { running: false, server: 'Orlando', wall: Date.now() });
			w.webContents.send('scene-data', empty);
			await wait(250);
			a0 = acts.length;
			await w.webContents.executeJavaScript("document.getElementById('rec').click(); 1");
			await wait(120);
			ok(acts.length === a0 + 1 && acts[a0].type === 'start', 'пустая сцена — запись начинается с одного щелчка');
			w.webContents.send('scene-data', scenePayload(200));
			await wait(250);
			a0 = acts.length;
			await w.webContents.executeJavaScript("document.getElementById('rec').click(); 1");
			await wait(120);
			ok(acts.length === a0 + 1 && acts[a0].type === 'stop', 'запись идёт — щелчок по REC останавливает');
			w.webContents.send('scene-data', sd);
			await wait(250);
			w.webContents.send('scene-data', scenePayload(200));
			await wait(250);
			acts.length = 0;
			await w.webContents.executeJavaScript("document.getElementById('stageBtn').click(); document.getElementById('backBtn').click(); 1");
			await wait(200);
			ok(acts.length === 2 && acts[0].type === 'stage' && acts[0].dir === 1 && acts[1].dir === -1,
				'кнопки «Сделано» и «↶» шлют этап вперёд и назад');
			// ссылка на закон — щелчок просит Protocol открыть статью
			await w.webContents.executeJavaScript("document.getElementById('nowRef').click(); 1");
			await wait(150);
			ok(acts.length === 3 && acts[2].type === 'ref' && acts[2].ref === 'ПК ст.17 п.г', 'щелчок по «ПК ст.17 п.г» — открыть статью: ' + JSON.stringify(acts[2]));
			const beta = await w.webContents.executeJavaScript("getComputedStyle(document.querySelector('#title .beta')).display");
			ok(beta !== 'none', 'плашка BETA в шапке видна и в узком окне');

			// 2) та же сцена через час: срок задержания истёк
			w.webContents.send('scene-data', scenePayload(14 + 3600 + 30));
			await wait(1300);
			r = await probe();
			const det2 = r.timers.find((t) => /задержан/i.test(t.t));
			say('та же сцена через час:');
			ok(det2 && det2.over && /истёк/.test(det2.t), 'срок задержания помечен истёкшим: ' + (det2 && det2.t));

			// уголок размера шлёт новый размер окна
			await w.webContents.executeJavaScript(`(function () {
				var g = document.getElementById('gripC');
				var o = { bubbles: true, button: 0, pointerId: 1, screenX: 300, screenY: 400 };
				g.dispatchEvent(new PointerEvent('pointerdown', o));
				g.dispatchEvent(new PointerEvent('pointermove', Object.assign({}, o, { screenX: 380, screenY: 470 })));
				g.dispatchEvent(new PointerEvent('pointerup', o));
				return 1; })()`);
			await wait(150);
			// окно шлёт смещение от начала жеста, а не размер: свой размер страница
			// с Electron 44 видит с невидимыми краями (+16×8) — main берёт его у окна
			ok(sizes.length === 1 && sizes[0].dw === 80 && sizes[0].dh === 70 && sizes[0].begin === true,
				'уголок шлёт смещение от начала жеста: ' + JSON.stringify(sizes[0]));

			// звук не открылся — окно говорит об этом первым, а не «слушает» тишину
			const fd0 = scenePayload(200); fd0.fault = 'Не слышу: микрофон не открылся (Error 0x800401f0).';
			w.webContents.send('scene-data', fd0);
			await wait(200);
			const fl = await w.webContents.executeJavaScript("JSON.stringify({ shown: !document.getElementById('fault').classList.contains('hide'), text: document.getElementById('fault').textContent, first: document.getElementById('body').firstElementChild.id })");
			const flt = JSON.parse(fl);
			ok(flt.shown && /микрофон не открылся/.test(flt.text) && flt.first === 'fault', 'сбой звука виден в окне первым: «' + flt.text + '»');

			// 3) вся процедура пройдена клавишей: плашка на 5 секунд, потом сводка
			const fin = VB.create({ server: 'orlando', laws: load('orlando') });
			fin.setWall(new Date(2026, 9, 28, 21, 30, 0).getTime());
			for (let g = 0; g < 9; g++) fin.stage(10 + g * 30);
			const fd = fin.overlay(400);
			fd.running = true; fd.server = 'Orlando'; fd.wall = Date.now();
			w.webContents.send('scene-data', fd);
			await wait(400);
			const SUMP = `JSON.stringify({
				banner: !document.getElementById('doneT').classList.contains('hide'),
				now: !document.getElementById('now').classList.contains('hide'),
				askIdle: !document.getElementById('ask').classList.contains('hide') && !document.getElementById('askIdle').classList.contains('hide'),
				noStamps: !document.getElementById('stamps'),
				stripBelow: document.getElementById('strip').getBoundingClientRect().top >= document.getElementById('body').getBoundingClientRect().bottom - 1,
				stripFont: parseFloat(getComputedStyle(document.querySelector('#strip .chip b')).fontSize),
				det: document.getElementById('detT').textContent,
				stop: document.getElementById('rec').title
			})`;
			let f = JSON.parse(await w.webContents.executeJavaScript(SUMP));
			say('процедура пройдена:');
			ok(f.banner && !f.now, 'маленькая плашка «Процедура пройдена» вместо большой карточки');
			ok(f.askIdle, 'главный блок — разговор с адвокатом: «жду вопросов»');
			ok(f.noStamps && f.stripBelow && f.stripFont <= 10,
				'время этапов убрано; полоса «задержан + сроки» — внизу, над подвалом, мелко (' + f.stripFont + ' px)');
			ok(f.det === '21:30:10', 'время задержания в полосе: ' + f.det);
			ok(/Остановить запись/.test(f.stop), 'REC, пока идёт запись, — кнопка остановки: «' + f.stop + '»');
			await wait(5200);
			f = JSON.parse(await w.webContents.executeJavaScript(SUMP));
			ok(!f.banner && f.askIdle, 'через 5 секунд плашка исчезла, блок вопросов остался');

			// адвокат спросил — ответ по записи сразу, ответ ИИ — когда пришёл
			fin.feed({ n: 99, track: 'around', spk: 'S2', t0: 470, t1: 473, text: 'Я адвокат. Когда вы зачитали права моему клиенту?', sure: true });
			const fq = fin.state().questions[0];
			fin.setAiWaiting(fq.id);
			const send = () => { const x = fin.overlay(480); x.running = true; x.server = 'Orlando'; x.wall = Date.now(); w.webContents.send('scene-data', x); };
			send();
			await wait(300);
			const QP = `JSON.stringify({ who: document.getElementById('askWho').textContent, a: document.getElementById('askA').textContent, src: document.getElementById('askSrc').textContent })`;
			let qa = JSON.parse(await w.webContents.executeJavaScript(QP));
			ok(qa.who === 'Адвокат спрашивает' && /21:31/.test(qa.a) && /ИИ уточняет/.test(qa.src),
				'вопрос адвоката: ответ по записи сразу — «' + qa.a + '», ' + qa.src);
			fin.setAi(fq.id, 'Права я зачитал в 21:31, сразу после объявления основания.');
			send();
			await wait(300);
			qa = JSON.parse(await w.webContents.executeJavaScript(QP));
			ok(/зачитал в 21:31/.test(qa.a) && /^ИИ/.test(qa.src), 'пришёл ответ ИИ — он в окне: «' + qa.a + '»');

			// второй вопрос: первый становится серой свёрнутой карточкой, щелчок раскрывает
			fin.feed({ n: 100, track: 'around', spk: 'S2', t0: 490, t1: 493, text: 'Вы предоставили моему клиенту звонок?', sure: true });
			send();
			await wait(300);
			const OP = `JSON.stringify({ cur: document.getElementById('askQ').textContent,
				old: [].map.call(document.querySelectorAll('#qOld .qc'), function (c) { return { open: c.classList.contains('open'),
					h: c.querySelector('.qcA').getBoundingClientRect().height, op: parseFloat(getComputedStyle(c).opacity) }; }) })`;
			let o = JSON.parse(await w.webContents.executeJavaScript(OP));
			ok(/звонок/.test(o.cur) && o.old.length === 1 && !o.old[0].open && o.old[0].h === 0 && o.old[0].op < 0.7,
				'новый вопрос сверху, прошлый — серый и свёрнутый (ответ скрыт)');
			await w.webContents.executeJavaScript("document.querySelector('#qOld .qc').click(); 1");
			await wait(100);
			o = JSON.parse(await w.webContents.executeJavaScript(OP));
			ok(o.old[0].open && o.old[0].h > 0, 'щелчок раскрывает прошлый вопрос с ответом');
			send();
			await wait(200);
			o = JSON.parse(await w.webContents.executeJavaScript(OP));
			ok(o.old[0].open, 'раскрытый остаётся раскрытым при обновлении окна');

			say(fails ? '\nПРОВАЛОВ: ' + fails : '\nокно показывает всё, что должно');
		} catch (err) { fails++; say('  ПРОВАЛ  не смог прочитать окно: ' + err); }
		finish();
	});
});

function finish() {
	const text = out.join('\n') + '\n';
	process.stdout.write(text);
	// Консоль главного процесса Electron на Windows доходит до оболочки не
	// всегда; копия в файле не даст принять пустой вывод за успех.
	try { fs.writeFileSync(path.join(require('os').tmpdir(), 'protocol_overlay_test.txt'), text); } catch (e) { }
	app.exit(fails ? 1 : 0);
}
