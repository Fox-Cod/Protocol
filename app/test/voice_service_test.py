# -*- coding: utf-8 -*-
"""Проверка службы распознавания без модели речи: мусор и голоса.

    npm run test:service        (= ..\\voice-env\\Scripts\\python.exe test\\voice_service_test.py)

1. Мусор: «Субтитры создавал DimaTorzok» и подобное отбрасывается, живая
   речь — нет.
2. Голоса: служба различает людей по отпечатку голоса. Голоса берутся из
   синтезатора Windows (Ирина, Зира) и Ирина, пониженная пересэмплированием, —
   три «человека». У ERes2Net свой голос синтеза — 0.87–0.95, чужой —
   0.34–0.54, поэтому порог здесь 0.6. Для живой речи в службе 0.40:
   подобран по настоящей записи задержания, где свои фразы в среднем 0.53.

Звук нигде не сохраняется, кроме временной папки на время проверки.
"""
import os
import sys
import types
import wave
import shutil
import tempfile
import subprocess
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'voice'))
import protocol_voice as pv  # noqa: E402

fails = 0


def ok(cond, what):
    global fails
    if not cond:
        fails += 1
    print(('  ок      ' if cond else '  ПРОВАЛ  ') + what)


print('мусор распознавания:')
seg = types.SimpleNamespace(no_speech_prob=0.1, avg_logprob=-0.3)
for t in ['Субтитры создавал DimaTorzok', 'Продолжение следует...', 'Спасибо за просмотр!',
          'Редактор субтитров А.Семкин Корректор А.Егорова']:
    ok(pv.is_hallucination(t, seg), 'отброшено: ' + t)
for t in ['Спасибо, офицер.', 'Вы задержаны по подозрению в угоне.']:
    ok(not pv.is_hallucination(t, seg), 'оставлено: ' + t)
ok(pv.is_hallucination('Угу.', types.SimpleNamespace(no_speech_prob=0.9, avg_logprob=-1.4)),
   'тишина, принятая за речь, отброшена')

