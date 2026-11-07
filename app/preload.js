const { contextBridge, ipcRenderer } = require('electron');

// API главного окна
contextBridge.exposeInMainWorld('winAPI', {
  minimize: () => ipcRenderer.send('win-minimize'),
  close:    () => ipcRenderer.send('win-close'),
  setTop:   (v) => ipcRenderer.send('win-top', v),
  setNoFocus: (v) => ipcRenderer.send('win-nofocus', v),
  getNoFocus: () => ipcRenderer.invoke('get-nofocus'),
  summon: () => ipcRenderer.send('win-summon'),
  openAiOverlay: () => ipcRenderer.send('ai-overlay-open'),
  setMouseThrough: (v) => ipcRenderer.send('win-mouse-through', v),
  setOverlayHotkey: (accel) => ipcRenderer.send('set-overlay-hotkey', accel),
  openDevTools: () => ipcRenderer.send('open-devtools'),
  resetWindow: () => ipcRenderer.send('reset-app-state'),
  setPrivacy: (obj) => ipcRenderer.send('set-privacy', obj),
  statsPreview: () => ipcRenderer.invoke('stats-preview'),
  setHotkeys: (map) => ipcRenderer.send('set-hotkeys', map),
  // Обновление базы законов
  dataCheckUpdate: () => ipcRenderer.invoke('data-check-update'),
  dataDownload: (opts) => ipcRenderer.invoke('data-download', opts),
  dataReadLocal: (file) => ipcRenderer.invoke('data-read-local', file),
  dataReadBundled: (file) => ipcRenderer.invoke('data-read-bundled', file),
  onDataProgress: (cb) => ipcRenderer.on('data-download-progress', (e, p) => cb(p || {})),
  // Bodycam (разбор сцены): служба распознавания речи (локальная, не входит в сборку)
  voiceAvailable: () => ipcRenderer.invoke('voice-available'),
  voiceStart: (opts) => ipcRenderer.invoke('voice-start', opts || {}),
  voiceStop: () => ipcRenderer.invoke('voice-stop'),
  voiceSplit: (v) => ipcRenderer.invoke('voice-split', v),
  onVoiceEvent: (cb) => ipcRenderer.on('voice-event', (e, p) => cb(p || {})),
  setStageHotkeys: (map) => ipcRenderer.invoke('set-stage-hotkeys', map || {}),
  voiceInfo: () => ipcRenderer.invoke('voice-info'),
  voiceModels: () => ipcRenderer.invoke('voice-models'),
  onVoiceDownload: (cb) => ipcRenderer.on('voice-download', (e, p) => cb(p || null)),
  // установка Bodycam из вкладки
  bodycamStatus: () => ipcRenderer.invoke('bodycam-status'),
  bodycamInstall: (opts) => ipcRenderer.invoke('bodycam-install', opts || {}),
  bodycamCancel: () => ipcRenderer.invoke('bodycam-cancel'),
  bodycamAddModel: (id) => ipcRenderer.invoke('bodycam-add-model', id),
  bodycamRemove: () => ipcRenderer.invoke('bodycam-remove'),
  bodycamChooseDir: (reset) => ipcRenderer.invoke('bodycam-choose-dir', !!reset),
  onBodycamProgress: (cb) => ipcRenderer.on('bodycam-progress', (e, p) => cb(p || null)),
  voiceModelDelete: (what) => ipcRenderer.invoke('voice-model-delete', what),
  onSceneStage: (cb) => ipcRenderer.on('scene-stage', (e, dir) => cb(dir)),
  onSceneStop: (cb) => ipcRenderer.on('scene-stop', () => cb()),
  // Окно разбора поверх игры: сводку шлём туда, решения офицера получаем обратно
  sceneOpen: () => ipcRenderer.send('scene-open'),
  sceneClose: () => ipcRenderer.send('scene-close'),
  scenePush: (data) => ipcRenderer.send('scene-push', data),
  onSceneAction: (cb) => ipcRenderer.on('scene-action', (e, a) => cb(a || {})),
  createSticker: (text) => ipcRenderer.send('create-sticker', text),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  openUserData: () => ipcRenderer.send('open-user-data'),
  setFocusBack: (on) => ipcRenderer.send('set-focus-back', !!on),
  createStickerWith: (text, opts) => ipcRenderer.send('create-sticker-with', { text, ...(opts || {}) }),
  onAddFavoriteNote: (cb) => ipcRenderer.on('add-favorite-note', (e, data) => cb(data || {})),
  onNoFocusRestored: (cb) => ipcRenderer.on('nofocus-restored', (e, v) => cb(!!v)),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (e, info) => cb(info || {})),
  openReleasePage: (url) => ipcRenderer.send('open-release-page', url),
  // Автообновление приложения
  updateDownload: () => ipcRenderer.invoke('update-download'),
  updateInstall: (arg) => ipcRenderer.invoke('update-install', arg),
  onUpdateProgress: (cb) => ipcRenderer.on('update-download-progress', (e, p) => cb(p || {})),
  // Ручная проверка обновлений: шлём запрос и слушаем результат
  checkUpdate: () => ipcRenderer.send('check-update'),
  onUpdateCheckResult: (cb) => ipcRenderer.on('update-check-result', (e, res) => cb(res || {})),
  // Глобальные горячие клавиши (из main): передаём колбэку имя действия.
  // hk-proc, hk-calc и hk-nofocus main давно не шлёт — фокус переключает
  // сам main (toggleFocusMode), калькулятора и «процедуры» больше нет.
  onHotkey: (cb) => {
    ipcRenderer.on('hk-fav', () => cb('fav'));
    ipcRenderer.on('hk-class', () => cb('class'));
  },
});

