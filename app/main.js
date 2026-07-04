const { app, BrowserWindow, Menu, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
const stickers = new Set();

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
      opacity: s._stickerOpacity, dark: s._stickerDark };
  }
  saveStickerData(data);
}
let noFocusMode = false;   // режим «не красть фокус у игры»
let userAlwaysTop = false; // пользователь сам включил «поверх других окон» кнопкой ⇧

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 820,
    height: 680,
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
  mainWindow.loadFile('GovHelper.html');

  // Блокируем системное меню по Alt (Alt+F и т.п. больше не «замораживают» окно).
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.alt && !input.control && !input.meta && !input.shift) {
      // одиночный Alt или Alt+одна буква/цифра — гасим (это триггеры системного меню)
      if (input.key === 'Alt' || (input.key && input.key.length === 1)) {
        event.preventDefault();
      }
    }
  });

  // После разворачивания из панели задач — вернуть режим «не красть фокус», если он был
  mainWindow.on('restore', () => {
    if (mainWindow._restoreNoFocus) {
      // небольшая задержка, чтобы окно успело показаться и получить фокус
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        noFocusMode = true;
        mainWindow.setFocusable(false);
        mainWindow.setAlwaysOnTop(true, 'screen-saver');
        for (const s of stickers) { if (!s.isDestroyed()) s.setFocusable(false); }
        mainWindow.webContents.send('nofocus-restored', true);
        mainWindow._restoreNoFocus = false;
      }, 300);
    }
  });

  // Закрытие главного окна → закрыть все стикеры (всё приложение уходит)
  mainWindow.on('closed', () => {
    for (const s of stickers) { if (!s.isDestroyed()) s.close(); }
    stickers.clear();
    mainWindow = null;
  });
}

// Режим «не красть фокус у игры»: окно не активируется при клике,
// поэтому звук и управление остаются в игре. Печатать в поля нельзя.
ipcMain.on('win-nofocus', (e, on) => {
  if (!mainWindow) return;
  noFocusMode = !!on;
  mainWindow.setFocusable(!on);        // окно нельзя сфокусировать
  if (on) {
    // В игровом режиме держим поверх игры
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  } else {
    // Обычный режим — НЕ поверх других окон (если пользователь сам не включил ⇧)
    if (!userAlwaysTop) mainWindow.setAlwaysOnTop(false);
  }
  // стикеры тоже
  for (const s of stickers) { if (!s.isDestroyed()) s.setFocusable(!on); }
});

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
ipcMain.on('win-top', (e, val) => {
  userAlwaysTop = !!val;
  if (mainWindow) mainWindow.setAlwaysOnTop(!!val);
});

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
  s.setAlwaysOnTop(true, 'screen-saver');
  if (noFocusMode) s.setFocusable(false);
  s.loadFile('sticker.html');
  s.webContents.once('did-finish-load', () => {
    s.webContents.send('sticker-init', {
      text: s._stickerText, title: s._stickerTitle,
      opacity: s._stickerOpacity, dark: s._stickerDark,
    });
  });
  const save = () => { s._saveT && clearTimeout(s._saveT); s._saveT = setTimeout(persistStickers, 400); };
  s.on('move', save);
  s.on('resize', save);
  stickers.add(s);
  s.on('closed', () => { stickers.delete(s); persistStickers(); });
  return s;
}

ipcMain.on('create-sticker', (e, payload) => {
  spawnSticker({ text: payload || '' });
  persistStickers();
});

ipcMain.on('sticker-update', (e, patch) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (patch.text !== undefined) w._stickerText = patch.text;
  if (patch.title !== undefined) w._stickerTitle = patch.title;
  if (patch.opacity !== undefined) w._stickerOpacity = patch.opacity;
  if (patch.dark !== undefined) w._stickerDark = patch.dark;
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

app.whenReady().then(() => {
  createWindow();

  // Восстановить сохранённые стикеры на их местах
  const saved = loadStickerData();
  for (const id of Object.keys(saved)) {
    const d = saved[id];
    spawnSticker({ id, x: d.x, y: d.y, w: d.w, h: d.h, text: d.text,
      title: d.title, opacity: d.opacity, dark: d.dark });
  }

  // Глобальные горячие клавиши — работают даже когда фокус в игре
  const send = (channel) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel); };

  // Принудительно вывести окно вперёд и дать ему фокус для ввода
  const bringToFrontForInput = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      noFocusMode = false;                          // временно разрешаем фокус
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
  regAll(['CommandOrControl+F', 'CommandOrControl+Shift+F', 'Alt+F'], 'hk-proc', bringToFrontForInput);
  regAll(['CommandOrControl+D', 'CommandOrControl+Shift+D', 'Alt+D'], 'hk-nofocus');
  regAll(['CommandOrControl+B', 'CommandOrControl+Shift+B', 'Alt+B'], 'hk-fav', bringToFrontForInput);
  for (let i = 1; i <= 9; i++) {
    regAll(['CommandOrControl+' + i], 'hk-code-' + i, bringToFrontForInput);
  }

  // Аварийный вызов окна, если оно вдруг «потерялось» (Ctrl+Shift+P или Alt+P)
  const rescue = () => {
    if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
    mainWindow.setSkipTaskbar(false);
    mainWindow.setFocusable(true);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.setAlwaysOnTop(false);
    mainWindow.focus();
    noFocusMode = false;
    mainWindow.webContents.send('nofocus-restored', false);
  };
  try { globalShortcut.register('CommandOrControl+Shift+P', rescue) || globalShortcut.register('Alt+P', rescue); } catch (e) {}

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
