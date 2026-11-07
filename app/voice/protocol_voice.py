# -*- coding: utf-8 -*-
"""Служба распознавания речи для «Протокола».

Что это и почему отдельный процесс
----------------------------------
Приложение — Electron, распознавание — Python с моделью на видеокарте.
Связывать их внутри одного процесса нечем, поэтому служба поднимает
крошечный HTTP-сервер на 127.0.0.1 и отдаёт готовые реплики. Наружу
не слушает и без запроса от приложения ничего не делает.

Звук никуда не уходит. Модель работает на этой машине, на диск ничего
не пишется, в сеть не отправляется ни байта. Это не побочный плюс, а
условие: на второй дорожке звучат голоса других игроков, и отправлять
их на чужой сервис было бы нечестно по отношению к ним.

Две дорожки, а не одна
----------------------
  ВЫ      — микрофон. Голос офицера идёт мимо игры и остаётся чистым.
  ВОКРУГ  — то, что звучит в игре: гражданин, адвокат, прокурор.

Разделение не косметическое. Проверка показала, что машинные помехи
(двигатель, сирена, шипение) распознаванию почти не мешают, а ломает
его только чужая речь. На отдельной микрофонной дорожке её нет, поэтому
процедура разбирается надёжно даже посреди галдежа.

Служба НЕ знает законов и ничего не решает. Она отдаёт текст с временем
и оценкой уверенности; кто что нарушил — решает приложение, у которого
есть база текущего сервера. Так логика остаётся там, где её видно.

Запуск вручную (обычно её запускает само приложение):
    python protocol_voice.py --port 8777
"""

import sys
import os
import io
import json
import glob
import time
import queue
import ctypes
import threading
import argparse

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

SR = 16000
HERE = os.path.dirname(os.path.abspath(__file__))
# Встраиваемый Python установленного Bodycam (pythonXY._pth) НЕ кладёт папку
# скрипта в sys.path — соседний proc_loopback не находился, и «звук только
# игры» молча откатывался на весь звук ПК (найдено 31.10.2026 на настоящей
# установке). Добавляем сами.
if HERE not in sys.path:
    sys.path.insert(0, HERE)


# ── библиотеки CUDA ─────────────────────────────────────────────────────────
# Ставятся колёсами nvidia-*, но Windows не ищет DLL внутри site-packages сам.
# Мало объявить каталог: CTranslate2 зовёт LoadLibrary из своего кода по одному
# имени, а это в обход объявленных каталогов. Поэтому библиотеки затягиваются
# заранее и по полному пути — тогда поиск по имени находит уже загруженный
# модуль. Порядок важен: cublas зависит от cublasLt.
def _preload_cuda():
    base = None
    for cand in (os.path.join(sys.prefix, 'Lib', 'site-packages', 'nvidia'),
                 os.path.join(sys.prefix, 'lib', 'site-packages', 'nvidia')):
        if os.path.isdir(cand):
            base = cand
            break
    if not base:
        return
    dirs = glob.glob(os.path.join(base, '*', 'bin'))
    for d in dirs:
        try:
            os.add_dll_directory(d)
        except (OSError, AttributeError):
            pass
    os.environ['PATH'] = os.pathsep.join(dirs) + os.pathsep + os.environ.get('PATH', '')
    for pat in ('cublasLt64_*.dll', 'cublas64_*.dll', 'cudnn_ops*.dll', 'cudnn*64_*.dll'):
        for d in dirs:
            for f in sorted(glob.glob(os.path.join(d, pat))):
                try:
                    ctypes.WinDLL(f)
                except OSError:
                    pass


_preload_cuda()

import numpy as np                                    # noqa: E402
from faster_whisper import WhisperModel               # noqa: E402


# ── приведение частоты ──────────────────────────────────────────────────────
def _lowpass(x, sr, cut):
    n = 101
    t = np.arange(n) - (n - 1) / 2.0
    h = np.sinc(2 * cut / sr * t) * np.hamming(n)
    return np.convolve(x, h / h.sum(), mode='same').astype(np.float32)


def resample(x, src, dst):
    if src == dst:
        return x.astype(np.float32)
    if dst < src:
        x = _lowpass(x, src, dst * 0.45)
    n = int(round(len(x) * dst / float(src)))
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)


