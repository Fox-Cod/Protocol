#!/usr/bin/env node
/**
 * Список установки Bodycam — app/bodycam-manifest.json.
 *
 *   node tools/bodycam-manifest.js [путь к voice-env]      (по умолчанию ..\voice-env)
 *
 * Bodycam не едет в Protocol.exe: среда распознавания весит гигабайты, и
 * нужна она не всем. Приложение скачивает её само по этому списку. Список
 * собирается с проверенного окружения разработчика (voice-env), чтобы у
 * пользователя стояло ровно то, на чём всё проверено:
 *
 *   python  — встраиваемый Python той же версии, с python.org;
 *   pip     — колесо pip: им ставятся остальные колёса, без сети (--no-index);
 *   wheels  — каждый пакет voice-env: тот файл с PyPI, чья метка совпадает
 *             с установленной (cp314-win_amd64, abi3, none-any…). base — всем,
 *             cuda — только при видеокарте NVIDIA (это 2 ГБ из 2,3);
 *   speaker — модель голосов (ERes2Net) с GitHub;
 *   models  — модели речи: файлы снимка из кэша huggingface разработчика,
 *             адрес привязан к коммиту — через месяц скачается то же самое.
 *             Модели, которых в кэше нет (кэш чистили), берутся из прежнего
 *             списка: коммит и суммы в нём те же, переснимать нечего.
 *             GigaAM — не из кэша, а прямо из репозитория по закреплённому
 *             коммиту (HF_PINNED): только нужные файлы RNN-T int8, суммы
 *             больших файлов — из LFS, мелких — по скачанному.
 *
 * У каждого файла — адрес, размер и sha256. Приложение не установит файл,
 * чья сумма не совпала: даже взломанный хостинг не подсунет чужое.
 *
 * Сеть: метаданные PyPI и сам встраиваемый Python (~11 МБ, ради суммы).
 * Суммы колёс берутся из PyPI, суммы моделей — считаются по кэшу на диске.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const APP = path.join(__dirname, '..');
const ENV = path.resolve(process.argv[2] || path.join(APP, '..', 'voice-env'));
const OUT = path.join(APP, 'bodycam-manifest.json');
const PY = path.join(ENV, 'Scripts', 'python.exe');

// модели — те же, что предлагает приложение (VOICE_MODELS в main.js)
const MODELS = {
  'large-v3': 'Systran/faster-whisper-large-v3',
  'large-v3-turbo': 'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
  'medium': 'Systran/faster-whisper-medium',
  'small': 'Systran/faster-whisper-small',
};

// Модели, которые берутся прямо из репозитория: коммит и список файлов.
// GigaAM-v3 e2e RNN-T int8 (~225 МБ): только эти файлы нужны onnx_asr;
// кодировщик — последним (по нему служба видит, что модель скачана целиком).
const HF_PINNED = {
  'gigaam-v3': {
    repo: 'istupakov/gigaam-v3-onnx',
    commit: '322c3b29492673eb7d0b434bfa9dfb8653e34d02',
    files: ['config.json', 'v3_e2e_rnnt.yaml', 'v3_e2e_rnnt_vocab.txt', 'v3_e2e_rnnt_decoder.int8.onnx',
      'v3_e2e_rnnt_joint.int8.onnx', 'v3_e2e_rnnt_encoder.int8.onnx'],
  },
};

const log = (m) => process.stdout.write(m + '\n');

function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(8 * 1048576);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Protocol-bodycam-manifest' } });
  if (!r.ok) throw new Error(url + ' → ' + r.status);
  return r.json();
}

// Метки колеса из имени файла: name-ver(-build)?-py-abi-plat.whl, сжатые
// наборы через точку (py2.py3-none-any) раскрываются в произведение.
function wheelTags(filename) {
  const parts = filename.replace(/\.whl$/, '').split('-');
  const [py, abi, plat] = parts.slice(-3);
  const out = new Set();
  for (const a of py.split('.')) for (const b of abi.split('.')) for (const c of plat.split('.')) out.add(a + '-' + b + '-' + c);
  return out;
}

// Установленные пакеты voice-env с метками из их WHEEL — так выбирается
// ровно тот файл с PyPI, который поставил pip, а не «похожий».
function installed() {
  const code = [
    'import json, importlib.metadata as m',
    'out = []',
    'for d in m.distributions():',
    '    w = d.read_text("WHEEL") or ""',
    '    tags = [l.split(":", 1)[1].strip() for l in w.splitlines() if l.startswith("Tag:")]',
    '    out.append({"name": d.metadata["Name"], "version": d.version, "tags": tags})',
    'print(json.dumps(out))',
  ].join('\n');
  const ver = execFileSync(PY, ['-c', 'import platform; print(platform.python_version())'], { encoding: 'utf8' }).trim();
  const list = JSON.parse(execFileSync(PY, ['-c', code], { encoding: 'utf8' }));
  return { ver, list };
}

async function wheelFor(pkg) {
  const meta = await getJson('https://pypi.org/pypi/' + encodeURIComponent(pkg.name) + '/' + encodeURIComponent(pkg.version) + '/json');
  const want = new Set(pkg.tags);
  const cands = meta.urls.filter((u) => u.packagetype === 'bdist_wheel' && [...wheelTags(u.filename)].some((t) => want.has(t)));
  if (!cands.length) throw new Error(pkg.name + ' ' + pkg.version + ': на PyPI нет колеса с меткой ' + pkg.tags.join(', ') +
    ' — значит, у разработчика пакет собирался на месте, и раздать его так нельзя');
  // точное совпадение набора меток — первым
  cands.sort((a, b) => Math.abs(wheelTags(a.filename).size - want.size) - Math.abs(wheelTags(b.filename).size - want.size));
  const u = cands[0];
  return { name: pkg.name, version: pkg.version, file: u.filename, url: u.url, size: u.size, sha256: u.digests.sha256 };
}

async function python(ver) {
  const file = 'python-' + ver + '-embed-amd64.zip';
  const url = 'https://www.python.org/ftp/python/' + ver + '/' + file;
  const tmp = path.join(os.tmpdir(), file);
  log('  встраиваемый Python ' + ver + ' — качаю ради контрольной суммы…');
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' → ' + r.status);
  fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
  const res = { version: ver, file, url, size: fs.statSync(tmp).size, sha256: sha256File(tmp) };
  fs.rmSync(tmp, { force: true });
  return res;
}

function speaker() {
  const src = fs.readFileSync(path.join(APP, 'voice', 'protocol_voice.py'), 'utf8');
  const url = (src.match(/SPK_URL = \(([\s\S]*?)\)/) || [])[1].replace(/['\s]/g, '');
  const file = url.split('/').pop();
  const local = path.join(APP, 'voice', 'models', file);
  if (!fs.existsSync(local)) throw new Error('нет модели голосов ' + local + ' — скачайте её (app/CLAUDE.md)');
  return { file, url, size: fs.statSync(local).size, sha256: sha256File(local) };
}

function hubDir() {
  return process.env.HF_HUB_CACHE ||
    path.join(process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface'), 'hub');
}

function model(id, repo) {
  const snaps = path.join(hubDir(), 'models--' + repo.replace('/', '--'), 'snapshots');
  let commit = null;
  try { commit = fs.readdirSync(snaps).find((c) => fs.existsSync(path.join(snaps, c, 'model.bin'))); } catch (e) {}
  if (!commit) throw new Error('модель ' + id + ' не скачана у разработчика (' + snaps + ') — запустите с ней Bodycam хоть раз');
  const dir = path.join(snaps, commit);
  const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort().map((f) => {
    log('  ' + id + '/' + f + '…');
    const p = path.join(dir, f);
    return { path: f, url: 'https://huggingface.co/' + repo + '/resolve/' + commit + '/' + f, size: fs.statSync(p).size, sha256: sha256File(p) };
  });
  return { repo, commit, files };
}

async function pinned(id) {
  const p = HF_PINNED[id];
  const tree = await getJson('https://huggingface.co/api/models/' + p.repo + '/tree/' + p.commit);
  const files = [];
  for (const f of p.files) {
    const t = tree.find((x) => x.path === f);
    if (!t) throw new Error(p.repo + '@' + p.commit + ': нет файла ' + f);
    const url = 'https://huggingface.co/' + p.repo + '/resolve/' + p.commit + '/' + f;
    let sha = t.lfs && t.lfs.oid;
    if (!sha) {   // мелкий файл не в LFS — сумму считаем по скачанному
      const r = await fetch(url);
      if (!r.ok) throw new Error(url + ' → ' + r.status);
      sha = crypto.createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex');
    }
    log('  ' + id + '/' + f + '…');
    files.push({ path: f, url, size: t.lfs ? t.lfs.size : t.size, sha256: sha });
  }
  return { repo: p.repo, commit: p.commit, files };
}

(async () => {
  log('Список установки Bodycam по ' + ENV);
  let old = null;
  try { old = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {}
  const { ver, list } = installed();
  const pip = list.find((d) => d.name.toLowerCase() === 'pip');
  if (!pip) throw new Error('в voice-env нет pip');
  const wheels = { base: [], cuda: [] };
  for (const d of list.sort((a, b) => a.name.localeCompare(b.name))) {
    if (d.name.toLowerCase() === 'pip') continue;
    const w = await wheelFor(d);
    (/^nvidia-/i.test(d.name) ? wheels.cuda : wheels.base).push(w);
    log('  ' + w.file + '  ' + (w.size / 1048576).toFixed(1) + ' МБ');
  }
  const manifest = {
    // Номер среды: менять при любой правке состава. Приложение сравнивает его
    // с установленным и предлагает «Обновить Bodycam».
    version: 1,
    made: new Date().toISOString().slice(0, 10),
    python: await python(ver),
    pip: await wheelFor(pip),
    wheels,
    speaker: speaker(),
    models: {},
  };
  for (const id of Object.keys(MODELS)) {
    try { manifest.models[id] = model(id, MODELS[id]); } catch (e) {
      if (!(old && old.models && old.models[id])) throw e;
      log('  модель ' + id + ' — нет в кэше, беру из прежнего списка (' + old.models[id].commit.slice(0, 8) + ')');
      manifest.models[id] = old.models[id];
    }
  }
  for (const id of Object.keys(HF_PINNED)) manifest.models[id] = await pinned(id);
  // номер среды не сбрасываем: если состав не изменился, оставляем прежний,
  // если изменился — поднимаем на единицу
  if (old) {
    const same = (o) => JSON.stringify([o.python, o.pip, o.wheels, o.speaker]);
    manifest.version = same(old) === same(manifest) ? old.version : old.version + 1;
  }
  fs.writeFileSync(OUT, JSON.stringify(manifest, null, 1) + '\n');
  const sum = (a) => a.reduce((s, x) => s + x.size, 0);
  const gb = (b) => (b / 1073741824).toFixed(2) + ' ГБ';
  log('\nГотово: ' + path.relative(process.cwd(), OUT) + ', среда v' + manifest.version);
  log('  Python ' + gb(manifest.python.size) + ', основа ' + gb(sum(wheels.base) + manifest.pip.size) +
    ', CUDA ' + gb(sum(wheels.cuda)) + ', голоса ' + gb(manifest.speaker.size));
  for (const id of Object.keys(manifest.models)) log('  модель ' + id + ' ' + gb(sum(manifest.models[id].files)));
})().catch((e) => { console.error('ОШИБКА: ' + e.message); process.exit(1); });
