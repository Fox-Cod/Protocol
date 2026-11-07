/**
 * Установка Bodycam — среда распознавания, которую Protocol.exe скачивает сам.
 *
 * В .exe её нет: это гигабайты, нужные не всем. По списку
 * bodycam-manifest.json (собирается tools/bodycam-manifest.js с проверенного
 * окружения разработчика) ставится:
 *
 *   root/python/          встраиваемый Python с python.org + пакеты в Lib\site-packages
 *   root/models/<id>/     модель речи (файлы снимка huggingface)
 *   root/models/speaker/  модель голосов
 *   root/installed.json   отметка «установлено» — пишется ПОСЛЕДНЕЙ
 *
 * Правила, на которых держится надёжность:
 *   - каждый скачанный файл сверяется по sha256 из списка, иначе удаляется;
 *   - скачивание своё и с докачкой: прерванный файл лежит как .part и
 *     продолжается с места (Range), а не начинается заново (у загрузчика
 *     huggingface докачки нет — проверено 31.10.2026);
 *   - пакеты ставит pip, запущенный прямо из своего колеса, без сети
 *     (--no-index) и только из уже проверенных файлов; без кэша
 *     (--no-cache-dir) — за пределами папки Bodycam ничего не остаётся;
 *   - пока нет installed.json, Bodycam не установлен — недоустановка
 *     не выдаёт себя за готовую.
 *
 * Модуль не знает про окна Electron: его проверяют обычным node
 * (test/bodycam_install_test.js).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');

const MARK = 'installed.json';

const pyDir = (root) => path.join(root, 'python');
const pythonExe = (root) => path.join(pyDir(root), 'python.exe');
const modelDir = (root, id) => path.join(root, 'models', id);
const speakerFile = (root, m) => path.join(root, 'models', 'speaker', m.speaker.file);
const dlDir = (root) => path.join(root, 'downloads');

function readMark(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, MARK), 'utf8')); } catch (e) { return null; }
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p, { highWaterMark: 4 * 1048576 })
      .on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

function dirBytes(p) {
  let n = 0;
  let list = [];
  try { list = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { return 0; }
  for (const d of list) {
    const f = path.join(p, d.name);
    if (d.isSymbolicLink()) continue;
    if (d.isDirectory()) n += dirBytes(f);
    else { try { n += fs.statSync(f).size; } catch (e) {} }
  }
  return n;
}

/** Свободно на диске, где будет root (байт), или null, если не узнать. */
function freeSpace(dir) {
  let d = path.resolve(dir);
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  try { const s = fs.statfsSync(d); return s.bavail * s.bsize; } catch (e) { return null; }
}

/**
 * Что скачать. cuda — ставить ли библиотеки для NVIDIA; models — какие
 * модели речи. Возвращает список файлов и сколько их всего.
 */
function plan(m, opts) {
  const o = opts || {};
  const items = [];
  const add = (kind, name, f, dest) => items.push({ kind, name, version: f.version, url: f.url, size: f.size, sha256: f.sha256, dest });
  add('python', 'Python ' + m.python.version, m.python, ['downloads', m.python.file]);
  add('pip', 'pip', m.pip, ['downloads', m.pip.file]);
  for (const w of m.wheels.base) add('wheel', w.name, w, ['downloads', w.file]);
  if (o.cuda) for (const w of m.wheels.cuda) add('cuda', w.name, w, ['downloads', w.file]);
  add('speaker', 'модель голосов', m.speaker, ['models', 'speaker', m.speaker.file]);
  for (const id of o.models || []) {
    const mm = m.models[id];
    if (!mm) throw new Error('нет такой модели в списке: ' + id);
    for (const f of mm.files) add('model', id, f, ['models', id, f.path]);
  }
  return { items, bytes: items.reduce((s, x) => s + x.size, 0) };
}

/**
 * Модель скачана целиком: все её файлы из списка на месте. У Whisper главный
 * файл — model.bin, у GigaAM — пять файлов onnx; проверка по одному файлу
 * выдала бы недокачанную модель за готовую. Без списка — по model.bin.
 */
