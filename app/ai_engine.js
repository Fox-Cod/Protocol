/**
 * ai_engine.js — движок ИИ-ассистента внутри Protocol.
 *
 * Порт Python-логики (retrieve.py + assistant.py) на браузерный JS.
 * Работает на данных, УЖЕ загруженных в приложение (LAW_CACHE), поэтому
 * поиск локальный и мгновенный. Через прокси идут только два маленьких
 * запроса к модели: перевод бытовой речи в термины и финальный разбор.
 *
 * Подключается как <script src="ai_engine.js"> перед основным кодом.
 * Настройки прокси — в ai_config.js (его правите вы, он не в git).
 */

(function () {
  "use strict";

  // ─── стеммер: русский Портер (Snowball) ───
  //
  // Прежний вариант просто резал самый длинный суффикс из списка и потому
  // разводил формы одного слова: «наркотиков» → «наркотик», а «наркотических»
  // → «наркотическ»; «человека» и «человеку» сходились, а «скорости» и
  // «скоростного» — нет. Из-за этого BM25 ранжировал по половине запроса.
  // Портер работает по областям слова (RV/R2) и сводит формы согласованно.
  var RU_V = "аеиоуыэюя";

  function regions(w) {
    // RV — после первой гласной; R1 — после первой пары «гласная+согласная»;
    // R2 — то же внутри R1. Портер удаляет суффиксы только внутри этих зон,
    // поэтому короткие корни не съедаются.
    var rv = -1, r1 = -1, r2 = -1, i;
    for (i = 0; i < w.length; i++) {
      if (RU_V.indexOf(w[i]) >= 0) { rv = i + 1; break; }
    }
    for (i = 1; i < w.length; i++) {
      if (RU_V.indexOf(w[i]) < 0 && RU_V.indexOf(w[i - 1]) >= 0) { r1 = i + 1; break; }
    }
    if (r1 >= 0) for (i = r1 + 1; i < w.length; i++) {
      if (RU_V.indexOf(w[i]) < 0 && RU_V.indexOf(w[i - 1]) >= 0) { r2 = i + 1; break; }
    }
    return { rv: rv < 0 ? w.length : rv, r1: r1 < 0 ? w.length : r1, r2: r2 < 0 ? w.length : r2 };
  }

  var PERF_G1 = /(в|вши|вшись)$/,      PERF_G2 = /(ив|ивши|ившись|ыв|ывши|ывшись)$/;
  var REFLEX  = /(ся|сь)$/;
  var ADJ     = /(ее|ие|ые|ое|ими|ыми|ей|ий|ый|ой|ем|им|ым|ом|его|ого|ему|ому|их|ых|ую|юю|ая|яя|ою|ею)$/;
  var PART1   = /(ем|нн|вш|ющ|щ)$/,    PART2 = /(ивш|ывш|ующ)$/;
  var VERB1   = /(ла|на|ете|йте|ли|й|л|ем|н|ло|но|ет|ют|ны|ть|ешь|нно)$/;
  var VERB2   = /(ила|ыла|ена|ейте|уйте|ите|или|ыли|ей|уй|ил|ыл|им|ым|ен|ило|ыло|ено|ят|ует|уют|ит|ыт|ены|ить|ыть|ишь|ую|ю)$/;
  var NOUN    = /(а|ев|ов|ие|ье|е|иями|ями|ами|еи|ии|и|ией|ей|ой|ий|й|иям|ям|ием|ем|ам|ом|о|у|ах|иях|ях|ы|ь|ию|ью|ю|ия|ья|я)$/;
  var SUPER   = /(ейш|ейше)$/,         DERIV = /(ост|ость)$/;

  // Суффикс из группы 1 снимается, только если перед ним «а» или «я».
  function cut(rvPart, re1, re2) {
    var m = re2.exec(rvPart);
    if (m) return rvPart.slice(0, m.index);
    m = re1 && re1.exec(rvPart);
    if (m && m.index > 0 && (rvPart[m.index - 1] === "а" || rvPart[m.index - 1] === "я"))
      return rvPart.slice(0, m.index);
    return null;
  }

  function stem(w) {
    w = String(w == null ? "" : w).toLowerCase().replace(/ё/g, "е");
    if (!/[а-я]/.test(w)) return w;          // латиница и цифры — как есть
    if (w.length <= 3) return w;
    var reg = regions(w), pre = w.slice(0, reg.rv), rv = w.slice(reg.rv), t;

    // Шаг 1: деепричастие, иначе возвратность + (прилаг./причастие | глагол | сущ.)
    t = cut(rv, PERF_G1, PERF_G2);
    if (t === null) {
      rv = rv.replace(REFLEX, "");
      t = cut(rv, null, ADJ);
      if (t !== null) {
        rv = t;
        var p = cut(rv, PART1, PART2);
        if (p !== null) rv = p;
      } else {
        t = cut(rv, VERB1, VERB2);
        if (t !== null) rv = t;
        else { t = cut(rv, null, NOUN); if (t !== null) rv = t; }
      }
    } else rv = t;

    // Шаг 2: конечная «и»
    rv = rv.replace(/и$/, "");
    // Шаг 3: словообразовательный суффикс — только в R2
    var word = pre + rv;
    if (reg.r2 < word.length && DERIV.test(word.slice(reg.r2))) {
      word = word.replace(DERIV, "");
      pre = word.slice(0, Math.min(reg.rv, word.length)); rv = word.slice(Math.min(reg.rv, word.length));
    }
    // Шаг 4: «нн» → «н», превосходная степень, мягкий знак
    if (/нн$/.test(rv)) rv = rv.slice(0, -1);
    else {
      var s = SUPER.exec(rv);
      if (s) { rv = rv.slice(0, s.index); if (/нн$/.test(rv)) rv = rv.slice(0, -1); }
    }
    rv = rv.replace(/ь$/, "");
    return pre + rv;
  }

  function tokenize(text, doStem) {
    var toks = (text || "").toLowerCase().match(/[а-яёa-z0-9]+/g) || [];
    return doStem === false ? toks : toks.map(stem);
  }

  // ─── синонимы: сленг и обиходные глаголы → язык закона ───
  //
  // Стеммер сводит формы одного слова, но не разные слова. Игрок пишет «убил»,
  // «отобрал силой», «дурь», а статья называется «Причинение смерти»,
  // «Грабеж», «наркотические средства». Без этого моста BM25 ранжирует
  // по случайному общему слову. Группы перенесены из GovHelper.html 2.7.0,
  // где они собирались по живым запросам игроков.
  var SYNONYMS = [
    ['убийство','убил','убить','лишил жизни','завалил','грохнул','застрелил','зарезал','труп','смерть','мокруха','причинение смерти'],
    ['тяжкое убийство','массовое убийство','убил нескольких','расстрел','резня','убил копа','убил сотрудника'],
    ['телесные','побил','избил','покалечил','ранил','ранение','ножевое','порезал','повреждения','драка','напал','побои','вред здоровью'],
    ['кража','украл','спёр','стащил','своровал','тайно взял','обнёс','карманник','вытащил кошелёк','хищение','похитил имущество'],
    ['взлом','со взломом','вскрыл сейф','вскрыл замок','проник в помещение','залез в дом'],
    ['грабёж','грабеж','ограбил','отнял','отобрал','забрал силой','вырвал','открыто похитил','гоп-стоп'],
    ['разбой','напал с оружием','ограбил с пушкой','нападение ради денег','налёт','ствол к голове'],
    ['мошенничество','обман','развод','кинул','аферист','мошенник','обманул','обманом'],
    ['вымогательство','вымогал','крышевал','требовал деньги','шантаж'],
    ['оружие','пушка','ствол','пистолет','автомат','незаконное оружие','хранение оружия','нелегальный ствол','носил оружие','огнестрельное','ношение'],
    ['спецсредства','бронежилет','тазер','дубинка','гос оружие'],
    ['взрывчатка','бомба','взрыв','взрыва','взорвал','взорвать','подорвал','динамит','граната','взрывное устройство'],
    ['стрельба','стрелял','открыл огонь','палил','выстрелы'],
    ['наркотики','нарко','дурь','вещества','трава','закладка','травка','барыга','сбыт','каннабис','марихуана','наркотических','наркотические','продавал наркотики'],
    ['терроризм','теракт','террорист','взорвал'],
    ['экстремизм','экстремист','разжигание','ненависть','вражда'],
    ['беспорядки','бунт','митинг','массовые беспорядки','погром','восстание','поджог','демонстрация'],
    ['угроза','угрожал','пригрозил','запугивал','грозился убить','угрожал убийством'],
    ['похищение','похитил','украл человека','взял в заложники','заложник','удержание','лишение свободы','увёз'],
    ['изнасилование','изнасиловал','насилие половое','домогательство','домогался'],
    ['угон','угнал','тачка','завладение','автомобиль','автомобилем','завладел машиной','украл тачку','украл авто','неправомерное завладение','завладение автомобилем','транспортным средством','транспортное средство','уехал на чужой машине','уехал на чужой тачке'],
    ['порча','сломал','разбил','уничтожил имущество','повредил','уничтожение','повреждение'],
    ['взятка','взятку','подкуп','дал денег копу','коррупция','откат','откуп'],
    ['превышение','превысил полномочия','коп беспредел','коп нарушает','злоупотребление'],
    ['оскорбление','оскорбил','обозвал','послал','нахамил копу','унизил'],
    ['неповиновение','не подчинился','отказался выполнять','игнорирует копа','сопротивление','убегал от копов','препятствовал'],
    ['клевета','оклеветал','ложь обо мне','распространил ложь'],
    ['самоуправство','самовольно','без разрешения сделал'],
    ['проникновение','залез на объект','незаконно проник','зашёл на охраняемую'],
    ['налоги','уклонение от налогов','не платил налоги','скрыл доход'],
    ['поддельные','подделка','фальшивые документы','липовые','поддельное удостоверение'],
    ['опьянение','пьяный','бухой','нетрезвый','алкоголь','под наркотиками','обдолбанный'],
    ['ложный вызов','ложно сообщил'],
    ['браконьерство','незаконная охота','незаконный улов'],
    ['животные','жестокость к животным','избил собаку','мучил животное'],
    ['убытки','возмещение','ущерб','компенсация','взыскать убытки','упущенная выгода'],
    ['моральный вред','моральная компенсация','нравственные страдания'],
    ['сделка','договор','соглашение','контракт','расписка'],
    ['репутация','честь','достоинство','опровержение','порочащие сведения','деловая репутация'],
    ['собственность','имущество','владение','право собственности','чужого имущества'],
    ['юрлицо','организация','компания','регистрация бизнеса','предприниматель'],
    ['неосторожность','случайно','по неосторожности','нечаянно','не хотел','сбил насмерть','непреднамеренно'],
    ['самозащита','защита прав','самозащита прав','оборона','необходимая оборона'],
    ['дресс-код','внешний вид','причёска','татуировки','макияж'],
    ['этика','этический','поведение служащего','госслужащий'],
    ['задержание','задержали','арест','наручники','кпз','процессуальный час','задержать'],
    ['миранда','права задержанного','зачитать права','право на адвоката','право на звонок'],
    ['обыск','досмотр','личный обыск','шмон','выверни карманы','проверка карманов'],
    ['применение силы','стадии силы','эскалация','шокер'],
    ['боло','боло-розыск','розыск','звёзды розыска','уровень розыска'],
    ['залог','выйти под залог','выкуп'],
    ['реабилитация','снять судимость','юридическая реабилитация','судимость'],
    ['допрос','допросить','повестка'],
    ['освидетельствование','проверка на опьянение','тест на алкоголь'],
    ['компетенция','юрисдикция','федеральная','региональная','финансовая','военная'],
    ['штраф','тикет','выписал штраф','оплата штрафа'],
    ['изъятие','конфискация','изъяли','забрали вещи','отобрали'],
    ['неприкосновенность','иммунитет'],
    ['обыск машины','осмотр тс','досмотр авто','багажник'],
    ['адвокат','звонок','право на адвоката','телефонный звонок'],
    ['видеозапись','видеофиксация','боди камера','боди-камера','экшн камера','запись задержания'],
    ['кпз срок','срок кпз','сколько кпз','время кпз','звёзды кпз','сколько сидеть'],
    ['медик','ems','врач','парамедик','дефибриллятор'],
    ['жалоба','обжалование','пожаловаться','иск на копа'],
    ['правила сервера','админ','деморган','demorgan','бан','наказание админа'],
    ['незаконный','незаконное','нелегальный','нелегально','без разрешения','без лицензии','неправомерный'],
    ['смягчающие','смягчающие обстоятельства','смягчение'],
    ['отягчающие','отягчающие обстоятельства','отягчение'],
    ['рецидив','повторно','снова совершил','рецидивист'],
    ['соучастие','группой лиц','сговор','подельник','пособник'],
  ];

  // stem одиночного слова → индексы групп; многословные — ищутся подстрокой.
  var SYN_WORD = {}, SYN_PHRASE = [], SYN_GROUP_STEMS = [];
  (function buildSyn() {
    SYNONYMS.forEach(function (group, gi) {
      var stems = {};
      group.forEach(function (entry) {
        var words = entry.trim().split(/\s+/);
        if (words.length > 1) SYN_PHRASE.push([entry.toLowerCase(), gi]);
        words.forEach(function (w) {
          var st = stem(w);
          if (st.length >= 3) stems[st] = 1;
        });
        if (words.length === 1) {
          var s1 = stem(entry);
          if (s1.length >= 3) (SYN_WORD[s1] = SYN_WORD[s1] || []).push(gi);
        }
      });
      SYN_GROUP_STEMS.push(Object.keys(stems));
    });
  })();

  // Настройки ранжирования. Подобраны перебором по эталонному набору
  // из 25 типичных запросов игрока (см. комментарий к expandTerms).
  var SYN_WEIGHT = 0.45;   // синоним весит меньше, чем слово самого запроса
  var SYN_NORM = 0.15;      // степень нормировки вклада группы по её размеру

  // Запрос → карта «основа → вес». Слова запроса весят 1, синонимы — меньше,
  // чтобы дополняли ранжирование, а не перебивали исходный смысл.
  //
  // Вклад группы нормируется по её размеру. Иначе одна побочная деталь топит
  // запрос: в «убил человека из пистолета» слово «пистолета» поднимает группу
  // «оружие» на 16 основ, и статьи о хранении оружия перебивают убийство —
  // проверено, статья 6.2 уезжала с 1-го места на 22-е. Делитель √n уравнивает
  // крупные и мелкие группы: смысл добавляют все, но массой не давит никто.
  function expandTerms(query) {
    var q = String(query || "").toLowerCase();
    var terms = {}, groups = {};
    tokenize(q).forEach(function (t) {
      if (!t) return;
      terms[t] = Math.max(terms[t] || 0, 1);
      (SYN_WORD[t] || []).forEach(function (gi) { groups[gi] = (groups[gi] || 0) + 1; });
    });
    SYN_PHRASE.forEach(function (p) {
      if (q.indexOf(p[0]) >= 0) groups[p[1]] = (groups[p[1]] || 0) + 2;  // фраза — сигнал сильнее слова
    });
    Object.keys(groups).forEach(function (gi) {
      var stems = SYN_GROUP_STEMS[gi];
      var per = SYN_WEIGHT * Math.min(2, groups[gi]) / Math.pow(stems.length || 1, SYN_NORM);
      stems.forEach(function (st) {
        if (!terms[st]) terms[st] = per;
        else if (terms[st] < 1) terms[st] = Math.max(terms[st], per);
      });
    });
    return terms;
  }

  // ─── индекс одного сервера ───
  function ServerIndex(server, codes) {
    this.server = server;
    this.docs = [];
    this.df = {};
    this.postings = {};
    this.byNum = {};
    this._build(codes);
  }

  ServerIndex.prototype._build = function (codes) {
    var self = this;
    // Главы запоминаем отдельно: по ним строится оглавление (toc), из
    // которого модель сама выбирает, что читать.
    this.codes = [];
    Object.keys(codes || {}).forEach(function (cid) {
      var code = codes[cid];
      var ce = { cid: cid, short: code.short || "", title: code.title || "", chapters: [] };
      self.codes.push(ce);
      (code.parts || []).forEach(function (part) {
        (part.chapters || []).forEach(function (ch) {
          var che = { title: ch.title || "", docs: [] };
          ce.chapters.push(che);
          (ch.articles || []).forEach(function (art) {
            che.docs.push(self.docs.length);
            self._add(cid, code.short || "", code.title || "", ch.title || "", art);
          });
        });
      });
    });
    var n = this.docs.length;
    var total = 0;
    this.docs.forEach(function (d) { total += d._len; });
    this.avgLen = n ? total / n : 0;
    this.N = n;
  };

  ServerIndex.prototype._add = function (cid, short, ctitle, chap, art) {
    var num = String(art.num == null ? "" : art.num);
    var parts = art.parts || [];
    var body = parts.map(function (p) { return p.t || ""; }).join(" ");
    var full = ((art.title || "") + " " + body).trim();
    var di = this.docs.length;
    // _title — основы слов заголовка статьи, для надбавки в bm25.
    var titleStems = {};
    tokenize(art.title || "").forEach(function (t) { if (t) titleStems[t] = 1; });
    var doc = {
      code_id: cid, code_short: short, code_title: ctitle,
      chapter: chap, num: num, title: art.title || "",
      text: full, parts: parts, _len: 0, _title: titleStems, _i: di,
    };
    this.docs.push(doc);
    if (num) (this.byNum[num] = this.byNum[num] || []).push(di);

    var tf = {};
    var toks = tokenize(full);
    toks.forEach(function (t) { tf[t] = (tf[t] || 0) + 1; });
    var len = 0;
    for (var t in tf) {
      (this.postings[t] = this.postings[t] || []).push([di, tf[t]]);
      this.df[t] = (this.df[t] || 0) + 1;
      len += tf[t];
    }
    doc._len = len;
  };

  // exact-сигналы
  ServerIndex.prototype.exact = function (query) {
    var hits = [];
    var m = query.match(/(?:ст\.?|стать[яеи])?\s*(\d+\.\d+(?:\.\d+)?)/i);
    if (m && this.byNum[m[1]]) {
      this.byNum[m[1]].forEach(function (di) { hits.push([di, 100]); });
    }
    var money = query.match(/(\d[\d\s.,]{2,})\s*(?:\$|долл|usd|руб)/i);
    if (money) {
      var digits = money[1].replace(/\D/g, "");
      this.docs.forEach(function (d, di) {
        if (d.text.replace(/\D/g, "").indexOf(digits) >= 0) hits.push([di, 40]);
      });
    }
    return hits;
  };

  // BM25 с весами синонимов и надбавкой за попадание в заголовок статьи.
  // Заголовок — самое информативное поле: «Грабеж, то есть открытое хищение»
  // говорит о статье больше, чем абзац санкции, поэтому совпадение там
  // ценится отдельно (TITLE_BOOST).
  var TITLE_BOOST = 1.1;

  ServerIndex.prototype.bm25 = function (query, top) {
    top = top || 50;
    var weights = expandTerms(query);
    var termList = Object.keys(weights);
    if (!termList.length) return [];
    var scores = {}, k1 = 1.5, b = 0.75, self = this;
    termList.forEach(function (term) {
      var df = self.df[term] || 0;
      if (!df) return;
      var w = weights[term];
      var idf = Math.log(1 + (self.N - df + 0.5) / (df + 0.5));
      (self.postings[term] || []).forEach(function (pair) {
        var di = pair[0], tf = pair[1], d = self.docs[di], dl = d._len;
        var denom = tf + k1 * (1 - b + b * dl / (self.avgLen || 1));
        var s = idf * (tf * (k1 + 1)) / (denom || 1);
        if (d._title && d._title[term]) s += idf * TITLE_BOOST;
        scores[di] = (scores[di] || 0) + w * s;
      });
    });
    return Object.keys(scores)
      .map(function (di) { return [+di, scores[di]]; })
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, top);
  };

  // слияние (exact доминирует, bm25 доранжирует по силе)
  ServerIndex.prototype.search = function (query, top) {
    top = top || 10;
    var exactHits = this.exact(query);
    var bmHits = this.bm25(query);
    var sig = query.match(/(?:ст\.?|стать[яеи])?\s*(\d+\.\d+(?:\.\d+)?)/i);

    var order = [], seen = {};
    if (sig) {
      exactHits.filter(function (h) { return h[1] >= 100; })
        .sort(function (a, b) { return b[1] - a[1]; })
        .forEach(function (h) {
          if (!seen[h[0]]) { seen[h[0]] = 1; order.push([h[0], { exact: 100 }, 1.0]); }
        });
    }
    var fused = {}, raw = {};
    var otherExact = exactHits.filter(function (h) { return !seen[h[0]] && h[1] < 100; });
    otherExact.sort(function (a, b) { return b[1] - a[1]; })
      .forEach(function (h, r) {
        fused[h[0]] = (fused[h[0]] || 0) + 1.5 / (60 + r);
        (raw[h[0]] = raw[h[0]] || {}).exact = h[1];
      });
    var maxBm = bmHits.length ? bmHits[0][1] : 1;
    bmHits.forEach(function (h, r) {
      fused[h[0]] = (fused[h[0]] || 0) + 1.0 / (60 + r) + 0.02 * (h[1] / (maxBm || 1));
      (raw[h[0]] = raw[h[0]] || {}).bm25 = Math.round(h[1] * 100) / 100;
    });
    Object.keys(fused).map(function (di) { return [+di, fused[di]]; })
      .sort(function (a, b) { return b[1] - a[1]; })
      .forEach(function (p) {
        if (!seen[p[0]]) { seen[p[0]] = 1; order.push([p[0], raw[p[0]], p[1]]); }
      });

    var out = [], self = this;
    order.slice(0, top).forEach(function (o) {
      var d = self.docs[o[0]];
      out.push({ doc: d, score: Math.round(o[2] * 1e4) / 1e4, layers: o[1] });
    });
    return out;
  };

  // Поиск с раздельными квотами для законов и правил проекта.
  //
  // Зачем. Приложение держит в одном индексе и кодексы, и правила проекта
  // (ПОП, ОПП и прочие). Правила короткие и написаны бытовым языком, поэтому
  // на живом запросе вроде «угон» они уверенно перебивают кодекс: в контекст
  // уходили пять пунктов про ограбление авто и погоню, а Уголовный кодекс
  // не попадал вовсе — модель честно отвечала «точной статьи в базе нет»,
  // хотя статья есть.
  //
  // Квоты решают это без подкрутки весов: законам гарантирована своя доля,
  // правилам — своя. Ключи наборов приложение задаёт как 'law:{id}' и
  // 'rules:{id}'; всё, что не помечено rules:, считается законом.
  // Разнообразие верха выдачи. Закон об оружии пишет «хранение, ношение»
  // почти в каждой статье, и на запрос «ношение оружия без лицензии» его
  // разрешительные статьи занимали всю восьмёрку (Орландо: УК 12.8 — 24-е
  // место, Даллас: «нелегальный ствол» → УК 12.8 — 13-е). Восьмёрка — это
  // всё, что видит оверлей, поэтому в ней не больше DOC_CAP статей одного
  // документа; остальные сдвигаются ниже, но не пропадают. Точное попадание
  // по номеру («ст. 10.3») ограничение не трогает. Предел подобран наборами
  // (31.10.2026): 4 — 100 %/100 % на Орландо и Далласе; 3 выбивает «разбил
  // чужую машину» — самому УК в восьмёрке нужны четыре места; 2 — хуже обоих.
  var DOC_CAP = 4, DOC_CAP_TOP = 8;
  function diversify(hits) {
    var top = [], later = [], per = {};
    hits.forEach(function (h) {
      var id = h.doc.code_id || "";
      var exact = h.layers && h.layers.exact >= 100;
      if (top.length < DOC_CAP_TOP && (exact || (per[id] || 0) < DOC_CAP)) {
        top.push(h); per[id] = (per[id] || 0) + 1;
      } else later.push(h);
    });
    return top.concat(later);
  }

  ServerIndex.prototype.searchBalanced = function (query, quotaLaws, quotaRules) {
    quotaLaws = quotaLaws || 24; quotaRules = quotaRules || 6;
    var pool = this.search(query, (quotaLaws + quotaRules) * 3);
    var laws = [], rules = [];
    diversify(pool.filter(function (h) {
      return String(h.doc.code_id || "").indexOf("rules:") !== 0;
    })).concat(pool.filter(function (h) {
      return String(h.doc.code_id || "").indexOf("rules:") === 0;
    })).forEach(function (h) {
      var isRule = String(h.doc.code_id || "").indexOf("rules:") === 0;
      if (isRule) { if (rules.length < quotaRules) rules.push(h); }
      else if (laws.length < quotaLaws) laws.push(h);
    });
    // Недобор в одной корзине отдаём другой — пустых мест не оставляем.
    if (laws.length < quotaLaws) {
      pool.forEach(function (h) {
        if (laws.length + rules.length >= quotaLaws + quotaRules) return;
        if (String(h.doc.code_id || "").indexOf("rules:") === 0 && rules.indexOf(h) < 0) rules.push(h);
      });
    }
    return laws.concat(rules);
  };

  // ─── оркестратор: перевод → поиск → разбор ───
  var EXPAND_SYSTEM =
    "Ты помогаешь искать статьи в законах ролевого проекта. Игрок описывает " +
    "ситуацию бытовыми словами. Преврати это в набор ЮРИДИЧЕСКИХ терминов для " +
    "поиска, ничего не додумывая о наказании.\n" +
    'Верни ТОЛЬКО JSON: {"terms":["термин1",...],"offenses":["деяние1",...]}\n' +
    "termы — формулировки из кодексов (например «неповиновение сотруднику " +
    "полиции», «оставление места ДТП»). Не придумывай статьи и сроки.";

  var ANALYZE_SYSTEM =
    "Ты — помощник по законам ролевого проекта. Тебе дают ситуацию и НАБОР " +
    "НАЙДЕННЫХ СТАТЕЙ. Отвечай СТРОГО по ним.\n" +
    "ПРАВИЛА:\n" +
    "1. Используй ТОЛЬКО статьи из списка. Если подходящей нет — так и скажи.\n" +
    "2. Каждый вывод — со ссылкой на номер статьи из списка.\n" +
    "3. Не выдумывай сроки и суммы — бери из текста статей.\n" +
    "4. Не хватает факта — задай уточняющий вопрос, если ответ от него зависит.\n" +
    "Структура: применимые статьи и почему; наказание по каждой; что " +
    "смягчает/отягчает; чего не хватает.";

  function parseJSON(raw) {
    var s = String(raw).trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    var i = s.indexOf("{"), j = s.lastIndexOf("}");
    if (i < 0 || j < 0) throw new Error("нет JSON");
    return JSON.parse(s.slice(i, j + 1));
  }

  function formatArticles(found) {
    return found.map(function (r) {
      var d = r.doc;
      var head = "[" + d.code_short + " ст." + d.num + "] " + d.title;
      var body = (d.parts || []).map(function (p) {
        return p.t ? "    " + (p.n || "") + ": " + p.t : "";
      }).filter(Boolean).join("\n");
      return body ? head + "\n" + body : head;
    }).join("\n");
  }

  function Assistant(index, llm) {
    this.index = index;
    this.llm = llm;         // async (system, user) -> text
  }

  Assistant.prototype.expandQuery = async function (query) {
    if (!this.llm) return { terms: [query], offenses: [], raw: query };
    try {
      var out = await this.llm(EXPAND_SYSTEM, query);
      var data = parseJSON(out);
      return { terms: (data.terms && data.terms.length ? data.terms : [query]),
               offenses: data.offenses || [], raw: query };
    } catch (e) {
      return { terms: [query], offenses: [], raw: query };
    }
  };

  Assistant.prototype.retrieve = function (expanded, top) {
    top = top || 8;
    var acc = {}, self = this;
    function add(r, weight) {
      var key = r.doc.code_id + ":" + r.doc.num;
      var bm = r.layers.bm25 || 0, ex = r.layers.exact || 0;
      var s = r.score + 0.001 * bm + 0.01 * ex;
      if (acc[key]) {
        acc[key].score += s;
        if (bm > (acc[key].r.layers.bm25 || 0)) acc[key].r = r;
      } else acc[key] = { r: r, score: s };
    }
    self.index.search(expanded.raw, top).forEach(function (r) { add(r); });
    (expanded.terms || []).forEach(function (term) {
      self.index.search(term, top).forEach(function (r) { add(r); });
    });
    return Object.keys(acc).map(function (k) { return acc[k]; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, top)
      .map(function (it) {
        var r = it.r; r.score = Math.round(it.score * 1e4) / 1e4; return r;
      });
  };

  Assistant.prototype.analyze = async function (query, found) {
    if (!this.llm) return { answer: null, found: found };
    var context = formatArticles(found);
    var user = "СИТУАЦИЯ:\n" + query + "\n\nНАЙДЕННЫЕ СТАТЬИ:\n" + context;
    var answer = await this.llm(ANALYZE_SYSTEM, user);
    var cited = {};
    (answer.match(/ст\.?\s*(\d+(?:\.\d+)*)/gi) || []).forEach(function (m) {
      var n = m.replace(/[^\d.]/g, ""); if (n) cited[n] = 1;
    });
    var avail = {};
    found.forEach(function (r) { avail[r.doc.num] = 1; });
    var invented = Object.keys(cited).filter(function (c) { return !avail[c]; });
    return { answer: answer, cited: Object.keys(cited), invented: invented,
             verified: invented.length === 0, found: found };
  };

  Assistant.prototype.ask = async function (query, top) {
    var expanded = await this.expandQuery(query);
    var found = this.retrieve(expanded, top);
    var result = await this.analyze(query, found);
    result.expanded = expanded;
    return result;
  };

  // ─── путь запроса: оглавление → главы → ответ (03.11.2026) ───
  //
  // Раньше модель видела только то, что подобрал поиск по словам: 30 статей
  // (8 у оверлея) из 1300–1700. Поиск слов не понимает, и промахивался он
  // именно на живых вопросах: «напал на сотрудника» уводил в закон о ФРБ, где
  // слово «сотрудник» в каждой статье; «что такое субъект» и «порядок
  // задержания» не находились вовсе. Модель могла бы ответить, но до нужной
  // статьи её не допускали. Замер по 19 серверам: 83 % у оверлея, 89 % у чата.
  //
  // Теперь как человек с книгой: сначала оглавление. Модель получает список
  // законов с главами, говорит, что это за вопрос (статья, определение,
  // порядок, правила, общий) и какие главы читать, — и уже из этих глав
  // берутся статьи. Поиск по словам остаётся страховкой: если план не пришёл
  // или указал мимо, сильные совпадения всё равно попадают в подборку.
  //
  // Предел воркера — около 24 тыс. символов на запрос (system + user, больше —
  // HTTP 413), поэтому оглавление само ужимается до TOC_MAX.

  function cleanTitle(t, max) {
    var s = String(t || "").replace(/★+/g, "").replace(/\((?:F|M|R|N\/S|F\/R)\)/g, "")
      .replace(/\[[^\]]*\]/g, "").replace(/[«»"“”„]/g, "")
      .replace(/^\s*(?:глава|раздел|часть)\s+[IVXLCDM\d]+\.?\s*[-–—.:]?\s*/i, "")
      .replace(/\s*(?:в\s+)?штат[аеу]?\s+(?:San[\s-]*Andreas|Сан[\s-]*Андреас)/gi, "")
      .replace(/\s+/g, " ").trim();
    // ЗАГЛАВНЫЕ ЦЕЛИКОМ — в обычные: короче для модели и не кричит
    if (s && s === s.toUpperCase() && /[А-ЯЁA-Z]{4}/.test(s)) s = s.charAt(0) + s.slice(1).toLowerCase();
    if (max && s.length > max) s = s.slice(0, max - 1).replace(/[\s,;:.—-]+\S*$/, "") + "…";
    return s;
  }
  function isRuleCode(cid) { return String(cid || "").indexOf("rules:") === 0; }

  // Документ из 1–3 глав выбирается целиком, по своей метке («ЗСОШ»); у
  // больших — метки глав «УК/17». Метки — короткие коды документов, к ним
  // модель привыкла по ответам; повтор кода получает цифру («ПОБ2»).
  var TOC_CHAP_MIN = 4, TOC_MAX = 15000;
  ServerIndex.prototype.toc = function () {
    if (this._toc) return this._toc;
    var self = this, refs = {}, used = {}, lines = [];
    this.codes.forEach(function (c) {
      var chs = c.chapters.filter(function (ch) { return ch.docs.length; });
      if (!chs.length) return;
      var base = String(c.short || "?").toUpperCase().replace(/\s+/g, ""), label = base, k = 2;
      while (used[label]) label = base + (k++);
      used[label] = 1;
      var all = [];
      chs.forEach(function (ch) { all = all.concat(ch.docs); });
      refs[label] = all;
      var item = { label: label, rule: isRuleCode(c.cid), title: c.title, chs: [] };
      if (chs.length >= TOC_CHAP_MIN) chs.forEach(function (ch, i) {
        refs[label + "/" + (i + 1)] = ch.docs;
        // глава без названия — по первой статье
        item.chs.push(ch.title || (self.docs[ch.docs[0]] || {}).title || "");
      });
      lines.push(item);
    });
    function render(chLen) {
      var laws = [], rules = [];
      lines.forEach(function (it) {
        var s = it.label + " — " + cleanTitle(it.title, 64);
        if (it.chs.length) s += ": " + it.chs.map(function (t, i) { return (i + 1) + " " + cleanTitle(t, chLen); }).join("; ");
        (it.rule ? rules : laws).push(s);
      });
      return "ЗАКОНЫ СЕРВЕРА:\n" + laws.join("\n") +
        (rules.length ? "\n\nПРАВИЛА ПРОЕКТА (общие для всех серверов):\n" + rules.join("\n") : "");
    }
    var chLen = 48, text = render(chLen);
    while (text.length > TOC_MAX && chLen > 16) { chLen -= 4; text = render(chLen); }
    this._toc = { text: text, refs: refs };
    return this._toc;
  };

  var KINDS = { qualify: 1, define: 1, procedure: 1, rules: 1, general: 1, chat: 1 };
  var KIND_RU = {
    qualify: "ситуация — какая статья и наказание",
    define: "определение понятия",
    procedure: "порядок действий, права и обязанности",
    rules: "правила проекта",
    general: "общий вопрос",
    chat: "разговор, не вопрос",
  };
  function parsePlan(raw, toc) {
    var d;
    try { d = parseJSON(raw); } catch (e) { return null; }
    if (!d || typeof d !== "object") return null;
    var kind = KINDS[d.kind] ? d.kind : "qualify";
    var seen = {};
    var read = [].concat(d.read || d.chapters || []).map(function (s) {
      return String(s || "").toUpperCase().replace(/[\s\[\]]/g, "");
    }).filter(function (r) {
      if (!toc.refs[r] || seen[r]) return false;
      seen[r] = 1; return true;
    }).slice(0, 6);
    var terms = [].concat(d.terms || []).filter(function (x) { return typeof x === "string" && x.trim(); })
      .map(function (x) { return x.trim(); }).slice(0, 10);
    return { kind: kind, read: read, terms: terms };
  }

  // Подборка статей для ответа: выбранные моделью главы + поиск по словам.
  // Статьи выбранных глав получают надбавку и идут вперёд; внутри — по силе
  // совпадения с вопросом и терминами. Огромный «документ целиком» (правила
  // на сотню пунктов) надбавку даёт только статьям, где совпало хоть слово,
  // иначе он забил бы подборку пунктами по порядку.
  var CH_BONUS = 0.6, BIG_REF = 30;
  ServerIndex.prototype.gather = function (question, plan, opts) {
    opts = opts || {};
    var self = this, toc = this.toc();
    var q = String(question || "") + (plan && plan.terms && plan.terms.length ? " " + plan.terms.join(" ") : "");
    var score = {};
    function add(di, s) { score[di] = (score[di] || 0) + s; }
    var bm = this.bm25(q, 600), bmMax = bm.length ? bm[0][1] : 1, bmS = {};
    bm.forEach(function (h) { bmS[h[0]] = h[1] / (bmMax || 1); });
    (plan && plan.read || []).forEach(function (r, ri) {
      var docs = toc.refs[r] || [], big = docs.length > BIG_REF;
      docs.forEach(function (di) {
        if (big && !bmS[di]) return;
        add(di, CH_BONUS - ri * 0.02 + (bmS[di] || 0));
      });
    });
    var glob = this.searchBalanced(q, opts.overlay ? 10 : 24, plan && plan.kind === "rules" ? 10 : 5);
    // Самые сильные совпадения поиска попадают в подборку всегда, какую бы
    // главу ни выбрала модель: она видит только названия глав и может
    // ошибиться (нападение на полицейского — «против власти» вместо «против
    // порядка управления»). Без этой страховки длинные статьи выбранной главы
    // съедали весь объём, и верная статья со второго места поиска не доходила.
    var sure = opts.overlay ? 4 : 6;
    glob.forEach(function (h, r) {
      var di = h.doc._i;
      var ex = h.layers && h.layers.exact >= 100 ? 3 : 0;
      if (score[di] == null) add(di, (bmS[di] || 0) * 0.9);
      add(di, ex + (r < sure ? 0.8 - r * 0.06 : 0.25 * (1 - r / glob.length)));
    });
    // Слова самого вопроса — отдельно: термины плана их разбавляют, а в них
    // бывает самое точное («что такое субъект» → «Субъекты задержания»).
    if (plan && plan.terms && plan.terms.length) {
      var own = this.searchBalanced(String(question || ""), 6, 2);
      // Верх этого поиска весит как верх основного: слова игрока, совпавшие с
      // названием статьи, — самый надёжный сигнал из всех («порядок
      // задержания» → «Порядок задержания правомочным лицом»).
      own.forEach(function (h, r) { add(h.doc._i, (r < 3 ? 0.8 - r * 0.1 : 0.3 * (1 - r / own.length)) + (h.layers && h.layers.exact >= 100 ? 3 : 0)); });
    }
    // Слова вопроса целиком в названии статьи — надбавка. BM25 штрафует
    // длинные статьи, и «Порядок задержания правомочным лицом» (7 тыс.
    // символов, ПК 17 Орландо) на «какой порядок задержания?» уступала
    // коротким «Порядку ареста». Служебные короткие слова («как», «что»,
    // «такое») не считаются.
    var qs = tokenize(String(question || "")).filter(function (t) { return t.length >= 4; });
    if (qs.length) Object.keys(bmS).forEach(function (k) {
      var d = self.docs[k], hit = 0;
      qs.forEach(function (t) { if (d._title && d._title[t]) hit++; });
      if (hit && (hit === qs.length || hit >= 2)) add(+k, 0.6 * hit / qs.length);
    });
    var ranked = Object.keys(score).map(Number).sort(function (a, b) { return score[b] - score[a] || a - b; });
    var budget = opts.budget || 14000, max = opts.max || 30, out = [], len = 0;
    var line = opts.ctxLine || defaultCtxLine;
    // Один документ — не больше трети подборки (как DOC_CAP у поиска):
    // профильный закон («об обороте оружия» — «ношение» в каждой статье)
    // иначе занимал её целиком, и УК с наказанием не попадал. Лишние
    // статьи не пропадают, а идут вторым кругом, если останется место.
    var perCap = Math.max(3, Math.ceil(max / 3)), per = {}, later = [];
    var self2 = this;
    function take(d) {
      var s = line(d);
      if (!s) return;
      // длинная статья не вытесняет остальные: первым двум — больше места
      var cap = out.length < 2 ? 4000 : 1800;
      if (s.length > cap) s = s.slice(0, cap) + "…";
      if (len + s.length > budget) return;
      out.push({ doc: d, line: s }); len += s.length + 2;
    }
    ranked.forEach(function (di) {
      if (out.length >= max) return;
      var d = self2.docs[di], id = d.code_id || "";
      if ((per[id] || 0) >= perCap && score[di] < 3) { later.push(d); return; }
      per[id] = (per[id] || 0) + 1;
      take(d);
    });
    later.forEach(function (d) { if (out.length < max) take(d); });
    return out;
  };
  function defaultCtxLine(d) {
    var kind = isRuleCode(d.code_id) ? "п." : "ст.";
    var body = (d.parts || []).map(function (p) { return (p.n || "") + ": " + (p.t || ""); }).join("\n");
    return "[" + String(d.code_short || "").toUpperCase() + " " + kind + " " + d.num + "] " + d.title + (body ? "\n" + body : "");
  }

  // Сверка ссылок ответа с базой. Модель могут подвести и память, и спешка:
  // номер, которого в базе нет, не должен выглядеть как настоящий — его
  // применят в сцене не глядя. Проверяются только коды, которые у сервера
  // есть: «УК 10.5», «ПК ст. 17», «ОПП п. 2.1».
  ServerIndex.prototype.citeRefs = function (text) {
    var self = this;
    if (!this._shorts) {
      this._shorts = {};
      this.docs.forEach(function (d) {
        var c = String(d.code_short || "").toUpperCase().replace(/\s+/g, "");
        if (c) (self._shorts[c] = self._shorts[c] || {})[String(d.num)] = d;
      });
    }
    var re = /(^|[^А-ЯЁA-Za-zа-яё])([А-ЯЁA-Z][А-ЯЁA-Za-z]{0,5})\s*(?:ст\.?|стать[яиюеё]|п\.?|пункт)?\s*(\d+(?:\.\d+)*)/g;
    var out = [], seen = {}, m;
    var s = String(text || "");
    while ((m = re.exec(s))) {
      var code = m[2].toUpperCase(), num = m[3].replace(/\.$/, "");
      var nums = self._shorts[code];
      if (!nums) continue;
      var key = code + " " + num;
      if (seen[key]) continue;
      seen[key] = 1;
      out.push({ code: code, num: num, ok: !!nums[num], doc: nums[num] || null });
    }
    return out;
  };

  // «[УК ст. 17.2]» — модель копирует вид подборки; ссылка — без скобок
  function unbracket(text) {
    return String(text || "").replace(/\[\s*([А-ЯЁA-Z][А-ЯЁA-Za-z]{0,5}\s*(?:ст\.?|п\.?)\s*\d+(?:\.\d+)*(?:\s*(?:ч\.|п\.)\s*[\dа-я]+)?)\s*\]/g, "$1");
  }

  function withTimeout(p, ms, what) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { rej(new Error(what || "timeout")); }, ms);
      Promise.resolve(p).then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  }

  // Один вопрос целиком. o: index, llm (system, user) → text, planLlm —
  // модель для плана (по умолчанию та же), sys — промпты {plan, ai, overlay},
  // question, dialog (блок «РАНЕЕ В ДИАЛОГЕ» или ''), prevQ — прошлая
  // реплика игрока для поиска, overlay, ctxLine, cache — память планов.
  var LIMIT = 23000;
  async function ask(o) {
    var idx = o.index, toc = idx.toc(), ms = {}, plan = null, t0 = Date.now();
    var dialog = o.dialog || "";
    var key = dialog ? null : String(o.question || "").toLowerCase().trim();
    if (key && o.cache && o.cache[key]) plan = o.cache[key];
    else if (o.sys.plan) {
      try {
        var pu = "ОГЛАВЛЕНИЕ\n" + toc.text + "\n\n" + dialog.slice(-(LIMIT - toc.text.length - o.sys.plan.length - 1200)) +
          "ВОПРОС: " + String(o.question).slice(0, 600);
        plan = parsePlan(await withTimeout((o.planLlm || o.llm)(o.sys.plan, pu), o.planTimeout || 12000, "план не пришёл"), toc);
        if (plan && key && o.cache) o.cache[key] = plan;
      } catch (e) { plan = null; ms.planErr = String(e && e.message || e); }
    }
    ms.plan = Date.now() - t0;
    var kind = plan ? plan.kind : "qualify";
    var sys = o.overlay ? o.sys.overlay : o.sys.ai;
    var head = dialog + "ТИП ВОПРОСА: " + KIND_RU[kind] + "\nВопрос игрока: " + o.question + "\n\nДоступные статьи:\n";
    // запас 2,5 тыс. — под повторный запрос с исправлением номеров (он длиннее)
    var room = Math.max(3000, LIMIT - sys.length - head.length - 2700);
    var picked = kind === "chat" ? [] : idx.gather(o.question + (o.prevQ ? " " + o.prevQ : ""), plan, {
      overlay: !!o.overlay, ctxLine: o.ctxLine,
      budget: Math.min(o.overlay ? 9000 : 15000, room), max: o.overlay ? 12 : 30,
    });
    var user = head + (picked.length ? picked.map(function (p) { return p.line; }).join("\n\n")
      : "(статей к этому вопросу не нашлось — ответь по сути; номеров статей не называй)");
    var t1 = Date.now(), text = "", err = null;
    // Пустой ответ — повтор один раз: у моделей, которые сперва «думают»,
    // такое бывает, и человеку это выглядит как «ИИ не отвечает».
    for (var att = 0; att < 2 && !text; att++) {
      try { text = String(await withTimeout(o.llm(sys, user), o.answerTimeout || 45000, "ИИ не ответил за " + Math.round((o.answerTimeout || 45000) / 1000) + " с") || "").trim(); }
      catch (e) { err = e; break; }
    }
    ms.answer = Date.now() - t1;
    if (!text) throw (err || new Error("ИИ вернул пустой ответ"));
    text = unbracket(text);
    // Номер, которого в базе нет («УК 12.8.2» вместо 12.8 ч. 2 или 12.8.1), —
    // одна попытка исправиться: модель видит свой ответ и чужие номера.
    // Не исправилась — номер останется, но с пометкой «нет в базе».
    var cites = idx.citeRefs(text);
    var bad = cites.filter(function (c) { return !c.ok; });
    if (bad.length && o.fixRefs !== false) {
      var t2 = Date.now();
      try {
        // ближайшие настоящие номера того же кода: «12.8.2» → 12.8, 12.8.1
        var near = [];
        bad.forEach(function (c) {
          picked.forEach(function (p) {
            var d = p.doc, cs = String(d.code_short || "").toUpperCase().replace(/\s+/g, ""), n = String(d.num);
            var stem = c.num.split(".").slice(0, -1).join(".");
            if (cs === c.code && stem && (n === stem || n.indexOf(stem + ".") === 0)) near.push(cs + " " + n + " — " + cleanTitle(d.title, 70));
          });
        });
        var fixed = String(await withTimeout(o.llm(sys, user + "\n\nТВОЙ ОТВЕТ:\n" + text + "\n\nВ ответе номера, которых в списке нет: " +
          bad.map(function (c) { return c.code + " " + c.num; }).join(", ") + "." +
          (near.length ? " Похожие номера, которые в списке есть: " + near.slice(0, 6).join("; ") + "." : "") +
          " Часть статьи («ч. 2») — не отдельный номер. Перепиши ответ целиком в том же формате, бери номера только из списка. Подходящей нет — так и скажи."),
          o.answerTimeout || 45000, "исправление не пришло") || "").trim();
        if (fixed) {
          fixed = unbracket(fixed);
          var c2 = idx.citeRefs(fixed);
          if (c2.filter(function (c) { return !c.ok; }).length < bad.length) { text = fixed; cites = c2; }
        }
      } catch (e) {}
      ms.fix = Date.now() - t2;
    }
    return { text: text, plan: plan, kind: kind, docs: picked.map(function (p) { return p.doc; }),
      cites: cites, ms: ms, user: user };
  }

  // экспорт в глобальную область
  window.ProtocolAI = {
    ServerIndex: ServerIndex,
    Assistant: Assistant,
    tokenize: tokenize,
    stem: stem,
    ask: ask,
    parsePlan: parsePlan,
    cleanTitle: cleanTitle,
    KIND_RU: KIND_RU,
  };
})();
