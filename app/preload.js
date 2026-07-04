const { contextBridge, ipcRenderer } = require('electron');

// API главного окна
contextBridge.exposeInMainWorld('winAPI', {
  minimize: () => ipcRenderer.send('win-minimize'),
  close:    () => ipcRenderer.send('win-close'),
  setTop:   (v) => ipcRenderer.send('win-top', v),
  setNoFocus: (v) => ipcRenderer.send('win-nofocus', v),
  createSticker: (text) => ipcRenderer.send('create-sticker', text),
  onAddFavoriteNote: (cb) => ipcRenderer.on('add-favorite-note', (e, data) => cb(data || {})),
  onNoFocusRestored: (cb) => ipcRenderer.on('nofocus-restored', (e, v) => cb(!!v)),
  // Глобальные горячие клавиши (из main): передаём колбэку имя действия
  onHotkey: (cb) => {
    ipcRenderer.on('hk-proc', () => cb('proc'));
    ipcRenderer.on('hk-nofocus', () => cb('nofocus'));
    ipcRenderer.on('hk-fav', () => cb('fav'));
    ipcRenderer.on('hk-calc', () => cb('calc'));
    for (let i = 1; i <= 9; i++) ipcRenderer.on('hk-code-' + i, () => cb('code-' + i));
  },
});

// API окна-стикера
contextBridge.exposeInMainWorld('stickerAPI', {
  onInit: (cb) => ipcRenderer.on('sticker-init', (e, data) => cb(data || {})),
  onText: (cb) => ipcRenderer.on('sticker-init', (e, data) => cb((data && data.text) || '')),
  update: (patch) => ipcRenderer.send('sticker-update', patch),
  favorite: (payload) => ipcRenderer.send('sticker-favorite', payload),
  close:  () => ipcRenderer.send('sticker-close'),
});
