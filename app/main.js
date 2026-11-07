const { app, BrowserWindow, Menu, ipcMain, globalShortcut, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
// PROTOCOL_USER_DATA — отдельная папка настроек: проверка собранного .exe не
// должна трогать настоящие заметки, избранное и счётчик пользователя.
if (process.env.PROTOCOL_USER_DATA) app.setPath('userData', process.env.PROTOCOL_USER_DATA);
const privacyFile = () => path.join(app.getPath('userData'), 'privacy.json');
let privacy = {};
const https = require('https');

// Репозиторий для проверки обновлений
const REPO = 'Fox-Cod/Protocol';

// ── Анонимный счётчик запусков ────────────────────────────────────────────
// С включённым автообновлением счётчик скачиваний на GitHub перестал что-либо
// значить: люди обновляются молча. Без этого приложение улучшается вслепую.
//
// Наружу уходит РОВНО два поля: дневной хеш и версия. Хеш — это
// SHA-256(случайный номер установки + сегодняшняя дата), поэтому завтра у того
// же человека он будет другим: счётчик умеет сказать «сколько разных людей
// заходило сегодня» и физически не может связать вчерашнего с сегодняшним.
// Сам номер установки лежит в userData/stats.json и наружу не уходит никогда.
//
// Пустой адрес полностью выключает всю эту машинерию.
const STATS_WORKER_URL = ''   /* сервер автора убран из открытой версии — поднимите свой, см. app/README.md */;

const statsFile = () => path.join(app.getPath('userData'), 'stats.json');

function statsState() {
  try { return JSON.parse(fs.readFileSync(statsFile(), 'utf8')) || {}; } catch (e) { return {}; }
}

// Тело запроса собирается ЗДЕСЬ И ТОЛЬКО ЗДЕСЬ, потому что ровно эти байты
// показываются человеку в настройках («что именно уходит»). Разъедься сборка
// и показ — и объяснение станет враньём, а это хуже, чем не объяснять вовсе.
function statsPayload() {
  const day = new Date().toISOString().slice(0, 10);
  const st = statsState();
  if (!st.id) {
    st.id = require('crypto').randomBytes(16).toString('hex');
    try { fs.writeFileSync(statsFile(), JSON.stringify(st)); } catch (e) {}
  }
  const digest = require('crypto').createHash('sha256').update(st.id + '|' + day).digest('hex').slice(0, 32);
  return {
    day,
    lastPing: st.lastPing || '',
    url: STATS_WORKER_URL + '/ping',
    // note видно всякому, кто смотрит трафик: запрос объясняет сам себя,
    // не дожидаясь, пока человек найдёт объяснение в настройках
    body: { d: digest, v: app.getVersion(), note: 'анонимный счётчик запусков Protocol; d = SHA-256(случайное число + сегодняшняя дата), меняется каждые сутки' },
  };
}

// Отдаём окну то же самое, что уйдёт на сервер. Номер установки (st.id)
// сюда не попадает и не должен: наружу уходит только его хеш.
ipcMain.handle('stats-preview', () => {
  const p = statsPayload();
  return { url: p.url, body: p.body, day: p.day, lastPing: p.lastPing, enabled: privacy.stats !== false && !!STATS_WORKER_URL };
});

// Пинг раз в сутки и только при согласии. Любая ошибка глотается: счётчик —
// не та вещь, ради которой пользователь должен видеть сообщение об ошибке.
function pingStats() {
  if (!STATS_WORKER_URL) return;
  if (privacy.stats === false) return;
  const p = statsPayload();
  const day = p.day;
  const st = statsState();
  if (st.lastPing === day) return;
  const body = JSON.stringify(p.body);
  let u;
  try { u = new URL(STATS_WORKER_URL + '/ping'); } catch (e) { return; }
  const req = https.request({
    hostname: u.hostname, path: u.pathname, method: 'POST', timeout: 6000,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'x-app-secret': DATA_APP_SECRET,  // та же константа, что у воркера базы (см. ниже по файлу)
      'User-Agent': 'Protocol-App',
    },
  }, (res) => {
    res.resume();
    // День отмечаем только при успехе, иначе оффлайн-запуск съел бы попытку
    if (res.statusCode === 200) {
      st.lastPing = day;
      try { fs.writeFileSync(statsFile(), JSON.stringify(st)); } catch (e) {}
    }
  });
  req.on('error', () => {});
  req.on('timeout', () => { try { req.destroy(); } catch (e) {} });
  req.end(body);
}

// Сравнение версий: 1 если a<b (b новее), -1 если a>b, 0 равны
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x < y) return 1;
    if (x > y) return -1;
  }
  return 0;
}

// Спросить у GitHub последнюю версию релиза.
// manualEvent — если задан, это ручная проверка: всегда отвечаем результатом
// (есть новее / уже последняя / ошибка), а не только шлём баннер.
function checkForUpdate(manualEvent) {
  const options = {
    hostname: 'api.github.com',
    path: `/repos/${REPO}/releases/latest`,
    method: 'GET',
    headers: { 'User-Agent': 'Protocol-App', 'Accept': 'application/vnd.github+json' },
    timeout: 8000,
  };
  const reply = (payload) => {
    if (manualEvent && manualEvent.sender && !manualEvent.sender.isDestroyed()) {
      manualEvent.sender.send('update-check-result', payload);
    }
  };
  const req = https.request(options, (res) => {
    // Байтами, а не «data += c»: кусок, превращённый в текст сам по себе,
    // режет русскую букву на границе — в списке изменений выходило «�».
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const data = Buffer.concat(chunks).toString('utf8');
      try {
        if (res.statusCode !== 200) { reply({ status: 'error' }); return; }
        const json = JSON.parse(data);
        const latest = (json.tag_name || json.name || '').replace(/^v/, '');
        if (!latest) { reply({ status: 'error' }); return; }
        const url = json.html_url || `https://github.com/${REPO}/releases/latest`;
        // Тело релиза — это список изменений. Показываем его прямо в окне,
        // чтобы человек видел, ЧТО обновляется, а не только «доступна версия».
        const notes = String(json.body || '').slice(0, 8000);
        // Портативная сборка — один .exe в ассетах релиза.
        const asset = (json.assets || []).find((a) => /\.exe$/i.test(a.name || ''));
        // GitHub сам считает SHA-256 каждого файла релиза (поле digest,
        // «sha256:…»). Сверяем с ним скачанное: размер не ловит подмену
        // файла того же размера. У старых релизов поля нет — тогда как раньше.
        const dg = asset && /^sha256:([0-9a-f]{64})$/i.exec(String(asset.digest || ''));
        const payload = {
          version: latest, url, notes,
          asset: asset ? asset.browser_download_url : '',
          size: asset ? asset.size : 0,
          sha256: dg ? dg[1].toLowerCase() : '',
          published: json.published_at || '',
        };
        if (compareVersions(app.getVersion(), latest) === 1) {
          latestUpdate = payload;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update-available', payload);
          }
          reply(Object.assign({ status: 'update' }, payload));
        } else {
          reply({ status: 'latest', version: app.getVersion(), notes, url });
        }
      } catch (e) { reply({ status: 'error' }); }
    });
  });
  req.on('error', () => reply({ status: 'error' }));   // нет интернета
  req.on('timeout', () => { req.destroy(); reply({ status: 'error' }); });
  req.end();
}

let mainWindow;
let latestUpdate = null;          // последний известный релиз (см. checkForUpdate)
const stickers = new Set();

// ══════════════════════════════════════════════════════════════════
//  Автообновление приложения
//
//  Сборка портативная — это один Protocol.exe без установщика. Заменить
//  работающий .exe на месте Windows не даст, поэтому схема такая:
//    1) качаем новый файл в userData/update/
//    2) пишем рядом .cmd, который ЖДЁТ выхода приложения, подменяет файл,
//       запускает его снова и удаляет себя
//    3) закрываем приложение — дальше всё делает .cmd
//  Пользователь в любой момент может отключить автозагрузку в настройках:
//  тогда остаётся только уведомление со списком изменений.
// ══════════════════════════════════════════════════════════════════
const { spawn } = require('child_process');
const UA = require('./update_apply');
const updateDir = () => {
  const d = path.join(app.getPath('userData'), 'update');
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  return d;
};

// Скачивание с поддержкой редиректов GitHub и отчётом о прогрессе.
function downloadFile(url, dest, onProgress, redirects) {
  return new Promise((resolve, reject) => {
    if ((redirects || 0) > 5) return reject(new Error('слишком много перенаправлений'));
    const req = https.get(url, { headers: { 'User-Agent': 'Protocol-App' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(downloadFile(res.headers.location, dest, onProgress, (redirects || 0) + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => { got += c.length; if (onProgress) onProgress(got, total); });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve({ path: dest, size: got })));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(new Error('таймаут загрузки')); });
  });
}

// Скачанный файл обновления — тот ли, что в релизе. Без суммы в релизе
// (старые релизы) проверить нечем — считаем верным, как и раньше.
async function updateFileOk(file) {
  if (!latestUpdate || !latestUpdate.sha256) return true;
  try { return (await BI.sha256File(file)) === latestUpdate.sha256; }
  catch (e) { return false; }
}