print('голоса:')
tmp = tempfile.mkdtemp(prefix='protocol_voices_')
try:
    ps = (
        "Add-Type -AssemblyName System.Speech;"
        "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;"
        "$f=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono);"
        "function W($v,$n,$t){$s.SelectVoice($v);$s.SetOutputToWaveFile('" + tmp + "\\'+$n,$f);$s.Speak($t);$s.SetOutputToNull()};"
        "W 'Microsoft Irina Desktop' 'i1.wav' 'На каком основании вы задержали моего подзащитного? Я требую объяснений.';"
        "W 'Microsoft Irina Desktop' 'i2.wav' 'Мой клиент имеет право на телефонный звонок, вы его предоставили?';"
        "W 'Microsoft Zira Desktop' 'z1.wav' 'I did not do anything, let me go right now, this is ridiculous.';"
        "W 'Microsoft Zira Desktop' 'z2.wav' 'Why are you arresting me, I want my lawyer, I know my rights.'"
    )
    r = subprocess.run(['powershell', '-NoProfile', '-Command', ps], capture_output=True)
    if r.returncode != 0 or not os.path.exists(os.path.join(tmp, 'z2.wav')):
        print('  пропущено: синтезатор Windows с голосами Irina и Zira недоступен')
    else:
        def load(n):
            with wave.open(os.path.join(tmp, n)) as w:
                return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768

        def low(x, f=0.8):
            n = int(len(x) / f)
            return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)

        pv.Speakers.THR = 0.6
        sp = pv.Speakers(print)
        ok(sp.ex is not None, 'модель отпечатков голоса загрузилась')
        seq = [load('i1.wav'), load('z1.wav'), load('i2.wav'), low(load('i1.wav')), load('z2.wav'), low(load('i2.wav'))]
        got = [sp.who(x)[0] for x in seq]
        ok(got == ['S1', 'S2', 'S1', 'S3', 'S2', 'S3'], 'три голоса разведены и узнаются снова: ' + ' '.join(map(str, got)))
        ok(sp.who(load('z1.wav')[:8000])[0] is None, 'полсекунды звука — метку не ставим')

        # Гигиена центров (05.11.2026): на живой записи реплики с двумя
        # людьми и отпечаток всего куска вливались в центр первого голоса,
        # и всё сливалось в «S1». Склеенная речь двух голосов — та же беда.
        sp2 = pv.Speakers(print)
        a1 = sp2.who(load('i1.wav'))[0]
        mix = np.concatenate([load('i2.wav'), load('z1.wav')])
        before = [(c[1], c[0].copy()) for c in sp2.cent]
        sp2.who(mix, fallback=True)
        ok(len(sp2.cent) == len(before) and all(c[1] == b[0] and np.allclose(c[0], b[1]) for c, b in zip(sp2.cent, before)),
           'отпечаток куска с двумя голосами только ищет — не пополняет и не заводит голос')
        sp2.who(mix)
        z = sp2.who(load('z2.wav'))[0]
        ok(z is not None and z != a1, 'после длинной реплики двух людей второй голос не прилипает к первому: %s / %s' % (a1, z))
        ok(sp2.who(load('i1.wav'))[0] == a1, 'и первый голос узнаётся по-прежнему')
        sp3 = pv.Speakers(print)
        ok(sp3.who(load('i1.wav'), fallback=True)[0] == 'S1', 'отпечаток куска в начале сцены, пока голосов нет, — заводит первый')

        # Двое без паузы — одна строка GigaAM. runs() находит смену голоса,
        # split_by_voice режет строку по словам (06.11.2026).
        # синтезированные голоса похожи сильнее живых — порог смены, как и
        # THR выше, для них свой
        pv.Speakers.CP_THR = 0.5
        sp4 = pv.Speakers(print)
        x1, x2 = load('i2.wav'), load('z1.wav')
        both = np.concatenate([x1, x2])
        rr = sp4.runs(both)
        edge = len(x1) / pv.SR
        ok(rr is not None and len(rr) == 2 and rr[0][2] != rr[1][2] and abs(rr[0][1] - edge) < 1.6,
           'смена голоса внутри строки найдена: %s (стык на %.1f с)' % ([(round(r[0], 1), round(r[1], 1), r[2]) for r in (rr or [])], edge))
        rr1 = pv.Speakers(print).runs(np.concatenate([load('i1.wav'), load('i2.wav')]))
        ok(rr1 is not None and len(rr1) == 1, 'один голос подряд — не режется: %d частей' % len(rr1 or []))
        if rr and len(rr) == 2:
            words = ['Мой', 'клиент', 'имеет', 'право', 'на', 'звонок', 'I', 'did', 'not', 'do', 'anything', 'let', 'me', 'go']
            dur = len(both) / pv.SR
            ts = [i * dur / len(words) for i in range(len(words))]
            toks = [(t, ' ' + w, -0.1) for t, w in zip(ts, words)]
            parts = pv.split_by_voice((0.0, dur, ' '.join(words), -0.1, toks), rr)
            ok(parts and len(parts) == 2 and parts[0][4] != parts[1][4] and 'звонок' in parts[0][2] + parts[1][2]
               and not any(w in parts[0][2].split() and w in parts[1][2].split() for w in words),
               'строка разрезана по целым словам на две реплики: ' + ' | '.join(p[2] for p in (parts or [])))

        # Короткая вставка чужим голосом посреди чужой речи (запись 06.11:
        # «А спарринг-партнёры есть там, нет?» — 1.3 с внутри речи офицера).
        pv.Speakers.INS_THR = 0.5
        ins = load('z1.wav')
        ins = ins[np.argmax(np.abs(ins) > 0.02):][:int(1.8 * pv.SR)]
        a, b = load('i1.wav'), load('i2.wav')
        rr2 = pv.Speakers(print).runs(np.concatenate([a, ins, b]))
        e0, e1 = len(a) / pv.SR, (len(a) + len(ins)) / pv.SR
        mid = [r for r in (rr2 or []) if r[0] > e0 - 0.8 and r[1] < e1 + 0.8]
        ok(rr2 is not None and len(rr2) == 3 and len(mid) == 1 and rr2[0][2] != mid[0][2],
           'вставка 1.8 с чужим голосом — отдельная часть: %s (вставка %.1f–%.1f с)'
           % ([(round(r[0], 1), round(r[1], 1), r[2]) for r in (rr2 or [])], e0, e1))
        # «Деление реплик: По голосам» — второй проход выключен, вставка не отделяется
        # (синтезированные голоса так непохожи, что 1.8 с находит и первый
        # проход, — поэтому проверяем сам второй: окон по 1 с быть не должно)
        sp5, lens = pv.Speakers(print), []
        _emb = sp5.embed
        sp5.embed = lambda x: (lens.append(len(x)), _emb(x))[1]
        sp5.runs(np.concatenate([a, ins, b]), short=False)
        ok(lens and pv.SR not in lens, '«По голосам» — второй проход (окна по 1 с) не запускается')
        lens.clear(); sp5.runs(np.concatenate([a, ins, b]))
        ok(pv.SR in lens, '«Со вставками» — запускается')
        # «Выкл» — служба строку не режет вовсе (путь 4.3.0)
        ses = pv.Session('gigaam-v3')
        ok(ses.split == 'full', 'по умолчанию — «Со вставками»')
        calls = []
        class _Sp:
            def runs(self, *x, **k): calls.append(1); return None
            def who(self, *x, **k): return ('S1', 0.9)
        class _M:
            def recognize(self, a, sample_rate=None):
                return types.SimpleNamespace(text='раз два три четыре', tokens=[' раз', ' два', ' три', ' четыре'],
                                             timestamps=[0.2, 1.2, 2.2, 3.2], logprobs=[-0.1] * 4)
        ses.model, ses.split = _M(), 'off'
        out = []; ses.emit = out.append
        ses.utter_gigaam('game', 0.0, 4.5, np.zeros(int(4.5 * pv.SR), np.float32), _Sp())
        ok(not calls and len(out) == 1, '«Выкл» — смену голоса не ищет, строка одна: %d / %d' % (len(calls), len(out)))
        ses.split = 'voice'
        ses.utter_gigaam('game', 0.0, 4.5, np.zeros(int(4.5 * pv.SR), np.float32), _Sp())
        ok(len(calls) == 1, '«По голосам» — ищет')

        # Звук только игры: слушаем ОДИН процесс. Процесс-«игра» говорит,
        # процесс-«Discord» молчит — его захват должен быть тишиной, даже
        # если в системе в это время играет что-то ещё.
        print('звук только одного процесса:')
        import threading
        import ctypes
        import proc_loopback as pl
        play = ('import wave, numpy as np, sounddevice as sd, time, sys\n'
                'w = wave.open(sys.argv[1]); x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768\n'
                'time.sleep(1.0); sd.play(x * 0.9, 16000); sd.wait()\n')
        game = subprocess.Popen([sys.executable, '-c', play, os.path.join(tmp, 'i1.wav')])
        quiet = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(9)'])
        got = {}

        def grab(name, pid):
            ctypes.windll.ole32.CoInitializeEx(None, 0)
            stop, buf = threading.Event(), []
            th = threading.Thread(target=pl.capture, args=(pid, stop, buf.append))
            th.start()
            import time as _t
            _t.sleep(6)
            stop.set()
            th.join(5)
            got[name] = np.concatenate(buf) if buf else np.zeros(0, np.float32)

        ths = [threading.Thread(target=grab, args=('игра', game.pid)), threading.Thread(target=grab, args=('посторонний', quiet.pid))]
        [t.start() for t in ths]
        [t.join() for t in ths]
        game.wait()
        quiet.kill()
        lvl = {k: float(np.sqrt(np.mean(v * v))) if len(v) else 0.0 for k, v in got.items()}
        ok(lvl['игра'] > 0.01, 'звук процесса-игры захвачен (громкость %.3f)' % lvl['игра'])
        ok(lvl['посторонний'] < 0.001, 'чужой процесс не слышен (громкость %.4f)' % lvl['посторонний'])
