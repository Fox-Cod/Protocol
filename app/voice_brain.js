/**
 * voice_brain.js — разбор сцены задержания по расшифровке речи.
 *
 * Служба распознавания (voice/protocol_voice.py) отдаёт только текст с
 * временем: она не знает законов и ничего не решает. Всё юридическое — здесь,
 * в приложении, потому что законы уже загружены именно для того сервера, на
 * котором игрок сейчас находится. Один и тот же поступок на разных серверах
 * попадает под разные статьи, и брать их надо из базы, а не из общего знания.
 *
 * Главное правило, унаследованное от остального продукта: приложение не
 * обвиняет. Оно показывает услышанную фразу и статью из базы рядом с ней.
 * Указать не на ту статью хуже, чем не указать ни на какую, поэтому каждый
 * вывод носит с собой источник — фразу и время, — и его видно в окне.
 *
 * Экспортирует window.VoiceBrain.create(opts) -> brain.
 *   brain.vocab()        подсказка распознавателю: слова этого сервера
 *   brain.feed(utt)      подать реплику, вернуть список новых выводов
 *   brain.state()        текущая картина сцены
 *   brain.reset()
 */
(function () {
	'use strict';

	// ── чтение речи ─────────────────────────────────────────────────────────
	function norm(s) {
		return String(s || '').toLowerCase().replace(/ё/g, 'е')
			.replace(/[^а-яa-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
	}
	function words(s) { var n = norm(s); return n ? n.split(' ') : []; }

	/**
	 * Кириллица и регулярные выражения.
	 *
	 * В JavaScript `\w` — это [A-Za-z0-9_], а `\b` считает границу по тому же
	 * набору. На русском тексте они не срабатывают: `придур\w*` не находит
	 * «придурок», а `\b` стоит между каждой парой русских букв. Ошибка тихая —
	 * шаблон просто ничего не находит, и функция выглядит работающей.
	 *
	 * Поэтому границу слова и «хвост словоформы» задаём явно. Текст к этому
	 * моменту уже приведён norm(): только строчные буквы, цифры и пробелы.
	 *   <  начало слова     >  конец слова     @  остаток словоформы
	 */
	var WB = '(?<![а-яa-z0-9])';
	var WE = '(?![а-яa-z0-9])';
	var TAIL = '[а-яa-z0-9]*';

	function rx(src, flags) {
		return new RegExp(String(src).replace(/@/g, TAIL).replace(/</g, WB).replace(/>/g, WE),
			flags || '');
	}

	/**
	 * Сленг. Игроки не говорят «транспортное средство» — говорят «тачка».
	 * Поиск по базе такого не найдёт, поэтому рядом с услышанной фразой
	 * держим её «юридический» перевод. Показываем при этом обе: подменять
	 * сказанное нельзя, иначе в суде офицер процитирует то, чего не звучало.
	 */
	var SLANG = [
		['<(ствол@|пушк@|волын@|шпал@)>', 'огнестрельное оружие'],
		['<(тачк@|тачил@|телег@|корыт@)>', 'транспортное средство'],
		['<(мусор@|мент@|легав@|коп|копы|копов|копа)>', 'сотрудник правоохранительных органов'],
		['<(закрыть|закрою|принять его|упаковать|паковать)>', 'задержать'],
		['<(бабк@|бабл@|нал|кэш|кеш)>', 'денежные средства'],
		['<(шмон@|прошмонать)>', 'обыск'],
		['<(ксив@|корочк@)>', 'удостоверение личности'],
		['<(дурь|трав[аку]|порош@|колес@)>', 'наркотические средства'],
		['<(свистнул|увел|угнал|умыкнул)>', 'угон'],
		['<(развел|разводит|кинул на деньги)>', 'мошенничество'],
		['<(наехал|наезжает)>', 'угроза'],
		['<(стрелк@|разборк@)>', 'вооружённое столкновение'],
		['<(хата|флэт@)>', 'жилое помещение'],
		['<(движ@|движуха)>', 'происшествие']
	].map(function (p) { return { re: rx(p[0], 'g'), to: p[1] }; });

	function deslang(text) {
		var out = norm(text), seen = [];
		SLANG.forEach(function (p) {
			var before = out;
			out = out.replace(p.re, p.to);
			if (out !== before) seen.push(p.to);
		});
		return { text: out, terms: seen };
	}

	// ── что ищем в речи ─────────────────────────────────────────────────────
	// Важно: эти шаблоны применяются к тексту ПОСЛЕ deslang(), где «мент» уже
	// заменён на «сотрудник правоохранительных органов». Адресата это не
	// портит — заменённая форма тоже попадает под OFFICER_WORD.
	var OFFICER_WORD = rx('<(офицер@|сотрудник@|полицейск@|мент@|коп|копа|легав@|мусор@|шериф@)>');
	var SECOND = rx('<(ты|тебя|тебе|тобой|вы|вас|вам|вами|твой|твоя|ваш@)>');
	var THIRD = rx('<(он|она|они|его|ее|их|этот|эта|тот|та)>');

	var INSULT = rx('<(придур@|идиот@|дебил@|тупо[йея]@|кретин@|урод@|козел|козл@|свинь@|твар[ьи]@|скотин@|ничтожеств@|шавк@|падл@|мраз[ьи]@|гнид@|быдл@|ублюд@|сволоч@|поган@)>');
	var MAT = rx('<(бля@|сук[аиу]|суч@|ху[йея]@|хер@|пизд@|[е]бан@|еба@|мудак@|мудил@|пидор@|говн@|дерьм@)>');
	var THREAT = rx('<(убью|убьем|прикончу|застрелю|зарежу|порешу|пожалеешь|размажу|закопаю)>|<(конец тебе|тебе конец|найду тебя|достану тебя)>');
	var DISOBEY = rx('<(не буду|не выйду|не выхожу|не дам|не отдам|не подчинюсь|не пойду|не стану|отказываюсь|никуда не)>');
	var FALSECALL = rx('<(я пошутил|это шутка|вызвал просто так|ложный вызов|никого не было)>');

	var RULES = [
		{ id: 'insult', name: 'оскорбление', pats: [INSULT, MAT] },
		{ id: 'threat', name: 'угроза', pats: [THREAT] },
		{ id: 'disobey', name: 'неповиновение', pats: [DISOBEY] },
		{ id: 'falsecall', name: 'ложный вызов', pats: [FALSECALL] }
	];

	/**
	 * Какая статья этого сервера отвечает признаку.
	 *
	 * Падеж здесь решает всё. «Оскорбление сотрудника» — нужная статья;
	 * «оскорбления сотрудниками представительства СМИ» — совсем другая, и под
	 * свободный шаблон она подходит тоже. Поэтому цель берётся только в
	 * родительном падеже единственного числа и с границей слова.
	 */
	var TITLE_PAT = {
		insult_power: rx('оскорблени@[^.]{0,40}?(представителя власти|государственного служащего|сотрудника|должностного лица|полицейского)>'),
		insult_plain: rx('^оскорбление$|^оскорбление то есть'),
		threat: rx('угроза убийством|угроза а равно'),
		disobey: rx('неповиновение законн@'),
		falsecall: rx('ложн@ вызов')
	};

	// ── процедура: порядок задержания берётся из кодекса сервера ────────────
	// Сами шаги, их порядок, обязательность и сроки читает voice_procedure.js
	// из Процессуального кодекса выбранного сервера. Здесь — только то, как
	// каждую тему шага узнать в речи офицера.
	//
	// Формулировки у всех разные, поэтому шаблоны широкие: лучше отметить шаг
	// по непривычной фразе, чем не отметить вовсе и заставить офицера искать
	// галочку руками посреди сцены.
	var SPEECH = {
		cuffs: rx('<(наручник@|браслет@)>|<руки (за спину|назад)>'),
		badge: rx('<(жетон@|бейдж@|значок)>|служебн@ удостоверени@|<я (офицер|сотрудник|агент|шериф|детектив|сержант|лейтенант|капитан|кадет)>|<(лспд|лссд|фиб|lspd|lssd|fib|sasd)>|<представлюсь>'),
		search: rx('<(обыск@|обыщ@|досмотр@|ощупа@)>|<карман@>'),
		qualify: rx('<(вы задержаны|вы арестованы|задерживаю вас|по подозрению в|основание задержания|за совершение|по статье)>'),
		ident: rx('<(документ@|паспорт@|удостоверение личности|ваше имя|представьтесь|айди)>|<сним@ маск@>|<маск@ сним@>'),
		deliver: rx('<(в участок|в отделение|в департамент|в кпз|в камеру|в тюрьм@|поедем|едем в)>'),
		rights: rx('реализ@ [а-я ]{0,15}прав|<(можете позвонить|хотите позвонить|ваш звонок|нужен адвокат|адвоката будете)>'),
		lawyer: rx('<адвокат@>'),
		investigate: rx('<(допрос@|экспертиз@)>')
	};

	// Миранда без дословного текста в базе: сверять пункты не с чем, поэтому
	// засчитываем по узнаваемому началу и честно пишем, что дословно не сверено.
	var MIRANDA_LOOSE = rx('право хранить молчание');

	// События, с которых начинается отсчёт сроков (сами сроки — из кодекса).
	var EVENTS = {
		call: rx('<(можете позвонить|ваш звонок|звоните|предоставляю звонок|даю вам звонок)>'),
		lawyerCalled: rx('<(вызываю адвоката|вызвал адвоката|адвокат вызван|запросил адвоката|вызову адвоката|запрошу адвоката)>'),
		lawyerMeet: rx('конфиденциальн@|<(беседа с адвокатом|оставлю вас с адвокатом|поговорите с адвокатом)>')
	};

	// События задержания госслужащего — только в этом режиме: «вызываю
	// прокурора» звучит и при обычном задержании (по требованию адвоката), и
	// запускать там сроки госслужащего было бы неправдой.
	var GOV_EVENTS = {
		prosCalled: rx('<(вызываю прокурора|вызвал прокурора|прокурор вызван|запросил прокурора|вызову прокурора|запрошу прокурора|звоню в прокуратуру)>'),
		prosAccepted: rx('<(прокурор принял вызов|прокурор принял|прокурор едет|прокурор в пути|прокурор выехал)>'),
		prosArrived: rx('<(прокурор прибыл|прокурор на месте|прокурор приехал)>'),
		bossCalled: rx('<(вызываю начальство|уведомил начальство|уведомляю начальство|вызвал начальство|запросил начальство|вызываю руководство|уведомил руководство|в рацию департамента)>'),
		bossArrived: rx('<(начальство прибыло|руководство прибыло|начальство на месте|руководство на месте)>')
	};
	// Поздний этап подразумевает ранние: прокурор приехал — значит, и принял
	// вызов. Отмечается только время, сроки ранних этапов задним числом не
	// запускаются.
	var GOV_IMPLIES = { prosAccepted: ['prosCalled'], prosArrived: ['prosCalled', 'prosAccepted'], bossArrived: ['bossCalled'] };

	/**
	 * Действия против произносимого.
	 *
	 * Голосом не видно действий: наручники, обыск и доставку на Majestic делают
	 * через игровое меню, часто молча. Если требовать их «услышать», приложение
	 * будет кричать «упущено» про то, что сделано. Поэтому шаг-действие, через
	 * который сцена уже ушла дальше, считается пройденным молча и тревоги не
	 * поднимает. Тревога — только для того, что обязано прозвучать вслух:
	 * представиться, объявить основание, зачитать права. За это и цепляется
	 * адвокат.
	 */
	var ACTION = { cuffs: true, search: true, deliver: true, investigate: true };

	var TOPIC_TITLE = {
		cuffs: 'Наденьте наручники',
		badge: 'Представьтесь и предъявите удостоверение',
		search: 'Первичный обыск',
		qualify: 'Объявите основание задержания',
		miranda: 'Зачитайте права',
		ident: 'Установите личность задержанного',
		deliver: 'Доставьте в участок',
		rights: 'Предложите реализовать права',
		lawyer: 'Адвокат',
		investigate: 'Следственные действия'
	};

	function procedureModule(opts) {
		if (opts && opts.procedure) return opts.procedure;
		if (typeof window !== 'undefined' && window.VoiceProcedure) return window.VoiceProcedure;
		try { if (typeof require === 'function') return require('./voice_procedure.js'); } catch (e) { }
		return null;
	}

	// ── фабула ──────────────────────────────────────────────────────────────
	// Обстоятельства нельзя взять ни из базы, ни из номера статьи: преступление
	// обычно происходит до приезда офицера. Зато процедура требует произнести
	// основание вслух — и вот оттуда фабула и берётся, как побочный продукт
	// правильно отыгранной сцены.
	var FABULA = /(?:вы задержаны|вы арестованы|задерживаю вас|по подозрению в|за совершение|основание)\s*(.{6,160})/;

	// Служебная обвязка основания. Для показа она нужна — офицер должен видеть
	// фразу целиком, — а для поиска статьи только мешает: «по подозрению»
	// встречается в десятках статей и перетягивает выдачу на себя.
	var FABULA_LEAD = /^(?:по )?(?:подозрению|обвинению)?\s*(?:в|во|за)?\s*/;
	var STOP = ('и в во на с со по за из от до у к о об про что это так вот же бы ли не ни его их'
		+ ' вы вас вам ты тебя мы нам они он она там тут был была было были есть будет а но или'
		+ ' был совершение подозрению обвинению отделения').split(' ');

	// ── вопросы к офицеру ───────────────────────────────────────────────────
	// Мусор распознавания: модель «дописывает» титры из обучающих видео
	// («Субтитры создавал DimaTorzok»). Служба его уже отбрасывает; здесь —
	// на случай старой службы и записи, разобранной ею раньше.
	var HALLU = /субтитр|dimatorzok|торзок|продолжение следует|спасибо за просмотр|подпис[а-яё]+ на (?:наш )?канал|ставьте лайк|amara[.]org/i;

	// ── кто говорит ──
	// Служба различает голоса (S1, S2…), но не знает, кто это. Роль видна из
	// сказанного: адвокат говорит «мой подзащитный», задержанный — «за что
	// меня», офицер — «вы задержаны». Очки копятся по голосу; пока их мало —
	// «Неизвестный». Ошибиться ролью хуже, чем честно не знать.
	var ROLE_CUES = [
		{ role: 'lawyer', w: 3, re: /(?:^| )я (?:ваш |его |ее |государственн[а-я]* |частн[а-я]* )?адвокат|коллеги[а-я]* адвокатов/ },
		{ role: 'lawyer', w: 2, re: /(?:^| )(?:мой|моего|моему|моим|моя|моей|моих) (?:подзащитн|клиент|доверител)/ },
		{ role: 'prosecutor', w: 3, re: /(?:^| )я (?:прокурор|помощник прокурора|из прокуратуры)|офис[а-я]* генеральн[а-я]* прокурор/ },
		{ role: 'detainee', w: 2, re: /(?:^| )(?:я ничего не (?:делал|совершал|нарушал)|я не (?:виноват|делал)|отпусти(?:те)? меня|за что (?:вы )?меня|хочу (?:позвонить|адвоката|сделать звонок)|требую адвоката|мне нужен адвокат|(?:я )?(?:понимаю|понял|поняла) (?:свои |мои )?права|права (?:мне )?понятн)/ },
		// Офицер в живой записи говорит своими словами, а не по шпаргалке:
		// «имеете право на телефонный звонок», «будете реализовывать свои
		// права?», «посмотрю ваши документы», «прижмитесь к обочине» (мегафон).
		{ role: 'officer', w: 2, re: /(?:^| )(?:вы задержаны|вы арестованы|задерживаю вас|имеете право|ваши права|(?:ясны|понятны)[а-я ]{0,12}права|реализ[а-я]* (?:свои |ваши )?прав|руки за спину|предъявите документы|ваши документы|прохлоп[а-я]*|досмотр[а-я]*|прижмитесь к обочине|заглушите двигатель|я (?:офицер|сержант|детектив|лейтенант|шериф|кадет))/ }
	];
	var ROLE_LABEL = { lawyer: 'Адвокат', prosecutor: 'Прокурор', detainee: 'Задержанный', officer: 'Офицер', other: 'Посторонний', unknown: 'Неизвестный' };
	// Роли, которые офицер ставит голосу сам (щелчок по подписи реплики)
	var ROLES_MANUAL = ['officer', 'detainee', 'lawyer', 'prosecutor', 'other'];
	// Подсказка «Задержанный?»: столько ответов сразу после ваших слов задержания
	var REPLY_GAP = 6, REPLY_MIN = 2;

	var QUESTION = /(на каком основании|почему вы|зачем вы|кто вам|вы зачитали|вы предъявили|где ордер|чем это подтверж|в чем (?:именно )?(?:выразилось|проявилось)|что именно|имеете ли вы право|на основании чего)/;

	// О чём спросил адвокат. Ответ собирается из того, что Bodycam записал в
	// этой сцене, — по сути вопроса, а не одной общей справкой: на «когда
	// зачитали права?» отвечают временем прав, а не пересказом основания.
	// Текст здесь уже нормализован: строчные, «ё» → «е», без знаков.
	var ASK = [
		{ id: 'rights', re: /миранд|прав[аы]? (?:были |ему |ей )?(?:зачит|разъясн|оглас)|(?:зачитали|разъяснили|огласили)[а-я ]{0,24}прав/ },
		{ id: 'call', re: /звон|позвонить|телефон/ },
		{ id: 'lawyer', re: /(?:вызвали|вызывали|предоставили|запросили|позвали)[а-я ]{0,20}адвокат|адвокат[а-я]* (?:вызван|предостав|запрош)|право на адвоката/ },
		{ id: 'pros', re: /(?:вызвали|вызывали|уведомили|сообщили|запросили)[а-я ]{0,20}(?:прокурор|начальств|руководств)|(?:прокурор|начальств|руководств)[а-я]* (?:вызван|уведомлен)/ },
		{ id: 'time', re: /сколько (?:времени|минут|уже|он |она |мой |моя )|когда (?:вы )?(?:его |ее )?задерж|время задержани|как долго|срок задержани/ },
		{ id: 'badge', re: /представил|удостоверени|жетон|ваш[аеу]? (?:имя|номер|фамили)|кто вы|назовите себя/ },
		{ id: 'cuffs', re: /наручник|браслет/ },
		{ id: 'search', re: /обыск|досмотр/ },
		{ id: 'basis', re: /основани|за что|почему (?:вы )?(?:его |ее |моего [а-я]+ |мою [а-я]+ )?(?:задерж|аресто)|по как[а-я]+ стать|как[а-я]+ стать|в чем (?:его |ее )?(?:обвиня|подозрева)|что (?:он|она|мой [а-я]+|моя [а-я]+) (?:сделал|совершил)/ }
	];
	var ASKING = /(?:^| )(?:ли|почему|когда|зачем|кто|сколько|как|какой|какая|какие|где|разве|что)(?: |$)/;

	// Ответ ИИ на вопрос адвоката. Тот же инвариант, что во всём продукте:
	// ответ читают вслух посреди сцены, проверять некогда, поэтому «в записи
	// этого нет» всегда лучше правдоподобной выдумки.
	var ANSWER_SYS = [
		'Ты помогаешь полицейскому в ролевой игре GTA-RP (сервер Majestic RP). Идёт разговор после задержания:',
		'адвокат (или прокурор, или сам задержанный) задаёт офицеру вопрос. Подготовь ответ, который офицер прочитает вслух.',
		'Правила:',
		'1. Только факты из записи Bodycam ниже. Ничего не придумывай. Если нужного факта в записи нет — так и скажи',
		'   («в записи этого нет», «не отмечено») и, если уместно, что офицер может сделать сейчас.',
		'2. Номера статей — только из списка «Можно ссылаться», копируй дословно. Реальные законы (РФ, США) не упоминай.',
		'3. Время — как в записи (ЧЧ:ММ).',
		'4. От первого лица офицера, вежливо и твёрдо: 1–3 коротких предложения, без вступлений, без кавычек.',
		'5. На провокацию или вопрос не по делу — коротко и корректно, без оправданий.'
	].join('\n');
	function askTopicOf(low) {
		for (var i = 0; i < ASK.length; i++) if (ASK[i].re.test(low)) return ASK[i].id;
		return null;
	}

	// ────────────────────────────────────────────────────────────────────────
	function flatArticles(laws) {
		var out = [];
		(laws || []).forEach(function (law) {
			(law.parts || []).forEach(function (p) {
				(p.chapters || []).forEach(function (ch) {
					(ch.articles || []).forEach(function (a) { out.push({ law: law, a: a }); });
				});
			});
		});
		return out;
	}

	function cleanTitle(t) {
		return String(t || '').replace(/^[★\s]*/, '').replace(/^\((?:[A-Z]{1,2}\.?\s*)?[A-Z/. ]+\)\s*/, '').trim();
	}

	function buildCatalogue(rows) {
		var cat = {};
		rows.forEach(function (r) {
			var t = cleanTitle(r.a.title), low = norm(t);
			Object.keys(TITLE_PAT).forEach(function (key) {
				if (cat[key]) return;
				if (key === 'insult_plain' && /представител/.test(low)) return;
				if (TITLE_PAT[key].test(low)) {
					cat[key] = { short: r.law.short || '', num: String(r.a.num), title: t, lawId: r.law.id };
				}
			});
		});
		return cat;
	}

	/**
	 * Дословный текст Правила Миранды из кодекса сервера.
	 *
	 * Ищется по смыслу — от «Вы имеете право хранить молчание» до вопроса
	 * «понимаете / ясны ли вам ваши права?», — а не по кавычкам. Поиск по
	 * кавычкам в Сиэтле захватывал кусок между двумя РАЗНЫМИ цитатами, и в
	 * «пункты прав» попадало «Время на принятие вызова адвокатом составляет
	 * 3 минуты». Офицеру предлагалось бы читать это вслух, а права никогда не
	 * засчитывались бы полностью.
	 *
	 * Текст при этом остаётся дословным из кодекса. Где кодекс пересказывает
	 * своими словами («он имеет право хранить молчание…»), формулировки нет, и
	 * сверять нечем — это честный ответ, а не повод подобрать похожее.
	 */
	var MIR_START = /вы имеете право хранить молчание/i;
	var MIR_END = /(понимаете|ясны|понятны)[^.?!]{0,25}прав[а-я]*\s*\?/i;

	function findMiranda(rows) {
		var fallback = null;
		for (var i = 0; i < rows.length; i++) {
			var a = rows[i].a;
			var body = (a.parts || []).map(function (p) { return p.t || ''; }).join(' ');
			var full = ((a.title || '') + ' ' + body).replace(/\s+/g, ' ');
			if (!/миранд/i.test(full)) continue;
			// «Правило Миранды при задержании по ордеру» (Лос-Анджелес, ПК ст.1.1)
			// короче обычного — это текст для режима «по ордеру», не основной
			if (/ордер/i.test(a.title || '')) continue;
			var ref = { short: rows[i].law.short || '', num: String(a.num) };
			var s = full.search(MIR_START);
			if (s !== -1) {
				var tail = full.slice(s, s + 700);
				var e = tail.search(MIR_END);
				if (e !== -1) {
					var end = e + tail.slice(e).match(MIR_END)[0].length;
					return { quote: tail.slice(0, end).trim(), short: ref.short, num: ref.num };
				}
			}
			// запасной путь: цитата в кавычках, но только если в ней есть начало прав
			var m = full.match(/[«"]([^«»"]{80,})[»"]/);
			if (!fallback && m && MIR_START.test(m[1])) {
				fallback = { quote: m[1].trim(), short: ref.short, num: ref.num };
			}
		}
		return fallback;
	}

	// ── сверка пунктов прав ─────────────────────────────────────────────────
	function mirandaPoints(quote) {
		return String(quote).split(/(?<=[.!?])\s+/).map(function (s) { return s.trim(); })
			.filter(function (s) { return words(s).length >= 3; });
	}

	/**
	 * Вес слова тем выше, чем реже оно встречается в других пунктах.
	 * Без этого «право на один телефонный звонок» и «право на адвоката»
	 * неразличимы: пять слов из семи общие, и приложение отметит право,
	 * которого не называли. А это ровно то, за что цепляется адвокат.
	 */
	function pointWeights(pts) {
		var df = {};
		pts.forEach(function (p) {
			var uniq = {};
			words(p).forEach(function (w) { uniq[w] = 1; });
			Object.keys(uniq).forEach(function (w) { df[w] = (df[w] || 0) + 1; });
		});
		var wt = {};
		Object.keys(df).forEach(function (w) { wt[w] = 1 / (df[w] * df[w]); });
		return wt;
	}

	function lcsWeight(pw, tw, wt) {
		var n = pw.length, m = tw.length, i, j;
		var prev = new Array(m + 1).fill(0), cur;
		for (i = 1; i <= n; i++) {
			cur = new Array(m + 1).fill(0);
			for (j = 1; j <= m; j++) {
				cur[j] = pw[i - 1] === tw[j - 1]
					? prev[j - 1] + (wt[pw[i - 1]] || 1)
					: Math.max(prev[j], cur[j - 1]);
			}
			prev = cur;
		}
		return prev[m];
	}

	function pointScore(point, text, wt) {
		var pw = words(point), tw = words(text);
		if (!pw.length || !tw.length) return 0;
		var total = pw.reduce(function (s, w) { return s + (wt[w] || 1); }, 0) || 1;
		return lcsWeight(pw, tw, wt) / total;
	}

	var POINT_OK = 0.72;

	// ────────────────────────────────────────────────────────────────────────
	function create(opts) {
		opts = opts || {};
		var rows = flatArticles(opts.laws || []);
		var cat = buildCatalogue(rows);
		var mir = findMiranda(rows);
		var pts = mir ? mirandaPoints(mir.quote) : [];
		var wt = pointWeights(pts);

		// Сроки ожидания адвоката теряют смысл, когда он прибыл: дальше висел бы
		// «истёк» по сроку, который уже не действует.
		var TIMER_STOPS = { lawyerAnswer: ['lawyerMeet'], lawyerWait: ['lawyerMeet'] };
		// Срок ответа адвоката на вызов записан у половины серверов, и везде он
		// 3 минуты. Где кодекс молчит, офицеру всё равно нужен ориентир —
		// ставим типовой, но честно подписываем, что он не из этого кодекса.
		function withDefaultTimers(list) {
			if (list.some(function (t) { return t.id === 'lawyerAnswer'; })) return list;
			var out = list.slice();
			var at = out.map(function (t) { return t.id; }).indexOf('lawyerWait');
			out.splice(at === -1 ? out.length : at, 0, {
				id: 'lawyerAnswer', title: 'Ответ адвоката', minutes: 3, startsOn: ['lawyerCalled'],
				ref: 'типовой срок',
				quote: 'В кодексе этого сервера срок ответа адвоката на вызов не найден. У серверов, где он записан (Сиэтл, Детройт, Майами, Портленд и др.), — 3 минуты.'
			});
			return out;
		}

		var VPmod = procedureModule(opts);
		var proc = VPmod ? VPmod.read(opts.laws || [])
			: { source: null, sourceTitle: '', strict: false, steps: [], timers: [] };
		// Ветки сцены из того же кодекса: задержание госслужащего, по ордеру и
		// когда срок задержания стоит. Включает их офицер — кнопкой: узнать по
		// голосу, кто перед ним, ненадёжно, а ошибка тут дорогая.
		var GOV = proc.gov || null;
		var WAR = proc.warrant || { rules: {}, source: null, miranda: null };
		var FRZ = proc.freeze || null;

		function shortTitle(need, text) {
			if (need.indexOf('qualify') !== -1 && need.indexOf('miranda') !== -1) return 'Объявите основание и зачитайте права';
			if (need.length && TOPIC_TITLE[need[0]]) return TOPIC_TITLE[need[0]];
			var t = String(text || '').split(/[.;]/)[0];
			return t.length > 60 ? t.slice(0, 57) + '…' : t;
		}

		var st = {
			server: opts.server || '',
			fabula: null,
			// откуда взят порядок: «ПК ст.17» или null — тогда порядок общий
			proc: { source: proc.source, title: proc.sourceTitle || '', strict: !!proc.strict },
			startAt: null,   // когда началось задержание (секунды сцены)
			seen: {},        // тема или событие → когда впервые случилось (адвокат вызван и т.п.)
			voices: {},      // голос службы (S1…) → { n, score:{роль:очки}, first }
			steps: (proc.steps || []).map(function (s, i) {
				var need = (s.need || []).slice();
				return {
					idx: i, id: String(s.key), key: String(s.key),
					title: shortTitle(need, s.text), text: s.text,
					need: need, optional: !!s.optional, optional0: !!s.optional, auto: !!s.auto && need.length > 0,
					rank: s.rank != null ? s.rank : i,
					action: need.length > 0 && ACTION[need[0]] === true,
					ref: proc.source ? (proc.source + ' п.' + s.key) : 'общий порядок',
					done: false, at: null, src: '', manual: false, got: {}
				};
			}),
			timers: withDefaultTimers(proc.timers || []).concat(GOV ? GOV.timers : []).map(function (t) {
				return { id: t.id, title: t.title, minutes: t.minutes, ref: t.ref, quote: t.quote,
					startsOn: t.startsOn || [], stopsOn: t.stopsOn || TIMER_STOPS[t.id] || [],
					startedAt: null, stoppedAt: null, cause: '' };
			}),
			mode: { gov: false, warrant: false },
			wall0: null,     // настенное время начала сцены (мс) — для «задержан в 21:34»
			miranda: {
				available: !!mir,
				ref: mir ? (mir.short + ' ст.' + mir.num) : '',
				points: pts.map(function (p) { return { text: p, done: false, at: null }; })
			},
			hits: [],
			questions: [],
			trace: [],
			line: []
		};

		var seenText = '';   // накопленная речь офицера — для сверки Миранды
		var hitSeq = 0;
		var mirBase = { ref: st.miranda.ref, pts: pts };

		// ── голоса и роли ──
		function learnVoice(spk, low, at) {
			var fresh = !st.voices[spk];
			var v = st.voices[spk] || (st.voices[spk] = { spk: spk, n: 0, score: {}, first: at, replies: 0, hint: '', manual: '' });
			v.n += 1;
			ROLE_CUES.forEach(function (c) {
				if (c.re.test(low)) v.score[c.role] = (v.score[c.role] || 0) + c.w;
			});
			if (fresh) hintArrival(v, at);
			return voiceRole(spk);
		}

		/**
		 * Подсказка роли по ходу сцены — с «?», это догадка, а не вывод.
		 *
		 * Адвоката и прокурора вызывают, и они приезжают: голос, впервые
		 * зазвучавший после вызова и в его окне (ответ + прибытие + 5 минут
		 * запаса), скорее всего тот, кого ждали. Подсказка — только первому
		 * такому голосу: приехать мог и кто-то ещё. Слова («я адвокат») и
		 * роль, поставленная офицером, подсказку перекрывают.
		 */
		function hintArrival(v, at) {
			function win(called, ids) {
				if (called == null || at < called) return false;
				var w = 300;
				ids.forEach(function (id) { var t = timerOf(id); if (t) w += t.minutes * 60; });
				return at - called <= w;
			}
			function taken(role) { return Object.keys(st.voices).some(function (k) { return st.voices[k] !== v && st.voices[k].hint === role; }); }
			var role = '';
			if (st.mode.gov && win(st.seen.prosCalled, ['prosAnswer', 'prosWait']) && !taken('prosecutor')) role = 'prosecutor';
			else if (win(st.seen.lawyerCalled, ['lawyerAnswer', 'lawyerWait']) && !taken('lawyer')) role = 'lawyer';
			if (!role) return;
			v.hint = role;
			trace(at, 'новый голос после вызова — похоже, ' + ROLE_LABEL[role].toLowerCase() + ' (догадка; щелчок по подписи — поправить)', '');
		}

		/**
		 * Подсказка «Задержанный?»: голос, который чаще всех отвечает сразу
		 * после слов задержания офицера (основание, права, наручники) — не
		 * позже REPLY_GAP секунд. Отвечает обычно тот, к кому обращаются.
		 */
		var lastOfficerAt = null;
		function noteReply(v, at) {
			if (lastOfficerAt == null || at < lastOfficerAt || at - lastOfficerAt > REPLY_GAP) return;
			v.replies += 1;
			var best = null;
			Object.keys(st.voices).forEach(function (k) {
				var x = st.voices[k];
				if (x.replies >= REPLY_MIN && (!best || x.replies > best.replies)) best = x;
			});
			Object.keys(st.voices).forEach(function (k) {
				var x = st.voices[k];
				if (x.hint === 'detainee' && x !== best) x.hint = '';
			});
			if (best && !best.hint) {
				best.hint = 'detainee';
				trace(at, 'похоже, задержанный — ' + best.spk + ': отвечает на ваши слова задержания (догадка)', '');
			}
		}

		/** Роль голоса и откуда она: офицер поставил > по словам > догадка по сцене. */
		function voiceRoleInfo(spk) {
			var v = st.voices[spk];
			if (!v) return { role: 'unknown', how: '' };
			if (v.manual) return { role: v.manual, how: 'manual' };
			var best = 'unknown', top = 1;    // одной случайной фразы мало
			Object.keys(v.score).forEach(function (r) {
				if (v.score[r] > top) { best = r; top = v.score[r]; }
			});
			if (best !== 'unknown') return { role: best, how: 'words' };
			if (v.hint) return { role: v.hint, how: 'hint' };
			return { role: 'unknown', how: '' };
		}
		function voiceRole(spk) { return voiceRoleInfo(spk).role; }

		/**
		 * Офицер сам говорит, чей это голос (щелчок по подписи реплики во
		 * вкладке). Это главнее любой догадки, до конца сцены. Прокурор или
		 * адвокат, которых ждали, — значит, приехали: этап отмечается временем
		 * первой фразы этого голоса после вызова. role '' — снять.
		 */
		function setVoiceRole(spk, role) {
			var v = st.voices[spk];
			if (!v || (role && ROLES_MANUAL.indexOf(role) === -1)) return false;
			v.manual = role || '';
			trace(clock, role ? 'голос ' + spk + ' — ' + ROLE_LABEL[role].toLowerCase() + ' (отмечено вами)' : 'роль голоса ' + spk + ' снята', 'ok');
			function firstAfter(t0) {
				var at = null;
				st.line.forEach(function (l) { if (l.spk === spk && l.t0 >= t0 && at == null) at = l.t0; });
				return at == null ? clock : at;
			}
			if (role === 'prosecutor' && st.mode.gov && st.seen.prosCalled != null && st.seen.prosArrived == null && tailHas('prosArrived')) {
				startTimers('prosArrived', firstAfter(st.seen.prosCalled), 'голос отмечен как прокурор');
			}
			if (role === 'lawyer' && st.seen.lawyerCalled != null && st.seen.lawyerMeet == null && tailHas('lawyerMeet')) {
				startTimers('lawyerMeet', firstAfter(st.seen.lawyerCalled), 'голос отмечен как адвокат');
			}
			return true;
		}
		/**
		 * Подпись реплики: «ВЫ» — микрофон; по голосу — роль; без различения
		 * голосов — как раньше, по дорожке. Офицер на звуке игры — напарник
		 * (сам офицер говорит в микрофон), в записи с ПК — сам офицер.
		 */
		function whoOf(track, spk) {
			if (track === 'you') return { role: 'officer', label: 'Вы' };
			if (!spk) return { role: '', label: track === 'mix' ? 'Запись' : 'Вокруг' };
			var ri = voiceRoleInfo(spk), r = ri.role;
			var label = r === 'officer' && track !== 'mix' ? 'Напарник' : ROLE_LABEL[r];
			if (r === 'unknown') label += ' ' + String(spk).replace(/^S/, '');
			// догадка по ходу сцены — с вопросом: подпись не должна выдавать её за факт
			if (ri.how === 'hint') label += '?';
			return { role: r, label: label, how: ri.how, spk: spk };
		}

		function trace(at, text, tone) {
			st.trace.push({ at: at, text: text, tone: tone || '' });
			if (st.trace.length > 200) st.trace.shift();
		}

		/** Похоже ли, что офицер сейчас зачитывает права, а не говорит своими словами. */
		function looksLikeRights(low) {
			for (var i = 0; i < st.miranda.points.length; i++) {
				if (pointScore(st.miranda.points[i].text, low, wt) >= 0.6) return true;
			}
			return false;
		}

		var clock = 0;   // последнее известное время сцены, секунды

		/**
		 * Тема шага прозвучала. Засчитывается ПЕРВОМУ несделанному шагу, которому
		 * она нужна: в Детройте обыск встречается дважды — первичный и
		 * вторичный, — и одно слово «обыск» не должно закрыть оба.
		 * Обязательные шаги идут в очереди раньше необязательных: иначе
		 * «доставить при необходимости» забирало бы себе доставку, а настоящий
		 * пункт «доставить в участок» висел бы невыполненным до конца сцены.
		 */
		// С этого момента действует порядок задержания. Всё, что прозвучало
		// раньше (документы на остановке, «офицер такой-то»), засчитывается, но
		// тревог о нарушенном порядке не порождает: проверить документы до
		// решения задерживать — обычное дело, а не нарушение пункта «д».
		var START_TOPICS = { cuffs: 1, qualify: 1, miranda: 1 };

		function onTopic(topic, at, src) {
			if (START_TOPICS[topic] && st.startAt == null) {
				st.startAt = at;
				trace(at, 'началось задержание — дальше порядок по ' + (st.proc.source || 'общему порядку'), '');
			}
			var target = null, pass, i, s;
			for (pass = 0; pass < 2 && !target; pass++) {
				for (i = 0; i < st.steps.length; i++) {
					s = st.steps[i];
					if (s.done || s.need.indexOf(topic) === -1 || s.got[topic] != null) continue;
					if ((pass === 0) === s.optional) continue;
					target = s; break;
				}
			}
			startTimers(topic, at, src);
			if (!target) return null;
			target.got[topic] = at;
			var complete = target.need.every(function (t) { return target.got[t] != null; });
			if (complete) {
				target.done = true; target.at = at; target.src = src;
				trace(at, target.ref + ' — «' + target.title + '» отмечено по фразе: ' + src, 'ok');
			} else {
				trace(at, target.ref + ' — часть пункта прозвучала («' + (TOPIC_TITLE[topic] || topic)
					+ '»), ждём остального', '');
			}
			return target;
		}

		function startTimers(trigger, at, src) {
			if (st.seen[trigger] == null) st.seen[trigger] = at;
			(GOV_IMPLIES[trigger] || []).forEach(function (e) { if (st.seen[e] == null) st.seen[e] = at; });
			st.timers.forEach(function (t) {
				if (t.startedAt != null && t.stoppedAt == null && t.stopsOn.indexOf(trigger) !== -1) {
					t.stoppedAt = at;
					trace(at, 'отсчёт «' + t.title + '» больше не нужен — остановлен', '');
				}
			});
			st.timers.forEach(function (t) {
				if (t.startedAt != null || t.startsOn.indexOf(trigger) === -1) return;
				t.startedAt = at; t.cause = src;
				trace(at, 'пошёл отсчёт «' + t.title + '»: ' + t.minutes + ' мин по ' + t.ref, 'ask');
			});
		}

		/** Офицер сам подтверждает шаг, который голосом не узнать. */
		function markManual(key) {
			st.steps.forEach(function (s) {
				if (s.key !== String(key) || s.done) return;
				s.done = true; s.manual = true; s.at = clock; s.src = 'отмечено вручную';
				s.need.forEach(function (t) { if (s.got[t] == null) s.got[t] = clock; });
				trace(clock, s.ref + ' — «' + s.title + '» отмечено вручную', 'ok');
			});
		}

		/**
		 * Где сейчас сцена и что пропущено.
		 *
		 * Позиция — самый поздний сделанный шаг. Всё, что раньше и не сделано:
		 *   - действие (наручники, обыск) — «пройдено молча», без тревоги;
		 *   - произносимое — «не прозвучало», с тревогой. Но только если позже
		 *     прозвучал другой ПРОИЗНОСИМЫЙ шаг: брошенное мимоходом «поедем в
		 *     участок» не должно задним числом обвинить весь список выше.
		 * Тревога включается лишь там, где порядок прочитан из кодекса. Общий
		 * порядок мы составили сами, и требовать его соблюдения нечестно.
		 * Шаги одной группы перестановки делят ранг и друг друга не обгоняют.
		 */
		function position() {
			var any = -1, spoken = -1;
			st.steps.forEach(function (s) {
				// Начатый шаг двигает позицию так же, как сделанный. Иначе, пока
				// офицер читает права после «вы задержаны», подсказка продолжала
				// бы твердить «наденьте наручники» — сцена ушла, а курсор нет.
				var times = Object.keys(s.got).map(function (k) { return s.got[k]; });
				if (s.done && s.at != null) times.push(s.at);
				if (!times.length) return;
				// до начала задержания порядок не действует
				if (st.startAt == null || Math.min.apply(null, times) < st.startAt) return;
				if (s.rank > any) any = s.rank;
				if (!s.action && !s.manual && s.rank > spoken) spoken = s.rank;
			});
			return { any: any, spoken: spoken };
		}

		function statusOf(s, pos) {
			if (s.done) return s.manual ? 'manual' : 'done';
			if (s.optional) return 'optional';
			// действие и пункт без узнаваемой темы — пройдены молча, если сцена
			// ушла дальше хоть каким-то шагом
			if (s.action || !s.auto) return s.rank < pos.any ? 'passed' : 'pending';
			// Произносимое двигается только произносимым. Без порядка из кодекса
			// непрозвучавший шаг не «пройден», а просто ещё не сделан: иначе после
			// «предъявите документы» подсказка перепрыгивала непрочитанные права.
			//
			// Начатый, но брошенный шаг — не «не прозвучало». Основание объявлено,
			// два пункта прав прочитаны, потом офицер дал звонок: права не
			// «пропущены», они не дочитаны, и их ещё можно дочитать. Писать такое
			// в «не прозвучало» — неправда, за которой теряется настоящий пропуск.
			if (s.rank < pos.spoken) {
				if (!st.proc.strict) return 'pending';
				return Object.keys(s.got).length ? 'incomplete' : 'missed';
			}
			return 'pending';
		}

		function stepsView() {
			var pos = position();
			return st.steps.map(function (s) {
				return {
					key: s.key, id: s.id, title: s.title, text: s.text, ref: s.ref,
					optional: s.optional, action: s.action, auto: s.auto,
					done: s.done, at: s.at, manual: s.manual, status: statusOf(s, pos),
					partial: !s.done && Object.keys(s.got).length > 0
				};
			});
		}

		function missed() {
			return stepsView().filter(function (s) { return s.status === 'missed'; });
		}

		// Миранду в игре читают своими словами и не целиком. По закону это
		// нарушение, но на практике на него закрывают глаза (решение
		// пользователя 30.10). Поэтому начатые права, после которых сцена пошла
		// дальше, засчитываются прочитанными — со временем, когда их начали.
		// Иначе подсказка твердила бы «дочитайте права» посреди доставки, а
		// ответ адвокату сам подсказывал офицеру «зачитаны частично, 2 из 6».
		function mirandaStartedAt() {
			var t = null;
			st.miranda.points.forEach(function (p) { if (p.done && (t == null || p.at < t)) t = p.at; });
			return t;
		}
		function mirandaStep() {
			for (var i = 0; i < st.steps.length; i++) {
				var s = st.steps[i];
				if (s.need.indexOf('miranda') !== -1 && !s.done && s.got.miranda == null) return s;
			}
			return null;
		}
		function closeMiranda(at, found) {
			var first = mirandaStartedAt(), ms = mirandaStep();
			if (first == null || !ms) return;
			var moved = found.some(function (f) {
				if (f.type !== 'step' || f.topic === 'miranda') return false;
				var s = st.steps.filter(function (x) { return x.key === f.key; })[0];
				return s && s.rank > ms.rank;
			});
			if (!moved) return;
			onTopic('miranda', first, 'права зачитаны своими словами, сцена пошла дальше');
			trace(at, 'права засчитаны: читали не дословно, но сцена пошла дальше', 'ok');
		}

		function mirandaAt() {
			var t = null;
			st.miranda.points.forEach(function (p) { if (p.done && (t == null || p.at > t)) t = p.at; });
			return t;
		}

		// ── оскорбление: кому адресовано, та и статья ──
		function insultArticle(low) {
			var toOfficer = OFFICER_WORD.test(low) || (SECOND.test(low) && !THIRD.test(low));
			var art = toOfficer
				? (cat.insult_power || cat.insult_plain)
				: (cat.insult_plain || cat.insult_power);
			return {
				article: art || null,
				who: toOfficer ? 'в адрес сотрудника' : 'в адрес другого лица',
				downgraded: toOfficer && !cat.insult_power
			};
		}

		function ruleArticle(rule, low) {
			if (rule.id === 'insult') return insultArticle(low);
			var map = { threat: 'threat', disobey: 'disobey', falsecall: 'falsecall' };
			return { article: cat[map[rule.id]] || null, who: '', downgraded: false };
		}

		// ── подсказка распознавателю ──
		function vocab() {
			var bag = {};
			['Правило Миранды', 'задержание', 'представитель власти', 'удостоверение личности',
				'основание задержания', 'адвокат', 'прокурор', 'Процессуальный кодекс'].forEach(function (w) { bag[w] = 1; });
			// Сленг хранится объектами { re, to }. Здесь раньше стояло p[1] — след
			// старого формата-массива: в подсказку распознавателю с сентября уезжало
			// слово «undefined», а сленговых терминов не было ни одного.
			SLANG.forEach(function (p) { bag[p.to] = 1; });
			// названия кодексов этого сервера — модель начинает их слышать
			(opts.laws || []).slice(0, 24).forEach(function (l) {
				if (l && l.short) bag[String(l.short)] = 1;
			});
			var s = Object.keys(bag).join(', ');
			return s.length > 850 ? s.slice(0, 850) : s;
		}

		// ── приём реплики ──
		function feed(u) {
			var found = [];
			var raw = String(u.text || '').trim();
			if (!raw || HALLU.test(raw)) return found;
			var sl = deslang(raw);
			var low = sl.text;
			var item = {
				n: u.n, track: u.track, t0: u.t0, t1: u.t1, spk: u.spk || null,
				text: raw, sure: u.sure !== false, terms: sl.terms, marks: []
			};
			// роль голоса копится по каждой реплике — до разбора, чтобы уже эта
			// фраза («я адвокат задержанного») разбиралась с правильной ролью
			var role = item.spk ? learnVoice(item.spk, low, u.t0) : null;
			if (item.spk && u.track === 'around' && item.sure) noteReply(st.voices[item.spk], u.t0);
			// заговорил прокурор — значит, приехал
			if (role === 'prosecutor' && st.mode.gov && st.seen.prosCalled != null && st.seen.prosArrived == null && tailHas('prosArrived')) {
				startTimers('prosArrived', u.t0, 'голос прокурора');
				trace(u.t0, '«Прокурор прибыл» — слышен его голос', 'ok');
			}
			st.line.push(item);
			if (st.line.length > 600) st.line.shift();

			if (!item.sure) trace(u.t0, 'реплика распознана неуверенно, вывод по ней не делаю', 'warn');
			if (sl.terms.length) trace(u.t0, 'сленг понят как: ' + sl.terms.join(', '));

			if (u.t1 != null && u.t1 > clock) clock = u.t1;
			else if (u.t0 != null && u.t0 > clock) clock = u.t0;

			// 'mix' — временный режим проверки по записи: в видео задержания голос
			// офицера и чужие голоса идут одним звуком, разделить их нечем.
			// Поэтому такая реплика разбирается за обе стороны сразу. Цена —
			// собственный вопрос офицера («ваши документы?») всплывёт как вопрос
			// к нему; для проверки по записи это терпимо, в игре режим не нужен.
			// Когда голоса различаются, это уточняется ролью: известный адвокат
			// или задержанный не отмечает шагов офицера, а офицер (или напарник
			// на звуке игры) — не «совершает» статей и не задаёт вопросов себе.
			var OTHER = { lawyer: 1, prosecutor: 1, detainee: 1 };
			var asOfficer = u.track === 'you' || (u.track === 'mix' && !OTHER[role]) || role === 'officer';
			var asOthers = u.track !== 'you' && role !== 'officer';
			if (asOfficer) {
				// По неуверенно распознанной речи шаги не отмечаются: офицер
				// увидит строку с «?» в ленте, но галочку за неё не получит.
				if (item.sure) {
				// Шаги процедуры.
				//
				// Пока офицер зачитывает права, темы «права», «адвокат» и события
				// звонка не засчитываются. В самой Миранде есть и «телефонный
				// звонок», и «право на адвоката», и наивная проверка отмечала их
				// прямо во время чтения — то есть заявляла, что звонок предоставлен,
				// хотя его только пообещали. Ровно за такую отметку офицер и
				// поплатится в суде.
				var isRights = looksLikeRights(low) || MIRANDA_LOOSE.test(low);
				var MUTED = { rights: 1, lawyer: 1, call: 1, lawyerCalled: 1, lawyerMeet: 1 };
				Object.keys(SPEECH).forEach(function (topic) {
					if (isRights && MUTED[topic]) return;
					if (!SPEECH[topic].test(low)) return;
					var s = onTopic(topic, u.t0, raw);
					if (s) {
						item.marks.push({ type: 'step', label: s.ref.replace(/^.*\s(п\.\S+)$/, '$1') + ' ' + (TOPIC_TITLE[topic] || topic) });
						found.push({ type: 'step', key: s.key, topic: topic });
					}
				});
				Object.keys(EVENTS).forEach(function (ev) {
					if (isRights && MUTED[ev]) return;
					if (EVENTS[ev].test(low)) startTimers(ev, u.t0, raw);
				});
				if (st.mode.gov) Object.keys(GOV_EVENTS).forEach(function (ev) {
					if (st.seen[ev] == null && GOV_EVENTS[ev].test(low) && tailHas(ev)) {
						startTimers(ev, u.t0, raw);
						trace(u.t0, '«' + tailTitle(ev) + '» — отмечено по фразе: ' + raw, 'ok');
					}
				});
				// фабула — из объявленного вслух основания
				if (!st.fabula) {
					var mf = low.match(FABULA);
					if (mf) {
						st.fabula = { text: mf[1].trim(), at: u.t0, said: raw, articles: lookup(mf[1]) };
						item.marks.push({ type: 'fabula', label: 'основание' });
						trace(u.t0, 'обстоятельства взяты из объявленного основания', 'ok');
						found.push({ type: 'fabula' });
					}
				}
				// права — по накопленной речи, фразы часто рвутся между репликами
				if (st.miranda.available) {
					seenText = (seenText + ' ' + raw).slice(-2500);
					var before = st.miranda.points.filter(function (p) { return p.done; }).length;
					st.miranda.points.forEach(function (p) {
						if (p.done) return;
						if (pointScore(p.text, seenText, wt) >= POINT_OK) { p.done = true; p.at = u.t0; }
					});
					var after = st.miranda.points.filter(function (p) { return p.done; }).length;
					if (after > before) {
						item.marks.push({ type: 'right', label: 'права ' + after + '/' + st.miranda.points.length });
						trace(u.t0, 'зачитано прав: ' + after + ' из ' + st.miranda.points.length, 'ok');
						if (after === st.miranda.points.length) onTopic('miranda', u.t0, 'права зачитаны полностью');
						found.push({ type: 'miranda', done: after });
					}
				} else if (MIRANDA_LOOSE.test(low)) {
					// Дословного текста прав в базе нет — сверять пункты не с чем.
					// Засчитываем по узнаваемому началу, но честно помечаем.
					var sm = onTopic('miranda', u.t0, raw);
					if (sm) trace(u.t0, 'права засчитаны по началу фразы: дословного текста в базе этого сервера нет, полноту не сверить', 'warn');
				}
				if (st.miranda.available) closeMiranda(u.t0, found);
				// слова задержания — к ним обращён ответ задержанного
				if (u.track === 'you' && found.some(function (f) { return f.type === 'step' || f.type === 'miranda' || f.type === 'fabula'; })) {
					lastOfficerAt = u.t1 != null ? u.t1 : u.t0;
				}
				} // конец: уверенная реплика офицера
			}
			if (asOthers) {
				// вокруг: статьи, совершённые словами
				if (item.sure) {
					RULES.forEach(function (rule) {
						var hit = rule.pats.some(function (p) { return p.test(low); });
						if (!hit) return;
						var r = ruleArticle(rule, low);
						hitSeq += 1;
						var h = {
							id: 'h' + hitSeq, kind: rule.name, who: r.who, at: u.t0, spk: item.spk,
							phrase: raw, article: r.article, status: 'new',
							note: r.downgraded ? 'у этого сервера нет отдельной статьи за оскорбление сотрудника' : ''
						};
						st.hits.push(h);
						item.marks.push({ type: 'hit', label: rule.name, hid: h.id });
						trace(u.t0, r.article
							? ('признак «' + rule.name + '» → ' + r.article.short + ' ст.' + r.article.num)
							: ('признак «' + rule.name + '», но статьи в базе этого сервера нет'),
							r.article ? 'ok' : 'warn');
						found.push({ type: 'hit', id: h.id });
					});
				}
				// вопрос, на который офицеру придётся отвечать
				// Вопросом к офицеру считается не любая фраза со знаком вопроса.
				// Первая живая запись: «А можете броню кинуть?», «Что?» — игровая
				// болтовня, а окно показывало её как вопрос и тратило на неё ИИ.
				// Берём вопрос, если он про процедуру (основание, права, звонок,
				// адвокат, время…) или его задаёт адвокат либо прокурор.
				var askTopic = askTopicOf(low);
				var asksForm = QUESTION.test(low) || /\?$/.test(raw) || ASKING.test(low);
				var counsel = role === 'lawyer' || role === 'prosecutor';
				if (QUESTION.test(low) || (asksForm && (askTopic || counsel))) {
					var q = { id: 'q' + st.questions.length, at: u.t0, text: raw, spk: item.spk, topic: askTopic || 'basis', answer: null, ai: '', aiState: '', state: 'new' };
					st.questions.push(q);
					item.marks.push({ type: 'question', label: 'вопрос' });
					trace(u.t0, 'похоже на вопрос к офицеру — готовлю ответ', 'ask');
					found.push({ type: 'question', id: q.id });
				}
			}
			return found;
		}

		/**
		 * Ищет статьи по описанию.
		 *
		 * Если приложение дало настоящий движок (BM25 со стеммером), берём его —
		 * он для этого и сделан. Запасной перебор по заголовкам нужен на случай,
		 * когда движка нет, и он намеренно скупой: совпадение считается только
		 * по значимым словам, короткий заголовок выигрывает у длинного, а если
		 * совпало одно случайное слово — лучше не показывать ничего. Ошибочная
		 * статья дороже отсутствующей.
		 */
		function lookup(text) {
			var q = deslang(String(text).replace(FABULA_LEAD, '')).text;
			try {
				if (opts.search) {
					var res = opts.search(q) || [];
					if (res.length) {
						return res.slice(0, 3).map(function (r) {
							return { short: r.short || '', num: String(r.num), title: cleanTitle(r.title) };   // без служебных «★★★ (F/R)»
						});
					}
				}
			} catch (e) { }
			var qw = words(q).filter(function (w) {
				return w.length > 3 && STOP.indexOf(w) === -1;
			});
			if (!qw.length) return [];
			var best = [];
			rows.forEach(function (r) {
				var title = cleanTitle(r.a.title);
				var t = norm(title);
				if (!t) return;
				var sc = 0;
				// Окончание отбрасывается грубо, зато одинаково с обеих сторон:
				// «угоне» и «Угон» должны встретиться, а точного стеммера здесь
				// нет — он живёт в движке поиска, который подставляют сверху.
				qw.forEach(function (w) {
					var stem = w.slice(0, Math.max(4, w.length - 3));
					if (t.indexOf(stem) !== -1) sc += 1;
				});
				if (sc < Math.min(2, qw.length)) return;
				best.push({
					sc: sc / qw.length - Math.min(0.3, t.length / 1200),
					short: r.law.short || '', num: String(r.a.num), title: title
				});
			});
			best.sort(function (a, b) { return b.sc - a.sc; });
			return best.slice(0, 3);
		}

		/**
		 * Заготовка ответа адвокату. Никакой выдумки: ответ собирается из того,
		 * что уже прозвучало в сцене и записано со временем. Если чего-то не
		 * было — так и сказано, потому что офицеру важнее узнать про дыру
		 * сейчас, чем услышать гладкую фразу и попасться на ней в суде.
		 */
		// ── часы ──
		// Время для людей — по часам («в 21:34»), а не «на 3:12 сцены»: его
		// пишут в рапорт и называют адвокату. Без часов — время сцены.
		function setWall(ms) { st.wall0 = ms || null; }
		function clockOf(sec, withSec) {
			if (sec == null) return '';
			if (st.wall0 == null) return mmss(sec);
			var d = new Date(st.wall0 + sec * 1000);
			var p = function (n) { return ('0' + n).slice(-2); };
			return p(d.getHours()) + ':' + p(d.getMinutes()) + (withSec ? ':' + p(d.getSeconds()) : '');
		}
		/** Когда в сцене случилась тема или событие — по шагам, голосу или клавише. */
		function topicAt(topic) {
			var t = null;
			st.steps.forEach(function (s) {
				var v = s.got[topic];
				if (v != null && (t == null || v < t)) t = v;
			});
			if (t == null && st.seen[topic] != null) t = st.seen[topic];
			return t;
		}
		function timerOf(id) { return st.timers.filter(function (t) { return t.id === id; })[0] || null; }

		// ── ответ адвокату ──
		// Собирается из записанного в сцене, по сути вопроса. Только факты и
		// время; чего в сцене не было — так и сказано, с подсказкой, как это
		// закрыть сейчас. Сочинять обстоятельства за офицера нельзя.
		function answerBasis() {
			var out = [];
			if (st.fabula) {
				// основание часто уже начинается с «по подозрению в…» — не повторять
				var fab = String(st.fabula.text).replace(/[.!?…\s]+$/, '');
				out.push('Задержан' + (st.startAt != null ? ' в ' + clockOf(st.startAt) : '') + (/^(по подозрению|за |по статье|в связи)/i.test(fab) ? ' ' : ' по подозрению: ') + fab + '.');
				var a = st.fabula.articles && st.fabula.articles[0];
				if (a) out.push('Квалификация: ' + a.short + ' ст.' + a.num + ' — ' + String(a.title).replace(/[.!?…\s]+$/, '') + '.');
			} else {
				out.push('Основание вслух не объявлялось — объявите сейчас: «Вы задержаны по подозрению в …».');
			}
			var extra = st.hits.filter(function (h) { return h.status !== 'dropped' && h.article; });
			if (extra.length) {
				out.push('В ходе задержания: ' + extra.map(function (h) {
					return h.kind + ' — ' + h.article.short + ' ст.' + h.article.num + ' (' + clockOf(h.at) + ')';
				}).join('; ') + '.');
			}
			return out;
		}
		function answerRights() {
			var all = st.miranda.points.length;
			var done = st.miranda.points.filter(function (p) { return p.done; }).length;
			var at = topicAt('miranda');
			if (all && done === all) return ['Права зачитаны полностью в ' + clockOf(mirandaAt() || at || 0) + '.'];
			// Сколько пунктов «на слух» — не для адвоката: права читают своими
			// словами, и распознанное «2 из 6» значит пересказ, а не пропуск.
			if (at != null) return ['Права зачитаны в ' + clockOf(at) + '.'];
			if (done) return ['Права зачитаны в ' + clockOf(mirandaStartedAt()) + '.'];
			return ['Права ещё не зачитывались — зачитайте сейчас.'];
		}
		function answerCall() {
			var at = st.seen.call != null ? st.seen.call : topicAt('rights');
			var t = timerOf('call');
			if (at != null) return ['Право на звонок предоставлено в ' + clockOf(at) + (t ? ' (' + t.minutes + ' мин по ' + t.ref + ')' : '') + '.'];
			return ['Звонок ещё не предоставлялся' + (t ? ' — по ' + t.ref + ' на него ' + t.minutes + ' мин' : '') + '.'];
		}
		function answerLawyer() {
			var called = st.seen.lawyerCalled, met = st.seen.lawyerMeet;
			if (called != null) {
				var s = 'Адвокат вызван в ' + clockOf(called);
				if (met != null) return [s + ', прибыл в ' + clockOf(met) + '.'];
				var ans = timerOf('lawyerAnswer'), arr = timerOf('lawyerWait');
				var parts = [];
				if (ans) parts.push('ответ — до ' + clockOf(called + ans.minutes * 60));
				if (arr) parts.push('прибытие — до ' + clockOf(called + arr.minutes * 60));
				return [s + (parts.length ? '; ждём: ' + parts.join(', ') : '') + '.'];
			}
			var r = topicAt('rights');
			if (r != null) return ['Право на адвоката предложено в ' + clockOf(r) + '; задержанный адвоката не вызывал.'];
			return ['Адвоката ещё не вызывали — право на него входит в реализацию прав задержанного.'];
		}
		function answerTime() {
			if (st.startAt == null) return ['Время задержания не отмечено.'];
			var t = timerOf('detention');
			if (!t) return ['Задержан в ' + clockOf(st.startAt, true) + '.'];
			var from = t.startedAt != null ? t.startedAt : st.startAt;
			var p = detentionPause(clock, from), parts = [];
			p.all.forEach(function (x) {
				var w = x.why.replace(/^ждём /, 'ожидание ');
				if (parts.indexOf(w) === -1) parts.push(w);
			});
			var stood = p.sec >= 60 ? ' Срок стоял ' + Math.round(p.sec / 60) + ' мин (' + parts.join(', ') + ', ' + p.all[0].ref + ')' : '';
			return ['Задержан в ' + clockOf(st.startAt, true) + '. Срок задержания ' + t.minutes + ' мин по ' + t.ref
				+ (stood ? '.' + stood + ' — до ' : ' — до ') + clockOf(from + t.minutes * 60 + p.sec) + (p.active ? ' и сейчас стоит' : '') + '.'];
		}
		function answerPros() {
			if (!st.mode.gov) return ['Задержанный не отмечен как государственный служащий.'];
			var S = st.seen, out = [];
			if (st.mode.warrant && WAR.rules.noPros) out.push('Задержание по ордеру — прокурора по ' + WAR.rules.noPros.ref + ' не вызывают.');
			else if (S.prosCalled != null) out.push('Прокурор вызван в ' + clockOf(S.prosCalled)
				+ (S.prosAccepted != null && S.prosAccepted !== S.prosArrived ? ', принял вызов в ' + clockOf(S.prosAccepted) : '')
				+ (S.prosArrived != null ? ', прибыл в ' + clockOf(S.prosArrived) : '') + '.');
			else out.push('Прокурор ещё не вызван — вызовите сейчас' + (GOV ? ' (' + GOV.source + ')' : '') + '.');
			if (S.bossCalled != null) out.push('Начальство уведомлено в ' + clockOf(S.bossCalled) + (S.bossArrived != null ? ', прибыло в ' + clockOf(S.bossArrived) : '') + '.');
			return out;
		}
		function answerAt(topic, yes, no) {
			var at = topicAt(topic);
			return [at != null ? yes + ' в ' + clockOf(at) + '.' : no];
		}
		function draftAnswer(q) {
			switch (q && q.topic) {
				case 'rights': return answerRights().join(' ');
				case 'call': return answerCall().join(' ');
				case 'lawyer': return answerLawyer().join(' ');
				case 'time': return answerTime().join(' ');
				case 'pros': return answerPros().join(' ');
				case 'badge': return answerAt('badge', 'Сотрудник представился и предъявил удостоверение', 'Удостоверение не отмечено — представьтесь и предъявите сейчас.').join(' ');
				case 'cuffs': return answerAt('cuffs', 'Наручники надеты при задержании', 'Наручники не отмечены.').join(' ');
				case 'search': return answerAt('search', 'Обыск проведён', 'Обыск не проводился.').join(' ');
			}
			// общий вопрос: основание и права — то, о чём спрашивают первым
			return answerBasis().concat(answerRights()).join(' ');
		}

		// ── сводка: что записал Bodycam ──
		// Компактно, по этапам, с временем по часам. Нужна после процедуры —
		// для разговора с адвокатом и для рапорта.
		var SUM_LABEL = { cuffs: 'Наручники', badge: 'Удостоверение', qualify: 'Основание', miranda: 'Права',
			ident: 'Личность', deliver: 'Доставка', rights: 'Звонок / адвокат', search: 'Обыск', investigate: 'След. действия' };
		function summary() {
			var view = stepsView(), pos = position(), rows = [];
			if (st.startAt != null) rows.push({ k: 'Задержан', v: clockOf(st.startAt, true), tone: 'ok' });
			stageList.forEach(function (g) {
				var topic = g.topics[0], status = stageStatus(g, view, pos);
				var at = topic ? topicAt(topic) : null;
				if (at == null) g.steps.forEach(function (i) { var s = st.steps[i]; if (s.done && s.at != null && (at == null || s.at < at)) at = s.at; });
				var v = '—', tone = 'mute';
				if (status === 'done') { v = at != null ? clockOf(at) : 'да'; tone = 'ok'; }
				else if (status === 'missed') { v = 'не прозвучало'; tone = 'bad'; }
				else if (status === 'incomplete') { v = 'не закончено'; tone = 'warn'; }
				else if (status === 'passed') { v = 'молча'; tone = ''; }
				if (topic === 'miranda' && status !== 'done') {
					var dn = st.miranda.points.filter(function (p) { return p.done; }).length;
					if (dn) { v = dn + ' из ' + st.miranda.points.length; tone = 'warn'; }
				}
				rows.push({ k: SUM_LABEL[topic] || g.title, v: v, tone: tone });
			});
			var S = st.seen;
			if (st.mode.warrant) rows.push({ k: 'Ордер', tone: S.warrantRead != null ? 'ok' : '', v: S.warrantRead != null ? 'назван ' + clockOf(S.warrantRead) : 'задержание по ордеру' });
			if (st.mode.gov) {
				if (tailHas('prosCalled')) rows.push({ k: 'Прокурор', tone: S.prosArrived != null ? 'ok' : S.prosCalled != null ? 'warn' : 'bad',
					v: S.prosCalled == null ? 'не вызван' : 'вызван ' + clockOf(S.prosCalled)
						+ (S.prosAccepted != null && S.prosAccepted !== S.prosArrived ? ', принял ' + clockOf(S.prosAccepted) : '')
						+ (S.prosArrived != null ? ', прибыл ' + clockOf(S.prosArrived) : '') });
				if (tailHas('bossCalled')) rows.push({ k: 'Начальство', tone: S.bossCalled != null ? 'ok' : GOV.bossOptional ? 'mute' : 'bad',
					v: S.bossCalled == null ? 'не уведомлено' : 'уведомлено ' + clockOf(S.bossCalled) + (S.bossArrived != null ? ', прибыло ' + clockOf(S.bossArrived) : '') });
			}
			if (st.seen.lawyerCalled != null) {
				rows.push({ k: 'Адвокат', tone: 'ok', v: 'вызван ' + clockOf(st.seen.lawyerCalled) +
					(st.seen.lawyerMeet != null ? ', прибыл ' + clockOf(st.seen.lawyerMeet) : '') });
			}
			if (st.fabula) {
				var a = st.fabula.articles && st.fabula.articles[0];
				rows.push({ k: 'Обстоятельства', wide: true, tone: '',
					v: st.fabula.text + (a ? ' — ' + a.short + ' ст.' + a.num : '') });
			}
			var heard = st.hits.filter(function (h) { return h.status !== 'dropped'; });
			if (heard.length) {
				rows.push({ k: 'Услышано', wide: true, tone: 'bad', v: heard.map(function (h) {
					return h.kind + (h.article ? ' — ' + h.article.short + ' ст.' + h.article.num : '') + ' (' + clockOf(h.at) + ')';
				}).join('; ') });
			}
			return rows;
		}

		function mmss(t) {
			t = Math.max(0, Math.floor(t || 0));
			return Math.floor(t / 60) + ':' + ('0' + (t % 60)).slice(-2);
		}

		function answerQuestion(id) {
			for (var i = 0; i < st.questions.length; i++) {
				if (st.questions[i].id === id) {
					st.questions[i].answer = draftAnswer(st.questions[i]);
					st.questions[i].state = 'ready';
					return st.questions[i];
				}
			}
			return null;
		}

		/**
		 * Что делать прямо сейчас.
		 *
		 * Шаги перечислены в порядке процедуры, поэтому «следующий» — это просто
		 * первый неотмеченный. Для прав отдельно отдаются НЕПРОЗВУЧАВШИЕ пункты
		 * дословно: посреди сцены офицеру нужен не укор «права не дочитаны», а
		 * текст, который можно прочесть с экрана вслух.
		 */
		// Подсказка под заголовком — зачем этот шаг, если это не очевидно
		var WHY = {
			qualify: 'отсюда же берутся обстоятельства для суда',
			badge: '«сотрудник не представился» — первое, за что цепляется адвокат',
			rights: 'пообещать в правах — не то же самое, что предоставить'
		};

		// ── этапы: очередь, по которой идёт клавиша ──
		//
		// Голосом не узнать, надеты ли наручники и едет ли задержанный в участок:
		// это делается через меню игры, молча. Поэтому офицер ведёт сцену одной
		// клавишей — «сделано то, что показано в „Сейчас“», — а голос подхватывает
		// то, что слышно, и тогда курсор проходит этап сам.
		//
		// Очередь строится из шагов кодекса, с тремя поправками:
		//   - «объявить основание и зачитать Миранду» — два нажатия, а не одно:
		//     это два разных действия, и между ними обычно проходит время;
		//   - необязательные шаги пропускаются — кроме доставки. Кодекс пишет
		//     «доставить при необходимости», но на деле в участок везут почти
		//     всегда, и именно там реализуют права;
		//   - повтор одного и того же действия (в Орландо «доставить» встречается
		//     дважды, в Сиэтле дважды «установить личность») — один этап.
		// После процедуры — адвокат: вызван, прибыл. От этих нажатий идут сроки.
		var LAWYER_STAGES = [
			{ id: 'lawyerCalled', title: 'Вызовите адвоката, если просит',
				hint: 'нажмите, когда вызвали — пойдёт срок ожидания; не нужен — нажмите и так' },
			{ id: 'lawyerMeet', title: 'Беседа с адвокатом',
				hint: 'нажмите, когда адвокат прибыл — пойдёт срок беседы; его вопросы — ниже' }
		];
		var STAGE_TITLE = { qualify: 'Объявите основание задержания', miranda: 'Зачитайте права' };

		/**
		 * Этапы после процедуры кодекса — события, а не шаги: ордер назван,
		 * прокурор вызван, принял вызов, прибыл, начальство уведомлено, адвокат.
		 * Набор зависит от режимов сцены (госслужащий, по ордеру), поэтому
		 * собирается заново при каждом обращении.
		 *
		 * Прокурора и начальство кодексы велят вызывать «незамедлительно» или
		 * «по прибытии в КПЗ»; этапы стоят после процедуры, и та же клавиша
		 * отмечает их по очереди — офицер вызывает обоих и ждёт.
		 */
		function tailStages() {
			var out = [], war = st.mode.warrant ? WAR.rules : {};
			function ev(id, title, hint, ref, text) { out.push({ id: id, title: title, hint: hint, ref: ref || '', text: text || '', kind: 'event' }); }
			if (war.announce) ev('warrantRead', 'Назовите ордер задержанному', 'по требованию — и статьи из него', war.announce.ref, war.announce.quote);
			if (st.mode.gov && GOV) {
				var when = GOV.when === 'now' ? ' · по кодексу — сразу' : GOV.when === 'kpz' ? ' · по кодексу — по прибытии в КПЗ' : '';
				var pros = !war.noPros, boss = GOV.boss && !war.noBoss;
				if (pros) ev('prosCalled', 'Вызовите прокурора', 'телефон → «Правительство» → «Прокурор»' + when, GOV.source, GOV.whenQuote || GOV.title);
				if (boss) ev('bossCalled', 'Уведомите начальство задержанного',
					'рация департамента' + (GOV.bossOptional ? ' · по кодексу это право, а не обязанность' : ''), GOV.source, '');
				if (pros) {
					ev('prosAccepted', 'Прокурор принял вызов', 'нажмите, когда ответил — пойдёт срок прибытия', GOV.source, '');
					ev('prosArrived', 'Прокурор прибыл', 'покажите доказательства и запись — решение за ним', GOV.source,
						GOV.arrestGate && !war.arrestOk ? GOV.arrestGate : '');
				}
				if (boss) ev('bossArrived', 'Начальство прибыло', 'не приехало в срок — уведомить иначе и продолжать', GOV.source, '');
			}
			// По ордеру AS в Лос-Анджелесе адвоката нет совсем; в Сиэтле его
			// «вправе не предлагать» — этап остаётся, с пометкой.
			if (!(war.noLawyer && !war.noLawyer.may)) {
				LAWYER_STAGES.forEach(function (l) {
					var hint = l.hint;
					if (war.noLawyer && l.id === 'lawyerCalled') hint = 'по ордеру можно не предлагать (' + war.noLawyer.ref + ') · ' + hint;
					out.push({ id: l.id, title: l.title, hint: hint, ref: '', text: '', kind: 'lawyer' });
				});
			}
			return out;
		}
		function tailHas(id) { return tailStages().some(function (l) { return l.id === id; }); }
		function tailTitle(id) { var l = tailStages().filter(function (x) { return x.id === id; })[0]; return l ? l.title : id; }

		var stageList = buildStages();
		function buildStages() {
			var out = [], bySig = {};
			st.steps.forEach(function (s, i) {
				if (s.optional && s.need.indexOf('deliver') === -1) return;
				var split = s.need.length > 1 && s.need.indexOf('miranda') !== -1;
				var groups = split ? s.need.map(function (t) { return [t]; }) : [s.need.slice()];
				groups.forEach(function (topics) {
					var sig = topics.length ? topics.join('+') : '#' + s.key;
					if (bySig[sig]) { bySig[sig].steps.push(i); return; }
					var g = { id: s.key, topics: topics, steps: [i],
						title: (topics.length === 1 && STAGE_TITLE[topics[0]]) || s.title };
					bySig[sig] = g;
					out.push(g);
				});
			});
			return out;
		}

		function stageDone(g) {
			return g.steps.some(function (i) {
				var s = st.steps[i];
				return s.done || (g.topics.length > 0 && g.topics.every(function (t) { return s.got[t] != null; }));
			});
		}
		// По какому шагу судить о статусе: обязательный важнее «при необходимости»
		function stagePrimary(g) {
			for (var k = 0; k < g.steps.length; k++) if (!st.steps[g.steps[k]].optional) return g.steps[k];
			return g.steps[0];
		}
		function stageStatus(g, view, pos) {
			if (stageDone(g)) return 'done';
			var i = stagePrimary(g), s = st.steps[i];
			if (!s.optional) return view[i].status;
			return s.action && s.rank < pos.any ? 'passed' : 'pending';
		}
		function stageStarted(g) {
			if (g.topics.indexOf('miranda') !== -1 && st.miranda.points.some(function (p) { return p.done; })) return true;
			// «Вы задержаны» уже прозвучало — значит, и Миранда того же пункта
			// начата: её очередь первая, иначе подсказка уходила бы назад, к
			// удостоверению, посреди объявления основания
			return g.steps.some(function (i) { return Object.keys(st.steps[i].got).length > 0; });
		}

		/** Этапы со статусами — для полоски прогресса. */
		function stagesView() {
			var view = stepsView(), pos = position();
			var list = stageList.map(function (g) {
				return { id: g.id, title: g.title, status: stageStatus(g, view, pos) };
			});
			tailStages().forEach(function (l) {
				list.push({ id: l.id, title: l.title, status: st.seen[l.id] != null ? 'done' : 'pending' });
			});
			return list;
		}

		function nextAction() {
			var view = stepsView(), pos = position();
			// Сначала довести начатое — и то, что начато и брошено, — потом
			// браться за следующее. Недочитанные права важнее доставки в участок.
			var cand = [];
			stageList.forEach(function (g, n) {
				var status = stageStatus(g, view, pos);
				// пройденное молча и непрозвучавшее сюда не идут: первое не
				// требует действий, второе висит в «не прозвучало» с кнопкой
				if (status !== 'pending' && status !== 'incomplete') return;
				cand.push({ g: g, n: n, status: status, started: stageStarted(g) });
			});
			cand.sort(function (a, b) { return (a.started ? 0 : 1) - (b.started ? 0 : 1) || a.n - b.n; });
			var tail = tailStages();
			var total = stageList.length + tail.length;
			if (cand.length) {
				var c = cand[0], g = c.g, i = stagePrimary(g), s = st.steps[i];
				var lines = [];
				if (g.topics.indexOf('miranda') !== -1 && st.miranda.available) {
					st.miranda.points.forEach(function (x) { if (!x.done) lines.push(x.text); });
				}
				// Шаги, которые кодекс разрешает переставлять, показываем вместе:
				// офицер не должен думать, что нарушил порядок, начав с другого.
				var mates = stageList.filter(function (o) {
					if (o === g) return false;
					var p = st.steps[stagePrimary(o)];
					return p.rank === s.rank && !p.optional && stageStatus(o, view, pos) === 'pending';
				}).map(function (o) { return o.title.toLowerCase(); });
				var hint = WHY[g.topics[0]] || '';
				if (mates.length) hint = 'в любом порядке с: ' + mates.join(', ') + (hint ? ' · ' + hint : '');
				// права начаты — просить дочитать, а не начать
				var title = g.title;
				if (g.topics.indexOf('miranda') !== -1) {
					title = st.miranda.points.some(function (x) { return x.done; }) ? 'Дочитайте права' : 'Зачитайте права';
				}
				if (c.status === 'incomplete') hint = 'начато и брошено — ещё можно доделать' + (hint ? ' · ' + hint : '');
				return {
					id: g.id, stage: c.n + 1, stages: total, kind: 'step',
					title: title, hint: hint, lines: lines,
					ref: s.ref, text: s.text, action: s.action
				};
			}
			for (var k = 0; k < tail.length; k++) {
				var l = tail[k];
				if (st.seen[l.id] != null) continue;
				var tm = st.timers.filter(function (t) { return t.startsOn.indexOf(l.id) !== -1; })[0];
				return {
					id: l.id, stage: stageList.length + k + 1, stages: total, kind: l.kind,
					title: l.title, hint: l.hint + (tm ? ' (' + tm.minutes + ' мин по ' + tm.ref + ')' : ''),
					lines: [], ref: tm ? tm.ref : l.ref, text: l.text || (tm ? tm.quote : ''), action: true
				};
			}
			return { id: 'done', stage: total, stages: total, kind: 'done', title: 'Процедура пройдена', ref: st.proc.source || '',
				hint: 'всё, что требует кодекс, прозвучало или отмечено', lines: [], text: '' };
		}

		// Отмена ошибочного нажатия: состояние до него целиком. Голос мог что-то
		// отметить после нажатия — отмена снимет и это, но отменяют сразу, а не
		// через пять минут.
		var undo = [];
		function snapshot() {
			return JSON.stringify({
				startAt: st.startAt, seen: st.seen,
				steps: st.steps.map(function (s) { return { done: s.done, at: s.at, src: s.src, manual: s.manual, got: s.got }; }),
				timers: st.timers.map(function (t) { return { startedAt: t.startedAt, stoppedAt: t.stoppedAt, cause: t.cause }; })
			});
		}

		/**
		 * Клавиша этапа: «сделано то, что сейчас в „Сейчас“». Возвращает, что
		 * отмечено, — или null, если отмечать нечего.
		 */
		function stage(at) {
			at = at == null ? clock : at;
			if (at > clock) clock = at;
			var n = nextAction();
			if (n.kind === 'done') return null;
			undo.push(snapshot());
			if (undo.length > 40) undo.shift();
			var src = 'клавиша этапа';
			if (st.startAt == null) {
				st.startAt = at;
				trace(at, 'началось задержание (клавиша) — дальше порядок по ' + (st.proc.source || 'общему порядку'), '');
			}
			if (n.kind !== 'step') {
				startTimers(n.id, at, src);
				trace(at, '«' + n.title + '» — отмечено клавишей', 'ok');
				return n;
			}
			var g = null;
			stageList.forEach(function (x) { if (x.id === n.id && !stageDone(x) && !g) g = x; });
			if (!g) return null;
			g.steps.forEach(function (i) {
				var s = st.steps[i];
				g.topics.forEach(function (t) { if (s.got[t] == null) s.got[t] = at; });
				if (!s.done && s.need.every(function (t) { return s.got[t] != null; })) {
					s.done = true; s.manual = true; s.at = at; s.src = src;
				}
			});
			g.topics.forEach(function (t) { startTimers(t, at, src); });
			trace(at, st.steps[stagePrimary(g)].ref + ' — «' + n.title + '» отмечено клавишей', 'ok');
			return n;
		}

		function stageBack() {
			if (!undo.length) return false;
			var p = JSON.parse(undo.pop());
			st.startAt = p.startAt; st.seen = p.seen;
			p.steps.forEach(function (x, i) {
				var s = st.steps[i];
				s.done = x.done; s.at = x.at; s.src = x.src; s.manual = x.manual; s.got = x.got;
			});
			p.timers.forEach(function (x, i) { st.timers[i].startedAt = x.startedAt; st.timers[i].stoppedAt = x.stoppedAt; st.timers[i].cause = x.cause; });
			trace(clock, 'последнее нажатие отменено', 'warn');
			return true;
		}

		/**
		 * Когда срок задержания стоит. Окна — из кодекса: ожидание прокурора и
		 * начальства (режим «госслужащий»), вызов и беседа с адвокатом. Окно
		 * закрывается приездом, а если его нет — сроком, после которого ждать
		 * уже нельзя: прокурор не ответил вовремя — задержанного освобождают,
		 * и часы задержания дальше не стоят.
		 */
		function pauseWindows(now) {
			var out = [], S = st.seen;
			function tmin(id) { var t = timerOf(id); return t ? t.minutes * 60 : null; }
			if (st.mode.gov && GOV && (GOV.freeze || (FRZ && FRZ.pros))) {
				var c = S.prosCalled != null ? S.prosCalled : S.bossCalled;
				if (c != null) {
					var end = S.prosCalled != null ? S.prosArrived : S.bossArrived, ans = tmin('prosAnswer'), wt2 = tmin('prosWait');
					if (end == null) end = now;
					if (S.prosCalled != null) {
						if (S.prosAccepted == null && ans != null) end = Math.min(end, S.prosCalled + ans);
						if (S.prosAccepted != null && wt2 != null) end = Math.min(end, S.prosAccepted + wt2);
					} else if (tmin('bossWait') != null) end = Math.min(end, S.bossCalled + tmin('bossWait'));
					out.push({ a: c, b: end, why: S.prosCalled != null ? 'ждём прокурора' : 'ждём начальство',
						ref: GOV.freeze ? GOV.source : FRZ.ref, quote: GOV.freeze || FRZ.pros });
				}
			}
			var noLaw = st.mode.warrant && WAR.rules.noLawyer && !WAR.rules.noLawyer.may;
			if (FRZ && FRZ.lawyer && !noLaw && S.lawyerCalled != null) {
				var e = S.lawyerMeet != null ? S.lawyerMeet + (tmin('lawyerMeet') || 0) : now;
				if (S.lawyerMeet == null && tmin('lawyerAnswer') != null && tmin('lawyerWait') != null)
					e = Math.min(e, S.lawyerCalled + tmin('lawyerAnswer') + tmin('lawyerWait'));
				if (FRZ.lawyerCap) e = Math.min(e, S.lawyerCalled + FRZ.lawyerCap * 60);
				out.push({ a: S.lawyerCalled, b: Math.min(e, now),
					why: S.lawyerMeet != null && now >= S.lawyerMeet ? 'беседа с адвокатом' : 'ждём адвоката',
					ref: FRZ.ref, quote: FRZ.lawyer });
			}
			return out;
		}

		/** Сколько секунд срок задержания стоял к моменту now и стоит ли сейчас. */
		function detentionPause(now, from) {
			var w = pauseWindows(now).map(function (x) {
				return { a: Math.max(x.a, from), b: Math.min(x.b, now), why: x.why, ref: x.ref, quote: x.quote };
			}).filter(function (x) { return x.b > x.a; }).sort(function (x, y) { return x.a - y.a; });
			var sec = 0, edge = -Infinity, cur = null;
			w.forEach(function (x) {
				var a = Math.max(x.a, edge);
				if (x.b > a) { sec += x.b - a; edge = x.b; }
				if (x.b >= now) cur = x;
			});
			// Даллас: «общая продолжительность всех приостановок … не может
			// превышать 45 минут»
			if (FRZ && FRZ.cap && sec > FRZ.cap * 60) { sec = FRZ.cap * 60; cur = null; }
			return { sec: sec, active: cur, all: w };
		}

		/** Сроки на момент now (секунды сцены): сколько осталось. */
		function timersAt(now) {
			now = now == null ? clock : now;
			return st.timers.map(function (t) {
				var p = t.id === 'detention' && t.startedAt != null ? detentionPause(now, t.startedAt) : null;
				var left = t.startedAt == null ? null : Math.round(t.startedAt + t.minutes * 60 + (p ? p.sec : 0) - now);
				return { id: t.id, title: t.title, minutes: t.minutes, ref: t.ref, quote: t.quote,
					startedAt: t.startedAt, stoppedAt: t.stoppedAt, left: left,
					running: t.startedAt != null && t.stoppedAt == null,
					pause: p ? Math.round(p.sec) : 0, paused: !!(p && p.active),
					pauseWhy: p && p.active ? p.active.why + ' — срок стоит по ' + p.active.ref : '' };
			});
		}

		/** Компактная сводка для окна поверх игры. Только то, что читается взглядом. */
		function overlay(now) {
			var mDone = st.miranda.points.filter(function (p) { return p.done; }).length;
			var last = st.line.length ? st.line[st.line.length - 1] : null;
			// Вопросы — лентой, свежий сверху: после процедуры разговор с
			// адвокатом и есть вся сцена, и прошлые ответы нужны под рукой.
			// Ответ «по записи» пересобирается каждый раз (факты меняются);
			// ответ ИИ, если пришёл, лежит рядом.
			// Вопрос, заданный голосом, который потом оказался офицером
			// (роль копится по ходу сцены), — не вопрос к офицеру: убираем.
			var qs = st.questions.filter(function (x) {
				return x.state !== 'closed' && !(x.spk && (voiceRole(x.spk) === 'officer' || voiceRole(x.spk) === 'other'));
			}).slice(-4).reverse()
				.map(function (qq) {
					qq.answer = draftAnswer(qq);
					return { id: qq.id, at: clockOf(qq.at), text: qq.text, answer: qq.answer,
						ai: qq.ai || '', aiState: qq.aiState || '', who: qq.spk ? knownLabel('around', qq.spk) : '' };
				});
			var q = qs[0] || null;
			return {
				server: st.server,
				mode: { gov: st.mode.gov, warrant: st.mode.warrant },
				next: nextAction(),
				detainedAt: st.startAt != null ? clockOf(st.startAt, true) : '',
				summary: summary(),
				fabula: st.fabula ? st.fabula.text : '',
				fabulaAt: st.fabula ? mmss(st.fabula.at) : '',
				source: st.proc.source || '',
				steps: stepsView().map(function (s) {
					return { id: s.id, title: s.title, done: s.done, status: s.status,
						at: s.done ? mmss(s.at) : '' };
				}),
				stages: stagesView(),
				missed: missed().map(function (s) {
					return { key: s.key, title: s.title, ref: s.ref, text: s.text };
				}),
				clock: now == null ? clock : now,
				timers: timersAt(now).filter(function (t) { return t.running; }),
				rights: { done: mDone, total: st.miranda.points.length, available: st.miranda.available },
				hits: st.hits.filter(function (h) { return h.status === 'new'; }).slice(-3)
					.map(function (h) {
						return {
							id: h.id, kind: h.kind, who: h.who, at: clockOf(h.at), phrase: h.phrase,
							by: h.spk ? whoOf('around', h.spk).label : '',
							ref: h.article ? (h.article.short + ' ст.' + h.article.num) : '',
							title: h.article ? h.article.title : 'статьи в базе нет'
						};
					}),
				question: q,
				questions: qs,
				last: last ? lineView(last) : null,
				// субтитры: три последние реплики, свежая — последней
				feed: st.line.slice(-3).map(lineView),
				trace: st.trace.slice(-3).map(function (t) { return { at: mmss(t.at), text: t.text, tone: t.tone }; })
			};
		}

		// В окне поверх игры подпись — только когда роль известна: «Неизвестный 1»
		// у каждой строки — шум, а не сведения. В приложении подписи полные.
		function knownLabel(track, spk) {
			var w = whoOf(track, spk);
			return w.role && w.role !== 'unknown' ? w.label : '';
		}
		function lineView(l) {
			var w = whoOf(l.track, l.spk);
			return { track: l.track, who: knownLabel(l.track, l.spk), role: w.role, text: l.text, sure: l.sure, at: clockOf(l.t0) };
		}

		// ── ответ ИИ на вопрос ──
		// Сам запрос делает приложение (у него ключ и настройка «ИИ включён»);
		// разбор отдаёт контекст и проверяет, что ответ не сослался на статью,
		// которой в контексте не было.
		function questionById(id) {
			for (var i = 0; i < st.questions.length; i++) if (st.questions[i].id === id) return st.questions[i];
			return null;
		}
		function aiContext(id) {
			var q = questionById(id);
			if (!q) return null;
			var allowed = {};
			function art(a) { if (!a) return ''; var r = a.short + ' ст.' + a.num; allowed[String(a.num)] = 1; return r + ' — ' + a.title; }
			var L = [];
			L.push('Сервер: ' + (st.server || '—') + '. Порядок задержания: ' + (st.proc.source || 'общий') + '.');
			if (st.mode.gov && GOV) {
				L.push('Задержанный — государственный служащий: порядок по ' + GOV.source + '.');
				allowed[GOV.source.replace(/^.*ст\.\s*/, '')] = 1;
			}
			if (st.mode.warrant) L.push('Задержание по ордеру.' + Object.keys(WAR.rules).map(function (k) {
				allowed[WAR.rules[k].ref.replace(/^.*ст\.\s*/, '')] = 1;
				return ' ' + WAR.rules[k].ref + ': ' + WAR.rules[k].quote;
			}).join(''));
			if (st.startAt != null) L.push('Задержан: ' + clockOf(st.startAt, true) + '.');
			L.push('Этапы (время по часам, «—» — не отмечено):');
			summary().forEach(function (r) { if (r.k !== 'Задержан' && !r.wide) L.push('- ' + r.k + ': ' + r.v); });
			if (st.fabula) {
				L.push('Основание, объявленное офицером: ' + st.fabula.text + '.');
				(st.fabula.articles || []).slice(0, 2).forEach(function (a) { L.push('Статья по основанию: ' + art(a)); });
			} else L.push('Основание вслух не объявлялось.');
			// без «n из m пунктов на слух»: права читают своими словами, и счёт
			// распознанных пунктов модель приняла бы за признание неполного чтения
			var mAt = topicAt('miranda') != null ? topicAt('miranda') : mirandaStartedAt();
			L.push(mAt != null ? 'Права (Миранда) зачитаны в ' + clockOf(mAt) + '.' : 'Права (Миранда) ещё не зачитывались.');
			st.timers.forEach(function (t) {
				if (t.startedAt == null) return;
				allowed[String(t.ref).replace(/^.*ст\.\s*/, '')] = 1;
				L.push('Срок «' + t.title + '»: ' + t.minutes + ' мин по ' + t.ref + ', с ' + clockOf(t.startedAt) +
					(t.stoppedAt != null ? ', остановлен в ' + clockOf(t.stoppedAt) : ''));
			});
			st.steps.forEach(function (x) { if (x.ref) allowed[String(x.ref).replace(/^.*ст\.\s*/, '').replace(/\s.*$/, '')] = 1; });
			st.hits.filter(function (h) { return h.status !== 'dropped'; }).forEach(function (h) {
				// без цитаты: это слова другого игрока
				L.push('Услышано: ' + h.kind + (h.spk ? ' (' + whoOf('around', h.spk).label + ')' : '') + ' в ' + clockOf(h.at) +
					(h.article ? ' — ' + art(h.article) : ''));
			});
			// Расшифровка сцены НЕ отправляется. Звук не покидает машину потому,
			// что на второй дорожке голоса других игроков, — и их слова текстом
			// тоже. Наружу уходят только факты сцены (время этапов, основание,
			// которое объявил сам офицер, статьи, сроки) и сам вопрос: без него
			// отвечать не на что. Решение пользователя от 29.10.
			var asker = q.spk ? whoOf('around', q.spk).label : 'Собеседник';
			return {
				system: ANSWER_SYS,
				user: ['Запись Bodycam:', L.join('\n'), '',
					'Можно ссылаться только на номера статей: ' + (Object.keys(allowed).join(', ') || 'нет') + '.', '',
					asker + ' спрашивает: «' + q.text + '»'].join('\n'),
				allowed: Object.keys(allowed)
			};
		}
		/**
		 * Принять ответ ИИ. Ответ, где всплыл номер статьи не из контекста,
		 * отбрасывается: правдоподобная выдуманная статья посреди разговора
		 * с адвокатом хуже, чем ответ «по записи» без ИИ.
		 */
		function setAi(id, text, failed) {
			var q = questionById(id);
			if (!q) return false;
			if (failed) { q.aiState = 'error'; return false; }
			var t = String(text || '').trim().replace(/^[«"']|[»"']$/g, '');
			var ctx = aiContext(id), ok = { };
			(ctx ? ctx.allowed : []).forEach(function (n) { ok[n] = 1; });
			// «ст.17», «статьёй 228», «УК 228», «по ПК ст. 17.3» — во всех видах
			var refs = t.match(/(?:(?:^|[^а-яё])ст(?:ать[а-яё]*|\.)?|(?:УК|ПК|АК|ГК|ДК|ЭК|КоАП)\s*(?:ст\.?)?)\s*\d+(?:\.\d+)*/gi) || [];
			var bad = refs.some(function (m) {
				return !ok[(m.match(/\d+(?:\.\d+)*/) || [''])[0]];
			});
			if (!t || bad || /РФ|Российск/.test(t)) {
				q.aiState = 'rejected';
				trace(q.at, 'ответ ИИ отброшен: ' + (bad ? 'ссылался на статью не из записи' : 'пустой или про реальные законы'), 'warn');
				return false;
			}
			q.ai = t; q.aiState = 'ready';
			return true;
		}
		function setAiWaiting(id) { var q = questionById(id); if (q) q.aiState = 'wait'; }

		function closeQuestion(id) {
			st.questions.forEach(function (q) { if (q.id === id) q.state = 'closed'; });
		}

		function setHit(id, status) {
			st.hits.forEach(function (h) { if (h.id === id) h.status = status; });
		}

		function reset() {
			st.fabula = null; st.startAt = null; st.seen = {}; st.voices = {}; st.wall0 = null; undo = [];
			st.steps.forEach(function (s) { s.done = false; s.at = null; s.src = ''; s.manual = false; s.got = {}; });
			st.timers.forEach(function (t) { t.startedAt = null; t.stoppedAt = null; t.cause = ''; });
			st.miranda.points.forEach(function (p) { p.done = false; p.at = null; });
			st.hits = []; st.questions = []; st.trace = []; st.line = [];
			seenText = ''; hitSeq = 0; clock = 0; lastOfficerAt = null;
			// новая сцена — новый задержанный: режимы прошлой не переносятся
			setMode({ gov: false, warrant: false }, true);
		}

		/**
		 * Режимы сцены: задержанный — госслужащий, задержание по ордеру.
		 * Включает офицер. Шаги кодекса не меняются; меняются этапы после них,
		 * сроки и — по ордеру — то, что кодекс разрешает не делать.
		 */
		function setMode(m, quiet) {
			var was = { gov: st.mode.gov, warrant: st.mode.warrant };
			if (m.gov != null) st.mode.gov = !!m.gov;
			if (m.warrant != null) st.mode.warrant = !!m.warrant;
			var war = st.mode.warrant ? WAR.rules : {};
			// По ордеру, где у задержанного нет ни звонка, ни адвоката
			// (Лос-Анджелес, Атланта), шаг «реализовать права» не требуется
			var noRights = war.noLawyer && war.noCall && !war.noLawyer.may;
			st.steps.forEach(function (s) {
				s.optional = s.optional0 || !!(noRights && s.need[0] === 'rights');
			});
			stageList = buildStages();
			// Своя Миранда для ордера — пока права не начали читать: менять текст
			// посреди чтения значит сбить сверку
			var started = st.miranda.points.some(function (p) { return p.done; });
			if (!started) {
				var useW = st.mode.warrant && WAR.miranda;
				var q = useW ? mirandaPoints(WAR.miranda.quote) : mirBase.pts;
				if (useW || st.miranda.ref !== mirBase.ref) {
					st.miranda.available = useW ? true : mirBase.pts.length > 0;
					st.miranda.ref = useW ? WAR.miranda.ref : mirBase.ref;
					st.miranda.points = q.map(function (p) { return { text: p, done: false, at: null }; });
					wt = pointWeights(q);
				}
			}
			if (quiet) return;
			if (was.gov !== st.mode.gov) trace(clock, st.mode.gov
				? 'задержанный — госслужащий: порядок по ' + (GOV ? GOV.source : 'кодексу не найден')
				: 'режим «госслужащий» выключен', '');
			if (was.warrant !== st.mode.warrant) trace(clock, st.mode.warrant
				? 'задержание по ордеру' + (WAR.source ? ': исключения по ' + WAR.source : ' — кодекс исключений не делает')
				: 'режим «по ордеру» выключен', '');
		}

		/** Что режимы меняют на этом сервере — для вкладки, с цитатами. */
		function modesInfo() {
			var gov = [], war = [];
			if (GOV) {
				GOV.timers.forEach(function (t) { gov.push({ t: t.title + ' — ' + t.minutes + ' мин', ref: t.ref, quote: t.quote }); });
				if (!GOV.timers.length) gov.push({ t: 'Сроков ожидания в кодексе нет', ref: GOV.source, quote: '' });
				if (GOV.when) gov.push({ t: GOV.when === 'now' ? 'Вызывать сразу' : 'Вызывать по прибытии в КПЗ', ref: GOV.source, quote: GOV.whenQuote });
				if (GOV.bossOptional) gov.push({ t: 'Уведомить начальство — право, не обязанность', ref: GOV.source, quote: '' });
				if (GOV.release) gov.push({ t: 'Прокурор не ответил или не приехал — освободить', ref: GOV.source, quote: GOV.release });
				if (GOV.freeze || (FRZ && FRZ.pros)) gov.push({ t: 'Пока ждёте — срок задержания стоит', ref: GOV.freeze ? GOV.source : FRZ.ref, quote: GOV.freeze || FRZ.pros });
				if (GOV.arrestGate) gov.push({ t: 'Арест — только после решения прокурора', ref: GOV.source, quote: GOV.arrestGate });
			}
			var R = WAR.rules;
			if (R.announce) war.push({ t: 'Назвать задержанному ордер', ref: R.announce.ref, quote: R.announce.quote });
			if (R.noLawyer) war.push({ t: R.noLawyer.may ? 'Адвоката можно не предлагать' : 'Адвоката нет', ref: R.noLawyer.ref, quote: R.noLawyer.quote });
			if (R.noCall) war.push({ t: R.noCall.may ? 'Звонок можно не давать' : 'Звонка нет', ref: R.noCall.ref, quote: R.noCall.quote });
			if (R.noPros) war.push({ t: R.noBoss
				? (R.noPros.may ? 'Госслужащий: прокурора и начальство можно не вызывать' : 'Госслужащий: прокурора и начальство не вызывают')
				: 'Госслужащий: прокурора не вызывают, только начальство', ref: R.noPros.ref, quote: R.noPros.quote });
			if (R.arrestOk) war.push({ t: 'Госслужащего можно арестовать без решения прокурора', ref: R.arrestOk.ref, quote: R.arrestOk.quote });
			if (WAR.miranda) war.push({ t: 'Миранда своя, короткая', ref: WAR.miranda.ref, quote: WAR.miranda.quote });
			return {
				gov: { on: st.mode.gov, source: GOV ? GOV.source : null, items: gov },
				warrant: { on: st.mode.warrant, source: WAR.source, items: war }
			};
		}

		return {
			state: function () { return st; },
			catalogue: function () { return cat; },
			vocab: vocab,
			feed: feed,
			lookup: lookup,
			answerQuestion: answerQuestion,
			draftAnswer: draftAnswer,
			overlay: overlay,
			nextAction: nextAction,
			steps: stepsView,
			missed: missed,
			timers: timersAt,
			markManual: markManual,
			summary: summary,
			aiContext: aiContext,
			setAi: setAi,
			setAiWaiting: setAiWaiting,
			who: function (l) { return whoOf(l.track, l.spk); },
			setWall: setWall,
			clockOf: clockOf,
			stage: stage,
			stageBack: stageBack,
			stages: stagesView,
			setMode: setMode,
			modes: modesInfo,
			setVoiceRole: setVoiceRole,
			ROLES_MANUAL: ROLES_MANUAL,
			roleLabel: function (r, track) { return r === 'officer' && track !== 'mix' ? 'Напарник' : ROLE_LABEL[r] || r; },
			closeQuestion: closeQuestion,
			setHit: setHit,
			reset: reset,
			mmss: mmss
		};
	}

	var API = { create: create, deslang: deslang, norm: norm, SLANG: SLANG };
	if (typeof window !== 'undefined') window.VoiceBrain = API;
	if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