ipcMain.handle('update-download', async () => {
  try {
    if (!latestUpdate || !latestUpdate.asset) return { ok: false, error: 'нет файла в релизе' };
    const dest = path.join(updateDir(), 'Protocol-' + latestUpdate.version + '.exe');
    // Уже скачан целиком — второй раз не тянем.
    if (fs.existsSync(dest) && latestUpdate.size && fs.statSync(dest).size === latestUpdate.size
        && await updateFileOk(dest)) {
      return { ok: true, path: dest, cached: true };
    }
    const send = (done, total) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-download-progress', { done, total });
      }
    };
    const res = await downloadFile(latestUpdate.asset, dest, send);
    if (latestUpdate.size && res.size !== latestUpdate.size) {
      try { fs.unlinkSync(dest); } catch (e) {}
      return { ok: false, error: 'файл скачан не полностью' };
    }
    if (!(await updateFileOk(dest))) {
      try { fs.unlinkSync(dest); } catch (e) {}
      return { ok: false, error: 'контрольная сумма не совпала с релизом — файл удалён, обновление не установлено' };
    }
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('update-install', async (e, arg) => {
  try {
    const src = arg && arg.path;
    if (!src || !fs.existsSync(src)) return { ok: false, error: 'файл обновления не найден' };
    // Ещё раз перед подменой: между скачиванием и установкой файл лежит в
    // userData, и путь приходит из окна.
    if (path.dirname(path.resolve(src)) !== path.resolve(updateDir())) {
      return { ok: false, error: 'файл обновления не из папки обновлений' };
    }
    if (!(await updateFileOk(src))) {
      try { fs.unlinkSync(src); } catch (err) {}
      return { ok: false, error: 'контрольная сумма не совпала с релизом — обновление не установлено' };
    }
    // Заменяется файл, который скачал человек, а не временная копия
    // portable-распаковщика (подробно — update_apply.js; до 4.2.0 обновление
    // из-за этого не доходило до Protocol.exe).
    const cur = UA.updateTarget(process.env, app.getPath('exe'), app.isPackaged);
    if (!cur) return { ok: false, error: 'запуск из исходников — обновлять нечего' };
    if (!UA.canWriteDir(path.dirname(cur))) {
      return { ok: false, error: 'нет прав на запись в папку «' + path.dirname(cur) + '». Скачайте новую версию со страницы релизов и замените файл вручную' };
    }
    const cmd = path.join(updateDir(), 'apply-update.cmd');
    const job = { src, dst: cur, log: path.join(updateDir(), 'update.log') };
    fs.writeFileSync(cmd, UA.applyScript(job), 'utf8');
    UA.applyLogStart(job);
    // пути — переменными окружения: в тексте скрипта кириллица без консоли ломается
    const child = spawn('cmd.exe', ['/c', cmd], { detached: true, stdio: 'ignore', windowsHide: true,
      env: Object.assign({}, process.env, UA.applyEnv(job)) });
    child.unref();
    setTimeout(() => { try { app.quit(); } catch (err) {} }, 400);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// ── Хранилище стикеров (позиции, размер, текст) между запусками ──
const stickersFile = () => path.join(app.getPath('userData'), 'stickers.json');
function loadStickerData() {
  try { return JSON.parse(fs.readFileSync(stickersFile(), 'utf-8')); }
  catch { return {}; }
}
function saveStickerData(data) {
  try { fs.writeFileSync(stickersFile(), JSON.stringify(data)); } catch {}
}
function persistStickers() {
  const data = {};
  for (const s of stickers) {
    if (s.isDestroyed()) continue;
    const id = s._stickerId;
    if (!id) continue;
    const [x, y] = s.getPosition();
    const [w, h] = s.getSize();
    data[id] = { x, y, w, h, text: s._stickerText || '', title: s._stickerTitle || '',
      opacity: s._stickerOpacity, dark: s._stickerDark, fontSize: s._stickerFontSize };
  }
  saveStickerData(data);
}
let noFocusMode = false;   // режим «не красть фокус у игры»
let isQuitting = false;    // приложение закрывается — не трогаем файл стикеров из обработчиков
let userAlwaysTop = false; // пользователь сам включил «поверх других окон» кнопкой ⇧

const winStateFile = () => path.join(app.getPath('userData'), 'window-state.json');
function readWinState() { try { return JSON.parse(fs.readFileSync(winStateFile(), 'utf8')); } catch (e) { return null; } }
let _wsTimer = null;
function writeWinState() {
  if (_wsTimer) clearTimeout(_wsTimer);
  _wsTimer = setTimeout(() => { try { if (mainWindow && !mainWindow.isDestroyed()) fs.writeFileSync(winStateFile(), JSON.stringify(mainWindow.getBounds())); } catch (e) {} }, 300);
}

function createWindow() {
  const _ws = readWinState() || {};
  mainWindow = new BrowserWindow({
    width: _ws.width || 820,
    height: _ws.height || 680,
    x: (typeof _ws.x === 'number' ? _ws.x : undefined),
    y: (typeof _ws.y === 'number' ? _ws.y : undefined),
    minWidth: 480,
    minHeight: 440,
    title: 'Protocol',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  Menu.setApplicationMenu(null);
  mainWindow.removeMenu();               // полностью убираем меню, чтобы Alt+буква не активировала его
  mainWindow.setMenuBarVisibility(false);
  ['resize', 'move', 'close'].forEach(function (ev) { mainWindow.on(ev, writeWinState); });
  // UI приложения. Чтобы вернуть старый интерфейс — поставь 'GovHelper.html'.
  mainWindow.loadFile('lumen.html');

  // Блокируем системное меню по Alt (Alt+F и т.п. больше не «замораживают» окно).
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.alt && !input.control && !input.meta && !input.shift) {
      // одиночный Alt или Alt+одна буква/цифра — гасим (это триггеры системного меню)
      if (input.key === 'Alt' || (input.key && input.key.length === 1)) {
        event.preventDefault();
      }
    }
  });

  // После разворачивания из панели задач — вернуть режим «не красть фокус», если он был.
  // Флаг перепроверяется уже ПОСЛЕ задержки: если окно развернули горячей
  // клавишей ради ввода (ИИ, избранное), режим за эти 300 мс уже снят —
  // раньше он возвращался поверх, и печатать в поле было нельзя.
  mainWindow.on('restore', () => {
    if (!mainWindow._restoreNoFocus) return;
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || !mainWindow._restoreNoFocus) return;
      applyFocusMode(true, { raise: true });   // окно только что развернули — оно на виду
    }, 300);
  });

  // Закрытие главного окна → приложение уходит.
  // ВАЖНО: сначала сохраняем стикеры, потом закрываем. Иначе обработчик
  // 'closed' у каждого стикера дёргает persistStickers() на уже редеющем
  // списке окон и затирает файл — заметки пропадают при следующем запуске.
  mainWindow.on('closed', () => {
    isQuitting = true;
    persistStickers();                 // снимок всех позиций/текста ДО закрытия
    for (const s of stickers) { if (!s.isDestroyed()) s.close(); }
    stickers.clear();
    if (aiOverlayWin && !aiOverlayWin.isDestroyed()) aiOverlayWin.close(); // закрываем ИИ-оверлей вместе с приложением
    // Окно разбора сцены тоже. Пока оно открыто, «все окна закрыты» не
    // наступает, приложение не завершается, а служба продолжает держать
    // микрофон — при том что разбор живёт в главном окне и окно сцены
    // перестаёт обновляться. То есть микрофон включён, а показывать нечего.
    voiceShutdown();
    mainWindow = null;
  });
}

// Режим разработчика: открыть/закрыть DevTools по запросу из окна.
// Эти два обработчика жили внутри createWindow, и аварийное пересоздание
// окна (кнопка в трее, activate) вешало их второй раз: DevTools открывались
// и тут же закрывались, сброс окна срабатывал дважды.
ipcMain.on('open-devtools', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.toggleDevTools();
});

ipcMain.on('reset-app-state', () => {
  try { if (fs.existsSync(winStateFile())) fs.unlinkSync(winStateFile()); } catch (e) {}
  try { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.setSize(820, 680); mainWindow.center(); } } catch (e) {}
});

// Режим «не красть фокус у игры»: окно не активируется при клике,
// поэтому звук и управление остаются в игре. Печатать в поля нельзя.
// Сквозная прозрачность главного окна для мыши. Вынесена отдельно, потому что
// окно временно «ловит» мышь обратно, когда курсор над блоком управления, —
// иначе выключить режим было бы нечем.
function setMainClickThrough(on) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // forward:true обязателен: без него окно перестаёт получать и движения мыши,
  // а значит не узнает, что курсор вернулся на кнопку «Фокус».
  try { mainWindow.setIgnoreMouseEvents(!!on, { forward: true }); } catch (err) {}
}

// Окно просит вернуть себе мышь, пока курсор над блоком управления.
ipcMain.on('win-mouse-through', (e, on) => {
  if (!noFocusMode) return;            // вне игрового режима это не наше дело
  setMainClickThrough(on);
});

/**
 * Режим «Фокус игры» — ЕДИНСТВЕННОЕ место, где он включается и выключается.
 *
 * Раньше каждый из путей (кнопка, горячая клавиша, вызов окна для ввода,
 * аварийный вызов, разворачивание) трогал свой набор окон. Вызов окна
 * горячей клавишей снимал режим с главного окна, но не говорил об этом
 * интерфейсу и не трогал заметки: кнопка «Фокус» продолжала гореть, заметки
 * оставались сквозными, а следующее Ctrl+D «выключало» уже выключенное —
 * нажимать приходилось дважды. Теперь состояние живёт здесь, а интерфейс
 * только показывает его (nofocus-restored).
 *
 * Что делает режим с окнами:
 *   главное — не фокусируется, мышь насквозь (кроме блока управления),
 *             держится поверх игры;
 *   заметки и окно Bodycam — мышь насквозь целиком: их видно, но курсор игры
 *             о них не спотыкается. Bodycam ведётся клавишей этапа, а не мышью.
 */
// raise — поднимать ли главное окно поверх игры. Режим меняет только то,
// берёт ли окно мышь и фокус, а не то, какое окно впереди: включённый
// клавишей из игры, он вытаскивал поверх GTA Protocol, который пользователь
// убрал за игру (жалоба 31.10.2026). Поднимаем, только если окно и так на
// виду: нажата кнопка в нём самом, его развернули, или оно уже закреплено
// «поверх всех» — тогда уровень повыше, чтобы игра «Без рамки» не накрыла.
// Вернуть фокус туда, где был человек (в игру), оставив окно на экране.
// Игра без фокуса глушит звук: пока Protocol активен, звука нет. Спрятать
// активное окно — Windows сама отдаёт активность предыдущему (игре); сразу
// показать его снова, не активируя, — ответ или статья остаются на виду.
// Окно перед этим — нефокусируемое: щелчок по нему фокус больше не заберёт.
let focusBackOn = true;   // настройка «Возвращать фокус в игру» (приходит из окна)
ipcMain.on('set-focus-back', (e, v) => { focusBackOn = !!v; });
function giveFocusBack(w) {
  if (!focusBackOn) return false;
  if (!w || w.isDestroyed() || !w.isVisible() || w.isMinimized() || !w.isFocused()) return false;
  try { w.setFocusable(false); w.hide(); w.showInactive(); } catch (e) { return false; }
  return true;
}

function applyFocusMode(on, opts) {
  const wasActive = !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused());
  noFocusMode = !!on;
  const raise = !!(opts && opts.raise) || (noFocusMode && wasActive);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow._restoreNoFocus = false;
    // Свёрнутое нефокусируемое окно потом не развернуть — режим
    // применится при разворачивании (обработчик 'restore').
    if (mainWindow.isMinimized()) {
      mainWindow._restoreNoFocus = noFocusMode;
      if (!noFocusMode) setMainClickThrough(false);
    } else {
      mainWindow.setFocusable(!noFocusMode);
      // Мало сделать окно нефокусируемым: курсор всё равно цепляется за него,
      // кнопки подсвечиваются, а клик уходит в Protocol вместо игры.
      setMainClickThrough(noFocusMode);
      if (noFocusMode) {
        if (raise || mainWindow.isAlwaysOnTop()) mainWindow.setAlwaysOnTop(true, 'screen-saver');
        // Режим включили, сидя в Protocol (Ctrl+D или кнопка «Фокус»): окно
        // остаётся поверх игры дочитать, а фокус — обратно в игру (06.11.2026:
        // «пропадает звук, приходится быстро возвращаться в игру»)
        if (wasActive) giveFocusBack(mainWindow);
      } else if (!userAlwaysTop) mainWindow.setAlwaysOnTop(false);
    }
    mainWindow.webContents.send('nofocus-restored', noFocusMode);
  }
  for (const s of stickers) {
    if (s.isDestroyed()) continue;
    s.setFocusable(!noFocusMode);
    setStickerClickThrough(s, noFocusMode);
  }
  applySceneFocus();
}

// кнопка «Фокус» в самом окне — значит, окно на виду: держим его поверх игры
ipcMain.on('win-nofocus', (e, on) => applyFocusMode(on, { raise: true }));
// Клавиша «Фокус игры» — из игры, окно может стоять за ней: не поднимаем.
function toggleFocusMode() {
  applyFocusMode(!(noFocusMode || (mainWindow && mainWindow._restoreNoFocus)));
}
// Интерфейс спрашивает при загрузке: после перезагрузки окна (DevTools,
// аварийное пересоздание) он иначе считал бы режим выключенным.
ipcMain.handle('get-nofocus', () => noFocusMode);

// Кнопки главного окна
ipcMain.on('win-minimize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Перед сворачиванием обязательно делаем окно фокусируемым и видимым в панели задач,
  // иначе не-фокусируемое окно «исчезает» и его не вызвать обратно.
  const wasNoFocus = noFocusMode;
  mainWindow.setAlwaysOnTop(false);      // снимаем screen-saver уровень, мешающий сворачиванию
  mainWindow.setFocusable(true);
  mainWindow.setSkipTaskbar(false);
  mainWindow._restoreNoFocus = wasNoFocus;
  mainWindow.minimize();
});
ipcMain.on('win-close', () => mainWindow && mainWindow.close());