finally:
    shutil.rmtree(tmp, ignore_errors=True)

# Регрессия «Bodycam работает через раз»: каждая сцена открывает звук из
# НОВЫХ потоков; без инициализации COM в каждом из них вторая и следующие
# сцены молча не слышали ничего (Error 0x800401f0, ошибка запуска микрофона).
print('захват звука, три сцены подряд:')
import threading  # noqa: E402
import time  # noqa: E402
for scene in range(3):
    stop = threading.Event()
    got = {'you': 0, 'pc': 0}
    faults = []

    def sink(name):
        def f(chunk):
            got[name] += len(chunk)
        return f

    ts = [threading.Thread(target=pv.capture_voice, args=(stop, sink('you'), lambda m: None, lambda s, t: faults.append(s + ': ' + t))),
          threading.Thread(target=pv.capture_game, args=(stop, sink('pc'), lambda m: None, 'звук ПК', lambda s, t: faults.append(s + ': ' + t)))]
    for t in ts:
        t.start()
    time.sleep(1.5)
    stop.set()
    for t in ts:
        t.join(timeout=5)
    # звук ПК при полной тишине может не прийти вовсе — главное, что нет сбоя
    ok(not faults and got['you'] > 0, 'сцена %d: микрофон слышит (%d отсчётов), сбоев нет%s'
       % (scene + 1, got['you'], (' — ' + '; '.join(faults)) if faults else ''))

