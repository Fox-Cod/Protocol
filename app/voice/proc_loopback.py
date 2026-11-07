# -*- coding: utf-8 -*-
"""Звук ОДНОГО процесса (и его дочерних) — Windows Application Loopback.

Зачем
-----
Петля всего системного звука слышит не только игру: Discord, музыку, ролики.
Их голоса попадали в разбор «Неизвестными», а фразы — в «вопросы адвоката».
Голосовой чат Majestic играет внутри самого GTA5.exe (клиент грузит в игру
библиотеку BASS — видно в его журнале: «[voice] BASS: Device initialized»),
поэтому достаточно слушать процесс игры вместе с дочерними.

Как
---
ActivateAudioInterfaceAsync(VAD\\Process_Loopback) с параметрами
PROCESS_LOOPBACK → IAudioClient → IAudioCaptureClient. Готовой обёртки под
Python нет, поэтому COM здесь вручную, через ctypes: свой объект-обработчик
завершения (с IAgileObject — иначе Windows его не примет) и вызовы по
таблицам методов. Формат просим сразу 16 кГц моно 16 бит
(AUTOCONVERTPCM) — пересэмплировать не нужно.

Требует Windows 10 2104+ / Windows 11. Поток, который вызывает capture(),
должен инициализировать COM (MTA) — это делает служба.
"""
import ctypes
import ctypes.wintypes as wt
import subprocess
import threading

import numpy as np

SR = 16000

_ole32 = ctypes.OleDLL('ole32')
_kernel32 = ctypes.WinDLL('kernel32')
_mmdev = ctypes.WinDLL('Mmdevapi')

HRESULT = ctypes.c_long
E_NOINTERFACE = -2147467262          # 0x80004002


class GUID(ctypes.Structure):
    _fields_ = [('Data1', ctypes.c_uint32), ('Data2', ctypes.c_uint16),
                ('Data3', ctypes.c_uint16), ('Data4', ctypes.c_ubyte * 8)]


def _guid(s):
    g = GUID()
    _ole32.CLSIDFromString(ctypes.c_wchar_p(s), ctypes.byref(g))
    return g


def _same(a, b):
    return bytes(memoryview(a)) == bytes(memoryview(b))


IID_IUnknown = _guid('{00000000-0000-0000-C000-000000000046}')
IID_IAgileObject = _guid('{94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90}')
IID_Handler = _guid('{41D949AB-9862-444A-80F6-C261334DA5EB}')
IID_IAudioClient = _guid('{1CB9AD4C-DBFA-4C32-B178-C2F568A703B2}')
IID_IAudioCaptureClient = _guid('{C8ADBD64-E71E-48A0-A4DE-185C395CD317}')

VIRTUAL_PROCESS_LOOPBACK = 'VAD\\Process_Loopback'
ACTIVATION_PROCESS_LOOPBACK = 1
LOOPBACK_INCLUDE_TREE = 0
VT_BLOB = 65

AUDCLNT_SHAREMODE_SHARED = 0
AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000
AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000
AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = 0x80000000
AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000
AUDCLNT_BUFFERFLAGS_SILENT = 0x2


class ACTIVATION_PARAMS(ctypes.Structure):
    _fields_ = [('ActivationType', ctypes.c_int),
                ('TargetProcessId', wt.DWORD),
                ('ProcessLoopbackMode', ctypes.c_int)]


class BLOB(ctypes.Structure):
    _fields_ = [('cbSize', wt.ULONG), ('pBlobData', ctypes.c_void_p)]


class PROPVARIANT(ctypes.Structure):
    _fields_ = [('vt', wt.USHORT), ('r1', wt.WORD), ('r2', wt.WORD), ('r3', wt.WORD),
                ('blob', BLOB)]


class WAVEFORMATEX(ctypes.Structure):
    _pack_ = 1
    _fields_ = [('wFormatTag', wt.WORD), ('nChannels', wt.WORD),
                ('nSamplesPerSec', wt.DWORD), ('nAvgBytesPerSec', wt.DWORD),
                ('nBlockAlign', wt.WORD), ('wBitsPerSample', wt.WORD), ('cbSize', wt.WORD)]


# ── объект-обработчик завершения активации ──
_QI = ctypes.WINFUNCTYPE(HRESULT, ctypes.c_void_p, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p))
_REF = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)
_DONE = ctypes.WINFUNCTYPE(HRESULT, ctypes.c_void_p, ctypes.c_void_p)


class _VTBL(ctypes.Structure):
    _fields_ = [('qi', _QI), ('addref', _REF), ('release', _REF), ('done', _DONE)]


class _HANDLER(ctypes.Structure):
    _fields_ = [('vtbl', ctypes.POINTER(_VTBL))]


class _Completion:
    """COM-объект, которому Windows сообщает, что интерфейс готов.
    Живёт, пока жив Python-объект: ссылки на функции держим в нём."""

    def __init__(self):
        self.event = threading.Event()
        self.op = None

        def qi(this, riid, ppv):
            r = riid.contents
            if _same(r, IID_IUnknown) or _same(r, IID_Handler) or _same(r, IID_IAgileObject):
                ppv[0] = this
                return 0
            ppv[0] = None
            return E_NOINTERFACE

        def addref(this):
            return 1

        def release(this):
            return 1

        def done(this, op):
            self.op = op
            self.event.set()
            return 0

        self._fns = (_QI(qi), _REF(addref), _REF(release), _DONE(done))
        self._vtbl = _VTBL(*self._fns)
        self._obj = _HANDLER(ctypes.pointer(self._vtbl))

    @property
    def ptr(self):
        return ctypes.addressof(self._obj)