// Открыть страницу релиза в браузере (кнопка «Обновить» в баннере)
ipcMain.on('open-release-page', (e, url) => {
  try { shell.openExternal(safeWebUrl(url) || `https://github.com/${REPO}/releases/latest`); } catch (err) {}
});

// Открыть внешнюю ссылку в системном браузере. Только https: shell.openExternal
// открывает и file:, и ms-msdt:, и прочие схемы, через которые запускаются
// программы, — окно не должно уметь передать туда что угодно.
function safeWebUrl(url) {
  try { const u = new URL(String(url || '')); return u.protocol === 'https:' ? u.href : ''; } catch (e) { return ''; }
}
ipcMain.on('open-external', (e, url) => { const u = safeWebUrl(url); try { if (u) shell.openExternal(u); } catch (err) {} });
// Папка данных (настройки → «О программе»): к сообщению об ошибке прикладывают
// её содержимое. Путь только свой — окно ничего не передаёт.
ipcMain.on('open-user-data', () => { try { shell.openPath(app.getPath('userData')); } catch (err) {} });
ipcMain.on('check-update', (e) => checkForUpdate(e));
ipcMain.on('set-privacy', (e, obj) => { privacy = Object.assign({}, privacy, obj || {}); try { fs.writeFileSync(privacyFile(), JSON.stringify(privacy)); } catch (err) {} });

ipcMain.on('win-top', (e, val) => {
  userAlwaysTop = !!val;
  if (mainWindow) mainWindow.setAlwaysOnTop(!!val);
});

// Пропускать ли мышь сквозь окно-заметку.
// forward:true нужен, чтобы окно всё же получало движения курсора — иначе
// на части систем окно перестаёт перерисовываться.
function setStickerClickThrough(win, on) {
  try { win.setIgnoreMouseEvents(!!on, { forward: true }); } catch (err) {}
  // Сообщаем окну — оно подсветит рамку синим, чтобы было видно,
  // что заметка сейчас сквозная для мыши.
  try {
    if (win.webContents && !win.webContents.isDestroyed())
      win.webContents.send('sticker-nofocus', !!on);
  } catch (err) {}
}

// Создать отдельное окно-стикер поверх всего
function spawnSticker(opts = {}) {
  const s = new BrowserWindow({
    width: opts.w || 280,
    height: opts.h || 200,
    x: (typeof opts.x === 'number') ? opts.x : undefined,
    y: (typeof opts.y === 'number') ? opts.y : undefined,
    minWidth: 170,
    minHeight: 110,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  s._stickerId = opts.id || ('s_' + Date.now() + '_' + Math.floor(Math.random()*1000));
  s._stickerText = opts.text || '';
  s._stickerTitle = opts.title || '';
  s._stickerOpacity = opts.opacity;
  s._stickerDark = opts.dark;
  s._stickerFontSize = opts.fontSize;
  s.setAlwaysOnTop(true, 'screen-saver');
  // Заметка, созданная уже в игровом режиме, сразу должна быть сквозной
  if (noFocusMode) { s.setFocusable(false); setStickerClickThrough(s, true); }
  s.loadFile('sticker.html');
  s.webContents.once('did-finish-load', () => {
    s.webContents.send('sticker-init', {
      text: s._stickerText, title: s._stickerTitle,
      opacity: s._stickerOpacity, dark: s._stickerDark, fontSize: s._stickerFontSize,
    });
    if (noFocusMode) s.webContents.send('sticker-nofocus', true);
  });
  const save = () => { s._saveT && clearTimeout(s._saveT); s._saveT = setTimeout(persistStickers, 400); };
  s.on('move', save);
  s.on('resize', save);
  stickers.add(s);
  // Пока приложение закрывается, не пересохраняем — иначе затрём файл
  // на редеющем списке окон и потеряем позиции при следующем запуске.
  s.on('closed', () => { stickers.delete(s); if (!isQuitting) persistStickers(); });
  return s;
}

// ═══════════════ БЫСТРЫЙ ИИ-ОВЕРЛЕЙ ПОВЕРХ ИГРЫ ═══════════════
// Компактное окно только с полем ввода и ответом. Вызов/скрытие по Ctrl+Q.
// Не крадёт фокус у игры (голосовой чат Majestic продолжает работать).
let aiOverlayWin = null;

function aiOverlayFile() { return path.join(app.getPath('userData'), 'ai_overlay_pos.json'); }
function loadAiOverlayPos() {
  try { return JSON.parse(fs.readFileSync(aiOverlayFile(), 'utf8')); } catch (e) { return null; }
}
function saveAiOverlayPos() {
  if (!aiOverlayWin || aiOverlayWin.isDestroyed()) return;
  try {
    const b = aiOverlayWin.getBounds();
    fs.writeFileSync(aiOverlayFile(), JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height }));
  } catch (e) {}
}

function createAiOverlay() {
  const pos = loadAiOverlayPos() || {};
  // Прозрачное окно без системной тени: скругление и рамку рисует сама
  // страница (раньше квадратное тёмное окно торчало углами из-за панели).
  // Высоту подгоняет страница под ответ (ai-overlay-fit), руками её не тянут.
  aiOverlayWin = new BrowserWindow({
    width: Math.max(380, Math.min(560, pos.w || 440)),
    height: 160,
    x: (typeof pos.x === 'number') ? pos.x : undefined,
    y: (typeof pos.y === 'number') ? pos.y : undefined,
    frame: false,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  aiOverlayWin.setAlwaysOnTop(true, 'screen-saver');
  aiOverlayWin.loadFile(path.join(__dirname, 'ai-overlay.html'));
  // Показываем окно ТОЛЬКО когда контент готов — иначе прозрачное окно
  // может отрисоваться пустым/невидимым до загрузки ai-overlay.html.
  aiOverlayWin.once('ready-to-show', () => {
    aiOverlayWin.show();
    aiOverlayWin.focus();
    try { aiOverlayWin.setOpacity(0.95); } catch (e) {} // лёгкая прозрачность по умолчанию
  });
  const save = () => { aiOverlayWin._saveT && clearTimeout(aiOverlayWin._saveT); aiOverlayWin._saveT = setTimeout(saveAiOverlayPos, 400); };
  aiOverlayWin.on('move', save);
  aiOverlayWin.on('resize', save);
  aiOverlayWin.on('closed', () => { aiOverlayWin = null; });
  return aiOverlayWin;
}

let aiOverlayKey = 'Alt+Q';   // клавиша быстрого ИИ, какая реально назначена (подсказка в окне)
// Окно Alt+Q снова принимает ввод: после вопроса оно было нефокусируемым
// (фокус ушёл обратно в игру, см. ai-overlay-return-focus)
function aiOverlayTakeFocus() {
  if (!aiOverlayWin || aiOverlayWin.isDestroyed()) return;
  aiOverlayWin.setFocusable(true);
  aiOverlayWin.show();
  aiOverlayWin.focus();
  aiOverlayWin.webContents.send('ai-overlay-focus');
}

function toggleAiOverlay() {
  if (aiOverlayWin && !aiOverlayWin.isDestroyed()) {
    // Видно и в фокусе — спрятать. Видно с ответом, а фокус в игре —
    // новый вопрос: иначе после ответа Alt+Q прятал бы окно, и чтобы
    // спросить ещё, жать пришлось бы дважды.
    if (aiOverlayWin.isVisible() && aiOverlayWin.isFocused()) aiOverlayWin.hide();
    else aiOverlayTakeFocus();
    return;
  }
  createAiOverlay();
  aiOverlayWin.webContents.once('did-finish-load', () => {
    aiOverlayWin.webContents.send('ai-overlay-focus');
  });
}

ipcMain.on('ai-overlay-hide', () => { if (aiOverlayWin && !aiOverlayWin.isDestroyed()) aiOverlayWin.hide(); });
// Вопрос отправлен — фокус обратно в игру, ответ остаётся на экране (звук
// игры возвращается, пока ИИ думает). Просит только само окно Alt+Q.
ipcMain.on('ai-overlay-return-focus', (e) => {
  if (!aiOverlayWin || aiOverlayWin.isDestroyed() || e.sender !== aiOverlayWin.webContents) return;
  if (giveFocusBack(aiOverlayWin)) aiOverlayWin.webContents.send('ai-overlay-away', aiOverlayKey);
});
// Щелчок в поле вопроса, когда фокус в игре: окно снова принимает ввод
ipcMain.on('ai-overlay-want-focus', (e) => {
  if (!aiOverlayWin || aiOverlayWin.isDestroyed() || e.sender !== aiOverlayWin.webContents) return;
  if (!aiOverlayWin.isFocused()) aiOverlayTakeFocus();
});
// Плитка «Быстрый ИИ» на главной: только открыть (уже открыто — в фокус), не переключать
ipcMain.on('ai-overlay-open', () => {
  if (aiOverlayWin && !aiOverlayWin.isDestroyed() && aiOverlayWin.isVisible()) { aiOverlayTakeFocus(); return; }
  toggleAiOverlay();
});
// Высота — по содержимому окна: ответ виден целиком. Ширина и место — прежние.
ipcMain.on('ai-overlay-fit', (e, h) => {
  if (!aiOverlayWin || aiOverlayWin.isDestroyed()) return;
  const b = aiOverlayWin.getBounds();
  const nh = Math.max(110, Math.min(680, Math.round(Number(h) || 0)));
  if (Math.abs(nh - b.height) > 1) aiOverlayWin.setBounds({ x: b.x, y: b.y, width: b.width, height: nh });
});
// Щелчок по статье в ответе — Protocol открывает её (тот же путь, что ссылки Bodycam)
ipcMain.on('ai-overlay-ref', (e, ref) => {
  if (mainWindow && !mainWindow.isDestroyed() && typeof ref === 'string' && ref.length < 40) {
    mainWindow.webContents.send('scene-action', { type: 'ref', ref });
  }
});

// Мост: оверлей просит ответ ИИ у главного окна (там база законов и вся логика askAI).
// Оверлей шлёт 'overlay-ask' → пересылаем в главное окно → ответ 'overlay-ask-result' → назад в оверлей.
// ═══════════════ ОБНОВЛЕНИЕ БАЗЫ ЗАКОНОВ (через воркер-прокси) ═══════════════
// Каркас: скачивает manifest.json и {server}.json с воркера базы, кладёт в userData/data/.
// TODO(дома): подставить реальный адрес воркера и APP_SECRET (лучше из ai_config, не хардкодить).
const DATA_WORKER_URL = ''   /* сервер автора убран из открытой версии — поднимите свой, см. app/README.md */; // адрес воркера базы
const DATA_APP_SECRET = ''   /* сервер автора убран из открытой версии — поднимите свой, см. app/README.md */;                          // APP_SECRET воркера базы

function userDataDir() {
  const d = path.join(app.getPath('userData'), 'data');
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  return d;
}

// Скачать один файл (manifest.json или {server}.json) с воркера базы.
function fetchDataFile(file) {
  return new Promise((resolve, reject) => {
    // Пустой адрес — сборка из открытых исходников без своего сервера базы:
    // встроенная база работает, обновлять её неоткуда (см. app/README.md)
    if (!DATA_WORKER_URL) { reject(new Error('сервер базы не настроен — встроенная база работает, обновлений не будет')); return; }
    const url = DATA_WORKER_URL + '/?file=' + encodeURIComponent(file);
    const req = https.get(url, { headers: { 'x-app-secret': DATA_APP_SECRET } }, (res) => {
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); res.resume(); return; }
      // Байтами, текст — в конце. До 4.2.0 здесь было «data += c»: каждый
      // кусок ответа превращался в текст отдельно, и русская буква (два байта
      // в UTF-8), разрезанная на границе кусков, становилась «�». Скачанная
      // база выходила с испорченными словами — «у��азанных», «20 дн��й»: у
      // автора ~1800 таких мест на 19 серверов (в Protocol-Data их ноль).
      // Чинит уже скачанное repairDownloadedData() при запуске.
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('timeout')); });
  });
}