# «Стоп», нажатый, пока модель грузится: раньше служба отвечала «остановлено»
# (слушать она ещё не начала), догружала модель и всё равно открывала
# микрофон. Загрузка модели здесь подменена паузой — сама модель не нужна.
print('отмена запуска:')
sess = pv.Session('small')
sess.ensure_model = lambda size=None: time.sleep(1.0)
res = {}


def go():
    try:
        res['since'] = sess.start('', 'game', 'small')
    except pv.StartCancelled:
        res['cancelled'] = True


th = threading.Thread(target=go)
th.start()
time.sleep(0.3)
sess.halt()
th.join(10)
ok(res.get('cancelled') and not sess.running,
   '«стоп» во время загрузки модели отменяет запуск — микрофон не открывается')
sess.ensure_model = lambda size=None: None
since = sess.start('', 'game', 'small')
ok(sess.running, 'следующий запуск после отмены идёт как обычно')
sess.halt()

# Тишина звука игры: одни нули дольше 60 с — «звук не доходит» (не тот
# процесс, игра без звука). Тихий фон — не тревога.
print('тишина звука игры:')
q = pv.Quiet(0.0)
zeros = np.zeros(1600, np.float32)
noise = (np.random.RandomState(1).randn(1600) * 0.002).astype(np.float32)
for t in range(5, 60, 5):
    q.feed(zeros, float(t))
ok(q.check(59.0) is None, '59 с нулей — ещё не тревога')
q.feed(zeros, 65.0)
ok(q.check(65.0) == 'on' and q.check(70.0) is None, '60+ с нулей — тревога, и один раз, а не каждые 5 с')
q.feed(noise, 75.0)
ok(q.check(75.0) == 'off', 'звук вернулся — тревога снята')
q2 = pv.Quiet(0.0)
ok_q2 = True
for t in range(5, 300, 5):
    q2.feed(noise * 0.1, float(t))
    ok_q2 = ok_q2 and q2.check(float(t)) is None
