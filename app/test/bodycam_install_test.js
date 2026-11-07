/**
 * Проверка установщика Bodycam (bodycam_install.js).
 *
 *   npm run test:install            без сети: локальный сервер
 *   npm run test:install -- --net   плюс настоящая установка: Python с python.org
 *                                   и два маленьких пакета с PyPI (~13 МБ)
 *
 * Без сети проверяется то, на чём установка ломается у людей: обрыв посреди
 * файла и докачка с места, сервер без докачки, переадресация, подменённый
 * файл, 404 без бесконечных повторов. С сетью — что встраиваемый Python
 * распаковывается, видит свои пакеты, а pip ставит колёса без интернета.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const BI = require('../bodycam_install');

let fails = 0;
const ok = (c, w) => { if (!c) fails++; console.log((c ? '  ок      ' : '  ПРОВАЛ  ') + w); };
const NET = process.argv.includes('--net');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protocol_bi_'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const DATA = crypto.randomBytes(3 * 1048576);
const OTHER = crypto.randomBytes(3 * 1048576);
let hits = [];     // { url, range }
let served = 0;    // байт отдано

const server = http.createServer((q, r) => {
  hits.push({ url: q.url, range: q.headers.range || '' });
  if (q.url === '/404') { r.writeHead(404); return r.end(); }
  if (q.url === '/redir/a.bin') { r.writeHead(302, { Location: '/a.bin' }); return r.end(); }
  const body = q.url === '/bad/a.bin' ? OTHER : DATA;
  const m = /bytes=(\d+)-/.exec(q.headers.range || '');
  const from = m && q.url !== '/norange/a.bin' ? Number(m[1]) : 0;
  const part = body.subarray(from);
  r.writeHead(from ? 206 : 200, { 'Content-Length': part.length });
  if (q.url !== '/slow/a.bin') { served += part.length; return r.end(part); }
  // медленно, кусками — чтобы успеть оборвать посреди файла
  let i = 0;
  const t = setInterval(() => {
    if (r.destroyed) return clearInterval(t);
    const c = part.subarray(i, i + 65536);
    if (!c.length) { clearInterval(t); return r.end(); }
    served += c.length; r.write(c); i += 65536;
  }, 15);
});

(async () => {
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = 'http://127.0.0.1:' + server.address().port;
  const item = (u, s) => ({ name: 'a.bin', url: base + u, size: DATA.length, sha256: s || sha(DATA) });
  const dest = path.join(tmp, 'dl', 'a.bin');
  let got = 0;
  const count = (n) => { got += n; };

  console.log('скачивание:');
  await BI.fetchFile(item('/a.bin'), dest, count);
  ok(fs.existsSync(dest) && !fs.existsSync(dest + '.part') && sha(fs.readFileSync(dest)) === sha(DATA) && got === DATA.length,
    'файл скачан, сумма сверена, прогресс сошёлся (' + got + ' байт)');

  hits = []; got = 0;
  await BI.fetchFile(item('/a.bin'), dest, count);
  ok(hits.length === 0 && got === DATA.length, 'уже скачанный и верный — повторно не качается, прогресс сразу полный');

  // обрыв посреди файла → докачка с места
  fs.rmSync(dest); hits = []; got = 0; served = 0;
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 350);
  let err = null;
  try { await BI.fetchFile(item('/slow/a.bin'), dest, count, ac.signal); } catch (e) { err = e; }
  const have = fs.existsSync(dest + '.part') ? fs.statSync(dest + '.part').size : 0;
  ok(err && err.cancelled && have > 0 && have < DATA.length, 'отмена посреди файла: недокачанное сохранено (' + (have / 1048576).toFixed(1) + ' из 3 МБ)');
  hits = []; served = 0; got = 0;
  await BI.fetchFile(item('/a.bin'), dest, count);
  ok(hits.length === 1 && hits[0].range === 'bytes=' + have + '-' && served === DATA.length - have && sha(fs.readFileSync(dest)) === sha(DATA),
    'докачка с места: запрошено ' + hits[0].range + ', дослано ' + served + ' байт, файл верный');
  ok(got === DATA.length, 'прогресс при докачке не завышен и не занижен: ' + got);

  // сервер без докачки: начинаем заново
  fs.rmSync(dest); fs.writeFileSync(dest + '.part', DATA.subarray(0, 1048576)); got = 0;
  await BI.fetchFile(item('/norange/a.bin'), dest, count);
  ok(sha(fs.readFileSync(dest)) === sha(DATA) && got === DATA.length, 'сервер без докачки — файл скачан с начала, верный');

  fs.rmSync(dest);
  await BI.fetchFile(item('/redir/a.bin'), dest, () => {});
  ok(sha(fs.readFileSync(dest)) === sha(DATA), 'переадресация (как у GitHub и huggingface) — проходит');

  fs.rmSync(dest); err = null; hits = [];
  try { await BI.fetchFile(item('/bad/a.bin'), dest, () => {}); } catch (e) { err = e; }
  ok(err && /контрольная сумма/.test(err.message) && !fs.existsSync(dest) && !fs.existsSync(dest + '.part') && hits.length === 1,
    'подменённый файл отвергнут и удалён, без повторов: «' + (err && err.message) + '»');

  err = null; hits = [];
  try { await BI.fetchFile(Object.assign(item('/404'), { name: 'x' }), path.join(tmp, 'x'), () => {}); } catch (e) { err = e; }
  ok(err && /404/.test(err.message) && hits.length === 1, '404 — сразу ошибка, без бесконечных повторов');

  console.log('план и состояние:');
  const M = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bodycam-manifest.json'), 'utf8'));
  const p0 = BI.plan(M, { cuda: false, models: ['large-v3-turbo'] });
  const p1 = BI.plan(M, { cuda: true, models: ['large-v3-turbo'] });
  const gb = (b) => (b / 1073741824).toFixed(2) + ' ГБ';
  ok(p1.bytes > p0.bytes + 1e9 && p0.items.some((x) => x.kind === 'model') && !p0.items.some((x) => x.kind === 'cuda'),
    'без NVIDIA ' + gb(p0.bytes) + ', с NVIDIA ' + gb(p1.bytes) + ' (turbo) — библиотеки CUDA только для NVIDIA');
  let threw = false; try { BI.plan(M, { models: ['../../x'] }); } catch (e) { threw = true; }
  ok(threw, 'неизвестная модель — ошибка, а не путь куда попало');
  const empty = path.join(tmp, 'none');
  ok(!BI.status(empty, M).installed, 'пустая папка — не установлено');
  ok(BI.freeSpace(path.join(tmp, 'a', 'b')) > 0, 'свободное место на диске видно: ' + gb(BI.freeSpace(tmp)));
  // GigaAM: шесть файлов onnx и словарь, кодировщик — последним; готова — когда на месте все
  const pg = BI.plan(M, { cuda: false, models: ['gigaam-v3'] }).items.filter((x) => x.kind === 'model');
  ok(pg.length === 6 && /encoder/.test(pg[pg.length - 1].dest.join('/')) && pg.every((x) => /^[0-9a-f]{64}$/.test(x.sha256)),
    'GigaAM: ' + pg.length + ' файлов с суммами, ' + gb(pg.reduce((a, x) => a + x.size, 0)) + ', кодировщик последним');
  const groot = path.join(tmp, 'g');
  for (const f of M.models['gigaam-v3'].files.slice(0, -1)) { fs.mkdirSync(BI.modelDir(groot, 'gigaam-v3'), { recursive: true }); fs.writeFileSync(path.join(BI.modelDir(groot, 'gigaam-v3'), f.path), 'x'); }
  ok(!BI.modelReady(groot, M, 'gigaam-v3'), 'без кодировщика модель не готова — недокачанная не выдаётся за готовую');
  fs.writeFileSync(path.join(BI.modelDir(groot, 'gigaam-v3'), 'v3_e2e_rnnt_encoder.int8.onnx'), 'x');
  ok(BI.modelReady(groot, M, 'gigaam-v3') && !BI.modelReady(groot, M, 'small'), 'все файлы на месте — готова; у Whisper по-прежнему model.bin');

  if (NET) {
    console.log('настоящая установка (python.org, PyPI):');
    const root = path.join(tmp, 'Bodycam');
    const mini = Object.assign({}, M, {
      wheels: { base: M.wheels.base.filter((w) => /^(idna|colorama)$/i.test(w.name)), cuda: [] },
      speaker: Object.assign({}, M.speaker),
      models: {},
    });
    const phases = [];
    let last = null;
    const st = await BI.install(root, mini, { cuda: false, models: [], onProgress: (p) => { last = p; if (!phases.includes(p.phase)) phases.push(p.phase); } });
    ok(st.installed && phases.join(',') === 'download,unpack,install,done', 'установлено, этапы: ' + phases.join(' → '));
    ok(last.done === last.total, 'прогресс дошёл до конца');
    const out = execFileSync(BI.pythonExe(root), ['-c', 'import sys, idna, colorama; print(sys.version.split()[0], idna.__version__)'], { encoding: 'utf8' }).trim();
    ok(new RegExp('^' + M.python.version.replace(/\./g, '\\.') + ' ').test(out), 'встраиваемый Python видит поставленные пакеты: ' + out);
    ok(!fs.existsSync(path.join(root, 'downloads')), 'скачанные архивы после установки удалены');
    ok(fs.existsSync(BI.speakerFile(root, mini)), 'модель голосов на месте');
    // обновление на месте: в списке появился пакет — качается только он, Python не трогается
    const pyMark = path.join(root, 'python', 'protocol_keep.txt');
    fs.writeFileSync(pyMark, 'x');
    const mini2 = Object.assign({}, mini, { version: mini.version + 1,
      wheels: { base: M.wheels.base.filter((w) => /^(idna|colorama|typing_extensions)$/i.test(w.name)), cuda: [] } });
    const ph2 = []; const names = [];
    const st2 = await BI.install(root, mini2, { cuda: false, models: [], onProgress: (p) => { if (!ph2.includes(p.phase)) ph2.push(p.phase); if (p.phase === 'download' && !names.includes(p.name)) names.push(p.name); } });
    const out2 = execFileSync(BI.pythonExe(root), ['-c', 'import idna, typing_extensions; print("ok")'], { encoding: 'utf8' }).trim();
    ok(st2.installed && st2.version === mini2.version && fs.existsSync(pyMark) && !ph2.includes('unpack') && out2 === 'ok',
      'обновление на месте: Python не распаковывался заново, новый пакет виден, этапы: ' + ph2.join(' → '));
    ok(!names.some((n) => /idna|colorama|Python/i.test(n)), 'скачано только новое: ' + names.join(', '));
    // ускорение NVIDIA — выбор пользователя: добавить и убрать на месте (роль CUDA играет colorama)
    const mini3 = Object.assign({}, mini2, { wheels: { base: M.wheels.base.filter((w) => /^(idna|typing_extensions)$/i.test(w.name)),
      cuda: M.wheels.base.filter((w) => /^colorama$/i.test(w.name)) } });
    let st3 = await BI.install(root, mini3, { cuda: true, models: [] });
    ok(st3.cuda && fs.existsSync(pyMark), 'ускорение отмечено, Python не переставлялся');
    st3 = await BI.install(root, mini3, { cuda: false, models: [] });
    let gone = false;
    try { execFileSync(BI.pythonExe(root), ['-c', 'import colorama'], { stdio: 'ignore' }); } catch (e) { gone = true; }
    ok(!st3.cuda && gone && fs.existsSync(pyMark), 'ускорение убрано: библиотеки сняты pip-ом, остальное на месте');
    const freed = BI.remove(root);
    ok(!fs.existsSync(root) && freed > 0, 'удаление целиком: освобождено ' + (freed / 1048576).toFixed(0) + ' МБ');
  } else {
    console.log('(настоящая установка — npm run test:install -- --net)');
  }

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + (fails ? 'ПРОВАЛОВ: ' + fails : 'установщик: всё в порядке'));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА: ' + (e && e.stack || e)); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (er) {} process.exit(1); });