// Проверить, есть ли обновление: сравнить дату манифеста на воркере и локальную.
ipcMain.handle('data-check-update', async () => {
  try {
    const remote = JSON.parse(await fetchDataFile('manifest.json'));
    const remoteDate = remote.updated || '';
    let localDate = '';
    let localMani = null;
    try {
      localMani = JSON.parse(fs.readFileSync(path.join(userDataDir(), 'manifest.json'), 'utf8'));
      localDate = localMani.updated || '';
    } catch (e) {}
    // короткие даты (день) для показа пользователю
    const remoteDay = remote.date || String(remoteDate).slice(0, 10);
    const localDay = (localMani && localMani.date) || String(localDate).slice(0, 10);
    // Манифест без наборов обновлением не считаем — качать всё равно нечего,
    // а зелёная кнопка «база устарела» увела бы в тупик (см. data-download).
    const remoteServers = remote.servers || {};
    const usable = Object.keys(remoteServers).length > 0;
    // Какие наборы отстали: скачанные с прошлой датой + вовсе не скачанные.
    // Нужно, чтобы после частичной загрузки было видно, что осталось.
    const fetched = (localMani && localMani.fetched) || {};
    const stale = Object.keys(remoteServers).filter((s) => fetched[s] !== remoteDate);
    return { ok: true, remoteDate: remoteDay, localDate: localDay,
             hasUpdate: usable && remoteDate > localDate, servers: remoteServers,
             stale: stale, staleCount: stale.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// Скачать базу: один сервер или все. Сохраняет в userData/data/.
ipcMain.handle('data-download', async (e, opts) => {
  opts = opts || {};
  try {
    const remote = JSON.parse(await fetchDataFile('manifest.json'));
    // Пустой манифест — признак сорванной сборки на стороне данных.
    // Записывать его нельзя: список серверов обнулится, а локальная дата
    // сравняется с удалённой, и приложение больше НИКОГДА не предложит
    // обновиться — пользователь останется с пустой базой без выхода.
    if (!remote.servers || !Object.keys(remote.servers).length) {
      return { ok: false, error: 'на сервере пустой манифест — база не обновлена' };
    }
    let servers;
    if (Array.isArray(opts.servers) && opts.servers.length) servers = opts.servers; // выбранные
    else if (opts.server) servers = [opts.server];         // только текущий
    else servers = Object.keys(remote.servers);            // все
    let done = 0;
    const fetched = [];
    for (const srv of servers) {
      try {
        // имя набора — только буквы, цифры и «_-»: оно идёт в путь файла
        if (typeof srv !== 'string' || !/^[a-z0-9_-]+$/i.test(srv)) continue;
        const content = await fetchDataFile(srv + '.json');
        // Скачанный файл важнее встроенного, поэтому мусор (обрезанный ответ,
        // страница ошибки) оставил бы сервер без законов до следующей удачной
        // загрузки. Пишем только разобранный JSON с непустыми наборами, и через
        // временный файл: оборванная запись не заменит рабочий.
        const doc = JSON.parse(content);
        if (!doc || typeof doc !== 'object' || !Object.keys(doc).length || content.indexOf('\ufffd') !== -1) {
          throw new Error('набор ' + srv + ' пришёл повреждённым');
        }
        const dst = path.join(userDataDir(), srv + '.json');
        fs.writeFileSync(dst + '.part', content);
        fs.renameSync(dst + '.part', dst);
        done++; fetched.push(srv);
        // сообщаем прогресс в окно
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('data-download-progress', { done, total: servers.length, server: srv });
        }
      } catch (err) {
        // один сервер не скачался — продолжаем остальные
      }
    }
    // Манифест сохраняем ТОЛЬКО после удачной загрузки: иначе локальная дата
    // догонит удалённую при сорванном скачивании и обновление «потеряется».
    if (done) {
      const maniPath = path.join(userDataDir(), 'manifest.json');
      let local = {};
      try { local = JSON.parse(fs.readFileSync(maniPath, 'utf8')) || {}; } catch (err) {}

      // Отметка «когда этот набор скачан» — по ней видно, что свежее, а что нет.
      const have = Object.assign({}, local.fetched || {});
      fetched.forEach((srv) => { have[srv] = remote.updated || ''; });

      // Дату базы поднимаем до удалённой, ТОЛЬКО когда скачаны все наборы.
      // Раньше сюда писался полный манифест после любой загрузки: качаешь один
      // сервер — локальная дата догоняет удалённую, hasUpdate становится false,
      // и остальные 19 серверов остаются старыми навсегда, без единого намёка.
      const complete = Object.keys(remote.servers).every((s) => have[s] === (remote.updated || ''));

      // servers берём удалённый целиком: это список ДОСТУПНОСТИ, а не свежести.
      // Урезать его нельзя — иначе не скачанные серверы пропадут из интерфейса,
      // хотя их данные лежат встроенными в самом приложении.
      const merged = {
        updated: complete ? (remote.updated || '') : (local.updated || ''),
        date: complete ? (remote.date || String(remote.updated || '').slice(0, 10)) : (local.date || ''),
        servers: remote.servers,
        fetched: have,
      };
      fs.writeFileSync(maniPath, JSON.stringify(merged));
    }
    return { ok: done > 0, downloaded: done, total: servers.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// Прочитать локальный (скачанный) файл базы из userData/data/. Вернёт текст или null.
ipcMain.handle('data-read-local', async (e, file) => {
  try {
    if (typeof file !== 'string' || !/^[a-z0-9_.-]+$/i.test(file)) return null;
    const p = path.join(app.getPath('userData'), 'data', file);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return null;
  }
});

// Встроенная база: data/{file}.br рядом с приложением, сжатая brotli.
//
// Зачем сжатие. Полная база 19 серверов — 33 МБ несжатого JSON, и всё это
// раньше ехало в .exe как есть. Выкинуть её нельзя: приложение обязано
// работать офлайн с первого запуска, даже если человек никогда не включит
// сеть. Brotli решает обе задачи разом — 33 МБ → 3.6 МБ, а распаковка
// самого большого сервера занимает ~2.5 мс, меньше чем JSON.parse после неё.
const zlib = require('zlib');
ipcMain.handle('data-read-bundled', async (e, file) => {
  try {
    if (typeof file !== 'string' || !/^[a-z0-9_.-]+$/i.test(file)) return null;
    const p = path.join(__dirname, 'data', file + '.br');
    if (!fs.existsSync(p)) return null;
    return zlib.brotliDecompressSync(fs.readFileSync(p)).toString('utf8');
  } catch (e) {
    return null;
  }
});

ipcMain.on('overlay-ask', (e, question) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ai-overlay-query', question);
  } else if (aiOverlayWin && !aiOverlayWin.isDestroyed()) {
    aiOverlayWin.webContents.send('overlay-ask-result', { error: 'Главное окно закрыто. Открой Protocol.' });
  }
});
ipcMain.on('overlay-ask-answer', (e, result) => {
  if (aiOverlayWin && !aiOverlayWin.isDestroyed()) {
    aiOverlayWin.webContents.send('overlay-ask-result', result || {});
  }
});
ipcMain.on('ai-overlay-close', () => { if (aiOverlayWin && !aiOverlayWin.isDestroyed()) aiOverlayWin.close(); });
ipcMain.on('ai-overlay-opacity', (e, v) => {
  if (aiOverlayWin && !aiOverlayWin.isDestroyed()) {
    var a = Math.max(0.2, Math.min(1, (Number(v) || 100) / 100));
    try { aiOverlayWin.setOpacity(a); } catch (err) {}
  }
});

ipcMain.on('create-sticker', (e, payload) => {
  spawnSticker({ text: payload || '' });
  persistStickers();
});

// Создать заметку с сохранёнными настройками (из избранного)
ipcMain.on('create-sticker-with', (e, arg) => {
  const o = arg || {};
  spawnSticker({ text: o.text || '', title: o.title || '', fontSize: o.fontSize,
    opacity: (o.opacity != null ? o.opacity : 95), dark: o.dark });
  persistStickers();
});

ipcMain.on('sticker-update', (e, patch) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (patch.text !== undefined) w._stickerText = patch.text;
  if (patch.title !== undefined) w._stickerTitle = patch.title;
  if (patch.opacity !== undefined) w._stickerOpacity = patch.opacity;
  if (patch.dark !== undefined) w._stickerDark = patch.dark;
  if (patch.fontSize !== undefined) w._stickerFontSize = patch.fontSize;
  w._saveT && clearTimeout(w._saveT);
  w._saveT = setTimeout(persistStickers, 400);
});

// Стикер просит добавить свой текст в избранное приложения
ipcMain.on('sticker-favorite', (e, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    // payload может быть строкой (старое) или объектом {title, text}
    const data = (typeof payload === 'string') ? { title: '', text: payload } : (payload || {});
    mainWindow.webContents.send('add-favorite-note', data);
  }
});

// Стикер сам себя закрывает
ipcMain.on('sticker-close', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && !w.isDestroyed()) w.close();
});

// ── Распознавание речи: связь со служебным процессом ──────────────────────
//
// Распознавание живёт в отдельном процессе на Python (voice/protocol_voice.py):
// модель работает на видеокарте, и втащить её внутрь Electron нечем. Обмен —
// по локальному адресу, наружу ничего не слушает и не отправляет.
//
// Это же и есть ограничение доступа. Ни папка voice/, ни окружение Python в
// сборку не попадают (build.files берёт только js/html/css и данные), поэтому
// у всех остальных функция просто не включится: приложение не найдёт службу
// и не покажет раздел. Отдельного «замка» не нужно — нечего взламывать.
const http = require('http');
// PROTOCOL_VOICE_PORT — для проверок рядом с работающей службой пользователя
const VOICE_PORT = Number(process.env.PROTOCOL_VOICE_PORT) || 8777;
// Код службы — обычными файлами: Python не читает из app.asar. В собранном
// Protocol.exe он лежит в resources/voice (build.extraResources), из исходников —
// рядом, в app/voice. Сама среда (Python, пакеты, модели) — отдельно, её
// скачивает приложение (bodycam_install.js).
const voiceDir = () => {
  const packed = path.join(process.resourcesPath || '', 'voice');
  return app.isPackaged && fs.existsSync(path.join(packed, 'protocol_voice.py')) ? packed : path.join(__dirname, 'voice');
};

let voiceProc = null;
let voicePoll = null;
let voiceSeq = 0;

// ── установленный Bodycam (4.0) ──
// Среда распознавания скачивается приложением (bodycam_install.js) в
// %LOCALAPPDATA%\Protocol\Bodycam: встраиваемый Python с пакетами и модели.
// Есть установка — служба запускается из неё и берёт модели из её папки.
// Нет — как раньше: voice-env рядом с проектом и кэш huggingface (запуск из
// исходников у разработчика). PROTOCOL_BODYCAM_DIR — другая папка (проверки).
const BI = require('./bodycam_install');
function bodycamDefaultRoot() {
  const local = process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local');
  return path.join(local, 'Protocol', 'Bodycam');
}
// Папку можно выбрать (на системном диске у игроков часто мало места, а это
// ~4 ГБ) — выбор хранится в userData/bodycam.json.
const bodycamChoiceFile = () => path.join(app.getPath('userData'), 'bodycam.json');
function bodycamRoot() {
  if (process.env.PROTOCOL_BODYCAM_DIR) return process.env.PROTOCOL_BODYCAM_DIR;
  try {
    const r = JSON.parse(fs.readFileSync(bodycamChoiceFile(), 'utf8')).root;
    if (r) return r;
  } catch (e) {}
  return bodycamDefaultRoot();
}
let bodycamManifestCache = null;
function bodycamManifest() {
  if (!bodycamManifestCache) {
    // PROTOCOL_BODYCAM_MANIFEST — маленький список для проверок (без гигабайтов)
    const f = process.env.PROTOCOL_BODYCAM_MANIFEST || path.join(__dirname, 'bodycam-manifest.json');
    try { bodycamManifestCache = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
  }
  return bodycamManifestCache;
}
// Только два файла: зовётся часто, а status() ещё и обходит всю папку ради размера.
function bodycamReady() {
  const r = bodycamRoot();
  return fs.existsSync(path.join(r, BI.MARK)) && fs.existsSync(BI.pythonExe(r));
}

// voice-env разработчика — только по явному флагу PROTOCOL_VOICE_ENV=1.
// Иначе запуск из исходников вёл бы себя не как Protocol.exe у людей: при
// неустановленном Bodycam молча брал бы voice-env, и карточку установки не
// увидел бы никто, включая разработчика.
const voiceDevEnv = () => process.env.PROTOCOL_VOICE_ENV === '1';

/** Python с установленной моделью. Рядом с проектом, а не системный. */
function voicePython() {
  if (bodycamReady()) return BI.pythonExe(bodycamRoot());
  if (!voiceDevEnv()) return '';
  const named = path.join(voiceDir(), 'python.txt');
  try {
    const p = fs.readFileSync(named, 'utf8').trim();
    if (p && fs.existsSync(p)) return p;
  } catch (e) {}
  const local = path.join(__dirname, '..', 'voice-env', 'Scripts', 'python.exe');
  return fs.existsSync(local) ? local : '';
}

// supported — код службы есть в приложении (вкладка видна в меню);
// ok — ещё и среда установлена, можно записывать.
function voiceAvailable() {
  const script = path.join(voiceDir(), 'protocol_voice.py');
  if (!fs.existsSync(script)) return { ok: false, supported: false, reason: 'служба распознавания не входит в эту сборку' };
  const py = voicePython();
  if (!py) return { ok: false, supported: true, reason: 'Bodycam не скачан' };
  return { ok: true, supported: true, python: py, script };
}

function voiceReq(method, route, body) {
  return new Promise((resolve) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = http.request({
      host: '127.0.0.1', port: VOICE_PORT, path: route, method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
        : {},
      // /start может скачивать модель (до 3 ГБ) — один раз, но долго:
      // обрывать его через две минуты значило бы «не запустилось» на ровном месте
      timeout: route.indexOf('/events') === 0 ? 20000 : route === '/start' ? 3600000 : 120000,
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (payload) req.write(payload);
    req.end();
  });
}

/** Поднимает службу, если её ещё нет, и ждёт, пока она отзовётся. */
async function ensureVoiceProc() {
  const health = await voiceReq('GET', '/health');
  if (health && health.ok) return health;
  const av = voiceAvailable();
  if (!av.ok) return null;
  let exited = false;
  try {
    // Из установленного Bodycam — модели и кэш huggingface в его папке:
    // всё, что служба скачает, удаляется вместе с ним.
    const root = bodycamRoot();
    const env = bodycamReady() ? Object.assign({}, process.env, {
      PROTOCOL_MODELS_DIR: path.join(root, 'models'),
      PROTOCOL_SPK_MODEL: path.join(root, 'models', 'speaker', bodycamManifest() ? bodycamManifest().speaker.file : 'speaker.onnx'),
      HF_HOME: path.join(root, 'hf'),
    }) : process.env;
    const p = spawn(av.python, [av.script, '--port', String(VOICE_PORT)],
      { cwd: voiceDir(), windowsHide: true, stdio: 'ignore', env });
    voiceProc = p;
    // ссылку обнуляет только СВОЙ выход: процесс, убитый отменой запуска,
    // может завершиться уже после того, как поднят новый
    p.on('exit', () => { exited = true; if (voiceProc === p) voiceProc = null; });
  } catch (e) {
    return null;
  }
  // Первый запуск холодный: Python поднимает библиотеки CUDA, и это секунды,
  // а после перезагрузки ПК с холодного диска — и за полминуты. Раньше ожидание
  // обрывалось через 30 с с ошибкой, а служба тем временем всё-таки вставала,
  // и второе нажатие «срабатывало». Ждём дольше, но если процесс умер — сразу.
  // Сама модель грузится позже, уже внутри /start.
  for (let i = 0; i < 180 && !exited; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const h = await voiceReq('GET', '/health');
    if (h && h.ok) return h;
  }
  return null;
}

/**
 * Забирает реплики и отдаёт их окну.
 *
 * Служба держит запрос открытым, пока не появится новое, поэтому это не
 * опрос вхолостую: цикл почти всё время спит внутри одного запроса.
 */
//
// У каждого запуска насоса свой флаг. Остановленный насос ещё до восьми секунд
// висит в долгом запросе; раньше, вернувшись, он обнулял общую ссылку — уже
// на НОВЫЙ насос, и следующую сцену было нечем остановить.
function voicePumpStart() {
  voicePumpStop();
  const me = { alive: true };
  voicePoll = me;
  (async function pump() {
    while (me.alive) {
      const res = await voiceReq('GET', '/events?since=' + voiceSeq);
      if (!me.alive) break;
      if (!res) { await new Promise((r) => setTimeout(r, 500)); continue; }
      if (res.seq) voiceSeq = res.seq;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('voice-event', { items: res.items || [], running: !!res.running });
      }
      if (!res.running && !(res.items || []).length) break;
    }
    if (voicePoll === me) voicePoll = null;
  })();
}

function voicePumpStop() {
  if (voicePoll) { voicePoll.alive = false; voicePoll = null; }
}

// Модели речи: пользователь выбирает сам, скачиваются по запросу (служба
// качает выбранную при первом запуске). Здесь — только где они лежат после
// скачивания, чтобы окно честно писало «скачана» или «скачается ~N ГБ».
const VOICE_MODELS = {
  'large-v3': 'Systran/faster-whisper-large-v3',
  'large-v3-turbo': 'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
  'medium': 'Systran/faster-whisper-medium',
  'small': 'Systran/faster-whisper-small',
  // GigaAM-v3 (только русский, на процессоре) — см. MODELS в protocol_voice.py
  'gigaam-v3': 'istupakov/gigaam-v3-onnx',
};
// Файл, по которому видно, что модель в кэше huggingface скачана: у Whisper —
// model.bin, у GigaAM — кодировщик (служба ищет тот же, `mark` в MODELS).
const VOICE_MARK = { 'istupakov/gigaam-v3-onnx': 'v3_e2e_rnnt_encoder.int8.onnx' };
const voiceMarkOf = (repo) => VOICE_MARK[repo] || 'model.bin';
// Кэш huggingface — туда же качает служба (то же окружение, те же переменные).
// У установленного Bodycam — свой, внутри его папки (HF_HOME при запуске службы).
function voiceHubDir() {
  if (bodycamReady()) return path.join(bodycamRoot(), 'hf', 'hub');
  return process.env.HF_HUB_CACHE ||
    path.join(process.env.HF_HOME || path.join(require('os').homedir(), '.cache', 'huggingface'), 'hub');
}
function voiceModelCached(repo) {
  const snaps = path.join(voiceHubDir(), 'models--' + repo.replace('/', '--'), 'snapshots');
  try {
    return fs.readdirSync(snaps).some((s) => fs.existsSync(path.join(snaps, s, voiceMarkOf(repo))));
  } catch (e) { return false; }
}
// Модель готова к работе: в папке установленного Bodycam или в кэше huggingface.
function voiceModelReady(id) {
  if (bodycamReady() && BI.modelReady(bodycamRoot(), bodycamManifest(), id)) return true;
  return !!VOICE_MODELS[id] && voiceModelCached(VOICE_MODELS[id]);
}

// ── скачанные модели: размер и удаление ──
// Модели весят от 0,5 до 3 ГБ, и человек должен иметь возможность их убрать.
// Трогаем ТОЛЬКО папки моделей распознавания (models--*--faster-whisper-* и
// GigaAM): в общем кэше huggingface могут лежать модели других программ.
const VOICE_DIR_RE = /^models--(?:[\w.-]+--faster-whisper-[\w.-]+|istupakov--gigaam-v3-onnx)$/;
function dirSize(p) {
  let n = 0;
  let list = [];
  try { list = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { return 0; }
  for (const d of list) {
    const f = path.join(p, d.name);
    if (d.isSymbolicLink()) continue;          // ссылки в кэше указывают на blobs — не считать дважды
    if (d.isDirectory()) n += dirSize(f);
    else { try { n += fs.statSync(f).size; } catch (e) {} }
  }
  return n;
}
function voiceModelsOnDisk() {
  const hub = voiceHubDir();
  const byDir = {};
  Object.keys(VOICE_MODELS).forEach((k) => { byDir['models--' + VOICE_MODELS[k].replace('/', '--')] = k; });
  let names = [];
  try { names = fs.readdirSync(hub).filter((n) => VOICE_DIR_RE.test(n)); } catch (e) {}
  const out = names.map((dir) => ({
    dir,
    id: byDir[dir] || '',                                         // '' — модель не из списка приложения
    name: byDir[dir] || dir.replace(/^models--[\w.-]+--(?:faster-whisper-)?/, ''),
    bytes: dirSize(path.join(hub, dir)),
    // нет готового model.bin — скачивание было прервано
    partial: !voiceModelCached(dir.replace(/^models--/, '').replace('--', '/')),
  }));
  // модели установленного Bodycam — его папка models/<id> (speaker — модель голосов, не речи)
  if (bodycamReady()) {
    const mdir = path.join(bodycamRoot(), 'models');
    let ids = [];
    try { ids = fs.readdirSync(mdir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'speaker').map((d) => d.name); } catch (e) {}
    for (const id of ids) {
      out.push({ dir: 'bodycam:' + id, id: VOICE_MODELS[id] ? id : '', name: id,
        bytes: dirSize(path.join(mdir, id)), partial: !BI.modelReady(bodycamRoot(), bodycamManifest(), id) });
    }
  }
  return out;
}
ipcMain.handle('voice-models', () => voiceModelsOnDisk());

// Прерванное скачивание НЕ докачивается: загрузчик huggingface (hf_xet) при
// повторе заводит новый файл `<хеш>.<случайное>.incomplete` с нуля, а старый
// бросает (проверено 31.10.2026: после отмены и повтора на диске лежали оба,
// по 256 МБ). Поэтому брошенные куски модели удаляем сами — при отмене и
// перед каждым новым запуском (в это время эту модель никто не качает).
// Файл только что закрытой службы Windows отпускает не сразу — удаляем с
// повторами (до ~3 с), асинхронно, чтобы окно не подвисало.
async function voiceDropPartial(model) {
  const repo = VOICE_MODELS[model];
  if (!repo) return 0;
  const found = [];
  const walk = (p) => {
    let list = [];
    try { list = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { return; }
    for (const d of list) {
      const f = path.join(p, d.name);
      if (d.isDirectory()) walk(f);
      else if (d.name.endsWith('.incomplete')) found.push(f);
    }
  };
  walk(path.join(voiceHubDir(), 'models--' + repo.replace('/', '--')));
  let freed = 0;
  for (const f of found) {
    let n = 0;
    try { n = fs.statSync(f).size; } catch (e) {}
    try { await fs.promises.rm(f, { force: true, maxRetries: 15, retryDelay: 200 }); freed += n; } catch (e) {}
  }
  return freed;
}

// what — имя папки модели или 'all'. Во время записи и запуска — нельзя:
// модель в работе. Служба без записи закрывается, чтобы отпустить файлы;
// следующий запуск поднимет её сама.
ipcMain.handle('voice-model-delete', async (e, what) => {
  if (voiceStarting) return { ok: false, error: 'идёт запуск Bodycam — сначала остановите его' };
  const h = await voiceReq('GET', '/health');
  if (h && h.running) return { ok: false, error: 'идёт запись — удалить модель можно после «Стоп»' };
  const hub = voiceHubDir();
  const all = voiceModelsOnDisk();
  const targets = what === 'all' ? all : all.filter((m) => m.dir === what);
  if (!targets.length) return { ok: false, error: 'такой модели на диске нет' };
  if (h && h.ok) {
    await voiceReq('POST', '/quit');
    const p = voiceProc;
    if (p) {
      voiceProc = null;
      await new Promise((resolve) => { p.once('exit', resolve); setTimeout(resolve, 3000); try { p.kill(); } catch (err) { resolve(); } });
    }
  }
  let freed = 0;
  const failed = [];
  for (const m of targets) {
    if (m.dir.startsWith('bodycam:')) {         // модель установленного Bodycam
      try { BI.removeModel(bodycamRoot(), m.dir.slice(8)); freed += m.bytes; } catch (err) { failed.push(m.name); }
      continue;
    }
    if (!VOICE_DIR_RE.test(m.dir)) continue;   // путь только из проверенного имени, внутри кэша
    try {
      fs.rmSync(path.join(hub, m.dir), { recursive: true, force: true, maxRetries: 3 });
      try { fs.rmSync(path.join(hub, '.locks', m.dir), { recursive: true, force: true }); } catch (err) {}
      freed += m.bytes;
    } catch (err) { failed.push(m.name); }
  }
  return { ok: !failed.length, freed, failed, error: failed.length ? 'не удалось удалить: ' + failed.join(', ') : '' };
});
// Видеокарта — чтобы подсказать модель по видеопамяти. Нет nvidia-smi —
// значит, нет NVIDIA: распознавание пойдёт на процессоре.
function voiceGpu() {
  return new Promise((resolve) => {
    try {
      require('child_process').execFile('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
        { timeout: 4000, windowsHide: true }, (err, out) => {
          if (err || !out) return resolve(null);
          const [name, mb] = String(out).split('\n')[0].split(',').map((x) => x.trim());
          resolve(name ? { name, vramMB: Number(mb) || 0 } : null);
        });
    } catch (e) { resolve(null); }
  });
}
ipcMain.handle('voice-info', async () => {
  const cached = {};
  Object.keys(VOICE_MODELS).forEach((k) => { cached[k] = voiceModelReady(k); });
  return { gpu: await voiceGpu(), cached };
});

ipcMain.handle('voice-available', () => {
  const av = voiceAvailable();
  return { ok: av.ok, supported: !!av.supported, installed: bodycamReady(), reason: av.reason || '' };
});

// ── установка Bodycam из вкладки ──
// Одна работа за раз: установка или докачка модели. Отмена — сразу; наша
// загрузка докачивается, поэтому повторное нажатие продолжит с места.
let bodycamJob = null;
const bodycamSend = (p) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('bodycam-progress', p); };

function bodycamSizes(m) {
  const sum = (a) => a.reduce((s, x) => s + x.size, 0);
  const models = {};
  Object.keys(m.models).forEach((id) => { models[id] = sum(m.models[id].files); });
  return { base: m.python.size + m.pip.size + sum(m.wheels.base), cuda: sum(m.wheels.cuda), speaker: m.speaker.size, models };
}

ipcMain.handle('bodycam-status', async () => {
  const m = bodycamManifest();
  const root = bodycamRoot();
  const installed = bodycamReady();
  const st = installed ? BI.status(root, m) : { version: 0, cuda: false, models: [], bytes: 0 };
  return {
    supported: fs.existsSync(path.join(voiceDir(), 'protocol_voice.py')) && !!m,
    installed, root, defaultRoot: bodycamDefaultRoot(), custom: root !== bodycamDefaultRoot(),
    version: st.version, manifestVersion: m ? m.version : 0, needsUpdate: !!(installed && m && st.version !== m.version),
    cuda: st.cuda, models: st.models, bytes: st.bytes,
    free: BI.freeSpace(root), gpu: await voiceGpu(), sizes: m ? bodycamSizes(m) : null,
    // состав — для «Подробнее о Bodycam» в карточке установки: что именно и откуда
    details: m ? {
      python: m.python.version, made: m.made,
      base: m.wheels.base.map((w) => ({ name: w.name, version: w.version })),
      cuda: m.wheels.cuda.map((w) => ({ name: w.name, version: w.version })),
      speaker: m.speaker.file,
      models: Object.keys(m.models).reduce((o, id) => { o[id] = m.models[id].repo; return o; }, {}),
    } : null,
    busy: bodycamJob ? bodycamJob.kind : '', dev: !installed && voiceDevEnv(),
  };
});

// Самопроверка после установки: модули грузятся, видеокарта и микрофон видны.
// Микрофон при этом не открывается — только перечисляется.
function bodycamSelfCheck() {
  const code = [
    'import sys, json',
    'sys.path.insert(0, ' + JSON.stringify(voiceDir()) + ')',
    'import protocol_voice, ctranslate2, soundcard',
    'print(json.dumps({"cuda": ctranslate2.get_cuda_device_count(), "mics": len(soundcard.all_microphones())}))',
  ].join('\n');
  return new Promise((resolve) => {
    require('child_process').execFile(BI.pythonExe(bodycamRoot()), ['-c', code],
      { cwd: voiceDir(), windowsHide: true, timeout: 120000 }, (err, out, errOut) => {
        // последняя непустая строка — сама ошибка («No module named …»), без стрелочек трассировки
        if (err) return resolve({ ok: false, error: (String(errOut || err.message).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || 'ошибка').slice(0, 300) });
        try { resolve(Object.assign({ ok: true }, JSON.parse(String(out).trim().split('\n').pop()))); } catch (e) { resolve({ ok: false, error: 'непонятный ответ проверки' }); }
      });
  });
}

ipcMain.handle('bodycam-install', async (e, opts) => {
  const m = bodycamManifest();
  if (!m) return { ok: false, error: 'нет списка установки' };
  if (bodycamJob) return { ok: false, error: 'уже идёт ' + (bodycamJob.kind === 'install' ? 'установка' : 'скачивание модели') };
  if (voiceStarting || voicePoll) return { ok: false, error: 'идёт запись — сначала остановите её' };
  const model = opts && m.models[opts.model] ? opts.model : 'gigaam-v3';
  const ac = new AbortController();
  bodycamJob = { kind: 'install', ac };
  try {
    // служба из старой установки держит файлы Python — закрываем
    if (voiceProc) { await voiceReq('POST', '/quit'); const p = voiceProc; voiceProc = null; try { p.kill(); } catch (err) {} }
    await BI.install(bodycamRoot(), m, { cuda: !!(opts && opts.cuda), models: [model], signal: ac.signal,
      onProgress: (p) => bodycamSend(Object.assign({ kind: 'install' }, p)) });
    bodycamSend({ kind: 'install', phase: 'check', done: 1, total: 1 });
    const check = await bodycamSelfCheck();
    return { ok: true, check };
  } catch (err) {
    return { ok: false, cancelled: !!err.cancelled, error: err.cancelled ? 'отменено' : String(err.message || err) };
  } finally {
    bodycamJob = null;
    bodycamSend(null);
  }
});

ipcMain.handle('bodycam-cancel', () => { if (bodycamJob) bodycamJob.ac.abort(); return { ok: true }; });

// Докачать модель речи к установленному Bodycam — нашим загрузчиком, с докачкой.
async function bodycamAddModel(id, kind, signal) {
  const m = bodycamManifest();
  await BI.addModel(bodycamRoot(), m, id, { signal, onProgress: (p) => bodycamSend(Object.assign({ kind, model: id }, p)) });
}
ipcMain.handle('bodycam-add-model', async (e, id) => {
  const m = bodycamManifest();
  if (!bodycamReady() || !m || !m.models[id]) return { ok: false, error: 'нет такой модели или Bodycam не установлен' };
  if (bodycamJob) return { ok: false, error: 'уже идёт скачивание' };
  const ac = new AbortController();
  bodycamJob = { kind: 'model', ac };
  try {
    await bodycamAddModel(id, 'model', ac.signal);
    return { ok: true };
  } catch (err) {
    return { ok: false, cancelled: !!err.cancelled, error: err.cancelled ? 'отменено — скачанное не пропадёт' : String(err.message || err) };
  } finally {
    bodycamJob = null;
    bodycamSend(null);
  }
});

ipcMain.handle('bodycam-remove', async () => {
  if (bodycamJob) return { ok: false, error: 'идёт скачивание — сначала отмените его' };
  if (voiceStarting) return { ok: false, error: 'идёт запуск Bodycam — сначала остановите его' };
  const h = await voiceReq('GET', '/health');
  if (h && h.running) return { ok: false, error: 'идёт запись — удалить Bodycam можно после «Стоп»' };
  if (h && h.ok) await voiceReq('POST', '/quit');
  const p = voiceProc;
  if (p) {
    voiceProc = null;
    await new Promise((resolve) => { p.once('exit', resolve); setTimeout(resolve, 3000); try { p.kill(); } catch (err) { resolve(); } });
  }
  try {
    const freed = BI.remove(bodycamRoot());
    return { ok: true, freed };
  } catch (err) {
    return { ok: false, error: 'удалилось не всё: ' + String(err.message || err).slice(0, 200) };
  }
});

// Выбрать диск/папку — только пока Bodycam не установлен: переносить
// гигабайты на ходу незачем, проще удалить и поставить заново.
ipcMain.handle('bodycam-choose-dir', async (e, reset) => {
  if (bodycamReady() || bodycamJob) return { ok: false, error: 'сначала удалите Bodycam — папку меняют до установки' };
  if (reset) { try { fs.rmSync(bodycamChoiceFile(), { force: true }); } catch (err) {} return { ok: true, root: bodycamRoot() }; }
  const { dialog } = require('electron');
  const r = await dialog.showOpenDialog(mainWindow, { title: 'Куда поставить Bodycam (~4 ГБ)', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths.length) return { ok: false, cancelled: true };
  const root = path.join(r.filePaths[0], 'Protocol Bodycam');
  fs.writeFileSync(bodycamChoiceFile(), JSON.stringify({ root }));
  return { ok: true, root, free: BI.freeSpace(root) };
});

// Идущий запуск. «Стоп» во время него — отмена, и немедленная: модель может
// скачиваться и грузиться минутами, а человек передумал сейчас.
let voiceStarting = null;

ipcMain.handle('voice-start', async (e, opts) => {
  const av = voiceAvailable();
  if (!av.ok) return { ok: false, error: av.reason };
  const mode = opts && opts.mode === 'pc' ? 'pc' : 'game';
  const model = (opts && VOICE_MODELS[opts.model]) ? opts.model : 'gigaam-v3';
  const me = { cancelled: false, model };
  voiceStarting = me;
  await voiceDropPartial(model);     // куски прошлой прерванной загрузки — всё равно не пригодятся
  const dl = voiceDownloadWatch(model);
  try {
    // Установленный Bodycam, а выбранной модели нет — качаем своим загрузчиком
    // (с докачкой и проверкой суммы), а не через huggingface внутри службы.
    if (bodycamReady() && !BI.modelReady(bodycamRoot(), bodycamManifest(), model)) {
      if (bodycamJob) return { ok: false, error: 'идёт скачивание Bodycam — дождитесь его или отмените' };
      me.ac = new AbortController();
      const send = (p) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('voice-download', p); };
      try {
        await BI.addModel(bodycamRoot(), bodycamManifest(), model, { signal: me.ac.signal,
          onProgress: (p) => send({ model, bytes: p.done, done: false, resumable: true }) });
        send({ model, bytes: 0, done: true, resumable: true });
      } catch (err) {
        send(null);
        if (err.cancelled || me.cancelled) return { ok: false, cancelled: true };
        return { ok: false, error: 'модель не скачалась: ' + String(err.message || err) };
      }
      if (me.cancelled) return { ok: false, cancelled: true };
    }
    const health = await ensureVoiceProc();
    if (me.cancelled) return { ok: false, cancelled: true };
    if (!health) return { ok: false, error: 'служба распознавания не запустилась' };
    const r = await voiceReq('POST', '/start', { vocab: (opts && opts.vocab) || '', mode, model, split: voiceSplitMode(opts && opts.split) });
    if (me.cancelled || (r && r.cancelled)) {
      // отмена пришла, когда служба уже успела начать, — останавливаем
      if (r && r.ok) await voiceReq('POST', '/stop');
      return { ok: false, cancelled: true };
    }
    return voiceStarted(r, mode);
  } finally {
    dl.stop();
    if (voiceStarting === me) voiceStarting = null;
  }
});

// Модели нет на диске — «Начать запись» сначала её скачивает (до 3 ГБ, минуты).
// Человек должен видеть именно «скачиваю» и сколько уже, а не бесконечное
// «запуск». Сколько скачано — по росту папки модели в кэше (недокачанный
// файл лежит там же, .incomplete), раз в секунду. Скачалась — done: дальше
// модель грузится на видеокарту, это уже обычный «запуск».
function voiceDownloadWatch(model) {
  const repo = VOICE_MODELS[model];
  const send = (p) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('voice-download', p); };
  // у установленного Bodycam модель качает наш загрузчик (voice-start) — со своим прогрессом
  if (!repo || voiceModelReady(model) || bodycamReady()) return { stop() {} };
  const dir = path.join(voiceHubDir(), 'models--' + repo.replace('/', '--'));
  const tick = () => {
    const done = voiceModelCached(repo);
    send({ model, bytes: dirSize(dir), done });
    if (done) clearInterval(t);
  };
  const t = setInterval(tick, 1000);
  tick();
  return { stop() { clearInterval(t); send(null); } };
}

function voiceStarted(r, mode) {
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'не удалось начать слушать' };
  // Читаем журнал службы с начала ЭТОЙ сцены. С нуля сюда приезжали реплики
  // и «остановлено» прошлой сцены: разбор засорялся старым, а кнопка гасла.
  voiceSeq = Number(r.since) || 0;
  voicePumpStart();
  return { ok: true, device: r.device || '', mode: r.mode || mode };
}

// Клавиша этапа: «сделано то, что в „Сейчас“» и её отмена. Глобальная —
// нажимают её из игры, окно Protocol в этот момент не в фокусе. Ставится,
// только если приложение её прислало, а прислать может лишь окно, где служба
// распознавания есть: у остальных пользователей клавиша у игры не отнимается.
let stageAccels = [];
ipcMain.handle('set-stage-hotkeys', (e, map) => {
  stageAccels.forEach((a) => { try { globalShortcut.unregister(a); } catch (err) {} });
  stageAccels = [];
  const res = {};
  // stop — остановка записи из игры. В «Фокусе игры» окно Bodycam пропускает
  // мышь насквозь, и до его кнопки «Стоп» не дотянуться; клавиша работает всегда
  // (и во время запуска — отменяет его).
  [['stage', 'scene-stage', 1], ['back', 'scene-stage', -1], ['stop', 'scene-stop', 0]].forEach(([k, channel, dir]) => {
    const accel = map && map[k];
    if (!accel) return;
    let ok = false;
    try {
      ok = globalShortcut.register(accel, () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, dir);
      });
    } catch (err) {}
    if (ok) stageAccels.push(accel);
    res[k] = ok;   // false — сочетание занято другой программой
  });
  return res;
});