ok(ok_q2 and not q2.alarm, 'тихий фон (0.0002) — не тревога за 5 мин')
ok('GTA5' in pv.QUIET_TEXT['around'] % pv.Quiet.LIMIT and 'you' not in pv.QUIET_TEXT,
   'микрофон по нулям не проверяется (гарнитуры в паузе отдают нули); текст про игру: «'
   + pv.QUIET_TEXT['around'] % pv.Quiet.LIMIT + '»')

# Микрофон, закрытый настройками приватности Windows, — программа получает
# тишину без ошибки. Служба читает настройку и говорит, какую включить.
print('доступ к микрофону в Windows:')
real = pv.mic_blocked()
ok(real is None, 'на этом ПК доступ открыт: ' + str(real))


class FakeReg:
    HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER = 1, 2

    def __init__(self, deny):
        self.deny = deny

    def OpenKey(self, root, path):
        key = (root, path.endswith('NonPackaged'))
        reg = self

        class K:
            def __enter__(s):
                return key

            def __exit__(s, *a):
                return False
        return K()

    def QueryValueEx(self, key, name):
        return ('Deny' if key == self.deny else 'Allow', 1)


saved = sys.modules.get('winreg')
try:
    sys.modules['winreg'] = FakeReg((2, True))
    why = pv.mic_blocked()
    ok(why and 'классическим приложениям' in why, 'выключено для классических приложений — так и сказано: «%s»' % why)
    sys.modules['winreg'] = FakeReg((2, False))
    ok('Доступ к микрофону' in (pv.mic_blocked() or ''), 'выключен общий доступ — так и сказано')
    ok('Параметры' in pv.MIC_FIX, 'к сбою приложен путь в настройках Windows')
finally:
    if saved is not None:
        sys.modules['winreg'] = saved

# GigaAM ставит тире на смене говорящего — по нему кусок делится на реплики со
# своим временем и уверенностью; обрывки без слов («.», «Д.») отбрасываются.
print('GigaAM: реплики из куска:')
toks = [' —', ' Так', ' чё', '?', ' —', ' Я', ' тебе', ' не', ' ну', 'жен', '.', ' —', ' Д', '.']
ts = [0.0, 0.04, 0.16, 0.3, 1.8, 1.96, 2.08, 2.56, 2.68, 2.8, 2.92, 3.0, 3.1, 3.2]
lps = [-0.2, -0.03, -0.2, -0.4, -0.1, 0.0, -0.04, -0.5, -0.36, 0.0, -0.46, -0.3, -0.9, -0.9]
r = types.SimpleNamespace(text='', tokens=toks, timestamps=ts, logprobs=lps)
pcs = pv.gigaam_pieces(r, 4.0)
ok([p[2] for p in pcs] == ['Так чё?', 'Я тебе не нужен.'], 'по тире — две реплики, обрывок «Д.» отброшен: %s' % [p[2] for p in pcs])
# конец реплики — где начал говорить следующий (первое слово после тире)
ok(abs(pcs[0][0] - 0.04) < 1e-6 and abs(pcs[0][1] - 1.96) < 1e-6 and abs(pcs[1][1] - 3.1) < 1e-6,
   'у каждой реплики своё время: %s' % [(round(p[0], 2), round(p[1], 2)) for p in pcs])
ok(all(p[3] > pv.GIGAAM_SURE for p in pcs), 'уверенность — средний логарифм вероятности токенов')
ok(pv.gigaam_pieces(types.SimpleNamespace(text='Вы задержаны.', tokens=None, timestamps=None, logprobs=None), 2.0)[0][2] == 'Вы задержаны.',
   'без токенов — весь текст одной репликой')
ok(pv.model_mark('gigaam-v3') == 'v3_e2e_rnnt_encoder.int8.onnx' and pv.model_mark('small') == 'model.bin',
   'готовность модели — по своему файлу: у GigaAM кодировщик, у Whisper model.bin')

print('\n' + ('ПРОВАЛОВ: %d' % fails if fails else 'служба: всё в порядке'))
sys.exit(1 if fails else 0)
