/**
 * voice_procedure.js — порядок задержания и сроки из Процессуального кодекса
 * ТОГО сервера, на котором находится игрок.
 *
 * Зачем отдельно. Первая версия разбора сцены держала шаги задержания в коде,
 * одинаковыми для всех. Проверка по базе показала, что это не просто грубо, а
 * местами неверно. В Орландо кодекс требует, чтобы офицер вторым шагом
 * предъявил СВОЁ удостоверение, а личность задержанного устанавливается пятым
 * шагом; зашитый в код шаг «Потребуйте документы» путал одно с другим. В
 * Далласе, Майами и Вашингтоне «доставить в участок» стоит раньше установления
 * личности, а в Орландо — позже. Любой один порядок где-то неверен.
 *
 * Поэтому порядок, обязательность и сроки читаются из кодекса при загрузке
 * базы. Каждый шаг и каждый срок несут дословную строку кодекса и номер
 * статьи — офицер видит, откуда взялось требование, и может назвать статью
 * адвокату. Там, где порядок прочесть не удалось, модуль так и говорит
 * (`source: null`), а не подставляет правдоподобную выдумку.
 *
 * Экспортирует window.VoiceProcedure.read(laws) -> профиль процедуры.
 */
(function () {
	'use strict';

	function low(s) { return String(s || '').toLowerCase().replace(/ё/g, 'е'); }
	function squash(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

	/** Все статьи процессуальных кодексов сервера, с полным текстом. */
	function pkArticles(laws) {
		var out = [];
		(laws || []).forEach(function (law) {
			if (!law || !law.parts) return;
			var isPk = law.short === 'ПК' || /процессуал/i.test(law.title || '');
			if (!isPk) return;
			law.parts.forEach(function (p) {
				(p.chapters || []).forEach(function (ch) {
					(ch.articles || []).forEach(function (a) {
						var text = squash((a.parts || []).map(function (x) {
							return (x.n ? x.n + ' ' : '') + (x.t || '');
						}).join(' '));
						out.push({
							short: law.short || 'ПК', num: String(a.num),
							title: squash(a.title), text: text,
							ref: (law.short || 'ПК') + ' ст.' + a.num
						});
					});
				});
			});
		});
		return out;
	}

	// ── темы шагов ──────────────────────────────────────────────────────────
	// Тема отвечает на два вопроса: как этот шаг узнать в речи офицера и можно
	// ли его пропустить. Текст шага при этом остаётся дословным из кодекса.
	//
	// Регулярные выражения по кириллице пишутся с явными наборами букв: в
	// JavaScript `\w` и `\b` считают словом только латиницу и на русском
	// тексте молча ничего не находят (на этом уже обжигались в voice_brain.js).
	// Начало слова задаётся явно: без этого «доставить» находилось внутри
	// «преДОСТАВИТЬ видеофиксацию», и шаг про прокурора становился доставкой
	// в участок.
	var B = '(?<![а-я])';
	var TOPICS = [
		{ id: 'cuffs', name: 'Наручники', text: new RegExp(B + 'наручник') },
		{ id: 'badge', name: 'Предъявить своё удостоверение',
			text: new RegExp(B + '(свой документ|свое удостоверени|жетон|бейдж|идентифицировать себя|представиться|представляться)') },
		// «Досмотреть документы» — это установление личности, а не обыск,
		// поэтому досмотр считается обыском только когда досматривают человека.
		{ id: 'search', name: 'Первичный обыск',
			text: new RegExp(B + '(обыск|личный досмотр|досмотр[а-я]* (лица|задержанн|подозреваем))') },
		{ id: 'qualify', name: 'Объявить основание',
			text: /разъяснить (квалификац|основани|причин|стат)|объяснить причину|сообщить [а-я ]{0,20}причину|причину, по которой|причину задержания|основания задержания|(огласить|озвучить) [а-я ]{0,30}стат/ },
		{ id: 'miranda', name: 'Правило Миранды', text: /миранд/ },
		{ id: 'ident', name: 'Установить личность задержанного',
			text: /идентификац[а-я]* личност|установ[а-я]* личност|досмотр[а-я]* документ|проверить документы|свер[а-я]* [а-я ]{0,12}фоторобот|снять маску|(закрывающ|скрывающ)[а-я]* лицо|состоит ли [а-я ]{0,30}государственн/ },
		{ id: 'deliver', name: 'Доставить в участок',
			text: new RegExp(B + '(доставить|транспортировк|доставлени)|поместить [а-я ]{0,20}(в кпз|под стражу|в камеру)') },
		{ id: 'lawyer', name: 'Адвокат',
			text: /конфиденциальн[а-я]* (беседу|встречу) с адвокатом|вызвать адвоката|предоставить адвоката/ },
		{ id: 'rights', name: 'Реализовать права задержанного',
			text: /реализова[а-я]*[^.]{0,25}?прав|реализаци[а-я]* прав|прав[а-я]* [а-я ]{0,30}реализова|исполнить прав/ },
		{ id: 'investigate', name: 'Следственные действия',
			text: new RegExp('следственные действия|' + B + 'допрос|экспертиз') }
	];

	/** Темы пункта в порядке появления в тексте: первая — главное действие. */
	function topicsOf(text) {
		var t = low(text), found = [];
		TOPICS.forEach(function (tp) {
			var m = tp.text.exec(t);
			if (m) found.push({ id: tp.id, at: m.index });
		});
		found.sort(function (a, b) { return a.at - b.at; });
		return found.map(function (f) { return f.id; });
	}

	/**
	 * Что должно прозвучать, чтобы пункт считался сделанным.
	 *
	 * Главное действие пункта — первое по тексту: «Доставить … при
	 * необходимости проведения допроса» — это доставка, а не допрос, и
	 * требовать допроса для отметки значило бы никогда её не ставить. Миранда
	 * исключение: если пункт велит её зачитать, это самостоятельная обязанность,
	 * даже когда она идёт второй («разъяснить квалификацию и зачитать Миранду»).
	 */
	function needOf(topics) {
		if (!topics.length) return [];
		var need = [topics[0]];
		if (topics[0] !== 'miranda' && topics.indexOf('miranda') !== -1) need.push('miranda');
		return need;
	}

	// «На усмотрение сотрудника» и «если есть необходимость» — шаг не обязателен,
	// и пропускать его не ошибка. Подсвечивать такой шаг как упущенный значит
	// учить офицера делать лишнее.
	//
	// Смотрим ТОЛЬКО первую фразу пункта. В Орландо пункт «ж» начинается с
	// «Реализовать права задержанного.», а «при необходимости» стоит в третьей
	// фразе и относится к видеофиксации. Проверка по всему тексту объявила
	// реализацию прав необязательной — то есть приложение перестало бы
	// напоминать о ней. Ошибиться в эту сторону хуже, чем в обратную.
	var OPTIONAL = /на усмотрени|если есть необходимост|при необходимост|по возможност|если [а-я ]{0,30}необходим|если это требуется/;
	// Пункт, который сам начинается с условия («В случае, если при гражданине
	// найден дефибриллятор…», «При обнаружении лицензии…»), обязателен только
	// при этом условии. Требовать его в каждой сцене — шум, за которым
	// потеряется настоящее упущение.
	var CONDITIONAL = /^(в случае,? если|в случае|при обнаружени|если )/;

	function isOptional(text) {
		var first = low(text).split(/\.\s|;\s/)[0].trim();
		return OPTIONAL.test(first) || CONDITIONAL.test(first);
	}

	// ── поиск статьи с порядком задержания ──────────────────────────────────
	var ANCHOR = /(последовательност|в следующем порядке|порядок задержания)/;

	/**
	 * Режет текст на пункты. Понимает «а) б) в)» и «1. 2. 3.»/«1) 2) 3)».
	 * Пункты обязаны идти подряд с первого: «а, б, в» — да, «а, в» — нет.
	 * Иначе в список попадали бы буквы из середины чужих перечислений.
	 */
	var LETTERS = 'абвгдежзиклмнопрст';

	function splitItems(text) {
		var best = [];
		// буквенный список
		// буквы бывают и заглавными: «А) … Е)» (Сан-Франциско, ПК ст.17)
		var re = /(^|[\s;:.])([а-тА-Т])\)\s/g, m, marks = [];
		while ((m = re.exec(text))) marks.push({ at: m.index + m[1].length, key: low(m[2]), len: 3 });
		best = pickRun(text, marks, function (i) { return LETTERS[i]; });
		// нумерованный список
		// пробел после номера бывает пропущен: «…лицо. 9.Произвести следственные
		// действия» (Сиэтл) — без этого список обрывался на 8-м пункте и терял
		// реализацию прав; тогда за номером обязана стоять заглавная буква
		var re2 = /(^|[\s;:])(\d{1,2})[.)](?:\s|(?=[А-ЯЁ]))/g, marks2 = [];
		while ((m = re2.exec(text))) marks2.push({ at: m.index + m[1].length, key: m[2], len: m[0].length - m[1].length });
		var num = pickRun(text, marks2, function (i) { return String(i + 1); });
		if (num.length > best.length) best = num;
		// подпункты частей: «ч. 1.1 … ч. 1.2 …» (Детройт держит так шаги
		// внутри стадий; без этого стадия «Начало задержания» была бы одним
		// шагом вместо трёх)
		var re3 = /(^|\s)(ч\.\s?\d+\.(\d{1,2})\s)/g, marks3 = [];
		while ((m = re3.exec(text))) marks3.push({ at: m.index + m[1].length, key: m[3], len: m[2].length });
		// пропуск одного номера допустим: у Сиэтла «8. … 9.Произвести …» — одна
		// строка форума, отдельной «ч. 1.9» нет, а 10 и 11 (права) идут дальше
		var sub = pickRun(text, marks3, function (i) { return String(i + 1); }, false, true);
		if (sub.length > best.length) best = sub;
		return best;
	}

	/**
	 * Пункты частями «ч. 1 … ч. 11» (Атланта: список «1)…11)» парсер разложил
	 * по частям статьи). Серия рвётся на новой «ч. 1»: перед списком стоит
	 * вводная «ч. 1», и без обрыва она заняла бы место первого шага.
	 */
	function partsList(text) {
		// метка части — «ч. 4 Озвучить…»: с пробелом и с заглавной после;
		// ссылка внутри фразы («до п.6) ч.1 статьи 16») так не выглядит и
		// раньше обрывала список Атланты на четвёртом шаге
		var re = /(^|\s)(ч\. (\d{1,2}))\s(?=[А-ЯЁA-Z])/g, m, marks = [];
		while ((m = re.exec(text))) marks.push({ at: m.index + m[1].length, key: m[3], len: m[2].length + 1 });
		return pickRun(text, marks, function (i) { return String(i + 1); }, true);
	}

	function pickRun(text, marks, keyAt, breakOnRestart, allowGap) {
		var bestRun = [];
		for (var s = 0; s < marks.length; s++) {
			if (marks[s].key !== keyAt(0)) continue;
			var run = [marks[s]], want = 1;
			for (var j = s + 1; j < marks.length; j++) {
				if (marks[j].key === keyAt(want)) { run.push(marks[j]); want++; }
				else if (breakOnRestart && marks[j].key === keyAt(0)) break;
				else if (allowGap && marks[j].key === keyAt(want + 1)) { run.push(marks[j]); want += 2; }
			}
			if (run.length > bestRun.length) bestRun = run;
		}
		return bestRun.map(function (mk, i) {
			var end = i + 1 < bestRun.length ? bestRun[i + 1].at : text.length;
			var body = text.slice(mk.at + mk.len, end);
			// хвост последнего пункта часто уходит в примечания и следующие части
			body = body.split(/примечани|исключени|ч\. ?\d+ /i)[0];
			body = squash(body).replace(/[;,.]\s*$/, '');
			if (body.length > 260) body = body.slice(0, 257).replace(/\s+\S*$/, '') + '…';
			return { key: mk.key, text: body };
		});
	}

	/**
	 * Список, который парсер разнёс по отдельным «статьям».
	 *
	 * В Сиэтле статья 17 кончается словами «в следующей последовательности:»,
	 * а пункты «1. Надеть наручники», «2. Представиться»… лежат следом как
	 * статьи 1, 2, 3 с пустым текстом. Это дефект разбора форума (псевдостатьи),
	 * и чинить его надо в парсере. Здесь — только бережный подхват, чтобы
	 * разбор сцены работал на текущей базе: срабатывает, лишь когда статья с
	 * порядком кончается двоеточием, а за ней подряд идут ПУСТЫЕ статьи с
	 * номерами 1, 2, 3… Настоящие статьи с текстом так не выглядят.
	 */
	function strayList(arts, i) {
		var a = arts[i];
		if (!/:\s*$/.test(a.text)) return [];
		var items = [], want = 1;
		for (var k = i + 1; k < arts.length; k++) {
			var n = arts[k];
			var num = parseInt(n.num, 10);
			// Номер должен идти по порядку. Пропуск одного допустим: в Сиэтле
			// парсер слил пункты 8 и 9 в одну «статью», и за 8 сразу идёт 10.
			// Без этого допуска список обрывался и терял последний пункт —
			// «Реализовать права задержанного», ради которого всё и считается.
			if (String(num) !== n.num || num < want || num > want + 1) break;
			// Пункт лежит либо в заголовке (а текста нет), либо в тексте
			// (а заголовка нет). Настоящая статья имеет и то и другое.
			var body = n.text.replace(/^ч\.\s?1\s+/, '').split(/исключени|примечани/i)[0].trim();
			if (n.title && n.text) break;
			var t = n.title || body;
			if (!t || t.length > 420) break;
			items.push({ key: String(num), text: t.replace(/[;,.]\s*$/, '') });
			// Сырой текст пунктов нужен для проверки гибкости порядка: в Сиэтле
			// оговорка «разрешено изменение последовательности» лежит в
			// примечании внутри последнего пункта, а не в самой статье 17.
			items.raw = (items.raw || '') + ' ' + n.title + ' ' + n.text;
			want = num + 1;
		}
		return items;
	}

	/**
	 * Какие пункты кодекс разрешает переставлять МЕЖДУ СОБОЙ.
	 *
	 * Гибкость в кодексах частичная, и это важно. Орландо: «в пунктах а) и б)
	 * … разрешено изменение последовательности» и отдельно «в пунктах в) и г)».
	 * То есть наручники и удостоверение можно поменять местами, обыск и Миранду
	 * тоже, а остальное — строго по порядку. Флажок «порядок можно менять» на
	 * весь список выключил бы предупреждение о реальном нарушении — например,
	 * о доставке в участок раньше установления личности.
	 *
	 * Возвращает группы ключей: [['а','б'], ['в','г']] или [['2',…,'9']].
	 */
	function swapGroups(whole) {
		var groups = [];
		// Левую границу фразы ищем по слову «примечание», а не по точке: точка
		// стоит внутри «ч. 1», и фраза «в пунктах а) и б) ч. 1 и ч. 2 …
		// разрешено» резалась ровно перед нужными буквами.
		var re = /(?:разрешено|допускается)[^.]{0,30}изменени[а-я]* (?:в )?последовательност/g, m;
		while ((m = re.exec(whole))) {
			var back = whole.slice(Math.max(0, m.index - 300), m.index);
			var pn = back.lastIndexOf('примечание');
			var s = (pn >= 0 ? back.slice(pn) : back.slice(-200)) + m[0];
			// «с 2 по 9 пункт»
			var r = /с (\d{1,2}) по (\d{1,2}) пункт/.exec(s);
			if (r) {
				var g = [];
				for (var k = +r[1]; k <= +r[2]; k++) g.push(String(k));
				if (g.length >= 2) groups.push(g);
				continue;
			}
			// «в пунктах в) и г) ч. 1 и пунктах в), г) и д) ч. 2» — берём то, что
			// относится к первой части статьи: именно её порядок мы и читаем
			var head = s.split(/ч\.\s?1(?![0-9.])/)[0];
			var letters = [], lm, lr = /([а-я])\)/g;
			while ((lm = lr.exec(head))) letters.push(lm[1]);
			if (letters.length >= 2) groups.push(letters);
		}
		return groups;
	}

	/**
	 * Список без номеров: шаги через «;».
	 *
	 * У Лос-Анджелеса порядок задержания (ПК ст.4) на форуме — список HTML,
	 * номера которого рисует браузер; в тексте их нет. Вдобавок примечание
	 * посреди списка забрало следующие шаги в свою часть. Но шаг всегда
	 * начинается с глагола в неопределённой форме («Надеть», «Представиться»,
	 * «Вызвать»), а примечания и пояснения — нет («Допускается», «При
	 * запросе», «Также»). Берём самую длинную серию таких фраз; до двух
	 * посторонних фраз подряд серию не рвут — это примечание внутри списка.
	 */
	function verbList(text) {
		// метки частей отделяют фразы; «см. Примечание №2» внутри шага — не метка
		var chunks = text.replace(/(^|\s)(?<!см\.\s)(?:ч\.\s?\d+(?:\.\d+)*|примечание|исключение|пояснение)\s/gi, '$1| ')
			.split(/(?<![сС]м)[;.]\s+(?=[А-ЯЁ|])|\s\|\s/);
		var best = [], run = [], gap = 0;
		chunks.forEach(function (c) {
			c = squash(c.replace(/^\|\s*/, ''));
			var w = low(c.split(/\s/)[0] || '');
			if (/^[а-яё]{3,}(ть|ться|ти)$/.test(w) && !/^(есть|быть)$/.test(w)) {
				var body = c.replace(/[;,.]\s*$/, '');
				if (body.length > 260) body = body.slice(0, 257).replace(/\s+\S*$/, '') + '…';
				run.push({ key: String(run.length + 1), text: body });
				gap = 0;
			} else if (run.length && ++gap > 2) {
				if (run.length > best.length) best = run;
				run = []; gap = 0;
			}
		});
		return run.length > best.length ? run : best;
	}

	function findSequence(arts) {
		var best = null;
		arts.forEach(function (a, i) {
			var whole = low(a.title + ' ' + a.text);
			if (!ANCHOR.test(whole) || !/задержан/.test(whole)) return;
			var anchorAt = low(a.text).search(ANCHOR);
			var from = anchorAt >= 0 ? anchorAt : 0;
			// Список должен быть о задержании, а не о чём-то рядом: в нём обязаны
			// встретиться хотя бы два узнаваемых шага задержания.
			function knownOf(list) {
				var n = 0;
				list.forEach(function (it) { if (topicsOf(it.text).length) n++; });
				return n;
			}
			// Способы прочесть список — по очереди, берётся первый, прошедший
			// проверку. Первым идёт прежний: где порядок уже читался, всё как было.
			// Остальные — для кодексов, где он не читался: части «ч. N»
			// (Атланта; у неё список стоит в тексте раньше слов «порядок
			// задержания», поэтому — и по всему тексту) и шаги без номеров
			// (Лос-Анджелес).
			var tries = [
				function () {
					var it = splitItems(a.text.slice(from));
					if (it.length < 4) {
						it = strayList(arts, i);
						whole += ' ' + low(it.raw || '');
					}
					return it;
				},
				function () { return partsList(a.text.slice(from)); },
				function () { return partsList(a.text); },
				function () { return verbList(a.text.slice(from)); },
				function () { return verbList(a.text); }
			];
			// Прежний способ — если сработал, он и решает. Из новых берётся
			// лучший, а не первый: у Атланты части «ч. N» по срезу находят
			// порядок задержания по ордеру, а по всему тексту — основной.
			var items = [], known = 0;
			for (var t = 0; t < tries.length; t++) {
				var got = tries[t](), k = knownOf(got);
				if (got.length < 4 || k < 2) continue;
				if (!items.length || k * 10 + got.length > known * 10 + items.length) { items = got; known = k; }
				if (t === 0) break;
			}
			if (!items.length) return;
			var score = known * 10 + items.length;
			if (!best || score > best.score) {
				best = { score: score, ref: a.ref, title: a.title, items: items, swaps: swapGroups(whole) };
			}
		});
		return best;
	}

	// ── сроки ───────────────────────────────────────────────────────────────
	// Число с хвостом: «3-х минут», «60 минут», «15 (пятнадцати) минут», «1 часа».
	var NUM = '(\\d{1,3})(?:-?[а-я]{1,3})?\\s*(?:\\([а-я]+\\)\\s*)?';
	var UNIT = '(минут|час|секунд)';

	function toMinutes(n, unit) {
		var v = parseInt(n, 10);
		if (!isFinite(v)) return null;
		if (/^час/.test(unit)) return v * 60;
		if (/^секунд/.test(unit)) return Math.max(1, Math.round(v / 60));
		return v;
	}

	/**
	 * Фраза вокруг совпадения — то, что офицер увидит как источник срока.
	 *
	 * Граница — не только точка: в кодексах права перечисляются через «;» и
	 * «а) б) в)» одной длинной фразой. Резка по точке давала цитату, которая
	 * начиналась за три пункта до нужного и обрывалась раньше самого числа, —
	 * ссылка, которая ничего не подтверждает. Поэтому цитата обязана
	 * содержать совпадение целиком, а режется по ближайшей границе пункта.
	 */
	function sentenceAround(text, idx, len) {
		var head = text.slice(0, idx);
		var cuts = [head.lastIndexOf('. '), head.lastIndexOf('; ')];
		var mk = /\s[а-я]\)\s|\s\d{1,2}[.)]\s/g, m, lastMark = -1;
		while ((m = mk.exec(head))) lastMark = m.index;
		cuts.push(lastMark);
		var start = Math.max.apply(null, cuts);
		start = start < 0 ? 0 : start + 1;
		if (idx - start > 200) start = head.lastIndexOf(' ', idx - 160) + 1;
		var tail = text.slice(idx + len);
		var stop = tail.search(/[.;]/);
		var end = idx + len + (stop === -1 ? Math.min(tail.length, 120) : Math.min(stop + 1, 160));
		return squash(text.slice(start, end));
	}

	/**
	 * Каждый срок ищется своими шаблонами, и берётся ПЕРВОЕ подходящее место в
	 * порядке статей. Шаблоны узкие нарочно: в тех же статьях рядом стоят
	 * другие числа (ограничение свободы журналистами — 15 минут, хранение
	 * записи — 48 часов), и широкий шаблон охотно взял бы чужой срок.
	 */
	var TIMER_RULES = [
		{
			id: 'detention', title: 'Срок задержания', startsOn: ['cuffs', 'qualify'],
			pats: [
				new RegExp('задержани[а-я]*[^.]{0,140}?(?:на срок|сроком)\\s+(?:до|не более)\\s+' + NUM + UNIT),
				new RegExp('(?:прошло|прошл[а-я]*) (?:больше|более)\\s+' + NUM + UNIT + '[а-я]*\\s+с момента (?:фактического )?задержани'),
				new RegExp('задержани[а-я]*[^.]{0,80}?не более\\s+' + NUM + UNIT + '[а-я]*\\s+с момента')
			],
			// Срок задержания журналистами и прочие частные случаи — не наш срок.
			reject: /weazel|журналист|сми/
		},
		{
			id: 'call', title: 'Телефонный звонок', startsOn: ['call'],
			pats: [
				new RegExp('звонк?[а-я]*[^.]{0,90}?(?:не должна превышать|не более|не превышает|длительностью до|продолжительностью не более|до)\\s+' + NUM + UNIT),
				new RegExp('длительност[а-я]* звонка[^.]{0,30}?' + NUM + UNIT)
			]
		},
		// Адвоката ждут дважды: сначала ответа на вызов (у большинства серверов
		// 3 минуты), потом прибытия (обычно 10). Это разные сроки с разными
		// последствиями, и путать их нельзя: «не ответил за 3 минуты» и «не
		// приехал за 10» — два разных повода продолжать без адвоката.
		{
			id: 'lawyerAnswer', title: 'Ответ адвоката', startsOn: ['lawyerCalled'],
			pats: [
				new RegExp('(?:ожидани[а-я]* (?:ответа|принятия)|принятие вызова|ответа (?:от )?адвоката)[^.]{0,60}?(?:составля[а-я]*|не более|до|в течение)\\s+' + NUM + UNIT),
				new RegExp('адвокат[^.]{0,60}?не принял вызов в течение\\s+' + NUM + UNIT),
				new RegExp('ответа от адвоката не последовало в течение\\s+' + NUM + UNIT),
				new RegExp(NUM + UNIT + '[а-я]* для ответа на вызов')
			]
		},
		{
			id: 'lawyerWait', title: 'Прибытие адвоката', startsOn: ['lawyerCalled'],
			pats: [
				new RegExp('адвокат[а-я]*[^.]{0,90}?(?:не приехал|не прибыл|не прибывает|прибыть)[^.]{0,40}?(?:в течение|не позднее)\\s+' + NUM + UNIT),
				new RegExp('ожидани[а-я]* адвоката[^.]{0,50}?(?:до|не более)\\s+' + NUM + UNIT),
				new RegExp('адвокат[^.]{0,120}?(?:время на )?прибыти[ея][^.]{0,20}?(?:составляет|—|–|-)\\s*' + NUM + UNIT)
			]
		},
		{
			id: 'lawyerMeet', title: 'Встреча с адвокатом', startsOn: ['lawyerMeet'],
			pats: [
				new RegExp('встреч[а-я]* с адвокатом[^.]{0,60}?(?:не превышает|не более|не должна превышать|до)\\s+' + NUM + UNIT)
			]
		}
	];

	function findTimers(arts) {
		var out = [];
		TIMER_RULES.forEach(function (rule) {
			for (var i = 0; i < arts.length; i++) {
				var a = arts[i], t = low(a.text), hit = null;
				for (var k = 0; k < rule.pats.length && !hit; k++) {
					var m = rule.pats[k].exec(t);
					if (!m) continue;
					var quote = sentenceAround(a.text, m.index, m[0].length);
					if (rule.reject && rule.reject.test(low(quote))) continue;
					var min = toMinutes(m[1], m[2]);
					if (!min || min > 600) continue;
					hit = { id: rule.id, title: rule.title, minutes: min, startsOn: rule.startsOn,
						ref: a.ref, quote: quote };
				}
				if (hit) { out.push(hit); break; }
			}
		});
		return out;
	}

	// ── задержание госслужащего ─────────────────────────────────────────────
	// Правило есть у всех серверов, но сроки свои у каждого: прокурору на ответ
	// 3, 10 или 15 минут, начальство где-то обязательно, где-то — право
	// офицера (Даллас), вызывают сразу или по прибытии в КПЗ (Майами). Общих
	// чисел нет, поэтому всё читается из кодекса, каждое — с цитатой.
	//
	// Начало ветки ищется по задержанному, а не по словам «государственный
	// служащий»: так в кодексах называют и самого офицера («государственный
	// служащий, проводящий задержание»), и с него ветка начиналась бы не там.
	var GOV_DETAINEE = /(?:задержанн[а-я]*|лиц[а-я]*)[^.]{0,60}(?:является|состоящ[а-я]* на) (?:государственн[а-я]* служащ|государственной служб|сотрудник[а-я]* государственн)|удостоверени[а-я]* государственного сотрудника|(?:задержани[а-я]*|аресте)(?: или аресте| и ареста)? (?:государственн[а-я]* служащ|госслужащ|сотрудник[а-я]* государственн)|уведомлени[а-я]* о задержании/;
	var GOV_NUM = /(\d{1,3}|тр[её]х|три|пяти|пять|десяти|десять|пятнадцати|пятнадцать|двадцати|двадцать)(?:-?[а-я]{1,3})?\s*(?:\([а-я]+\)\s*)?(минут|час)/g;
	var WORD_NUM = { 'трех': 3, 'три': 3, 'пяти': 5, 'пять': 5, 'десяти': 10, 'десять': 10,
		'пятнадцати': 15, 'пятнадцать': 15, 'двадцати': 20, 'двадцать': 20 };
	// Чей срок: прокурора («сотрудник офиса» — тоже он), начальства или обоих
	// сразу («ответа указанных лиц», Орландо и шаблон ст.19).
	var WHO_PROS = /прокур|сотрудник[а-я]* офиса/;
	var WHO_BOSS = /начальств|руководств|руководител|представител[а-я]* администрац/;
	var WHO_BOTH = /указанных лиц/;
	// Какой срок: ответа на вызов или прибытия. Решает ближайшее к числу слово
	// перед ним: «не отреагировал на первый вызов или не прибыл на место в
	// течение 10 минут» (Чикаго) — это срок прибытия. И слово сразу после
	// числа: «срок приостанавливается ещё на 10 минут для прибытия» (Сиэтл).
	var KIND_WAIT = /прибыти|приезд|прибыл|прибыва/g;
	var KIND_ANSWER = /ответ|принят|принял|подтвержд|отреагир/g;

	function lastAt(re, s) {
		var m, at = -1;
		re.lastIndex = 0;
		while ((m = re.exec(s))) at = m.index;
		return at;
	}

	function govWindow(text) {
		var t = low(text);
		var from = t.search(GOV_DETAINEE);
		if (from < 0) return null;
		var w = t.slice(from, from + 12000);
		// дальше начинаются другие случаи: задержание по ордеру (Атланта ч.4) и
		// частный адвокат (Майами ч.10) — у них свои сроки
		var cut = w.search(/задержание по решению суда\/ордер|особое положение|при задержании лица, имеющего действующую лицензию частного адвоката/);
		return { text: cut > 0 ? w.slice(0, cut) : w, raw: squash(text).slice(from, from + (cut > 0 ? cut : 12000)) };
	}

	function govTimes(w) {
		var out = {};
		w.split(/(?<!ч|ст|см|п)[.;]\s+/).forEach(function (sn) {
			var pros = WHO_PROS.test(sn), boss = WHO_BOSS.test(sn), both = WHO_BOTH.test(sn);
			// сроки адвоката живут рядом и на вид такие же
			if (/адвокат/.test(sn) && !pros) return;
			var who = both || (pros && boss) ? ['pros', 'boss'] : pros ? ['pros'] : boss ? ['boss'] : [];
			if (!who.length) return;
			var m;
			GOV_NUM.lastIndex = 0;
			while ((m = GOV_NUM.exec(sn))) {
				var n = /^\d/.test(m[1]) ? parseInt(m[1], 10) : WORD_NUM[m[1].replace('ё', 'е')];
				var min = /^час/.test(m[2]) ? n * 60 : n;
				// «в течение 24 часов направить обращение» — не срок ожидания
				if (!min || min > 30) continue;
				var before = sn.slice(Math.max(0, m.index - 120), m.index);
				var after = sn.slice(m.index + m[0].length, m.index + m[0].length + 25);
				var kind;
				// «время на приезд прокурора после ответа на вызов составляет 10
				// минут» (Атланта) — предмет фразы приезд, хоть «ответ» и ближе
				if (/^\s*(?:[а-я]+\s)?(?:для|на) (?:прибыти|приезд)/.test(after)
					|| /(?:время|срок)[а-я]* (?:на )?(?:приезд|прибыти)/.test(before)
					// «при принятии вызова прокурором … время ожидания составляет
					// 10 минут» (Лас-Вегас): ответ уже был, ждут приезда
					|| /(?:при|после) (?:принятии|подтверждении|ответе)[^,]{0,60}(?:время|срок)[^,]{0,30}$/.test(before)) kind = 'wait';
				else {
					var wa = lastAt(KIND_WAIT, before), an = lastAt(KIND_ANSWER, before);
					if (wa < 0 && an < 0) {
						// «время задержания замораживается, но не более 15 минут»
						// без слова об ответе — это предел ожидания ответа
						if (!/заморажива|приостанавлива/.test(before)) continue;
						kind = 'answer';
					} else kind = wa > an ? 'wait' : 'answer';
				}
				// Срок «указанных лиц» — общий; срок, названный для прокурора
				// отдельно, точнее и его заменяет (Сан-Франциско: ожидание обоих
				// до 10 минут, но прокурор не ответил за 3 — освободить).
				var weak = who.length > 1;
				who.forEach(function (w2) {
					var id = w2 + (kind === 'wait' ? 'Wait' : 'Answer');
					if (!out[id] || (out[id].weak && !weak)) out[id] = { minutes: min, quote: squash(sn), weak: weak };
				});
			}
			// «не прибыл в течение того же срока» (Денвер) — срок ответа и есть
			// срок прибытия
			if (out.prosAnswer && !out.prosWait && pros && /не прибыл[а-я]* в течение того же срока/.test(sn)) {
				out.prosWait = { minutes: out.prosAnswer.minutes, quote: squash(sn) };
			}
		});
		return out;
	}

	/**
	 * Первая фраза окна, подходящая под шаблон, — как цитата. `prefer` — что
	 * в ней желательно (сначала ищется фраза и с ним), `not` — чего быть не
	 * должно: «приостанавливается» о беседе с адвокатом — не та остановка.
	 */
	function quoteOf(w, re, prefer, not) {
		var parts = w.raw.split(/(?<!ч|ст|см|п)[.;]\s+/);
		for (var pass = prefer ? 0 : 1; pass < 2; pass++) {
			for (var i = 0; i < parts.length; i++) {
				var l = low(parts[i]);
				if (!re.test(l) || (not && not.test(l)) || (pass === 0 && !prefer.test(l))) continue;
				// разбор форума иногда делает из числа метку части: «ч. 2.10
				// минут после его принятия…» — метка тут не нужна
				return squash(parts[i]).replace(/^ч\. \d+\.(?=\d+ минут)/, '');
			}
		}
		return '';
	}

	function readGov(arts) {
		var best = null;
		arts.forEach(function (a) {
			var w = govWindow(a.title + ' ' + a.text);
			if (!w || !WHO_PROS.test(w.text)) return;
			var times = govTimes(w.text);
			var score = Object.keys(times).length * 5
				+ (/уведомлени[а-я]* о задержании|государственн[а-я]* служащ/.test(low(a.title)) ? 3 : 0);
			if (!best || score > best.score) best = { score: score, a: a, w: w, times: times };
		});
		if (!best) return null;
		var w = best.w, t = w.text, T = best.times;
		var timers = [];
		function add(id, title, startsOn, stopsOn, list) {
			var parts = list.map(function (k) { return T[k]; }).filter(Boolean);
			if (!parts.length) return;
			var min = parts.reduce(function (s, p) { return s + p.minutes; }, 0);
			var quote = parts.map(function (p) { return p.quote; })
				.filter(function (q, i, all) { return all.indexOf(q) === i; }).join(' … ');
			timers.push({ id: id, title: title, minutes: min, startsOn: startsOn, stopsOn: stopsOn,
				ref: best.a.ref, quote: quote });
		}
		add('prosAnswer', 'Ответ прокурора', ['prosCalled'], ['prosAccepted', 'prosArrived'], ['prosAnswer']);
		add('prosWait', 'Прибытие прокурора', ['prosAccepted'], ['prosArrived'], ['prosWait']);
		// Начальству ответ и прибытие — одним сроком: офицеру важно одно —
		// можно ли продолжать без него, а промежуточного «ответило» в рации
		// голосом не отметить надёжно.
		add('bossWait', 'Ожидание начальства', ['bossCalled'], ['bossArrived'], ['bossAnswer', 'bossWait']);
		return {
			source: best.a.ref, title: best.a.title,
			boss: WHO_BOSS.test(t),
			// Даллас: уведомить начальство — право офицера, а не обязанность
			bossOptional: /уведомлени[а-я]* непосредственного начальника[^.]{0,250}является правом/.test(t),
			when: /по прибытии в кпз|на территории кпз|в кпз или допросн/.test(t) ? 'kpz'
				: /незамедлительно (?:вызвать|уведомл)/.test(t) ? 'now' : null,
			whenQuote: quoteOf(w, /по прибытии в кпз|на территории кпз|незамедлительно (?:вызвать|уведомл)/),
			timers: timers,
			// что будет, если прокурор не ответил или не приехал
			// (именно неявка: «по требованию прокурора подлежит освобождению» —
			// другое правило)
			release: quoteOf(w, /^(?=.*(?:не ответил|не принял|не прибыл|не прибывает|неявк|неприезд|отсутстви[а-я]* ответа|невозможност[а-я]* прибытия|не подтверждается|вызов не принят|не получил ответ|не отреагировал|не поступило ответа|не дает ответа|минут после его принятия))(?=.*(?:подлежит[^.]{0,25}освобожд|освобождается|(?:обязан|необходимо)[^.]{0,40}(?:освободить|отпустить)))/, WHO_PROS, /беседу/),
			// стоит ли срок задержания, пока ждут
			freeze: quoteOf(w, /(?:срок[а-я]*|время|течение)(?: задержания| ожидания)?[^.]{0,20}(?:заморажива|приостанавлива)|процессуальная пауза/, WHO_PROS, /беседу|адвокат/),
			arrestGate: quoteOf(w, /арест государственного служащего[^.]{0,120}только после|переход к процедуре ареста допускается исключительно/)
		};
	}

	// ── когда срок задержания стоит ─────────────────────────────────────────
	// У большинства серверов в статье об освобождении («прошло больше 1 часа»)
	// следом перечислено, на что срок не идёт: «а) проведения допроса; б) вызова
	// и разбирательства с адвокатом; в) … с Офисом Генерального прокурора». Без
	// этого часы задержания врали бы офицеру ровно тогда, когда он ждёт.
	function readFreeze(arts) {
		var out = null;
		arts.forEach(function (a) {
			if (out) return;
			var t = low(a.text);
			var m = /(?:течение срока|срок[а-я]* задержания|время задержания)[^;]{0,120}(?:приостанавлива|заморажива)[а-я]* в случаях:?/.exec(t);
			var ny = /на время ожидания (?:ответа )?(?:от )?адвоката срок задержания (?:замораживается|приостанавливается)(?: на ([0-9]{1,2}) минут)?/.exec(t);
			if (!m && !ny) return;
			out = { ref: a.ref, lawyer: '', pros: '', lawyerCap: null, cap: null, capQuote: '', head: '' };
			if (ny) {
				out.lawyer = sentenceAround(a.text, ny.index, ny[0].length);
				out.lawyerCap = ny[1] ? parseInt(ny[1], 10) : null;
			}
			if (!m) return;
			var raw = squash(a.text).slice(m.index, m.index + 1200);
			out.head = raw.slice(0, m[0].length).replace(/\s*:?\s*$/, '');
			// пункты списка: «б) вызова и разбирательства с адвокатом;»
			raw.slice(m[0].length).split(/;\s*|\.\s+(?=[А-ЯЁ])/).forEach(function (it) {
				var l = low(it);
				if (!out.lawyer && /адвокат/.test(l)) out.lawyer = out.head + ': ' + squash(it);
				if (!out.pros && /прокур/.test(l)) out.pros = out.head + ': ' + squash(it);
			});
			var cap = /общая продолжительность (?:всех )?приостановок[^.]{0,80}?не может превышать\s+(\d{1,3})\s*минут/.exec(low(raw));
			if (cap) {
				out.cap = parseInt(cap[1], 10);
				out.capQuote = sentenceAround(raw, cap.index, cap[0].length);
			}
		});
		return out;
	}

	// ── задержание по ордеру ────────────────────────────────────────────────
	// Исключения для ордера пишут немногие кодексы, и пишут по-разному: в
	// Лос-Анджелесе по ордеру AS нет звонка и адвоката, в Сиэтле офицер
	// «вправе не» вызывать прокурора и не предлагать адвоката. Где кодекс
	// молчит, ордер ничего не меняет — и окно так и говорит, а не отменяет
	// права задержанного по догадке.
	var WARRANT_RULES = [
		{ id: 'noLawyer', re: /(?:в ?праве не предлагать реализацию права на адвоката[^.]{0,120}ордер|ордер[^.]{0,60}не предоставляются права[^.]{0,30}адвокат|права задержанного[^.]{0,80}исключение:? задержание по ордеру)/ },
		{ id: 'noCall', re: /(?:ордер[^.]{0,60}не предоставляются права на телефонный звонок|права задержанного[^.]{0,80}исключение:? задержание по ордеру)/ },
		{ id: 'noPros', re: /(?:в ?праве не вызывать прокурора[^.]{0,80}ордер|не объявлен в розыск по ордеру|ордер[^.]{0,80}сотрудника прокуратуры вызывать не требуется|суда\/ордеру является государственным служащим[^.]{0,80}вызвать начальство)/ },
		{ id: 'noBoss', re: /(?:в ?праве не вызывать прокурора и начальство[^.]{0,80}ордер|не объявлен в розыск по ордеру)/ },
		{ id: 'announce', re: /озвучить[^.]{0,30}(?:наименование )?[^.]{0,20}ордер/ },
		{ id: 'arrestOk', re: /арест государственного служащего[^]{0,250}?исключение:? наличие авторизованного ордера/ }
	];

	function readWarrant(arts, laws) {
		var out = { rules: {}, source: null, miranda: null };
		arts.forEach(function (a) {
			var t = low(a.title + ' ' + a.text);
			if (!/ордер/.test(t)) return;
			WARRANT_RULES.forEach(function (r) {
				if (out.rules[r.id]) return;
				var m = r.re.exec(t);
				if (!m) return;
				var q = sentenceAround(a.title + ' ' + a.text, m.index, m[0].length)
					.replace(/^\d+(?:\.\d+)*\)?\s+/, '').replace(/\s+ч\.$/, '');
				// «вправе не» — можно не делать; «не предоставляются» — нельзя
				out.rules[r.id] = { ref: a.ref, quote: q, may: /в ?праве/i.test(q) };
				if (!out.source) out.source = a.ref;
			});
		});
		// Своя Миранда для ордера (Лос-Анджелес, ПК ст.1.1): короче обычной.
		(laws || []).forEach(function (law) {
			(law.parts || []).forEach(function (p) {
				(p.chapters || []).forEach(function (ch) {
					(ch.articles || []).forEach(function (a) {
						if (out.miranda || !/миранд/i.test(a.title || '') || !/ордер/i.test(a.title || '')) return;
						var body = squash((a.parts || []).map(function (x) { return x.t || ''; }).join(' '));
						var m = /[“«"]\s*(Вы имеете право хранить молчание[^”»"]{10,400})[”»"]/.exec(body);
						if (m) out.miranda = { quote: m[1].trim(), ref: (law.short || '') + ' ст.' + a.num };
					});
				});
			});
		});
		return out;
	}

	// ── общий порядок на случай, когда кодекс его не задаёт ─────────────────
	// Это не выдумка «как правильно», а минимум, который встречается во всех
	// прочитанных кодексах. И окно честно пишет, что порядок общий.
	var FALLBACK = [
		{ key: '1', topics: ['cuffs'], text: 'Надеть наручники' },
		{ key: '2', topics: ['badge'], text: 'Предъявить своё удостоверение' },
		{ key: '3', topics: ['qualify', 'miranda'], text: 'Объявить основание и зачитать права' },
		{ key: '4', topics: ['ident'], text: 'Установить личность задержанного' },
		{ key: '5', topics: ['deliver'], text: 'Доставить в участок' },
		{ key: '6', topics: ['rights'], text: 'Реализовать права задержанного' }
	];

	function read(laws) {
		var arts = pkArticles(laws);
		var seq = findSequence(arts);
		var steps;
		if (seq) {
			steps = seq.items.map(function (it) {
				var tps = topicsOf(it.text);
				return {
					key: it.key, text: it.text, topics: tps, need: needOf(tps),
					optional: isOptional(it.text),
					auto: tps.length > 0
				};
			});
		} else {
			steps = FALLBACK.map(function (f) {
				return { key: f.key, text: f.text, topics: f.topics.slice(), need: f.topics.slice(),
					optional: false, auto: true };
			});
		}
		// Ранг шага: шаги одной группы перестановки делят ранг, остальные идут по
		// порядку. Нарушение порядка — это сделанный шаг с бо́льшим рангом при
		// несделанном обязательном шаге с меньшим.
		var swaps = seq ? seq.swaps : [];
		steps.forEach(function (s, i) { s.rank = i; });
		swaps.forEach(function (g) {
			var idx = steps.map(function (s, i) { return g.indexOf(s.key) !== -1 ? i : -1; })
				.filter(function (i) { return i >= 0; });
			if (idx.length < 2) return;
			var r = Math.min.apply(null, idx);
			idx.forEach(function (i) { steps[i].rank = r; });
		});
		return {
			source: seq ? seq.ref : null,
			sourceTitle: seq ? seq.title : '',
			// Без прочитанного порядка («общий») нарушать нечего: строгий
			// порядок мы бы выдумали сами.
			strict: !!seq,
			swaps: swaps,
			steps: steps,
			timers: findTimers(arts),
			gov: readGov(arts),
			freeze: readFreeze(arts),
			warrant: readWarrant(arts, laws),
			articles: arts.length
		};
	}

	var API = { read: read, topicsOf: topicsOf, TOPICS: TOPICS };
	if (typeof window !== 'undefined') window.VoiceProcedure = API;
	if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