// «Деление реплик»: off — как дала модель, voice — по смене голоса,
// full — и короткие вставки. Меняется и посреди сцены — служба читает
// режим на каждом куске звука; не запущена — режим уйдёт со следующим /start.
const voiceSplitMode = (v) => (v === 'off' || v === 'voice' || v === 'full') ? v : 'full';
ipcMain.handle('voice-split', async (e, v) => {
  const r = await voiceReq('POST', '/split', { split: voiceSplitMode(v) });
  return { ok: !!(r && r.ok) };
});

ipcMain.handle('voice-stop', async () => {
  voicePumpStop();
  if (voiceStarting) {
    // Запуск ещё идёт: модель качается или грузится на видеокарту, и это
    // минуты. Ждать конца, чтобы потом остановить, — не «немедленно».
    // Службу закрываем целиком: микрофон она ещё не открывала, а следующий
    // запуск поднимет её заново. Недокачанное НЕ докачивается (см.
    // voiceDropPartial) — его удаляем сразу, чтобы не лежали сотни мегабайт.
    const was = voiceStarting;
    voiceStarting.cancelled = true;
    if (was.ac) was.ac.abort();   // качаем модель своим загрузчиком — недокачанное останется и докачается
    voiceStarting = null;
    await voiceReq('POST', '/stop');   // поднятая вручную служба тоже отменит запуск
    const p = voiceProc;
    if (p) {
      voiceProc = null;
      // ждём, пока процесс освободит порт: иначе следующий запуск, нажатый
      // сразу, достучится до умирающей службы
      await new Promise((resolve) => {
        p.once('exit', resolve);
        setTimeout(resolve, 3000);
        try { p.kill(); } catch (e) { resolve(); }
      });
      await voiceDropPartial(was.model);   // служба закрыта — файл больше никем не держится
    }
    return { ok: true, cancelled: true };
  }
  await voiceReq('POST', '/stop');
  return { ok: true };
});

