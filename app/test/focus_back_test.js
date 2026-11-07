// Возврат фокуса в игру (07.11.2026): игра без фокуса глушит звук.
//  - Alt+Q: вопрос отправлен → окно прячется и сразу показывается без
//    активации (Windows отдаёт активность предыдущему окну — игре), ответ
//    на экране; новое нажатие клавиши — снова поле ввода, а не «спрятать»;
//  - «Фокус игры», включённый из самого окна Protocol, — окно остаётся
//    поверх игры, фокус уходит в игру;
//  - настройка «Возвращать фокус в игру» выключена — ничего этого нет.
// Передний план Windows фоновому процессу не отдаёт, поэтому «в фокусе ли
// окно» здесь подставляется, а проверяется, что делает с окнами Protocol.
// Сама передача фокуса игре — только в игре.
// Запуск: npx electron test/focus_back_test.js
'use strict';
const path = require('path'), fs = require('fs'), os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
const UD = path.join(os.tmpdir(), 'protocol_focusback_' + Date.now());
fs.mkdirSync(UD, { recursive: true });
fs.writeFileSync(path.join(UD, 'privacy.json'), JSON.stringify({ autoUpdate: false, stats: false }));
process.env.PROTOCOL_USER_DATA = UD;
const M = require(path.join(__dirname, '..', 'main.js'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, msg) => { console.log((c ? '  ок      ' : '  ПРОВАЛ  ') + msg); if (!c) fails++; };
setTimeout(() => { console.log('ПРЕРВАНО'); app.exit(1); }, 60000);

// подменяем «в фокусе ли» и записываем, что окно делало
function spy(w, focused) {
  const log = [];
  w.isFocused = () => focused.v;
  for (const k of ['hide', 'showInactive', 'show', 'focus']) {
    const f = w[k].bind(w);
    w[k] = function () { log.push(k); if (k === 'hide' || k === 'showInactive') focused.v = false; if (k === 'focus') focused.v = true; return f.apply(null, arguments); };
  }
  const sf = w.setFocusable.bind(w);
  w.setFocusable = (v) => { log.push('focusable:' + v); return sf(v); };
  return log;
}

app.whenReady().then(async () => {
  try {
    await wait(2500);
    const main = BrowserWindow.getAllWindows().find((w) => /lumen\.html/.test(w.webContents.getURL()));
    ok(!!main, 'главное окно поднялось');
    console.log('быстрый ИИ (Alt+Q):');
    M.toggleAiOverlay();
    await wait(1800);
    const ov = BrowserWindow.getAllWindows().find((w) => /ai-overlay\.html/.test(w.webContents.getURL()));
    ok(!!ov && ov.isVisible(), 'окно быстрого ИИ открылось');
    const f = { v: true };
    const log = spy(ov, f);
    const away = [];
    const origSend = ov.webContents.send.bind(ov.webContents);
    ov.webContents.send = (ch, ...a) => { if (ch === 'ai-overlay-away' || ch === 'ai-overlay-focus') away.push(ch + ':' + (a[0] || '')); return origSend(ch, ...a); };

    // вопрос из окна: так же, как его отправляет ai-overlay.html после Enter
    ipcMain.emit('ai-overlay-return-focus', { sender: ov.webContents });
    await wait(200);
    ok(log.join(',') === 'focusable:false,hide,showInactive', 'после вопроса: окно перестаёт брать фокус, прячется и сразу видно снова без активации: ' + log.join(','));
    ok(ov.isVisible(), 'ответ остаётся на экране');
    ok(away.some((x) => /^ai-overlay-away:.+/.test(x)), 'окну сказано, что фокус ушёл, и какой клавишей спросить снова: ' + away.join(' '));

    // чужое окно просить не может
    log.length = 0; f.v = true;
    ipcMain.emit('ai-overlay-return-focus', { sender: main.webContents });
    await wait(100);
    ok(log.length === 0, 'просьбу вернуть фокус принимает только само окно быстрого ИИ');

    // клавиша, когда видно с ответом и фокус в игре, — новый вопрос
    f.v = false; log.length = 0; away.length = 0;
    M.toggleAiOverlay();
    await wait(150);
    ok(log.includes('focusable:true') && log.includes('focus') && !log.includes('hide') && away.includes('ai-overlay-focus:'),
      'клавиша при ответе на экране — снова поле ввода, а не «спрятать»: ' + log.join(','));
    // клавиша, когда окно в фокусе, — спрятать, как раньше
    f.v = true; log.length = 0;
    M.toggleAiOverlay();
    await wait(150);
    ok(log.join(',') === 'hide', 'клавиша, когда печатаете в окне, — спрятать: ' + log.join(','));
    // щелчок в поле, когда фокус в игре, — окно снова принимает ввод
    ov.show(); f.v = false; log.length = 0;
    ipcMain.emit('ai-overlay-want-focus', { sender: ov.webContents });
    await wait(100);
    ok(log.includes('focusable:true') && log.includes('focus'), 'щелчок в поле — окно снова принимает ввод: ' + log.join(','));
    // окно не в фокусе (спросили щелчком по примеру, не печатая) — фокус не трогаем
    f.v = false; log.length = 0;
    ipcMain.emit('ai-overlay-return-focus', { sender: ov.webContents });
    await wait(100);
    ok(log.length === 0, 'окно и так без фокуса — ничего не делаем: ' + (log.join(',') || 'тихо'));

    // окно само шлёт просьбу после Enter, если настройка включена
    f.v = true; log.length = 0;
    await ov.webContents.executeJavaScript("localStorage.setItem('lumenFocusBack','1'); var q=document.getElementById('q'); q.value='что за статья 12.8'; q.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); 1");
    await wait(300);
    ok(log.join(',') === 'focusable:false,hide,showInactive', 'Enter в окне — фокус уходит сам: ' + log.join(','));
    const hint = await ov.webContents.executeJavaScript("document.getElementById('hintAsk').textContent");
    ok(/новый вопрос/.test(hint), 'внизу подсказка, как спросить снова: «' + hint + '»');

    console.log('настройка выключена:');
    ipcMain.emit('set-focus-back', {}, false);
    f.v = true; log.length = 0;
    ipcMain.emit('ai-overlay-return-focus', { sender: ov.webContents });
    await wait(100);
    ok(log.length === 0, 'быстрый ИИ остаётся в фокусе');
    ipcMain.emit('set-focus-back', {}, true);

    console.log('«Фокус игры» из окна Protocol:');
    const mf = { v: true };
    const mlog = spy(main, mf);
    ipcMain.emit('win-nofocus', {}, true);
    await wait(200);
    ok(mlog.join(',').indexOf('hide,showInactive') !== -1 && main.isVisible() && main.isAlwaysOnTop(),
      'включили, сидя в Protocol: окно на экране поверх игры, фокус — в игру: ' + mlog.join(','));
    ipcMain.emit('win-nofocus', {}, false);
    await wait(150);
    // окно не в фокусе (клавиша из игры) — окно не трогаем, как раньше
    mf.v = false; mlog.length = 0;
    M.toggleFocusMode();
    await wait(150);
    ok(mlog.indexOf('hide') === -1, 'клавиша из игры, окно Protocol не в фокусе — не прячем и не поднимаем: ' + (mlog.join(',') || 'тихо'));
    M.toggleFocusMode();
    await wait(150);
    // настройка выключена — режим включается, но фокус остаётся в Protocol
    ipcMain.emit('set-focus-back', {}, false);
    mf.v = true; mlog.length = 0;
    ipcMain.emit('win-nofocus', {}, true);
    await wait(150);
    ok(mlog.indexOf('hide') === -1, 'настройка выключена — фокус не трогаем: ' + (mlog.join(',') || 'тихо'));
    ipcMain.emit('win-nofocus', {}, false);
  } catch (e) { ok(false, 'ERR ' + e.stack); }
  console.log(fails ? 'ПРОВАЛОВ: ' + fails : 'возврат фокуса работает');
  app.exit(fails ? 1 : 0);
});