// API быстрого ИИ-оверлея
contextBridge.exposeInMainWorld('overlayAPI', {
  onFocus: (cb) => ipcRenderer.on('ai-overlay-focus', () => cb()),
  hide:  () => ipcRenderer.send('ai-overlay-hide'),
  close: () => ipcRenderer.send('ai-overlay-close'),
  setOpacity: (v) => ipcRenderer.send('ai-overlay-opacity', v),
  ask: (question) => ipcRenderer.send('overlay-ask', question),
  onAskResult: (cb) => ipcRenderer.on('overlay-ask-result', (e, r) => cb(r || {})),
  fit: (h) => ipcRenderer.send('ai-overlay-fit', h),
  openRef: (ref) => ipcRenderer.send('ai-overlay-ref', ref),
  returnFocus: () => ipcRenderer.send('ai-overlay-return-focus'),
  wantFocus: () => ipcRenderer.send('ai-overlay-want-focus'),
  onAway: (cb) => ipcRenderer.on('ai-overlay-away', (e, key) => cb(key || '')),
});
// Мост в главном окне: принять запрос от оверлея и вернуть ответ ИИ
contextBridge.exposeInMainWorld('overlayBridge', {
  onQuery: (cb) => ipcRenderer.on('ai-overlay-query', (e, q) => cb(q)),
  answer: (result) => ipcRenderer.send('overlay-ask-answer', result),
});

// API окна разбора сцены (scene-overlay.html)
contextBridge.exposeInMainWorld('sceneAPI', {
  onScene: (cb) => ipcRenderer.on('scene-data', (e, d) => cb(d || null)),
  ready: () => ipcRenderer.send('scene-ready'),
  act: (a) => ipcRenderer.send('scene-action', a),
  close: () => ipcRenderer.send('scene-close'),
  setOpacity: (v) => ipcRenderer.send('scene-opacity', v),
  mouseThrough: (on) => ipcRenderer.send('scene-mouse-through', on),
  // «Фокус игры»: окно целиком сквозное, кнопки прячутся
  onNoFocus: (cb) => ipcRenderer.on('scene-nofocus', (e, v) => cb(!!v)),
  // смещение мыши от начала жеста; begin — первое событие жеста
  move: (dx, dy, begin) => ipcRenderer.send('scene-move', { dx, dy, begin: !!begin }),
  resize: (dw, dh, begin) => ipcRenderer.send('scene-resize', { dw, dh, begin: !!begin }),
});

// API окна-стикера
contextBridge.exposeInMainWorld('stickerAPI', {
  onInit: (cb) => ipcRenderer.on('sticker-init', (e, data) => cb(data || {})),
  // Режим «Фокус игры»: заметка стала сквозной для мыши — красим рамку
  onNoFocus: (cb) => ipcRenderer.on('sticker-nofocus', (e, v) => cb(!!v)),
  onText: (cb) => ipcRenderer.on('sticker-init', (e, data) => cb((data && data.text) || '')),
  update: (patch) => ipcRenderer.send('sticker-update', patch),
  favorite: (payload) => ipcRenderer.send('sticker-favorite', payload),
  close:  () => ipcRenderer.send('sticker-close'),
});