// ── Окно разбора сцены поверх игры ────────────────────────────────────────
//
// Основное окно — справочник: в него заходят, когда есть время. Посреди
// задержания времени нет, поэтому всё, что нужно знать прямо сейчас, живёт
// в отдельном маленьком окне поверх игры.
//
// Разбор считается в главном окне (там законы и voice_brain.js), сюда
// приезжает только готовая сводка. Обратно идут решения офицера: «в протокол»,
// «не то», «скрыть вопрос».
let sceneWin = null;
let sceneLast = null;

const sceneFile = () => path.join(app.getPath('userData'), 'scene-overlay.json');
function loadScenePos() {
  try { return JSON.parse(fs.readFileSync(sceneFile(), 'utf8')) || {}; } catch (e) { return {}; }
}
function saveScenePos() {
  if (!sceneWin || sceneWin.isDestroyed()) return;
  try {
    const b = sceneWin.getBounds();
    fs.writeFileSync(sceneFile(), JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height }));
  } catch (e) {}
}

function createSceneOverlay() {
  const pos = loadScenePos();
  sceneWin = new BrowserWindow({
    width: pos.w || 340,
    height: pos.h || 320,
    x: (typeof pos.x === 'number') ? pos.x : undefined,
    y: (typeof pos.y === 'number') ? pos.y : undefined,
    minWidth: 260,
    minHeight: 160,
    frame: false,
    show: false,
    // Прозрачное, без системной тени, как заметки и быстрый ИИ: скругление
    // рисует страница — у непрозрачного окна из-за него торчали тёмные углы.
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Окно не забирает фокус у игры: подсказка, ради которой пришлось бы
    // выходить из игры, бесполезна.
    focusable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  sceneWin.setAlwaysOnTop(true, 'screen-saver');
  sceneWin.loadFile(path.join(__dirname, 'scene-overlay.html'));
  sceneWin.once('ready-to-show', () => {
    sceneWin.showInactive();
    try { sceneWin.setOpacity(0.95); } catch (e) {}
    applySceneFocus();
    if (sceneLast) sceneWin.webContents.send('scene-data', sceneLast);
  });
  const save = () => {
    sceneWin._t && clearTimeout(sceneWin._t);
    sceneWin._t = setTimeout(saveScenePos, 400);
  };
  sceneWin.on('move', save);
  sceneWin.on('resize', save);
  sceneWin.on('closed', () => { sceneWin = null; });
  return sceneWin;
}

function openSceneOverlay() {
  if (sceneWin && !sceneWin.isDestroyed()) { sceneWin.showInactive(); return sceneWin; }
  return createSceneOverlay();
}

function closeSceneOverlay() {
  if (sceneWin && !sceneWin.isDestroyed()) sceneWin.close();
  sceneWin = null;
}

ipcMain.on('scene-open', () => openSceneOverlay());
ipcMain.on('scene-close', () => closeSceneOverlay());
ipcMain.on('scene-push', (e, data) => {
  sceneLast = data || null;
  if (sceneWin && !sceneWin.isDestroyed()) sceneWin.webContents.send('scene-data', sceneLast);
});
// Решение офицера едет обратно в главное окно: там состояние разбора.
ipcMain.on('scene-action', (e, a) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('scene-action', a || {});
});
// Окно Bodycam и так пропускает мышь в игру, забирая её только под кнопками.
// В «Фокусе игры» не забирает и там: кнопки скрыты, сцену ведёт клавиша.
function applySceneFocus() {
  if (!sceneWin || sceneWin.isDestroyed()) return;
  try { sceneWin.setIgnoreMouseEvents(true, { forward: true }); } catch (e) {}
  try { sceneWin.webContents.send('scene-nofocus', noFocusMode); } catch (e) {}
}
ipcMain.on('scene-mouse-through', (e, on) => {
  if (!sceneWin || sceneWin.isDestroyed()) return;
  if (noFocusMode && !on) return;
  try { sceneWin.setIgnoreMouseEvents(!!on, { forward: true }); } catch (err) {}
});
ipcMain.on('scene-opacity', (e, v) => {
  if (sceneWin && !sceneWin.isDestroyed()) {
    try { sceneWin.setOpacity(Math.max(0.3, Math.min(1, Number(v) || 1))); } catch (err) {}
  }
});
// Перенос и размер окна Bodycam — из самого окна (сквозному окну системные
// края не достаются). Окно присылает только смещение мыши от начала жеста,
// а исходное положение берётся здесь, у самого окна. Страница своё окно
// видит неточно: с Electron 44 у окна без рамки window.screenX на 8 px левее,
// а outerWidth/outerHeight больше на 16×8 (невидимые края изменения размера),
// и окно дёргалось при первом же движении.
let sceneGesture = null;
function sceneGestureStart(p) {
  if (p.begin || !sceneGesture) sceneGesture = sceneWin.getBounds();
  return sceneGesture;
}
ipcMain.on('scene-move', (e, p) => {
  if (!sceneWin || sceneWin.isDestroyed() || !p) return;
  const dx = Math.round(Number(p.dx)), dy = Math.round(Number(p.dy));
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const g = sceneGestureStart(p);
  sceneWin.setPosition(g.x + dx, g.y + dy);
});
// Верхний левый угол при изменении размера остаётся на месте.
ipcMain.on('scene-resize', (e, p) => {
  if (!sceneWin || sceneWin.isDestroyed() || !p) return;
  const dw = Math.round(Number(p.dw)), dh = Math.round(Number(p.dh));
  if (!Number.isFinite(dw) || !Number.isFinite(dh)) return;
  const g = sceneGestureStart(p);
  const w = g.width + dw, h = g.height + dh;
  const [minW, minH] = sceneWin.getMinimumSize();
  const area = screen.getDisplayMatching(sceneWin.getBounds()).workAreaSize;
  sceneWin.setSize(Math.max(minW, Math.min(w, area.width)), Math.max(minH, Math.min(h, area.height)));
});
ipcMain.on('scene-ready', (e) => {
  if (sceneLast && sceneWin && !sceneWin.isDestroyed()) sceneWin.webContents.send('scene-data', sceneLast);
});

function voiceShutdown() {
  closeSceneOverlay();
  voicePumpStop();
  // Службу могли поднять и вручную, тогда voiceProc пуст и убивать нечего.
  // Микрофон при этом всё равно надо отпустить — просим её перестать слушать.
  // Ответа не ждём: при выходе ждать некогда, а запрос локальный и мгновенный.
  voiceReq('POST', '/stop').catch(() => {});
  try { if (voiceProc) voiceProc.kill(); } catch (e) {}
  voiceProc = null;
}

// Скачанная до 4.2.0 база могла выйти с испорченными буквами (см.
// fetchDataFile). Такие наборы удаляем — приложение возьмёт встроенные
// (они чистые), — а дату скачанной базы сбрасываем, чтобы «Обновить базу»
// снова предлагалось и скачало уже правильно.
function repairDownloadedData() {
  try {
    const dir = path.join(app.getPath('userData'), 'data');
    if (!fs.existsSync(dir)) return;
    const bad = [];
    fs.readdirSync(dir).forEach((f) => {
      if (!/\.json$/i.test(f) || f === 'manifest.json') return;
      const p = path.join(dir, f);
      let ok = true;
      try { const t = fs.readFileSync(p, 'utf8'); ok = t.indexOf('\ufffd') === -1 && !!JSON.parse(t); } catch (e) { ok = false; }
      if (!ok) { try { fs.unlinkSync(p); bad.push(f.replace(/\.json$/i, '')); } catch (e) {} }
    });
    if (!bad.length) return;
    const mp = path.join(dir, 'manifest.json');
    try {
      const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
      bad.forEach((s) => { if (m.fetched) delete m.fetched[s]; });
      m.updated = ''; m.date = '';
      fs.writeFileSync(mp, JSON.stringify(m));
    } catch (e) {}
    console.log('база: испорченные наборы удалены, будут встроенные — ' + bad.join(', '));
  } catch (e) {}
}

// Окна приложения не уходят со своей страницы. По умолчанию Electron, если
// бросить на окно файл или ссылку, ПЕРЕХОДИТ на него — интерфейс подменялся
// содержимым файла. Ссылки на сайты — в системный браузер.
app.on('web-contents-created', (e, wc) => {
  wc.on('will-navigate', (ev, url) => { if (url !== wc.getURL()) ev.preventDefault(); });
  wc.setWindowOpenHandler(({ url }) => {
    const u = safeWebUrl(url);
    if (u) { try { shell.openExternal(u); } catch (err) {} }
    return { action: 'deny' };
  });
});

app.whenReady().then(() => {
  try { privacy = JSON.parse(fs.readFileSync(privacyFile(), 'utf8')); } catch (e) { privacy = {}; }
  repairDownloadedData();
  createWindow();

  // Проверить обновления через несколько секунд после запуска (если не отключено в настройках)
  setTimeout(() => { if (privacy.autoUpdate !== false) checkForUpdate(); }, 4000);
  setTimeout(pingStats, 12000);

  // Восстановить сохранённые стикеры на их местах
  const saved = loadStickerData();
  for (const id of Object.keys(saved)) {
    const d = saved[id];
    spawnSticker({ id, x: d.x, y: d.y, w: d.w, h: d.h, text: d.text,
      title: d.title, opacity: d.opacity, dark: d.dark, fontSize: d.fontSize });
  }

  // Глобальные горячие клавиши — работают даже когда фокус в игре
  const send = (channel) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel); };

  // Принудительно вывести окно вперёд и дать ему фокус для ввода
  // Вызов окна ради ввода снимает «Фокус игры» целиком — со всех окон и с
  // кнопки в интерфейсе. В поле, куда не попадает фокус, не напечатать.
  const bringToFrontForInput = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      if (noFocusMode || mainWindow._restoreNoFocus) applyFocusMode(false);
      mainWindow.setFocusable(true);
      mainWindow.setSkipTaskbar(false);
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
      mainWindow.focus();
      mainWindow.webContents.focus();
      // после фокуса вернуть корректное «поверх окон»: только если пользователь сам включил ⇧
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed() && !noFocusMode) {
          mainWindow.setAlwaysOnTop(userAlwaysTop);
        }
      }, 250);
    } catch (e) {}
  };
  // окно просит показать себя: клавиша этапа Bodycam до знакомства с режимом
  // открывает окно о нём — из игры его иначе не увидеть
  ipcMain.removeAllListeners('win-summon');
  ipcMain.on('win-summon', bringToFrontForInput);

  const tryReg = (accel, channel) => {
    try { return globalShortcut.register(accel, () => send(channel)); }
    catch (e) { return false; }
  };
  // Регистрируем ВСЕ сочетания (в т.ч. Alt+X), чтобы Alt+буква перехватывалась приложением,
  // а не открывала системное меню и не «морозила» окно.
  const regAll = (accels, channel, before) => {
    let any = null;
    for (const a of accels) {
      try {
        const ok = globalShortcut.register(a, () => { if (before) before(); send(channel); });
        if (ok && !any) any = a;
      } catch (e) {}
    }
    return any;
  };
  // Ctrl+F: вытащить окно вперёд с фокусом, затем открыть поиск
  // Ctrl+F отдан ИИ-ассистенту (см. hk-class ниже); отдельного proc-хоткея больше нет
  // Переключение «Фокуса» решает главный процесс сам, а не окно: окно могло
  // считать режим другим (см. applyFocusMode), и тогда клавиша промахивалась.
  for (const a of ['CommandOrControl+D', 'CommandOrControl+Shift+D', 'Alt+D']) {
    try { globalShortcut.register(a, toggleFocusMode); } catch (e) {}
  }
  regAll(['CommandOrControl+B', 'CommandOrControl+Shift+B', 'Alt+B'], 'hk-fav', bringToFrontForInput);
  // Ctrl+R: вытащить окно вперёд и переключить на Классификацию/Юриста с фокусом в поле
  regAll(['CommandOrControl+F', 'CommandOrControl+Shift+F', 'Alt+F'], 'hk-class', bringToFrontForInput);
  // Ctrl+Shift+P: приоритетный вызов Protocol — вытащить окно вперёд поверх игры
  regAll(['CommandOrControl+Shift+P'], 'hk-summon', bringToFrontForInput);

  // Настраиваемые глобальные хоткеи: приложение шлёт свои комбинации, мы перерегистрируем.
  // action → { channel, before }
  const HK_ACTIONS = {
    focus:  { run: toggleFocusMode },
    fav:    { channel: 'hk-fav',     before: bringToFrontForInput },
    class:  { channel: 'hk-class',   before: bringToFrontForInput },
    summon: { channel: 'hk-summon',  before: bringToFrontForInput },
  };
  // Дефолтные акселераторы — чтобы снимать их перед установкой пользовательских
  let userHotkeyAccels = {
    focus:  ['CommandOrControl+D', 'CommandOrControl+Shift+D', 'Alt+D'],
    fav:    ['CommandOrControl+B', 'CommandOrControl+Shift+B', 'Alt+B'],
    class:  ['CommandOrControl+F', 'CommandOrControl+Shift+F', 'Alt+F'],
    summon: ['CommandOrControl+Shift+P'],
  };
  ipcMain.on('set-hotkeys', (e, map) => {
    if (!map || typeof map !== 'object') return;
    Object.keys(HK_ACTIONS).forEach((action) => {
      const accel = map[action];
      if (!accel) return;
      // снять прежние комбинации этого действия
      (userHotkeyAccels[action] || []).forEach((a) => { try { globalShortcut.unregister(a); } catch (err) {} });
      // поставить новую
      const cfg = HK_ACTIONS[action];
      const fn = cfg.run || (() => { if (cfg.before) cfg.before(); send(cfg.channel); });
      // register() на занятой комбинации не бросает, а возвращает false: раньше
      // прежняя клавиша уже была снята, новая не встала — у действия не
      // оставалось клавиши, а настройки показывали её назначенной
      let okR = false;
      try { okR = globalShortcut.register(accel, fn); } catch (err) {}
      if (okR) userHotkeyAccels[action] = [accel];
      else (userHotkeyAccels[action] || []).forEach((a) => { try { globalShortcut.register(a, fn); } catch (err) {} });
    });
  });
  // Ctrl+Q (по умолчанию) — быстрый ИИ-оверлей. Хоткей настраиваемый из приложения.
  let overlayAccel = 'Alt+Q';
  function registerOverlayHotkey(accel) {
    try { if (overlayAccel) globalShortcut.unregister(overlayAccel); } catch (e) {}
    var wanted = accel || 'Alt+Q';
    // register() возвращает false, если комбинация занята другой программой.
    // Пробуем желаемую, затем запасные, чтобы оверлей гарантированно имел хоткей.
    var candidates = [wanted, 'Alt+Q', 'CommandOrControl+Shift+Q', 'CommandOrControl+Q', 'Alt+Shift+Q'];
    var ok = false;
    for (var i = 0; i < candidates.length; i++) {
      try {
        if (globalShortcut.isRegistered && globalShortcut.isRegistered(candidates[i])) continue;
        if (globalShortcut.register(candidates[i], toggleAiOverlay)) { overlayAccel = candidates[i]; ok = true; break; }
      } catch (e) {}
    }
    if (!ok) { overlayAccel = ''; }
    aiOverlayKey = overlayAccel;
    return overlayAccel;
  }
  registerOverlayHotkey(overlayAccel);
  ipcMain.on('set-overlay-hotkey', (e, accel) => { if (accel) registerOverlayHotkey(accel); });
  // Приложение может спросить, какой хоткей реально активен
  ipcMain.handle && ipcMain.handle('get-overlay-hotkey', () => overlayAccel);

  // Аварийный вызов окна, если оно вдруг «потерялось» (Ctrl+Shift+P или Alt+P)
  const rescue = () => {
    if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
    mainWindow.setSkipTaskbar(false);
    mainWindow.setFocusable(true);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    applyFocusMode(false);
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.setAlwaysOnTop(userAlwaysTop);
    mainWindow.focus();
  };
  try { globalShortcut.register('CommandOrControl+Shift+P', rescue) || globalShortcut.register('Alt+P', rescue); } catch (e) {}

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('before-quit', () => {
  // Подстраховка на случай выхода не через кнопку окна (таскбар, Alt+F4):
  // фиксируем позиции заметок до того, как окна начнут закрываться.
  if (!isQuitting) { isQuitting = true; persistStickers(); }
  if (aiOverlayWin && !aiOverlayWin.isDestroyed()) aiOverlayWin.destroy(); // гарантированно убираем оверлей
  // Служба распознавания держит микрофон. Оставить её работать после выхода
  // значит оставить включённый микрофон без окна, которое об этом сообщает.
  voiceShutdown();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// для проверки на настоящем main.js (test/focus_test.js): путь клавиши из игры
module.exports = { toggleFocusMode, toggleAiOverlay };   // toggleAiOverlay — для проверки окна быстрого ИИ
