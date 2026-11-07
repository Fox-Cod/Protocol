/**
 * Подмена Protocol.exe при обновлении (update_apply.js) — настоящим cmd.exe.
 *
 *   node test/update_apply_test.js
 *
 * Старый «Protocol.exe» здесь — копия ping.exe, запущенная на несколько
 * секунд: работающий .exe Windows заменить не даёт, ровно как распаковщик
 * portable-сборки держит свой файл, пока приложение не закрыто. Папка — с
 * кириллицей и пробелом: на таких путях ломался прежний скрипт без chcp.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const UA = require(path.join(__dirname, '..', 'update_apply.js'));

let fails = 0, oks = 0;
function ok(c, m) { if (c) { oks++; console.log('  ок      ' + m); } else { fails++; console.log('  ПРОВАЛ  ' + m); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (process.platform !== 'win32') { console.log('только Windows'); process.exit(0); }

  // ── какой файл заменять ──
  const tmpExe = 'C:\\Users\\x\\AppData\\Local\\Temp\\3Lbvl5E7\\Protocol.exe';
  ok(UA.updateTarget({ PORTABLE_EXECUTABLE_FILE: 'D:\\Игры\\Protocol.exe' }, tmpExe, true) === path.resolve('D:\\Игры\\Protocol.exe'),
    'portable: заменяется скачанный файл, а не временная копия распаковщика');
  ok(UA.updateTarget({}, 'C:\\Programs\\Protocol\\Protocol.exe', true) === path.resolve('C:\\Programs\\Protocol\\Protocol.exe'),
    'не portable (установщик, распакованная папка): сам .exe');
  ok(UA.updateTarget({}, 'C:\\Hub\\app\\node_modules\\electron\\dist\\electron.exe', false) === null,
    'из исходников: заменять нечего — electron.exe не трогаем');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Обновление тест '));
  ok(UA.canWriteDir(root), 'в свою папку писать можно');
  ok(!UA.canWriteDir(path.join(root, 'нет такой')), 'в несуществующую — нельзя');

  const ping = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'PING.EXE');
  // Запуск — как в приложении: отсоединённый, без консоли. Именно так
  // скрипт не видел кириллицу в путях (chcp без консоли не работает), а
  // запуск с консолью (spawnSync) эту ошибку прятал.
  async function run(o) {
    const cmd = path.join(root, 'apply-update.cmd');
    fs.writeFileSync(cmd, UA.applyScript(o), 'utf8');
    const t = Date.now();
    const child = spawn('cmd.exe', ['/c', cmd], { detached: true, stdio: 'ignore', windowsHide: true,
      env: Object.assign({}, process.env, UA.applyEnv(o)) });
    const code = await new Promise((r) => child.on('exit', r));
    return { ms: Date.now() - t, code, selfDeleted: !fs.existsSync(cmd) };
  }

  // ── 1. старый файл занят ~4 с, потом освобождается ──
  const dst = path.join(root, 'Protocol.exe'), src = path.join(root, 'Protocol-4.2.0.exe'), log = path.join(root, 'update.log');
  fs.copyFileSync(ping, dst);
  fs.writeFileSync(src, 'НОВАЯ ВЕРСИЯ');
  const holder = spawn(dst, ['-n', '5', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
  await sleep(300);
  const r1 = await run({ src, dst, log, start: false });
  await new Promise((r) => { if (holder.exitCode !== null) r(); else holder.on('exit', r); });
  ok(fs.readFileSync(dst, 'utf8') === 'НОВАЯ ВЕРСИЯ', 'занятый файл заменён, когда освободился (' + Math.round(r1.ms / 1000) + ' с)');
  ok(r1.ms >= 2500, 'ждал, пока старый файл занят, а не заменил сразу');
  ok(!fs.existsSync(dst + '.new') && !fs.existsSync(src), 'промежуточный .new и скачанный файл убраны');
  ok(/ok after \d+ s/.test(fs.readFileSync(log, 'utf8')), 'в журнале — удача и сколько ждал');
  ok(r1.selfDeleted, 'скрипт удалил сам себя');

  // ── 2. файл не освобождается — сдаётся, старый на месте, без вечного цикла ──
  fs.unlinkSync(dst); fs.copyFileSync(ping, dst);
  const before = fs.readFileSync(dst);
  fs.writeFileSync(src, 'НОВАЯ ВЕРСИЯ 2');
  const holder2 = spawn(dst, ['-n', '15', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
  await sleep(300);
  const r2 = await run({ src, dst, log, start: false, tries: 3 });
  ok(r2.ms < 10000, 'занят дольше предела — скрипт закончился сам (' + Math.round(r2.ms / 1000) + ' с), не крутится в фоне');
  ok(Buffer.compare(fs.readFileSync(dst), before) === 0, 'старый файл не тронут');
  ok(!fs.existsSync(dst + '.new'), 'недоделанный .new убран');
  ok(/FAIL: .*busy/.test(fs.readFileSync(log, 'utf8')), 'в журнале — причина неудачи');
  holder2.kill();

  // ── 3. скачанного файла нет — сразу неудача, старый на месте ──
  await sleep(500);
  const r3 = await run({ src: path.join(root, 'нет.exe'), dst, log, start: false });
  ok(r3.ms < 5000 && /FAIL: copy to \.new/.test(fs.readFileSync(log, 'utf8')), 'нет файла обновления — сразу «не вышло», без ожидания');

  // ── 4. в скрипте запуск после подмены (в тестах выключен) ──
  ok(/start "" "%UPD_DST%"/.test(UA.applyScript({ src: 'a', dst: 'b', log: 'c' })), 'после подмены программа запускается снова');
  // в тексте скрипта — ни одной не-ASCII буквы: без консоли cmd читает его в OEM
  const txt = UA.applyScript({ src: 'C:\\Users\\Иван\\обн.exe', dst: 'D:\\Игры\\Protocol.exe', log: 'C:\\Users\\Иван\\log' });
  ok(/^[\x00-\x7f]*$/.test(txt), 'текст скрипта — только латиница, пути не вшиты (идут переменными окружения)');
  ok(!/start ""/.test(UA.applyScript({ src: 'a', dst: 'b', log: 'c', start: false })), 'start:false — без запуска');

  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + (fails ? 'ПРОВАЛ: ' + fails + ' из ' + (fails + oks) : 'OK: ' + oks + ' проверок'));
  process.exit(fails ? 1 : 0);
})();
