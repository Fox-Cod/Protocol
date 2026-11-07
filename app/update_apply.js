/**
 * update_apply.js — подмена Protocol.exe новой версией (без Electron, проверяется
 * test/update_apply_test.js настоящим cmd.exe).
 *
 * Ошибка до 4.2.0. Установка брала app.getPath('exe'). Но portable-сборка — это
 * распаковщик: при каждом запуске он распаковывает приложение в
 * %TEMP%\<id>\ и запускает его оттуда, поэтому app.getPath('exe') — временная
 * копия, а не файл, который скачал человек. Обновление копировалось во
 * временную папку, распаковщик её тут же стирал, а скачанный Protocol.exe
 * оставался старым; скрипт подмены при этом мог крутиться в фоне без конца
 * (copy в несуществующую папку «ждал» вечно). Настоящий путь распаковщик
 * передаёт в PORTABLE_EXECUTABLE_FILE.
 *
 * Подмена: новая версия копируется рядом (Protocol.exe.new) — это можно
 * сразу, файл ничей; затем, когда старый .exe освободится (распаковщик
 * держит его, пока приложение не закрыто и временная папка не стёрта),
 * переименование move — оно атомарно: оборванное копирование не оставит
 * полуфайла на месте рабочего. Ждём не дольше ~2 минут, всё пишется в журнал.
 */
'use strict';
const fs = require('fs');
const path = require('path');

// Какой файл заменять. null — заменять нечего (запуск из исходников: там
// app.getPath('exe') — electron.exe из node_modules, его трогать нельзя).
function updateTarget(env, exePath, isPackaged) {
  const portable = env && env.PORTABLE_EXECUTABLE_FILE;
  if (portable) return path.resolve(portable);
  if (!isPackaged) return null;
  return path.resolve(exePath);
}

// Можно ли писать в папку с программой. Проверяем делом — создать и удалить
// файл: права на «Program Files», «только чтение» и синхронизацию облака
// по флагам не угадать.
function canWriteDir(dir) {
  const probe = path.join(dir, '.protocol-update-probe-' + process.pid);
  try { fs.writeFileSync(probe, ''); fs.unlinkSync(probe); return true; }
  catch (e) { return false; }
}

// Текст .cmd — ТОЛЬКО латиница, без путей. Пути приходят переменными
// окружения (applyEnv): скрипт запускается отсоединённым, без консоли, и
// «chcp 65001» там не работает — cmd читает текст скрипта в кодировке OEM,
// русские буквы в путях превращаются в мусор, и ни copy, ни start не находят
// файлов. Ломалось у всех, у кого кириллица в имени пользователя Windows
// (папка обновлений — в профиле). Переменные окружения Windows передаёт в
// Юникоде, и кодировка скрипта перестаёт иметь значение. По той же причине
// пути в журнал пишет main.js (applyLogStart), а скрипт — только итог.
// start=false — для теста: программу после подмены не запускать.
function applyScript(o) {
  const lines = [
    '@echo off',
    'set /a N=0',
    'copy /y "%UPD_SRC%" "%UPD_DST%.new" >nul 2>&1',
    'if errorlevel 1 (echo %date% %time% FAIL: copy to .new >> "%UPD_LOG%" & goto end)',
    ':wait',
    // пауза ~1 с. Не «timeout /t 1»: без консоли (stdin — NUL) timeout.exe
    // сразу падает «Input redirection is not supported», и цикл ожидания
    // крутился вхолостую
    'ping -n 2 127.0.0.1 >nul',
    'set /a N+=1',
    'move /y "%UPD_DST%.new" "%UPD_DST%" >nul 2>&1',
    'if not errorlevel 1 goto done',
    'if %N% lss ' + (Number(o.tries) || 120) + ' goto wait',
    'echo %date% %time% FAIL: target busy for %N% s >> "%UPD_LOG%"',
    'del /f /q "%UPD_DST%.new" >nul 2>&1',
    'goto end',
    ':done',
    'echo %date% %time% ok after %N% s >> "%UPD_LOG%"',
    'del /f /q "%UPD_SRC%" >nul 2>&1',
    ':end',
  ];
  // Запуск — и после удачи (новая версия), и после неудачи (старая на
  // месте): человек не должен остаться без программы, нажав «Обновить».
  if (o.start !== false) lines.push('start "" "%UPD_DST%"');
  lines.push('del /f /q "%~f0" >nul 2>&1');
  return lines.join('\r\n') + '\r\n';
}

// Пути для скрипта — переменными окружения (см. applyScript).
function applyEnv(o) {
  return { UPD_SRC: o.src, UPD_DST: o.dst, UPD_LOG: o.log };
}

// Первая строка журнала — из Node, в UTF-8: скрипт без консоли кириллицу не запишет.
function applyLogStart(o) {
  try { fs.appendFileSync(o.log, new Date().toISOString() + ' start: "' + o.src + '" -> "' + o.dst + '"\r\n', 'utf8'); } catch (e) {}
}

module.exports = { updateTarget, canWriteDir, applyScript, applyEnv, applyLogStart };
