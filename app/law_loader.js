// ═══════════════════════════════════════════════════════════════════
//  Загрузчик наборов законов (режим extern)
//  Подключить ДО остального кода: <script src="law_loader.js"></script>
// ═══════════════════════════════════════════════════════════════════
//
// Полная база (19 серверов x ~30 документов) весит десятки мегабайт —
// в один HTML её инлайнить нельзя, окно будет долго стартовать.
// Поэтому наборы лежат в data/{server}.json и грузятся при выборе сервера.
//
// АВТООБНОВЛЕНИЕ: свежая база скачивается в userData/data/ (личная папка
// приложения). Поэтому грузим В ДВА ЭТАПА:
//   1) сначала пробуем СКАЧАННЫЙ файл из userData (через мост winAPI.dataReadLocal)
//   2) если его нет — берём ВСТРОЕННЫЙ data/{server}.json (шёл вместе с .exe)
//
// getLaws() остаётся СИНХРОННОЙ: держим кэш и дёргаем перерисовку после загрузки.

const LAW_CACHE = {};          // server -> набор законов
let   LAW_LOADING = {};        // server -> Promise (чтобы не грузить дважды)

// Прочитать файл: сначала userData (скачанное), потом встроенный data/.
async function readDataFileText(file, skipLocal) {
  // 1) свежий скачанный файл из userData
  try {
    if (!skipLocal && typeof window !== 'undefined' && window.winAPI && window.winAPI.dataReadLocal) {
      const local = await window.winAPI.dataReadLocal(file);
      if (local) return local;
    }
  } catch (e) { /* нет моста или файла — идём дальше */ }
  // 2) встроенный сжатый файл data/{file}.br (так база едет в .exe: 33 МБ → 3.6 МБ)
  try {
    if (typeof window !== 'undefined' && window.winAPI && window.winAPI.dataReadBundled) {
      const packed = await window.winAPI.dataReadBundled(file);
      if (packed) return packed;
    }
  } catch (e) { /* нет моста или .br отсутствует — идём дальше */ }
  // 3) несжатый data/{file} — так работает `npm start` до прогона tools/pack-data.js
  try {
    const res = await fetch('data/' + file);
    if (res.ok) return await res.text();
  } catch (e) { /* оффлайн/нет файла */ }
  return null;
}

async function loadServerLaws(server) {
  if (LAW_CACHE[server]) return LAW_CACHE[server];
  if (LAW_LOADING[server]) return LAW_LOADING[server];

  LAW_LOADING[server] = (async () => {
    try {
      const text = await readDataFileText(server + '.json');
      if (!text) throw new Error('нет данных сервера');
      // Скачанный файл повреждён (оборванная запись) — не оставляем сервер
      // без законов, а берём встроенный набор.
      try { LAW_CACHE[server] = JSON.parse(text); }
      catch (e) { LAW_CACHE[server] = JSON.parse(await readDataFileText(server + '.json', true)); }
      return LAW_CACHE[server];
    } catch (e) {
      console.warn('Не удалось загрузить законы сервера', server, e);
      return null;                 // сработает запасной вариант в getLaws
    } finally {
      delete LAW_LOADING[server];
    }
  })();
  return LAW_LOADING[server];
}

// Манифест (пара КБ): какие серверы имеют данные + дата базы.
// Тоже грузим userData-first, чтобы после обновления дата была свежей.

const SERVERS_WITH_DATA = new Set();

(async function preloadManifest() {
  try {
    const text = await readDataFileText('manifest.json');
    if (!text) return;
    const mani = JSON.parse(text);
    // Новый формат: { updated, date, servers:{...} }. Старый: плоский { server:... }.
    const servers = mani.servers ? mani.servers : mani;
    for (const srv of Object.keys(servers)) SERVERS_WITH_DATA.add(srv);
    // date — короткий день для показа в футере; updated — метка времени для сравнения
    if (typeof window !== 'undefined') {
      window.__localDataDate = mani.date || (mani.updated ? String(mani.updated).slice(0, 10) : '');
    }
    // сообщаем приложению, что список доступности обновился
    if (typeof window !== 'undefined' && window.__protocolOnManifest)
      window.__protocolOnManifest();
  } catch (e) { /* оффлайн — останутся статические замки */ }
})();

// Сброс кэша конкретного сервера — нужно после скачивания свежей базы,
// чтобы loadServerLaws перечитал файл из userData, а не отдал старое из кэша.
function invalidateServerLaws(server) {
  try { delete LAW_CACHE[server]; } catch (e) {}
  try { delete LAW_LOADING[server]; } catch (e) {}
}
if (typeof window !== 'undefined') window.invalidateServerLaws = invalidateServerLaws;
