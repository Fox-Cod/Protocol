/**
 * Проверка режима «Фокус игры» на настоящем main.js.
 *
 *   npm run test:focus        (= electron test/focus_test.js)
 *
 * Режим трогает четыре вида окон из пяти мест (кнопка, клавиша, вызов окна
 * для ввода, сворачивание и разворачивание, аварийный вызов) — и именно на
 * стыках он ломался: кнопка горела при выключенном режиме, развёрнутое окно
 * само становилось сквозным. Глазами это ловится только в игре.
 *
 * Запускается с отдельной папкой данных: без проверки обновлений, без
 * счётчика запусков, без чужих заметок. Окна видны на экране пару секунд.
 * Вывод дублируется в %TEMP%\protocol_focus_test.txt.
 */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os');
const { app, BrowserWindow, ipcMain, globalShortcut } = require('electron');
const APP = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), 'protocol_focus_test.txt');
const UD = path.join(os.tmpdir(), 'protocol_focus_userdata');
fs.mkdirSync(UD, { recursive: true });
fs.writeFileSync(path.join(UD, 'privacy.json'), JSON.stringify({ autoUpdate: false, stats: false }));
app.setPath('userData', UD);
process.chdir(APP);
const M = require(path.join(APP, 'main.js'));

const log = []; let fails = 0;
const ok = (c, w) => { if (!c) fails++; log.push((c ? '  ок      ' : '  ПРОВАЛ  ') + w); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fake = { sender: { send() {} } };
// итог — и в файл, и в консоль: раньше он шёл только в файл, и запуск
// выглядел как молчаливый сбой (в консоли — лишь безвредное предупреждение
// про lumen.html, который main.js ищет от папки теста)
const finish = () => { log.push(fails ? 'ПРОВАЛОВ: ' + fails : 'фокус работает'); fs.writeFileSync(OUT, log.join('\n')); console.log(log.join('\n')); app.exit(fails ? 1 : 0); };

app.whenReady().then(async () => {
	try {
		await wait(1800);
		const main = BrowserWindow.getAllWindows().find((w) => /lumen\.html/.test(w.webContents.getURL()));
		ok(!!main, 'главное окно поднялось');
		// main.js грузит 'lumen.html' относительно папки приложения, а у
		// тестового запуска она — папка этого скрипта
		await main.loadFile(path.join(APP, 'lumen.html'));
		await wait(2000);
		const ui = (js) => main.webContents.executeJavaScript(js);
		const uiFocus = () => ui("!!document.querySelector('.app.focusmode')");

		// 1. включение с кнопки
		ipcMain.emit('win-nofocus', fake, true);
		await wait(300);
		ok(!main.isFocusable(), 'кнопка: главное окно больше не берёт фокус');
		ok(await uiFocus(), 'кнопка: интерфейс показывает режим включённым');

		// 2. окно Bodycam открывается уже в фокусе
		ipcMain.emit('scene-open', fake);
		await wait(1500);
		const scene = BrowserWindow.getAllWindows().find((w) => /scene-overlay/.test(w.webContents.getURL()));
		ok(!!scene, 'окно Bodycam открылось');
		const calls = [];
		const orig = scene.setIgnoreMouseEvents.bind(scene);
		scene.setIgnoreMouseEvents = (v, o) => { calls.push(v); return orig(v, o); };
		ok(await scene.webContents.executeJavaScript("document.body.classList.contains('nofocus')"), 'Bodycam: окно знает про фокус');
		// в фокусе — только синий контур, как у заметок; окно в остальном то же
		ok(await scene.webContents.executeJavaScript("/59, 130, 246/.test(getComputedStyle(document.getElementById('panel')).borderTopColor) && !document.getElementById('fchip') && getComputedStyle(document.getElementById('closeBtn')).display !== 'none'"),
			'Bodycam: в фокусе синий контур, без лишней плашки, окно как было');
		ipcMain.emit('scene-mouse-through', fake, false);
		ok(calls.indexOf(false) === -1, 'Bodycam: в фокусе окно не забирает мышь, даже если просит');

		// 3. перезагрузка интерфейса не теряет режим
		main.webContents.reload();
		await wait(2500);
		ok(await uiFocus(), 'после перезагрузки окна режим по-прежнему виден включённым');

		// 4. выключение
		ipcMain.emit('win-nofocus', fake, false);
		await wait(300);
		ok(main.isFocusable() && !(await uiFocus()), 'выключение: окно снова фокусируемое, кнопка погасла');
		ok(!(await scene.webContents.executeJavaScript("document.body.classList.contains('nofocus')")), 'Bodycam: режим снят');
		calls.length = 0;
		ipcMain.emit('scene-mouse-through', fake, false);
		ok(calls[0] === false, 'Bodycam: без фокуса окно снова берёт мышь под кнопками');

		// 5. свернули в фокусе, выключили, развернули — окно не должно вернуть фокус-режим
		ipcMain.emit('win-nofocus', fake, true);
		await wait(200);
		ipcMain.emit('win-minimize', fake);
		await wait(400);
		ipcMain.emit('win-nofocus', fake, false);
		main.restore();
		await wait(700);
		ok(main.isFocusable() && !(await uiFocus()), 'свёрнутое окно, режим снят — после разворачивания он не возвращается сам');

		// 6. свернули в фокусе и развернули — режим возвращается
		ipcMain.emit('win-nofocus', fake, true);
		await wait(200);
		ipcMain.emit('win-minimize', fake);
		await wait(400);
		main.restore();
		await wait(800);
		ok(!main.isFocusable() && (await uiFocus()), 'свернули в фокусе и развернули — режим вернулся, кнопка горит');
		ipcMain.emit('win-nofocus', fake, false);

		// 7. перенос и размер окна Bodycam — ровно на смещение мыши, без рывка.
		// С Electron 44 страница видит своё окно на 8 px левее и на 16×8 больше,
		// поэтому исходное положение берёт main.js, а окно шлёт только смещение.
		scene.setBounds({ x: 300, y: 200, width: 360, height: 400 });
		await wait(200);
		ipcMain.emit('scene-move', fake, { dx: 0, dy: 0, begin: true });
		ipcMain.emit('scene-move', fake, { dx: 25, dy: 10 });
		await wait(150);
		let b = scene.getBounds();
		ok(b.x === 325 && b.y === 210, 'перенос окна Bodycam — ровно на смещение мыши: ' + b.x + ',' + b.y);
		ipcMain.emit('scene-resize', fake, { dw: 0, dh: 0, begin: true });
		ipcMain.emit('scene-resize', fake, { dw: 40, dh: 30 });
		await wait(150);
		b = scene.getBounds();
		ok(b.width === 400 && b.height === 430 && b.x === 325, 'размер окна Bodycam — ровно на смещение, угол на месте: ' + b.width + '×' + b.height);

		// 8. клавиши Bodycam регистрируются в Windows, «стоп» — тоже: в фокусе
		// до кнопки окна не дотянуться. Редкие сочетания — чтобы не задеть чужие.
		const reg = await ui("window.winAPI.setStageHotkeys({ stage: 'Ctrl+Alt+Shift+F7', back: 'Ctrl+Alt+Shift+F8', stop: 'Ctrl+Alt+Shift+F11' })");
		ok(reg && reg.stage && reg.back && reg.stop && globalShortcut.isRegistered('Ctrl+Alt+Shift+F11'),
			'клавиши Bodycam, включая «стоп», зарегистрированы: ' + JSON.stringify(reg));
		await ui("window.winAPI.setStageHotkeys({})");
		ok(!globalShortcut.isRegistered('Ctrl+Alt+Shift+F11'), 'и снимаются, когда не нужны');

		// 9. Клавиша «Фокус игры» из игры не вытаскивает поверх GTA окно, убранное
		// за игру (жалоба 31.10). Кнопка в самом окне — окно на виду — держит его сверху.
		ipcMain.emit('win-top', fake, false);
		main.setAlwaysOnTop(false);
		await wait(150);
		M.toggleFocusMode();
		await wait(250);
		ok(!main.isFocusable() && !main.isAlwaysOnTop(), 'клавиша фокуса: режим включён, но окно за игрой осталось за игрой');
		M.toggleFocusMode();
		await wait(250);
		ok(main.isFocusable() && !main.isAlwaysOnTop(), 'клавиша фокуса ещё раз: режим снят, окно не поднималось');
		ipcMain.emit('win-nofocus', fake, true);
		await wait(250);
		ok(main.isAlwaysOnTop(), 'кнопка «Фокус» в самом окне: окно на виду — держится поверх игры');
		ipcMain.emit('win-nofocus', fake, false);
		await wait(200);
		ok(!main.isAlwaysOnTop(), 'и отпускается, когда режим сняли');
		main.setAlwaysOnTop(true);
		M.toggleFocusMode();
		await wait(250);
		ok(main.isAlwaysOnTop(), 'окно закреплено «поверх всех» — клавиша фокуса его там и держит');
		M.toggleFocusMode();
	} catch (e) { fails++; log.push('  ПРОВАЛ  ' + (e && e.stack || e)); }
	finish();
});