# ── нарезка на реплики ──────────────────────────────────────────────────────
class Segmenter:
    """Режет поток на реплики по паузам.

    Модель разбирает законченную фразу заметно лучше, чем кусок, обрезанный
    по таймеру посередине слова. Поэтому границу даёт тишина, а не часы:
    speech → пауза длиннее полусекунды → реплика готова.

    Порог громкости подстраивается под фон сам. Фиксированный порог означал бы,
    что на тихом микрофоне не слышно ничего, а на громком всё подряд считается
    речью, — а настраивать его руками посреди сцены никто не станет.
    """

    FRAME = 480                      # 30 мс
    SILENCE_TAIL = 0.55              # столько тишины закрывает реплику
    MIN_SPEECH = 0.35                # короче — это щелчок, а не слово
    MAX_LEN = 10.0                   # длинную речь режем принудительно

    def __init__(self):
        self.tail = np.zeros(0, dtype=np.float32)
        self.cur = []
        self.silence = 0.0
        self.speaking = False
        self.floor = 0.004
        self.t = 0.0
        self.start_t = 0.0

    def push(self, chunk):
        """Отдаёт список готовых реплик (начало, конец, звук)."""
        out = []
        buf = np.concatenate([self.tail, chunk]) if len(self.tail) else chunk
        n = (len(buf) // self.FRAME) * self.FRAME
        self.tail = buf[n:].copy()
        for i in range(0, n, self.FRAME):
            fr = buf[i:i + self.FRAME]
            lvl = float(np.sqrt(np.mean(fr * fr)) + 1e-9)
            dur = self.FRAME / float(SR)
            self.t += dur
            # фон запоминаем медленно и только по тишине
            if not self.speaking:
                self.floor = 0.995 * self.floor + 0.005 * lvl
            live = lvl > max(self.floor * 3.0, 0.006)
            if live:
                if not self.speaking:
                    self.speaking = True
                    self.start_t = self.t - dur
                    self.cur = []
                self.silence = 0.0
                self.cur.append(fr)
            elif self.speaking:
                self.silence += dur
                self.cur.append(fr)
                if self.silence >= self.SILENCE_TAIL:
                    out.append(self._close())
            if self.speaking and (self.t - self.start_t) >= self.MAX_LEN:
                out.append(self._close())
        return [o for o in out if o]

    def _close(self):
        aud = np.concatenate(self.cur) if self.cur else np.zeros(0, dtype=np.float32)
        st, en = self.start_t, self.t
        self.speaking = False
        self.silence = 0.0
        self.cur = []
        if (en - st) < self.MIN_SPEECH:
            return None
        return (st, en, aud)


# ── мусор распознавания ─────────────────────────────────────────────────────
# Модель училась в том числе на видео с субтитрами и на тишине, музыке и шуме
# «дописывает» титры: «Субтитры создавал DimaTorzok», «Продолжение следует…».
# Это не речь, и в разбор оно попадать не должно. Список — только то, что
# в живой сцене не говорят; обычное «спасибо» сюда не входит.
import re as _re                                                      # noqa: E402
HALLU = _re.compile(
    r'субтитр|dimatorzok|торзок|редактор[а-я]* субтитр|корректор[а-я]* [а-я]\.|'
    r'продолжение следует|спасибо за просмотр|подпис[а-я]+ на (?:наш )?канал|'
    r'ставьте лайк|amara\.org|^\W*(?:музыка|аплодисменты|смех)\W*$', _re.I)


def is_hallucination(text, seg):
    if HALLU.search(text or ''):
        return True
    # тишина, принятая за речь: модель сама считает, что речи нет,
    # и не уверена в тексте
    try:
        return float(seg.no_speech_prob) > 0.6 and float(seg.avg_logprob) < -1.0
    except Exception:
        return False


# ── кто говорит ─────────────────────────────────────────────────────────────
# На дорожке игры звучат все сразу: задержанный, адвокат, прокурор, напарник.
# Каждой реплике ставится метка голоса (S1, S2…) по «отпечатку голоса» —
# вектору, который модель выдаёт по звуку. Похожий на уже знакомый — тот же
# человек, непохожий — новый. Кто есть кто (адвокат, задержанный) решает
# приложение по смыслу сказанного; служба знает только «голос №2».
#
# Модель — ERes2Net (3D-Speaker, обучена на 200 тыс. голосов), ~40 МБ, на
# процессоре: ~40 мс на фразу, видеокарту у распознавания речи не отнимает.
#
# Выбрана по живой записи задержания (29.10): по фразам, где ясно, кто
# говорит, офицера от задержанного она отличает в 84% пар. Прежняя
# wespeaker ResNet34 на том же звуке давала 50% — наугад: голосовой чат игры
# сжимает звук, и её отпечатки у всех получались одинаковыми, все сливались
# в «Неизвестного 1». TitaNet — 81%, ERes2NetV2 — 85% при вдвое большем весе.
# Установленный Bodycam (4.0) передаёт свой путь — модель лежит в его папке.
SPK_MODEL = os.environ.get('PROTOCOL_SPK_MODEL') or os.path.join(
    HERE, 'models', '3dspeaker_speech_eres2net_base_200k_sv_zh-cn_16k-common.onnx')


class Speakers:
    # Сходство с «центром» голоса, начиная с которого это тот же человек.
    # Подобрано на той же записи: при 0.40 офицер, задержанный, мегафон и
    # прохожие разошлись по своим голосам; при 0.35 офицер и задержанный
    # слиплись, при 0.45–0.50 одного человека начинает дробить. Свои фразы
    # у этой модели в среднем 0.53, чужие 0.35. Синтезированные голоса одного
    # движка похожи сильнее живых — в проверке для них порог свой.
    # Подстраивается флагом --spk-thr.
    THR = 0.40
    MIN_SEC = 1.0          # короче — отпечаток ненадёжен, метку не ставим
    # Гигиена центров (05.11.2026). С GigaAM почти всё на записи шло в «S1»,
    # хотя отпечатки офицера и задержанного расходятся даже лучше, чем с
    # Whisper (AUC 0.94 против 0.84). Портила раскладка: GigaAM ставит тире
    # смены говорящего не всегда, и реплики по 8–10 с с двумя людьми, плюс
    # отпечаток всего куска для коротких реплик, вливались в центр S1 — он
    # становился «похож на всех» и тянул к себе задержанного (0.41–0.57).
    # Теперь: длинная реплика — окнами по 1.5 с (там обычно один человек),
    # голос — по большинству окон; центр пополняется только уверенным
    # совпадением (≥ THR + UPD); отпечаток куска — только для поиска. На
    # записи: офицер 11/11 в одном голосе, задержанный 5/5 в другом, голосов
    # 7 вместо 1; соседние настройки — 94–100 %, это не подгонка под точку.
    UPD = 0.10
    WIN, HOP, WIN_MIN = 1.5, 0.75, 3.0

    def __init__(self, log):
        self.ex = None
        self.cent = []     # [сумма векторов, сколько реплик]
        if not os.path.exists(SPK_MODEL):
            log('голоса не различаются: нет модели %s' % os.path.basename(SPK_MODEL))
            return
        try:
            import sherpa_onnx as so
            cfg = so.SpeakerEmbeddingExtractorConfig(model=SPK_MODEL, num_threads=2, provider='cpu')
            self.ex = so.SpeakerEmbeddingExtractor(cfg)
        except Exception as e:
            log('голоса не различаются: %s' % str(e)[:120])

    def embed(self, aud):
        st = self.ex.create_stream()
        st.accept_waveform(SR, aud)
        st.input_finished()
        e = np.asarray(self.ex.compute(st), dtype=np.float32)
        return e / (np.linalg.norm(e) + 1e-9)

    def _match(self, e, can_new=True, upd=True, excl=None):
        """Номер голоса для отпечатка (или None) и сходство с ним.
        excl — голос, которым это быть не может (сосед по разрезу)."""
        best, sim = -1, -1.0
        for i, (s, n) in enumerate(self.cent):
            if i == excl:
                continue
            c = s / (np.linalg.norm(s) + 1e-9)
            v = float(c @ e)
            if v > sim:
                best, sim = i, v
        if best >= 0 and sim >= self.THR:
            if upd and sim >= self.THR + self.UPD:
                self.cent[best][0] = self.cent[best][0] + e
                self.cent[best][1] += 1
            return best, sim
        if not can_new:
            return (best, sim) if best >= 0 else (None, 0.0)
        self.cent.append([e.copy(), 1])
        return len(self.cent) - 1, sim

    CP_THR = 0.40          # сходство «до» и «после» точки ниже — сменился говорящий
    SEG_MIN = 1.5          # часть короче (с) — не отдельная реплика
    INS_THR = 0.30         # короткая вставка: оба провала окон по 1 с ниже этого
    INS_GAP = (1.0, 2.6)   # и между ними столько секунд

    def runs(self, aud, short=True):
        """Части одной длинной реплики по говорящим (06.11.2026).

        GigaAM ставит тире на смене говорящего не всегда, и двое, говорящие
        без паузы, выходили одной строкой субтитров. Смена ищется так, как её
        обычно ищут: отпечаток двух окон до точки против двух окон после (окна
        не перекрываются); непохожи (< CP_THR) — и это самое непохожее место
        вокруг — здесь разрез. Голос части — большинством её окон, как в who()
        (подписи отдельных окон шумят, решение по одному окну не принимается).
        Возвращает [(начало, конец, номер голоса, сходство)] в секундах от
        начала куска — или None, если различать нечем."""
        if self.ex is None or aud is None or len(aud) < SR * self.WIN_MIN:
            return None
        n, h = int(self.WIN * SR), int(self.HOP * SR)
        try:
            E = [self.embed(aud[k:k + n]) for k in range(0, len(aud) - n + 1, h)]
        except Exception:
            return None
        if not E:
            return None
        dur = len(aud) / SR
        cps = []
        for i in range(1, len(E) - 3):
            left, right = E[i - 1] + E[i], E[i + 2] + E[i + 3]
            d = float((left / (np.linalg.norm(left) + 1e-9)) @ (right / (np.linalg.norm(right) + 1e-9)))
            cps.append((i * self.HOP + self.WIN, d))       # конец окна i = начало окна i+2
        cuts = []
        for k, (t, d) in enumerate(cps):
            if d >= self.CP_THR:
                continue
            if (k > 0 and cps[k - 1][1] < d) or (k + 1 < len(cps) and cps[k + 1][1] <= d):
                continue                                    # не самое непохожее место вокруг
            if t < self.SEG_MIN or dur - t < self.SEG_MIN or (cuts and t - cuts[-1] < self.SEG_MIN):
                continue
            cuts.append(t)
        # Короткая вставка чужим голосом (1–2.5 с: «А спарринг-партнёры есть
        # там, нет?» посреди речи офицера, запись 06.11) окнам в 1.5 с не
        # видна. Второй проход — окнами по 1 с, осторожный: нужны ДВА глубоких
        # провала подряд («вошёл — вышел», оба < INS_THR) на расстоянии
        # INS_GAP; одиночный провал коротких окон бывает и без смены голоса.
        # Шаг мелкий (0.25 с): с шагом 0.5 провал то находился, то нет —
        # в зависимости от того, где GigaAM начал фразу внутри куска.
        # short=False — второй проход выключен («Деление реплик: по голосам»).
        try:
            n1, h1 = int(1.0 * SR), int(0.25 * SR)
            E1 = [self.embed(aud[k:k + n1]) for k in range(0, len(aud) - n1 + 1, h1)] if short else []
        except Exception:
            E1 = []
        dips = []
        for k in range(4, len(E1) - 1):          # точка t = k·0.25: окна до кончаются в t, после — начинаются
            left = E1[k - 4] + (E1[k - 5] if k >= 5 else 0)
            right = E1[k] + E1[k + 1]
            d = float((left / (np.linalg.norm(left) + 1e-9)) @ (right / (np.linalg.norm(right) + 1e-9)))
            dips.append((k * 0.25, d))
        low = [t for k, (t, d) in enumerate(dips) if d < self.INS_THR
               and d <= min(x[1] for x in dips[max(0, k - 2):k + 3])]
        for x, y in zip(low, low[1:]):
            if self.INS_GAP[0] <= y - x <= self.INS_GAP[1] and x >= 0.8 and dur - y >= 0.8 \
                    and all(abs(x - c) > 0.8 and abs(y - c) > 0.8 for c in cuts):
                cuts += [x, y]
        cuts.sort()
        bounds = [0.0] + cuts + [dur]
        if cuts:
            # Соседи по разрезу — заведомо разные люди: кривая так сказала. Поэтому
            # часть не может получить голос предыдущей. Раньше обе сверялись с
            # «центрами» поодиночке и при широком центре (первый голос сцены
            # впитывает всех) получали один голос — и строка склеивалась обратно
            # (запись 06.11: «Гражданин, кто вам надел мешок…» внутри речи
            # задержанного). Голос части — по среднему её окон.
            out, prev = [], None
            for a, b in zip(bounds, bounds[1:]):
                ws = [e for wi, e in enumerate(E) if wi * self.HOP >= a - 1e-6 and wi * self.HOP + self.WIN <= b + 1e-6]
                try:
                    e = np.sum(ws, axis=0) if ws else self.embed(aud[int(a * SR):int(b * SR)])
                except Exception:
                    return None
                e = e / (np.linalg.norm(e) + 1e-9)
                j, sim = self._match(e, excl=prev)
                out.append((a, b, j, sim))
                prev = j
            return out
        out = []
        for a, b in zip(bounds, bounds[1:]):
            votes = {}
            for wi, e in enumerate(E):
                ws = wi * self.HOP
                if ws >= a - 1e-6 and ws + self.WIN <= b + 1e-6:
                    j, sim = self._match(e)
                    if j is not None:
                        votes.setdefault(j, []).append(sim)
            if not votes:
                j, sim = self._match(self.embed(aud[int(a * SR):int(b * SR)]))
                if j is None:
                    continue
                votes = {j: [sim]}
            j = max(votes, key=lambda x: (len(votes[x]), sum(votes[x])))
            sim = float(np.mean(votes[j]))
            if out and out[-1][2] == j:
                out[-1] = (out[-1][0], b, j, (out[-1][3] + sim) / 2)
            else:
                out.append((a, b, j, sim))
        return out or None

    def who(self, aud, fallback=False):
        """Метка голоса ('S1', 'S2'…) и сходство — или (None, 0).

        fallback=True — отпечаток всего куска между паузами для реплики
        короче секунды: там бывают несколько человек, поэтому он только
        ищет среди известных голосов — не пополняет их и не заводит новый."""
        if self.ex is None or aud is None or len(aud) < SR * self.MIN_SEC:
            return None, 0.0
        try:
            if fallback:
                i, sim = self._match(self.embed(aud), can_new=not self.cent, upd=False)
            elif len(aud) >= SR * self.WIN_MIN:
                n, h = int(self.WIN * SR), int(self.HOP * SR)
                votes = {}
                for k in range(0, len(aud) - n + 1, h):
                    j, s = self._match(self.embed(aud[k:k + n]))
                    if j is not None:
                        votes.setdefault(j, []).append(s)
                if not votes:
                    return None, 0.0
                i = max(votes, key=lambda j: (len(votes[j]), sum(votes[j])))
                sim = float(np.mean(votes[i]))
            else:
                i, sim = self._match(self.embed(aud))
        except Exception:
            return None, 0.0
        return ('S%d' % (i + 1), sim) if i is not None else (None, 0.0)


# ── захват звука ────────────────────────────────────────────────────────────
# Две библиотеки не от хорошей жизни: петлю системного звука Windows отдаёт
# только первой, а микрофон некоторых гарнитур объявляет формат, который
# первая не принимает и падает на проверке.
#
# COM — в КАЖДОМ потоке захвата. Звук Windows (WASAPI) работает через COM, а
# он инициализируется на поток. Библиотеки делают это один раз — при первой
# загрузке, в первом потоке. Каждая следующая сцена открывает звук из нового
# потока, и там COM нет: «Error 0x800401f0» у звука игры и ошибка запуска
# потока у микрофона. Служба при этом отвечала «слушаю» — отсюда «Bodycam
# работает через раз»: первая сцена после запуска слышит, следующие — нет.
COINIT_MULTITHREADED = 0x0


def _com_init():
    try:
        return ctypes.windll.ole32.CoInitializeEx(None, COINIT_MULTITHREADED) in (0, 1)   # S_OK, S_FALSE
    except Exception:
        return False


def _com_done(ok):
    if ok:
        try:
            ctypes.windll.ole32.CoUninitialize()
        except Exception:
            pass


# Устройство может быть занято долю секунды (прошлая сцена его ещё
# отпускает) — открываем с несколькими попытками, а не сдаёмся с первой.
OPEN_TRIES = 4
OPEN_PAUSE = 0.4


def capture_game(stop, on_chunk, log, what='звук игры', fault=None, only_game=False, info=None):
    """Звук игры. only_game — только процесс GTA5 (и дочерние): без Discord,
    музыки и роликов. Не нашли игру — весь звук ПК, с честной заметкой.
    info — сюда пишется, что слушаем на самом деле ('game' или 'pc'): от
    этого зависит, что сказать, если звук пропадёт."""
    info = info if info is not None else {}
    try:
        import soundcard as sc
    except Exception as e:
        log('%s: библиотека не поставлена (%s)' % (what, e))
        if fault:
            fault(what, 'библиотека не поставлена')
        return
    com = _com_init()
    try:
        if only_game:
            try:
                import proc_loopback
                pid = proc_loopback.find_pid()
            except Exception as e:
                pid = None
                log('%s: захват только игры недоступен (%s)' % (what, str(e)[:80]))
            if pid:
                err = None
                for attempt in range(OPEN_TRIES):
                    if stop.is_set():
                        return
                    try:
                        log('%s ← только GTA5 (процесс %d): Discord и музыка не слышны' % (what, pid))
                        info['source'] = 'game'
                        proc_loopback.capture(pid, stop, on_chunk)
                        return
                    except Exception as e:
                        err = e
                        time.sleep(OPEN_PAUSE)
                log('%s: звук игры отдельно не открылся (%s) — слушаю весь звук ПК' % (what, err))
            else:
                log('%s: GTA5 не запущена — слушаю весь звук ПК (Discord и музыка тоже попадут)' % what)
        err = None
        for attempt in range(OPEN_TRIES):
            if stop.is_set():
                return
            try:
                spk = sc.default_speaker()
                dev = sc.get_microphone(id=str(spk.name), include_loopback=True)
                with dev.recorder(samplerate=SR, channels=1, blocksize=1024) as r:
                    log('%s ← %s' % (what, spk.name))
                    info['source'] = 'pc'
                    while not stop.is_set():
                        on_chunk(np.asarray(r.record(numframes=2048), dtype=np.float32).reshape(-1))
                return
            except Exception as e:
                err = e
                time.sleep(OPEN_PAUSE)
        log('%s: сбой захвата — %s' % (what, err or type(err).__name__))
        if fault:
            fault(what, str(err or type(err).__name__))
    finally:
        _com_done(com)


def capture_voice(stop, on_chunk, log, fault=None):
    try:
        import sounddevice as sd
    except Exception as e:
        log('микрофон: библиотека не поставлена (%s)' % e)
        if fault:
            fault('микрофон', 'библиотека не поставлена')
        return
    com = _com_init()
    try:
        err = None
        for attempt in range(OPEN_TRIES):
            if stop.is_set():
                return
            try:
                api = [i for i, h in enumerate(sd.query_hostapis()) if 'WASAPI' in h['name']]
                api = api[0] if api else sd.default.hostapi
                idx = sd.query_hostapis(api)['default_input_device']
                dev = sd.query_devices()[idx]
                rate, ch = int(dev['default_samplerate']), max(1, dev['max_input_channels'])
                q = queue.Queue()

                def cb(data, frames, tinfo, status):
                    q.put(data.copy())

                with sd.InputStream(device=idx, channels=ch, samplerate=rate, dtype='float32',
                                    blocksize=2048, callback=cb):
                    log('микрофон ← %s' % dev['name'])
                    while not stop.is_set():
                        try:
                            d = q.get(timeout=0.2)
                        except queue.Empty:
                            continue
                        x = d.mean(axis=1) if d.ndim > 1 else d
                        on_chunk(resample(x.astype(np.float32), rate, SR))
                return
            except Exception as e:
                err = e
                time.sleep(OPEN_PAUSE)
        log('микрофон: сбой захвата — %s' % (err or type(err).__name__))
        if fault:
            fault('микрофон', str(err or type(err).__name__))
    finally:
        _com_done(com)


# ── модели речи: выбирает пользователь, скачиваются по запросу ──────────────
# Ни одна модель не едет с приложением: качается та, которую выбрали, при
# первом запуске с ней. Размеры — для сообщения «скачиваю ~N ГБ».
MODELS = {
    'large-v3':       {'repo': 'Systran/faster-whisper-large-v3', 'dl': 3.0},
    'large-v3-turbo': {'repo': 'mobiuslabsgmbh/faster-whisper-large-v3-turbo', 'dl': 1.6},
    'medium':         {'repo': 'Systran/faster-whisper-medium', 'dl': 1.5},
    'small':          {'repo': 'Systran/faster-whisper-small', 'dl': 0.5},
    # GigaAM-v3 (Сбер, MIT): только русский, e2e — с пунктуацией. RNN-T в int8
    # через onnxruntime, на процессоре. Замер на живой записи задержания
    # (03.11.2026): точнее Whisper large-v3 на голосовом чате игры («Полицейский
    # департамент…, прижмитесь к обочине» против «Чудо и болезнь. Салют
    # Лосатеса»), 184 с речи — за 5 с на процессоре; видеокарту не трогает
    # вовсе, поэтому и фризов в игре от неё нет. Подсказки словарём (vocab)
    # у неё нет — сленг понимает сама лучше, чем Whisper с подсказкой.
    'gigaam-v3':      {'repo': 'istupakov/gigaam-v3-onnx', 'dl': 0.23, 'engine': 'gigaam',
                       'mark': 'v3_e2e_rnnt_encoder.int8.onnx'},
}
# Сколько потоков процессора отдать GigaAM. Игре процессор тоже нужен; два
# потока разбирают десятисекундную фразу за 0,3 с (один — за 0,4, все 16 — не
# быстрее четырёх).
GIGAAM_THREADS = 2


# Установленный Bodycam (4.0): модели речи — в его папке, по одной на
# подпапку (model.bin, config.json…), скачанные установщиком приложения.
# Без неё (запуск из исходников) — имя модели и кэш huggingface, как раньше.
MODELS_DIR = os.environ.get('PROTOCOL_MODELS_DIR') or ''


def model_mark(size):
    """Файл, по которому видно, что модель скачана целиком: у Whisper —
    model.bin, у GigaAM — кодировщик (самый большой, качается последним)."""
    return MODELS.get(size, {}).get('mark', 'model.bin')


def model_path(size):
    p = os.path.join(MODELS_DIR, size) if MODELS_DIR else ''
    return p if p and os.path.exists(os.path.join(p, model_mark(size))) else None


def model_cached(size):
    if model_path(size):
        return True
    try:
        from huggingface_hub import try_to_load_from_cache
        p = try_to_load_from_cache(MODELS[size]['repo'], model_mark(size))
        return isinstance(p, str) and os.path.exists(p)
    except Exception:
        return False


def load_gigaam(path):
    """GigaAM-v3 e2e RNN-T на процессоре. path — папка установки; без неё
    (запуск из исходников) onnx_asr скачает модель в кэш huggingface сам."""
    import onnx_asr
    import onnxruntime as rt
    so = rt.SessionOptions()
    so.intra_op_num_threads = GIGAAM_THREADS
    so.inter_op_num_threads = 1
    return onnx_asr.load_model('gigaam-v3-e2e-rnnt', path, quantization='int8',
                               providers=['CPUExecutionProvider'], sess_options=so).with_timestamps()


# Уверенность GigaAM — средний логарифм вероятности токенов. На записи
# задержания ниже -0,5 — обрывки («Шак.», «Д.») на щелчках и вздохах.
GIGAAM_SURE = -0.5


def gigaam_pieces(res, dur, want_tokens=False):
    """Реплики из одного куска звука.

    GigaAM e2e сама ставит тире на смене говорящего: «— Так чё, сколько
    даёшь?— Я тебе не нужен.» По этому тире кусок делится на реплики, у
    каждой — своё время (по времени токенов) и своя уверенность. Голос потом
    определяется по каждой реплике отдельно — так, как Whisper отдавал свои
    отрезки. Возвращает [(начало, конец, текст, уверенность)] от начала куска."""
    import re
    toks = list(res.tokens or [])
    ts = list(res.timestamps or [])
    lps = list(res.logprobs or [])
    if not toks:
        t = (res.text or '').strip().lstrip('—').strip()
        return [(0.0, dur, t, -1.0)] if t else []
    groups, cur = [], []
    for i, tk in enumerate(toks):
        if tk.strip() == '—':
            if cur:
                groups.append(cur)
            cur = []
            continue
        cur.append(i)
    if cur:
        groups.append(cur)
    out = []
    for gi, g in enumerate(groups):
        text = ''.join(toks[i] for i in g).strip()
        # обрывок без слов («.», «Д.») — щелчок, а не речь
        if len(re.findall(r'[а-яёa-z]', text, re.I)) < 2:
            continue
        a = float(ts[g[0]]) if g[0] < len(ts) else 0.0
        b = float(ts[groups[gi + 1][0]]) if gi + 1 < len(groups) and groups[gi + 1][0] < len(ts) else dur
        conf = float(np.mean([lps[i] for i in g if i < len(lps)])) if lps else -1.0
        out.append((max(0.0, a), min(dur, max(b, a + 0.1)), text, conf))
        if want_tokens:
            out[-1] = out[-1] + ([(float(ts[i]) if i < len(ts) else a, toks[i], lps[i] if i < len(lps) else -1.0) for i in g],)
    return out


def split_by_voice(piece, runs):
    """Реплика (начало, конец, текст, уверенность, токены) → части по отрезкам
    голоса (Speakers.runs, время — от начала реплики). Граница — середина
    стыка соседних окон; часть без букв приклеивается к соседней.
    Возвращает [(начало, конец, текст, уверенность, номер голоса, сходство)]
    от начала куска."""
    import re
    a, b, text, conf, toks = piece
    if not runs or len(runs) < 2:
        return None
    # граница между отрезками: конец окна одного и начало окна другого — посередине
    cuts = [a + (runs[k][1] + runs[k + 1][0]) / 2 for k in range(len(runs) - 1)]
    parts = [[] for _ in runs]
    # по целым словам: GigaAM отдаёт кусочки слов («кро» + «ме»), и разрез по
    # кусочкам рвал слово пополам. Слово — от кусочка с пробелом впереди.
    words = []
    for t, tk, lp in toks:
        if not words or tk[:1].isspace() or not tk.strip():
            words.append([(t, tk, lp)])
        else:
            words[-1].append((t, tk, lp))
    # Разрез — к ближайшему стыку слов, где люди и сменяют друг друга: после
    # конца предложения или на самой большой паузе (±0.9 с). Окна в 1.5 с
    # знают место смены лишь с точностью до окна, и разрез вставал между
    # «думаете» и «что» вместо «…конечно. | Вы думаете…» (запись 06.11).
    def snap(c):
        best, bs = c, None
        for i in range(1, len(words)):
            t = words[i][0][0]
            if abs(t - c) > 0.9:
                continue
            prev = words[i - 1]
            gap = t - prev[-1][0]
            end = ''.join(x[1] for x in prev).rstrip()
            sc = (1.0 if end[-1:] in '.?!…' else 0.0) + min(gap, 1.0) - 0.4 * abs(t - c)
            if bs is None or sc > bs:
                best, bs = t, sc
        return best
    cuts = [snap(c) for c in cuts]
    groups = [[] for _ in runs]                     # слова по частям
    for w in words:
        k = sum(1 for c in cuts if w[0][0] >= c)
        groups[k].append(w)
    # части: [начало, конец, слова, голос, сходство]
    segs = []
    for k, g in enumerate(groups):
        segs.append([a if k == 0 else cuts[k - 1], cuts[k] if k < len(cuts) else b, g, runs[k][2], runs[k][3]])
    # Обрывок (меньше двух слов или короче 0.8 с) — не отдельная реплика, а
    # хвост соседней: «Семнадцать» в 0.1 с иначе получал свой голос.
    def small(sg):
        txt = ''.join(x[1] for w in sg[2] for x in w)
        return len(sg[2]) < 2 or len(re.findall(r'[а-яёa-z]', txt, re.I)) < 4 or (sg[2][-1][-1][0] - sg[2][0][0][0]) < 0.8
    changed = True
    while changed and len(segs) > 1:
        changed = False
        for i, sg in enumerate(segs):
            if sg[2] and not small(sg):
                continue
            j = i - 1 if i > 0 else i + 1
            o = segs[j]
            o[0], o[1] = min(o[0], sg[0]), max(o[1], sg[1])
            o[2] = (o[2] + sg[2]) if j < i else (sg[2] + o[2])
            del segs[i]
            changed = True
            break
    # соседние части одного голоса — одна строка
    k = 0
    while k < len(segs) - 1:
        if segs[k][3] == segs[k + 1][3]:
            segs[k][1] = segs[k + 1][1]; segs[k][2] += segs[k + 1][2]; del segs[k + 1]
        else:
            k += 1
    if len(segs) < 2:
        return None
    out = []
    for sg in segs:
        toks_ = [x for w in sg[2] for x in w]
        txt = ''.join(x[1] for x in toks_).strip()
        t0 = max(a, min(sg[0], toks_[0][0]) if out else a)
        out.append((t0, min(b, max(sg[1], t0 + 0.1)), txt, float(np.mean([x[2] for x in toks_])), sg[3], sg[4]))
    return out


# Отпечаток голоса — тоже по запросу: нет файла — скачиваем при старте сцены.
SPK_URL = ('https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/'
           '3dspeaker_speech_eres2net_base_200k_sv_zh-cn_16k-common.onnx')


def ensure_spk_model(log):
    if os.path.exists(SPK_MODEL):
        return True
    try:
        import urllib.request
        os.makedirs(os.path.dirname(SPK_MODEL), exist_ok=True)
        log('скачиваю модель голосов (~40 МБ) — один раз')
        tmp = SPK_MODEL + '.part'
        urllib.request.urlretrieve(SPK_URL, tmp)
        os.replace(tmp, SPK_MODEL)
        return True
    except Exception as e:
        log('модель голосов не скачалась (%s) — голоса различаться не будут' % str(e)[:100])
        return False


# ── состояние службы ────────────────────────────────────────────────────────
class StartCancelled(Exception):
    """«Стоп» пришёл, пока сцена запускалась."""


class Quiet:
    """Доходит ли звук игры вообще.

    Цифровая тишина (одни нули) дольше LIMIT секунд — не «в сцене молчат»:
    у игры всегда есть фон. Это «звук не доходит»: слушаем не тот процесс
    (голосовой чат идёт мимо игры) или игра без звука. Без этого Bodycam
    молча «слушал» бы тишину, и снаружи это выглядело бы как «не работает».

    Микрофон так не проверяется: гарнитуры с шумоподавлением в паузе отдают
    ровные нули (замерено на Razer Kaira 31.10: 78 блоков из 79 — нули), и
    обычная пауза выглядела бы как «микрофон молчит». Закрытый доступ к
    микрофону служба узнаёт прямо из настроек Windows — mic_blocked().
    """
    LIMIT = 60.0
    FLOOR = 1e-4

    def __init__(self, now):
        self.last = now        # последний живой звук; старт считаем живым
        self.alarm = False

    def feed(self, chunk, now):
        if chunk.size and float(np.max(np.abs(chunk))) > self.FLOOR:
            self.last = now

    def check(self, now):
        """'on' — поднять тревогу, 'off' — снять, None — без изменений."""
        quiet = now - self.last > self.LIMIT
        if quiet == self.alarm:
            return None
        self.alarm = quiet
        return 'on' if quiet else 'off'


QUIET_TEXT = {
    'pc': 'звук ПК молчит уже %d с — GTA5 не найдена, слушаю весь звук ПК, а на нём тишина',
    'around': 'звук игры молчит уже %d с — от GTA5 не приходит ни звука. Если игра '
              'без звука или голосовой чат идёт мимо неё, другие игроки не слышны',
    'mix': 'звук ПК молчит уже %d с — запустите видео',
}

MIC_FIX = ('Включите в Windows: Параметры → Конфиденциальность и защита → Микрофон → '
           '«Доступ к микрофону» и «Разрешить классическим приложениям доступ к микрофону». '
           'Потом остановите и запустите запись снова.')


def mic_blocked():
    """Закрыт ли микрофон настройками приватности Windows. Тогда программа
    получает тишину без всякой ошибки — снаружи это «Bodycam меня не
    слышит». Возвращает причину или None (в том числе если не прочитать)."""
    try:
        import winreg
    except Exception:
        return None
    base = r'Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone'
    checks = [(winreg.HKEY_LOCAL_MACHINE, base, 'доступ к микрофону запрещён для всего компьютера'),
              (winreg.HKEY_CURRENT_USER, base, 'выключен «Доступ к микрофону»'),
              (winreg.HKEY_CURRENT_USER, base + r'\NonPackaged',
               'выключено «Разрешить классическим приложениям доступ к микрофону»')]
    for root, path, why in checks:
        try:
            with winreg.OpenKey(root, path) as k:
                if str(winreg.QueryValueEx(k, 'Value')[0]).lower() == 'deny':
                    return why
        except OSError:
            continue
    return None


SPLIT_MODES = ('off', 'voice', 'full')


class Session:
    def __init__(self, model_size):
        self.model = None
        self.model_size = model_size
        self.engine = MODELS.get(model_size, {}).get('engine', 'whisper')
        self.device = '—'
        self.lock = threading.Lock()
        self.events = []
        self.seq = 0
        self.stop = threading.Event()
        self.running = False
        self.vocab = ''
        self.t0 = 0.0
        self.scene_from = 0
        self.mode = 'game'
        # «Деление реплик» (настройка Bodycam): off — строка как её дал
        # GigaAM (как в 4.3.0); voice — режется по смене голоса; full — ещё
        # и короткие вставки чужим голосом. Меняется и посреди сцены (/split).
        self.split = 'full'
        self.notes = []
        # Модель грузится внутри /start десятки секунд. Без замка второй
        # запрос, пришедший за это время, начал бы грузить вторую копию.
        self.start_lock = threading.Lock()
        # «Стоп», нажатый, пока модель грузится: запуск надо отменить, а не
        # молча довести до конца и открыть микрофон, которого уже не ждут.
        self.starting = False
        self.cancelled = False

    # ── журнал, который видно в приложении ──
    def log(self, msg):
        self.emit({'kind': 'note', 'text': msg})
        try:
            print(msg, flush=True)
        except Exception:
            pass

    def emit(self, obj):
        with self.lock:
            self.seq += 1
            obj = dict(obj)
            obj['n'] = self.seq
            obj['at'] = round(time.time() - self.t0, 2) if self.t0 else 0
            self.events.append(obj)
            if len(self.events) > 4000:
                del self.events[:1000]

    def since(self, n):
        with self.lock:
            return [e for e in self.events if e['n'] > n], self.seq

    # ── модель ──
    def ensure_model(self, size=None):
        """Модель речи, которую выбрал пользователь. Другая уже загружена —
        выгружаем её (видеопамять не резиновая). Нет на диске — скачивается
        здесь же, один раз (в кэш huggingface), и об этом сказано в журнале."""
        size = size if size in MODELS else self.model_size
        if self.model is not None and size == self.model_size:
            return
        if self.model is not None:
            self.log('меняю модель: %s → %s' % (self.model_size, size))
            self.model = None
            import gc
            gc.collect()
        self.model_size = size
        self.engine = MODELS[size].get('engine', 'whisper')
        self.notes = []
        if not model_cached(size):
            self.log('скачиваю модель %s (~%s ГБ) — один раз, дальше запуск за секунды'
                     % (size, MODELS[size]['dl']))
        probe = np.zeros(SR, dtype=np.float32)
        if self.engine == 'gigaam':
            try:
                t = time.time()
                m = load_gigaam(model_path(size))
                m.recognize(probe, sample_rate=SR)
                self.model, self.device = m, 'cpu'
                self.log('модель GigaAM-v3 на процессоре (%d потока), готова за %.0f с — видеокарту не занимает'
                         % (GIGAAM_THREADS, time.time() - t))
                return
            except ImportError:
                # среда Bodycam старше этой версии Protocol: пакета onnx_asr в ней нет
                raise RuntimeError('для GigaAM нужна обновлённая среда Bodycam — нажмите «Обновить» во вкладке Bodycam '
                                   '(модели скачивать заново не нужно)')
            except Exception as e:
                raise RuntimeError('модель GigaAM не запустилась: ' + str(e)[:200])
        for dev, ct in (('cuda', 'float16'), ('cpu', 'int8')):
            try:
                t = time.time()
                m = WhisperModel(model_path(self.model_size) or self.model_size, device=dev, compute_type=ct)
                list(m.transcribe(probe, language='ru')[0])
                self.model, self.device = m, dev
                self.log('модель %s на %s, готова за %.0f с'
                         % (self.model_size, 'видеокарте' if dev == 'cuda' else 'процессоре',
                            time.time() - t))
                return
            except Exception as e:
                self.notes.append('%s: %s' % (dev, str(e)[:160]))
        raise RuntimeError('модель не запустилась: ' + '; '.join(self.notes))

    def worker(self, stop, jobs, speakers):
        """Один поток на обе дорожки: видеокарта всё равно считает по очереди,
        а общая очередь сохраняет порядок реплик."""
        while not stop.is_set():
            try:
                track, st, en, aud = jobs.get(timeout=0.2)
            except queue.Empty:
                continue
            try:
                if self.engine == 'gigaam':
                    self.utter_gigaam(track, st, en, aud, speakers)
                    continue
                segs, _ = self.model.transcribe(
                    aud, language='ru', beam_size=5,
                    initial_prompt=self.vocab or None,
                    condition_on_previous_text=False,
                    vad_filter=True, vad_parameters={'min_silence_duration_ms': 300})
                # Каждая фраза — отдельное событие, а не весь кусок целиком.
                # Приложение показывает, ПО КАКОЙ фразе оно сделало вывод;
                # четырнадцатисекундный ком на эту роль не годится, а границы
                # фраз модель и так размечает вместе со временем.
                # Микрофон — всегда офицер; голоса различаем только на звуке ПК.
                diar = track != 'you'
                chunk_spk = None
                for s in segs:
                    txt = s.text.strip()
                    if not txt or is_hallucination(txt, s):
                        continue
                    lp = float(s.avg_logprob)
                    ev = {'kind': 'utt', 'track': track,
                          't0': round(st + float(s.start), 2),
                          't1': round(min(en, st + float(s.end)), 2),
                          'text': txt,
                          'conf': round(lp, 3), 'sure': bool(lp > -0.8)}
                    if diar:
                        piece = aud[int(float(s.start) * SR):int(float(s.end) * SR)]
                        spk, sim = speakers.who(piece)
                        if spk is None:
                            # фраза короче секунды — берём голос всего куска
                            # между паузами: обычно это один человек
                            if chunk_spk is None:
                                chunk_spk = speakers.who(aud, fallback=True)
                            spk, sim = chunk_spk
                        if spk:
                            ev['spk'] = spk
                            ev['spkSim'] = round(sim, 2)
                    self.emit(ev)
            except Exception as e:
                self.log('разбор реплики не удался: %s' % str(e)[:120])

    def utter_gigaam(self, track, st, en, aud, speakers):
        """Тот же путь, что у Whisper: реплика — событие со временем,
        уверенностью и голосом (голоса — только на звуке игры)."""
        res = self.model.recognize(aud, sample_rate=SR)
        diar = track != 'you'
        chunk_spk = None
        for piece in gigaam_pieces(res, en - st, want_tokens=True):
            a, b, txt, conf = piece[:4]
            if HALLU.search(txt):
                continue
            # Длинная реплика — голос по окнам; сменился внутри — строка режется
            # (двое без паузы выходили одной строкой субтитров, 06.11.2026)
            split = getattr(self, 'split', 'full')
            runs = speakers.runs(aud[int(a * SR):int(b * SR)], short=split == 'full')                 if diar and split != 'off' and (b - a) >= Speakers.WIN_MIN else None
            if runs:
                parts = split_by_voice(piece, runs)
                if not parts:
                    # голос один — какой занимает больше времени
                    g = max(runs, key=lambda r: r[1] - r[0])
                    parts = [(a, b, txt, conf, g[2], g[3])]
                for pa, pb, pt, pc, pi, ps in parts:
                    if HALLU.search(pt):
                        continue
                    self.emit({'kind': 'utt', 'track': track,
                               't0': round(st + pa, 2), 't1': round(min(en, st + pb), 2),
                               'text': pt, 'conf': round(pc, 3), 'sure': bool(pc > GIGAAM_SURE),
                               'spk': 'S%d' % (pi + 1), 'spkSim': round(ps, 2)})
                continue
            ev = {'kind': 'utt', 'track': track,
                  't0': round(st + a, 2), 't1': round(min(en, st + b), 2),
                  'text': txt, 'conf': round(conf, 3), 'sure': bool(conf > GIGAAM_SURE)}
            if diar:
                spk, sim = speakers.who(aud[int(a * SR):int(b * SR)])
                if spk is None:
                    if chunk_spk is None:
                        chunk_spk = speakers.who(aud, fallback=True)
                    spk, sim = chunk_spk
                if spk:
                    ev['spk'] = spk
                    ev['spkSim'] = round(sim, 2)
            self.emit(ev)

    def start(self, vocab, mode='game', model=None, split=None):
        """Начинает сцену и возвращает номер, с которого читать её события.

        Журнал событий общий на всю жизнь службы. Раньше приложение после
        повторного «Слушать» читало его с нуля и получало заодно «остановлено»
        от прошлой сцены — кнопка сама гасла, и нажимать приходилось дважды.
        Теперь граница сцены отдаётся явно.

        mode='pc' — временный режим для проверки по записи: звук ПК (видео
        задержания) разбирается за обе стороны сразу, потому что голос
        офицера в записи звучит не из микрофона, а из колонок.
        """
        with self.start_lock:
            if self.running:
                return self.scene_from
            # граница — до загрузки модели: строка «модель готова за N с»
            # относится уже к этой сцене
            with self.lock:
                self.scene_from = self.seq
            self.starting, self.cancelled = True, False
            try:
                self.ensure_model(model)
                ensure_spk_model(self.log)
            finally:
                self.starting = False
            if self.cancelled:
                self.log('запуск отменён — микрофон не открывался')
                raise StartCancelled()
            self.vocab = (vocab or '')[:900]
            self.mode = 'pc' if mode == 'pc' else 'game'
            if split in SPLIT_MODES:
                self.split = split
            # У каждой сцены свой флаг остановки и своя очередь. Общий флаг,
            # сброшенный через clear(), оставлял в живых потоки прошлой сцены,
            # если они не успели его заметить, — и звук шёл в разбор дважды.
            self.stop = stop = threading.Event()
            jobs = queue.Queue()
            self.t0 = time.time()
            self.running = True
            pc_track = 'mix' if self.mode == 'pc' else 'around'
            segs = {'you': Segmenter(), pc_track: Segmenter()}
            quiet = {pc_track: Quiet(self.t0)}
            heard = {}     # что слушает дорожка игры на самом деле — заполняет capture_game

            def feeder(track):
                def on_chunk(chunk):
                    if track in quiet:
                        quiet[track].feed(chunk, time.time())
                    for st, en, aud in segs[track].push(chunk):
                        jobs.put((track, st, en, aud))
                return on_chunk

            # тишина на дорожке — предупреждение в окне поверх игры, и снятие,
            # как только звук вернулся
            def watch():
                while not stop.wait(5):
                    now = time.time()
                    for track, q in quiet.items():
                        ch = q.check(now)
                        if ch:
                            key = 'pc' if track == 'around' and heard.get('source') == 'pc' else track
                            text = QUIET_TEXT[key] % Quiet.LIMIT
                            self.emit({'kind': 'warn', 'track': track, 'on': ch == 'on', 'text': text})
                            if ch == 'on':
                                self.log('тишина: ' + text)

            threading.Thread(target=watch, daemon=True).start()

            # голоса — заново на каждую сцену: в новой сцене новые люди
            threading.Thread(target=self.worker, args=(stop, jobs, Speakers(self.log)), daemon=True).start()
            # Источник не открылся — это не заметка в журнале, а отдельное
            # событие: приложение показывает его офицеру. Иначе служба молча
            # «слушает» тишину, и сбой выглядит как «Bodycam не слышит».
            def fault(source, text, fix=''):
                self.emit({'kind': 'fault', 'source': source, 'text': text[:200], 'fix': fix})

            # микрофон закрыт настройками Windows — сказать сразу и как открыть:
            # иначе вся сцена пройдёт «в тишине» без единой ошибки
            blocked = mic_blocked()
            if blocked:
                self.log('микрофон: ' + blocked)
                fault('микрофон', blocked, MIC_FIX)

            threading.Thread(target=capture_voice,
                             args=(stop, feeder('you'), self.log, fault), daemon=True).start()
            threading.Thread(target=capture_game,
                             args=(stop, feeder(pc_track), self.log,
                                   'звук ПК (запись)' if self.mode == 'pc' else 'звук игры', fault,
                                   # в игре — только GTA5; запись с ПК играет плеер, её не сузить
                                   self.mode == 'game', heard),
                             daemon=True).start()
            self.emit({'kind': 'state', 'running': True, 'mode': self.mode})
            self.log('слушаю' + (' — режим записи: звук ПК разбирается за обе стороны'
                                 if self.mode == 'pc' else ''))
            return self.scene_from

    def halt(self):
        if not self.running:
            if self.starting:
                self.cancelled = True
            return
        self.stop.set()
        self.running = False
        self.emit({'kind': 'state', 'running': False})
        self.log('остановлено')


# ── HTTP ────────────────────────────────────────────────────────────────────
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer   # noqa: E402
from urllib.parse import urlparse, parse_qs                            # noqa: E402

SESSION = None


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def _body(self):
        try:
            n = int(self.headers.get('Content-Length') or 0)
            return json.loads(self.rfile.read(n).decode('utf-8')) if n else {}
        except Exception:
            return {}

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == '/health':
            return self._send({'ok': True, 'running': SESSION.running,
                               'device': SESSION.device, 'model': SESSION.model_size,
                               'loaded': SESSION.model is not None})
        if u.path == '/events':
            q = parse_qs(u.query)
            since = int((q.get('since') or ['0'])[0])
            # ждём недолго, чтобы приложение не опрашивало вхолостую
            deadline = time.time() + 8.0
            while time.time() < deadline:
                items, seq = SESSION.since(since)
                if items:
                    return self._send({'items': items, 'seq': seq,
                                       'running': SESSION.running})
                time.sleep(0.15)
            return self._send({'items': [], 'seq': SESSION.seq, 'running': SESSION.running})
        return self._send({'error': 'нет такого адреса'}, 404)

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == '/start':
            b = self._body()
            try:
                since = SESSION.start(b.get('vocab') or '', b.get('mode') or 'game', b.get('model'), b.get('split'))
            except StartCancelled:
                return self._send({'ok': False, 'cancelled': True, 'error': 'запуск отменён'})
            except Exception as e:
                return self._send({'ok': False, 'error': str(e)[:300]}, 500)
            return self._send({'ok': True, 'device': SESSION.device,
                               'since': since, 'mode': SESSION.mode, 'model': SESSION.model_size})
        if u.path == '/split':
            v = self._body().get('split')
            if v not in SPLIT_MODES:
                return self._send({'ok': False, 'error': 'нет такого режима'}, 400)
            SESSION.split = v
            return self._send({'ok': True, 'split': v})
        if u.path == '/stop':
            SESSION.halt()
            return self._send({'ok': True})
        if u.path == '/quit':
            SESSION.halt()
            threading.Thread(target=lambda: (time.sleep(0.3), os._exit(0)), daemon=True).start()
            return self._send({'ok': True})
        return self._send({'error': 'нет такого адреса'}, 404)


def main():
    global SESSION
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8777)
    ap.add_argument('--model', default='large-v3-turbo')
    ap.add_argument('--spk-thr', type=float, default=Speakers.THR,
                    help='порог сходства голоса (выше — чаще считает разными людьми)')
    a = ap.parse_args()
    Speakers.THR = a.spk_thr
    SESSION = Session(a.model)
    srv = ThreadingHTTPServer(('127.0.0.1', a.port), Handler)
    print('служба распознавания на 127.0.0.1:%d' % a.port, flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