function modelReady(root, m, id) {
  const mm = m && m.models && m.models[id];
  const dir = modelDir(root, id);
  if (!mm) return fs.existsSync(path.join(dir, 'model.bin'));
  return mm.files.every((f) => fs.existsSync(path.join(dir, f.path)));
}

// Имя пакета так, как его пишет pip в папке *.dist-info: «onnx-asr» → «onnx_asr».
const distKey = (name, ver) => String(name).toLowerCase().replace(/[-_.]+/g, '_') + '-' + ver;
/** Пакеты, уже стоящие в Python установки: «имя-версия». */
function installedDists(root) {
  const out = new Set();
  let list = [];
  try { list = fs.readdirSync(path.join(pyDir(root), 'Lib', 'site-packages')); } catch (e) { return out; }
  for (const d of list) {
    const m = /^(.+)-([^-]+)\.dist-info$/.exec(d);
    if (m) out.add(distKey(m[1], m[2]));
  }
  return out;
}

/** Что стоит сейчас. */
function status(root, m) {
  const mark = readMark(root);
  const models = mark ? (mark.models || []).filter((id) => modelReady(root, m, id)) : [];
  return {
    installed: !!(mark && fs.existsSync(pythonExe(root))),
    version: mark ? mark.version : 0,
    needsUpdate: !!(mark && m && mark.version !== m.version),
    cuda: !!(mark && mark.cuda),
    models,
    bytes: dirBytes(root),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Скачать один файл с докачкой и проверкой суммы. onBytes(n) — прирост.
 * Уже скачанный и верный файл не качается заново.
 */
async function fetchFile(item, dest, onBytes, signal) {
  if (fs.existsSync(dest) && fs.statSync(dest).size === item.size && await sha256File(dest) === item.sha256) {
    onBytes(item.size);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  let tries = 0;
  for (;;) {
    let have = 0;
    try { have = fs.statSync(part).size; } catch (e) {}
    if (have > item.size) { fs.rmSync(part, { force: true }); have = 0; }
    if (have) onBytes(have);
    try {
      if (have < item.size) {
        const r = await fetch(item.url, {
          headers: Object.assign({ 'User-Agent': 'Protocol-Bodycam' }, have ? { Range: 'bytes=' + have + '-' } : {}),
          signal, redirect: 'follow',
        });
        if (have && r.status === 200) {          // сервер не умеет докачку — с начала
          onBytes(-have);
          have = 0;
        } else if (!r.ok && r.status !== 206) {
          throw Object.assign(new Error(item.name + ': сервер ответил ' + r.status), { http: r.status });
        }
        const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
        // счётчик — звеном цепочки: байт засчитан, только когда ушёл в файл
        const count = new Transform({ transform(c, enc, cb) { onBytes(c.length); cb(null, c); } });
        await pipeline(Readable.fromWeb(r.body), count, out, { signal });
      }
      const size = fs.statSync(part).size;
      const sum = await sha256File(part);
      if (size !== item.size || sum !== item.sha256) {
        fs.rmSync(part, { force: true });
        onBytes(-size);
        throw Object.assign(new Error(item.name + ': файл не совпал с ожидаемым (контрольная сумма) — удалён'), { bad: true });
      }
      fs.renameSync(part, dest);
      return;
    } catch (e) {
      if (signal && signal.aborted) throw Object.assign(new Error('отменено'), { cancelled: true });
      // Чужой файл и отказ сервера (404, 403) повтором не лечатся. Обрыв
      // сети — лечится: докачиваем с места, с нарастающей паузой.
      if (e.bad || (e.http && e.http < 500)) throw e;
      if (++tries > 4) throw new Error(item.name + ': не скачалось — ' + (e.message || e));
      try { onBytes(-fs.statSync(part).size); } catch (er) {}
      await sleep([1000, 3000, 8000, 15000][tries - 1]);
    }
  }
}

function run(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(file, args, Object.assign({ windowsHide: true, maxBuffer: 32 * 1048576 }, opts), (err, stdout, stderr) => {
      if (err) {
        if (opts && opts.signal && opts.signal.aborted) return reject(Object.assign(new Error('отменено'), { cancelled: true }));
        return reject(new Error((String(stderr || stdout || err.message).trim().split('\n').slice(-3).join(' ')).slice(0, 400)));
      }
      resolve(stdout);
    });
  });
}

// tar из Windows (bsdtar) распаковывает zip. Именно системный: tar из Git
// for Windows, если он раньше в PATH, zip не понимает.
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

/**
 * Поставить Python и пакеты, скачать модели. onProgress({ phase, name,
 * done, total }) — phase: download | unpack | install | done.
 * opts: { cuda, models: [id], signal }.
 */
async function install(root, m, opts) {
  const o = opts || {};
  const onProgress = o.onProgress || (() => {});
  const signal = o.signal;
  const p = plan(m, o);
  fs.mkdirSync(root, { recursive: true });
  const prev = readMark(root);
  // Обновление на месте. Python той же версии — качаются и ставятся только
  // пакеты, которых в установке нет; Python не трогается. Иначе ради одного
  // нового пакета (onnx_asr для GigaAM, 30 КБ) каждый перекачивал бы всю
  // среду — 1,4 ГБ с CUDA. Так же добавляется и убирается ускорение NVIDIA
  // (выбор пользователя в настройках): добавить — докачать библиотеки CUDA,
  // убрать — снять их pip-ом. Пакеты, убранные из списка, остаются: мешать
  // им нечему.
  const inPlace = !!(prev && prev.python === m.python.version && fs.existsSync(pythonExe(root)));
  const dropCuda = inPlace && !!prev.cuda && !o.cuda;
  if (inPlace) {
    const have = installedDists(root);
    p.items = p.items.filter((it) => it.kind !== 'python' &&
      !((it.kind === 'wheel' || it.kind === 'cuda') && have.has(distKey(it.name, it.version))));
    if (!dropCuda && !p.items.some((it) => it.kind === 'wheel' || it.kind === 'cuda')) p.items = p.items.filter((it) => it.kind !== 'pip');
    p.bytes = p.items.reduce((s2, x) => s2 + x.size, 0);
  }
  // отметку убираем в начале: прерванная установка не должна выглядеть готовой
  fs.rmSync(path.join(root, MARK), { force: true });

  let done = 0;
  for (const it of p.items) {
    if (signal && signal.aborted) throw Object.assign(new Error('отменено'), { cancelled: true });
    await fetchFile(it, path.join(root, ...it.dest), (n) => {
      done += n;
      onProgress({ phase: 'download', name: it.name, done, total: p.bytes });
    }, signal);
  }

  // Python — с чистого листа: старые пакеты другой версии не должны мешаться
  if (!inPlace) {
  onProgress({ phase: 'unpack', name: 'Python', done, total: p.bytes });
  fs.rmSync(pyDir(root), { recursive: true, force: true });
  fs.mkdirSync(pyDir(root), { recursive: true });
  await run(TAR, ['-xf', path.join(dlDir(root), m.python.file), '-C', pyDir(root)], { signal });
  // Встраиваемый Python видит только то, что перечислено в pythonXY._pth.
  // Добавляем site-packages и включаем site — иначе пакеты не импортируются.
  const pth = fs.readdirSync(pyDir(root)).find((f) => /^python\d+\._pth$/.test(f));
  if (!pth) throw new Error('в архиве Python нет ._pth — не тот архив');
  const zipName = pth.replace('._pth', '.zip');
  fs.writeFileSync(path.join(pyDir(root), pth), [zipName, '.', 'Lib\\site-packages', 'import site', ''].join('\r\n'));
  fs.mkdirSync(path.join(pyDir(root), 'Lib', 'site-packages'), { recursive: true });
  }

  // pip прямо из своего колеса, без сети: ставит только скачанное и проверенное
  onProgress({ phase: 'install', name: 'пакеты', done, total: p.bytes });
  const wheels = p.items.filter((it) => it.kind === 'wheel' || it.kind === 'cuda').map((it) => path.join(root, ...it.dest));
  if (wheels.length) {
    await run(pythonExe(root), [path.join(dlDir(root), m.pip.file, 'pip'), 'install', '--no-index', '--no-deps',
      '--disable-pip-version-check', '--no-warn-script-location', '--no-cache-dir', ...wheels], { signal, cwd: pyDir(root) });
  }
  if (dropCuda) {
    // ускорение больше не нужно — библиотеки CUDA (~2 ГБ на диске) снимаем
    onProgress({ phase: 'install', name: 'убираю ускорение NVIDIA', done, total: p.bytes });
    const names = m.wheels.cuda.map((w) => w.name);
    if (names.length) {
      await run(pythonExe(root), [path.join(dlDir(root), m.pip.file, 'pip'), 'uninstall', '-y',
        '--disable-pip-version-check', ...names], { signal, cwd: pyDir(root) });
    }
  }

  const models = Array.from(new Set([...(prev && prev.models || []), ...(o.models || [])]))
    .filter((id) => modelReady(root, m, id));
  fs.writeFileSync(path.join(root, MARK), JSON.stringify({
    version: m.version, cuda: !!o.cuda, python: m.python.version, models, date: new Date().toISOString(),
  }, null, 1));
  // скачанные колёса и архив больше не нужны — это ~1,4 ГБ
  fs.rmSync(dlDir(root), { recursive: true, force: true });
  onProgress({ phase: 'done', name: '', done: p.bytes, total: p.bytes });
  return status(root, m);
}

/** Докачать ещё одну модель к готовой установке. */
async function addModel(root, m, id, opts) {
  const o = opts || {};
  const mm = m.models[id];
  if (!mm) throw new Error('нет такой модели в списке: ' + id);
  const total = mm.files.reduce((s, f) => s + f.size, 0);
  let done = 0;
  for (const f of mm.files) {
    await fetchFile({ name: id, url: f.url, size: f.size, sha256: f.sha256 }, path.join(modelDir(root, id), f.path), (n) => {
      done += n;
      (o.onProgress || (() => {}))({ phase: 'download', name: id, done, total });
    }, o.signal);
  }
  const mark = readMark(root);
  if (mark) {
    mark.models = Array.from(new Set([...(mark.models || []), id]));
    fs.writeFileSync(path.join(root, MARK), JSON.stringify(mark, null, 1));
  }
}

/** Удалить одну модель речи. */
function removeModel(root, id) {
  if (!/^[\w.-]+$/.test(id) || id === 'speaker') throw new Error('не модель речи: ' + id);
  fs.rmSync(modelDir(root, id), { recursive: true, force: true, maxRetries: 3 });
  const mark = readMark(root);
  if (mark) {
    mark.models = (mark.models || []).filter((x) => x !== id);
    fs.writeFileSync(path.join(root, MARK), JSON.stringify(mark, null, 1));
  }
}

/** Удалить Bodycam целиком. Сначала отметку — недоудалённое не выглядит установленным. */
function remove(root) {
  // Страховка: путь берётся из userData/bodycam.json, и испорченный файл
  // («D:\\») превратил бы «Удалить Bodycam» в удаление всего диска. Сам
  // Protocol ставит только в «…\\Bodycam» или «…\\Protocol Bodycam».
  const abs = path.resolve(root);
  if (!/bodycam/i.test(path.basename(abs)) || path.dirname(abs) === abs) {
    throw new Error('папка не похожа на установку Bodycam: ' + abs);
  }
  const freed = dirBytes(root);
  fs.rmSync(path.join(root, MARK), { force: true });
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return freed;
}

module.exports = {
  plan, status, install, addModel, removeModel, remove, freeSpace, modelReady,
  pythonExe, modelDir, speakerFile, fetchFile, sha256File, MARK, installedDists,
};
