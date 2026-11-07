/**
 * Сжатие встроенной базы законов: data/*.json → data/*.json.br (brotli).
 *
 *   node tools/pack-data.js          # сжать
 *   node tools/pack-data.js --check  # только показать, ничего не писать
 *
 * Запускается автоматически перед `npm run dist` (см. скрипт predist).
 *
 * Зачем. Полная база 19 серверов + правила — ~33 МБ несжатого JSON, и раньше
 * всё это ехало в .exe как есть (asar 41 МБ, установщик 168 МБ). Выкинуть базу
 * из сборки нельзя: приложение обязано работать офлайн с первого запуска, даже
 * если пользователь никогда не включит сеть. Brotli закрывает обе задачи —
 * ~89% экономии, а распаковка самого крупного сервера ~2.5 мс, то есть меньше,
 * чем следующий за ней JSON.parse.
 *
 * Читает это main.js (обработчик data-read-bundled), путь — data/{файл}.br.
 * Несжатые .json остаются на диске для `npm start`, но в сборку не попадают
 * (см. build.files в package.json).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIR = path.join(__dirname, '..', 'data');
const CHECK = process.argv.includes('--check');

if (!fs.existsSync(DIR)) {
  console.error('Нет папки data/ — сжимать нечего:', DIR);
  process.exit(1);
}

// __review — отчёты парсера о плохо разобранных документах, а не наборы законов.
// В сборке им делать нечего: вес есть, пользы ноль.
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && !f.endsWith('__review.json'));
if (!files.length) {
  console.error('В data/ нет ни одного .json — сборка получилась бы без базы.');
  process.exit(1);
}

let raw = 0, packed = 0, written = 0, skipped = 0;
for (const f of files) {
  const src = path.join(DIR, f);
  const dst = src + '.br';
  const buf = fs.readFileSync(src);
  raw += buf.length;

  // Не пережимаем, если .br свежее исходника — полный проход стоит десятки секунд.
  if (!CHECK && fs.existsSync(dst) && fs.statSync(dst).mtimeMs >= fs.statSync(src).mtimeMs) {
    packed += fs.statSync(dst).size; skipped++;
    continue;
  }
  const out = zlib.brotliCompressSync(buf, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  });
  packed += out.length;
  if (!CHECK) { fs.writeFileSync(dst, out); written++; }
}

const mb = (n) => (n / 1048576).toFixed(1) + ' МБ';
console.log(`Файлов: ${files.length} (пересжато ${written}, без изменений ${skipped})`);
console.log(`  было : ${mb(raw)}`);
console.log(`  стало: ${mb(packed)}  (экономия ${(100 - packed * 100 / raw).toFixed(1)}%)`);

// Контроль: битый .br в сборке = пустая база у пользователя, причём молча.
if (!CHECK) {
  let bad = [];
  for (const f of files) {
    try {
      const t = zlib.brotliDecompressSync(fs.readFileSync(path.join(DIR, f + '.br'))).toString('utf8');
      JSON.parse(t);
    } catch (e) { bad.push(f); }
  }
  if (bad.length) {
    console.error('ОШИБКА: не распаковались или не разобрались:', bad.join(', '));
    process.exit(1);
  }
  console.log('Проверка: все архивы распакованы и разобраны как JSON.');
}