def _method(ptr, index, restype, *argtypes):
    """Метод COM-интерфейса по номеру в таблице."""
    vtbl = ctypes.cast(ptr, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    fn = ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)(vtbl[index])
    return lambda *a: fn(ptr, *a)


def _check(hr, what):
    if hr < 0:
        raise OSError('%s: HRESULT 0x%08X' % (what, hr & 0xFFFFFFFF))


def find_pid(names=('GTA5.exe', 'GTA5_Enhanced.exe')):
    """PID первого найденного процесса игры или None.

    PROTOCOL_GAME_PID — номер процесса напрямую (для проверки без игры),
    PROTOCOL_GAME_EXE — другие имена через запятую (если клиент сменит exe)."""
    import os
    if os.environ.get('PROTOCOL_GAME_PID', '').isdigit():
        return int(os.environ['PROTOCOL_GAME_PID'])
    extra = [x.strip() for x in os.environ.get('PROTOCOL_GAME_EXE', '').split(',') if x.strip()]
    for name in extra + list(names):
        try:
            out = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq %s' % name, '/FO', 'CSV', '/NH'],
                                 capture_output=True, text=True, timeout=5,
                                 creationflags=0x08000000).stdout
        except Exception:
            continue
        for line in out.splitlines():
            parts = [p.strip('"') for p in line.split('","')]
            if len(parts) > 1 and parts[0].lower() == name.lower() and parts[1].isdigit():
                return int(parts[1])
    return None


def capture(pid, stop, on_chunk, block_ms=100):
    """Слушает звук процесса pid (с дочерними), отдаёт float32 16 кГц моно,
    пока не взведён stop. Бросает OSError, если звук открыть не удалось."""
    params = ACTIVATION_PARAMS(ACTIVATION_PROCESS_LOOPBACK, pid, LOOPBACK_INCLUDE_TREE)
    pv = PROPVARIANT()
    pv.vt = VT_BLOB
    pv.blob.cbSize = ctypes.sizeof(params)
    pv.blob.pBlobData = ctypes.addressof(params)

    done = _Completion()
    op = ctypes.c_void_p()
    _check(_mmdev.ActivateAudioInterfaceAsync(ctypes.c_wchar_p(VIRTUAL_PROCESS_LOOPBACK),
                                              ctypes.byref(IID_IAudioClient), ctypes.byref(pv),
                                              ctypes.c_void_p(done.ptr), ctypes.byref(op)),
           'ActivateAudioInterfaceAsync')
    if not done.event.wait(5):
        raise OSError('звук процесса: Windows не ответила за 5 с')
    hr_act, client = HRESULT(), ctypes.c_void_p()
    _check(_method(op.value, 3, HRESULT, ctypes.POINTER(HRESULT), ctypes.POINTER(ctypes.c_void_p))(
        ctypes.byref(hr_act), ctypes.byref(client)), 'GetActivateResult')
    _method(op.value, 2, ctypes.c_ulong)()            # op больше не нужен
    _check(hr_act.value, 'активация звука процесса')

    fmt = WAVEFORMATEX(1, 1, SR, SR * 2, 2, 16, 0)
    cl = client.value
    _check(_method(cl, 3, HRESULT, ctypes.c_int, wt.DWORD, ctypes.c_longlong, ctypes.c_longlong,
                   ctypes.POINTER(WAVEFORMATEX), ctypes.c_void_p)(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        2000000, 0, ctypes.byref(fmt), None), 'IAudioClient.Initialize')
    ev = _kernel32.CreateEventW(None, False, False, None)
    cap = ctypes.c_void_p()
    try:
        _check(_method(cl, 13, HRESULT, wt.HANDLE)(ev), 'SetEventHandle')
        _check(_method(cl, 14, HRESULT, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p))(
            ctypes.byref(IID_IAudioCaptureClient), ctypes.byref(cap)), 'GetService')
        get_buf = _method(cap.value, 3, HRESULT, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_uint32),
                          ctypes.POINTER(wt.DWORD), ctypes.c_void_p, ctypes.c_void_p)
        rel_buf = _method(cap.value, 4, HRESULT, ctypes.c_uint32)
        next_size = _method(cap.value, 5, HRESULT, ctypes.POINTER(ctypes.c_uint32))
        _check(_method(cl, 10, HRESULT)(), 'IAudioClient.Start')
        data, frames, flags, n = ctypes.c_void_p(), ctypes.c_uint32(), wt.DWORD(), ctypes.c_uint32()
        pending = []
        while not stop.is_set():
            _kernel32.WaitForSingleObject(ev, block_ms)
            while True:
                if next_size(ctypes.byref(n)) < 0 or n.value == 0:
                    break
                _check(get_buf(ctypes.byref(data), ctypes.byref(frames), ctypes.byref(flags), None, None), 'GetBuffer')
                k = frames.value
                if flags.value & AUDCLNT_BUFFERFLAGS_SILENT or not data.value:
                    pending.append(np.zeros(k, dtype=np.float32))
                else:
                    raw = (ctypes.c_int16 * k).from_address(data.value)
                    pending.append(np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0)
                rel_buf(k)
            if pending:
                on_chunk(np.concatenate(pending))
                pending = []
        _method(cl, 11, HRESULT)()                     # Stop
    finally:
        if cap.value:
            _method(cap.value, 2, ctypes.c_ulong)()
        _method(cl, 2, ctypes.c_ulong)()
        _kernel32.CloseHandle(ev)
