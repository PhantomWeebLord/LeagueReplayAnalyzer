"""
League Replay Analyzer - the app's own window.

A plain Win32 window hosting Microsoft's WebView2 (the Edge engine that ships with Windows), called through ctypes so
the app needs no UI framework. If WebView2 can't start, run() returns False and the caller opens a browser window instead.
"""
import ctypes
import os
import shutil
import sys
import threading
import traceback
import urllib.parse
import uuid
from ctypes import wintypes
from pathlib import Path

import lra_core as core

WINFUNCTYPE = getattr(ctypes, "WINFUNCTYPE", ctypes.CFUNCTYPE)
HRESULT = ctypes.c_long
LRESULT = ctypes.c_ssize_t
S_OK = 0
E_NOINTERFACE = -2147467262
COINIT_APARTMENTTHREADED = 2

# COM vtable slots, from WebView2.h in SDK 1.0.4314.35
SLOT_QUERY_INTERFACE, SLOT_ADD_REF, SLOT_RELEASE = 0, 1, 2
ENV_CREATE_CONTROLLER = 3
CTRL_PUT_VISIBLE, CTRL_PUT_BOUNDS, CTRL_MOVE_FOCUS, CTRL_NOTIFY_MOVED, CTRL_CLOSE, CTRL_GET_WEBVIEW = 4, 6, 12, 23, 24, 25
WV_GET_SETTINGS, WV_NAVIGATE, WV_ADD_NAVIGATION_STARTING, WV_ADD_PROCESS_FAILED, WV_RELOAD = 3, 5, 7, 25, 31
WV_ADD_NEW_WINDOW, WV_ADD_FULLSCREEN_CHANGED, WV_GET_FULLSCREEN = 44, 52, 54
SET_WEB_MESSAGE, SET_STATUS_BAR, SET_DEV_TOOLS, SET_HOST_OBJECTS, SET_PASSWORD_AUTOSAVE, SET_GENERAL_AUTOFILL = 6, 10, 12, 16, 26, 28
NAV_GET_URI, NAV_PUT_CANCEL = 3, 8
NEW_WINDOW_GET_URI, NEW_WINDOW_PUT_HANDLED = 3, 6
FAILED_GET_KIND = 3
PROCESS_BROWSER_EXITED, PROCESS_RENDERER_EXITED = 0, 1

IID_UNKNOWN = "00000000-0000-0000-c000-000000000046"
IID_SETTINGS4 = "cb56846c-4168-4d53-b04f-03b6d6796ff2"
IID_ENV_DONE = "4e8a3389-c9d8-4bd2-b6b5-124fee6cc14d"
IID_CONTROLLER_DONE = "6c4819f3-c9b7-4260-8127-c9f5bde7f68c"
IID_NAVIGATION_STARTING = "9adbe429-f36d-432b-9ddc-f8881fbd76e3"
IID_NEW_WINDOW = "d4c185fe-c81c-4989-97af-2d3fa7ab5651"
IID_FULLSCREEN_CHANGED = "e45d98b1-afef-45be-8baf-6c7728867f73"
IID_PROCESS_FAILED = "79e0aea4-990b-42d9-aa1d-0fcc2e5bc7f1"

# Win32
WM_DESTROY, WM_MOVE, WM_SIZE, WM_SETFOCUS, WM_CLOSE, WM_GETMINMAXINFO, WM_COPYDATA = 0x02, 0x03, 0x05, 0x07, 0x10, 0x24, 0x4A
WM_TIMER, WM_DPICHANGED = 0x113, 0x2E0
WS_OVERLAPPEDWINDOW = 0x00CF0000
GWL_STYLE = -16
SW_HIDE, SW_SHOWNORMAL, SW_SHOWNOACTIVATE, SW_SHOW, SW_RESTORE = 0, 1, 4, 5, 9
SMTO_ABORTIFHUNG = 2
SWP_NOSIZE, SWP_NOMOVE, SWP_NOZORDER, SWP_NOACTIVATE, SWP_FRAMECHANGED, SWP_NOOWNERZORDER = 0x1, 0x2, 0x4, 0x10, 0x20, 0x200
MONITOR_DEFAULTTONEAREST = 2
SPI_GETWORKAREA = 0x30
IDC_ARROW = 32512
DWMWA_USE_IMMERSIVE_DARK_MODE = 20
DPI_AWARENESS_PER_MONITOR_V2 = -4
OFFSCREEN = -24000              # for automated tests. Not -32000, which Windows reserves for minimized windows

WINDOW_WIDTH, WINDOW_HEIGHT = 1640, 1000
MIN_WIDTH, MIN_HEIGHT = 960, 640
BACKGROUND_RGB = 0x00170F0B     # the app's dark background, as 0x00BBGGRR, so the window never flashes white
BACKGROUND_ARGB = "FF0B0F17"
START_TIMEOUT_MS = 20000
START_TIMER_ID, IDLE_TIMER_ID = 1, 2
IDLE_CHECK_MS = 5000            # how often a hidden window checks whether the live recording has finished
MAX_RESTARTS = 3
COPYDATA_SHOW = 0x4C5241        # marks a "show this" message from a second launch of the app
MAX_URL_BYTES = 1 << 16
SHOW_TIMEOUT_MS = 3000

WNDPROC = WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
_active = set()
_active_lock = threading.Lock()


class WNDCLASSEXW(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.UINT), ("style", wintypes.UINT), ("lpfnWndProc", WNDPROC), ("cbClsExtra", ctypes.c_int),
                ("cbWndExtra", ctypes.c_int), ("hInstance", wintypes.HINSTANCE), ("hIcon", wintypes.HANDLE), ("hCursor", wintypes.HANDLE),
                ("hbrBackground", wintypes.HANDLE), ("lpszMenuName", wintypes.LPCWSTR), ("lpszClassName", wintypes.LPCWSTR), ("hIconSm", wintypes.HANDLE)]


class MINMAXINFO(ctypes.Structure):
    _fields_ = [("ptReserved", wintypes.POINT), ("ptMaxSize", wintypes.POINT), ("ptMaxPosition", wintypes.POINT),
                ("ptMinTrackSize", wintypes.POINT), ("ptMaxTrackSize", wintypes.POINT)]


class MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT), ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]


class WINDOWPLACEMENT(ctypes.Structure):
    _fields_ = [("length", wintypes.UINT), ("flags", wintypes.UINT), ("showCmd", wintypes.UINT), ("ptMinPosition", wintypes.POINT),
                ("ptMaxPosition", wintypes.POINT), ("rcNormalPosition", wintypes.RECT)]


class COPYDATASTRUCT(ctypes.Structure):
    _fields_ = [("dwData", ctypes.c_size_t), ("cbData", wintypes.DWORD), ("lpData", ctypes.c_void_p)]


# ---------------------------------------------------------------- COM helpers
def com_method(obj, slot: int, *argtypes):
    vtable = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    return WINFUNCTYPE(HRESULT, ctypes.c_void_p, *argtypes)(vtable[slot])


def com_call(obj, slot: int, argtypes=(), *args):
    hr = com_method(obj, slot, *argtypes)(obj, *args)
    if hr < 0:
        raise OSError(f"WebView2 call failed (0x{hr & 0xFFFFFFFF:08X})")


def com_get_pointer(obj, slot: int):
    out = ctypes.c_void_p()
    com_call(obj, slot, (ctypes.POINTER(ctypes.c_void_p),), ctypes.byref(out))
    return out.value


def com_query(obj, iid: str):
    """The object's interface `iid`, or None if it doesn't have it (for example on an older WebView2)."""
    guid = ctypes.create_string_buffer(uuid.UUID(iid).bytes_le, 16)
    out = ctypes.c_void_p()
    hr = com_method(obj, SLOT_QUERY_INTERFACE, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p))(obj, guid, ctypes.byref(out))
    return out.value if hr >= 0 else None


def com_release(obj):
    vtable = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    WINFUNCTYPE(wintypes.ULONG, ctypes.c_void_p)(vtable[SLOT_RELEASE])(obj)


def com_add_ref(obj):
    vtable = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    WINFUNCTYPE(wintypes.ULONG, ctypes.c_void_p)(vtable[SLOT_ADD_REF])(obj)


class ComCallback:
    """A minimal COM object with one Invoke method. Python keeps it alive for the life of the window."""

    def __init__(self, iid: str, argtypes, fn):
        self.iid = uuid.UUID(iid).bytes_le
        self.fn = fn
        self.refs = 1
        self._qi = WINFUNCTYPE(HRESULT, ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p))(self._query)
        self._add = WINFUNCTYPE(wintypes.ULONG, ctypes.c_void_p)(self._add_ref)
        self._rel = WINFUNCTYPE(wintypes.ULONG, ctypes.c_void_p)(self._release)
        self._inv = WINFUNCTYPE(HRESULT, ctypes.c_void_p, *argtypes)(self._invoke)
        self._vtable = (ctypes.c_void_p * 4)(*(ctypes.cast(f, ctypes.c_void_p) for f in (self._qi, self._add, self._rel, self._inv)))
        self._object = ctypes.c_void_p(ctypes.addressof(self._vtable))
        self.ptr = ctypes.addressof(self._object)

    def _query(self, this, riid, out):
        if ctypes.string_at(riid, 16) in (self.iid, uuid.UUID(IID_UNKNOWN).bytes_le):
            out[0] = this
            self.refs += 1
            return S_OK
        out[0] = None
        return E_NOINTERFACE

    def _add_ref(self, _this):
        self.refs += 1
        return self.refs

    def _release(self, _this):
        self.refs -= 1
        return self.refs

    def _invoke(self, _this, *args):
        try:
            self.fn(*args)
        except Exception:  # an exception must never cross into WebView2's native code
            traceback.print_exc()
        return S_OK


# ---------------------------------------------------------------- setup
def loader_path():
    """WebView2Loader.dll: inside the packaged exe, or in build/webview2 after running build_exe.py."""
    for folder in (core.RES_ROOT, core.SRC_ROOT / "build" / "webview2"):
        p = Path(folder) / "WebView2Loader.dll"
        if p.is_file():
            return p
    return None


def runtime_version(loader):
    """The installed WebView2 runtime's version, or None."""
    out = ctypes.c_void_p()
    fn = loader.GetAvailableCoreWebView2BrowserVersionString
    fn.restype, fn.argtypes = HRESULT, [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_void_p)]
    if fn(None, ctypes.byref(out)) < 0 or not out.value:
        return None
    version = ctypes.wstring_at(out.value)
    ctypes.windll.ole32.CoTaskMemFree(out)
    return version


def migrate_browser_storage(data_dir: Path):
    """Bring over remembered settings (who you are, map options) from the earlier Edge app window, once."""
    old = data_dir / "window-v2" / "Default" / "Local Storage" / "leveldb"
    new = data_dir / "webview2" / "EBWebView" / "Default" / "Local Storage" / "leveldb"
    if not old.is_dir() or new.exists():
        return
    tmp = new.with_name("leveldb.migrating")
    try:
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(old, tmp, ignore=shutil.ignore_patterns("LOCK"))
        os.replace(tmp, new)
    except OSError:  # never block startup: the settings are simply remembered again
        traceback.print_exc()
        shutil.rmtree(tmp, ignore_errors=True)


def is_app_url(uri: str, app_url: str) -> bool:
    if uri == "about:blank":
        return True
    a, b = urllib.parse.urlsplit(uri), urllib.parse.urlsplit(app_url)
    return (a.scheme, a.netloc) == (b.scheme, b.netloc)


def is_external_link(uri: str) -> bool:
    return urllib.parse.urlsplit(uri).scheme in ("http", "https")


def parse_show_request(raw: bytes, app_url: str):
    """The URL a second launch asked this window to show, or None if it isn't a page of this app."""
    if not 0 < len(raw) <= MAX_URL_BYTES or len(raw) % 2:
        return None
    url = raw.decode("utf-16-le", "ignore").rstrip("\0")
    return url if url != "about:blank" and is_app_url(url, app_url) else None


def _user32():
    u = ctypes.WinDLL("user32", use_last_error=True)
    H, UINT, W, L = wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
    sig = {
        "RegisterClassExW": (wintypes.ATOM, [ctypes.POINTER(WNDCLASSEXW)]), "UnregisterClassW": (wintypes.BOOL, [wintypes.LPCWSTR, wintypes.HINSTANCE]),
        "CreateWindowExW": (H, [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, H, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]),
        "DefWindowProcW": (LRESULT, [H, UINT, W, L]), "DestroyWindow": (wintypes.BOOL, [H]), "ShowWindow": (wintypes.BOOL, [H, ctypes.c_int]),
        "SetForegroundWindow": (wintypes.BOOL, [H]), "GetClientRect": (wintypes.BOOL, [H, ctypes.POINTER(wintypes.RECT)]),
        "GetMessageW": (ctypes.c_int, [ctypes.POINTER(wintypes.MSG), H, UINT, UINT]), "TranslateMessage": (wintypes.BOOL, [ctypes.POINTER(wintypes.MSG)]),
        "DispatchMessageW": (LRESULT, [ctypes.POINTER(wintypes.MSG)]), "PostQuitMessage": (None, [ctypes.c_int]), "PostMessageW": (wintypes.BOOL, [H, UINT, W, L]),
        "SetTimer": (ctypes.c_size_t, [H, ctypes.c_size_t, UINT, ctypes.c_void_p]), "KillTimer": (wintypes.BOOL, [H, ctypes.c_size_t]),
        "SetWindowPos": (wintypes.BOOL, [H, H, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, UINT]),
        "GetWindowLongPtrW": (ctypes.c_ssize_t, [H, ctypes.c_int]), "SetWindowLongPtrW": (ctypes.c_ssize_t, [H, ctypes.c_int, ctypes.c_ssize_t]),
        "MonitorFromWindow": (wintypes.HANDLE, [H, wintypes.DWORD]), "GetMonitorInfoW": (wintypes.BOOL, [wintypes.HANDLE, ctypes.POINTER(MONITORINFO)]),
        "GetWindowPlacement": (wintypes.BOOL, [H, ctypes.POINTER(WINDOWPLACEMENT)]), "SetWindowPlacement": (wintypes.BOOL, [H, ctypes.POINTER(WINDOWPLACEMENT)]),
        "SystemParametersInfoW": (wintypes.BOOL, [UINT, UINT, ctypes.c_void_p, UINT]), "LoadCursorW": (wintypes.HANDLE, [wintypes.HINSTANCE, ctypes.c_void_p]),
        "GetDpiForSystem": (UINT, []), "IsIconic": (wintypes.BOOL, [H]), "FindWindowExW": (H, [H, H, wintypes.LPCWSTR, wintypes.LPCWSTR]),
        "SendMessageTimeoutW": (LRESULT, [H, UINT, W, L, UINT, UINT, ctypes.POINTER(ctypes.c_size_t)]),
        "GetWindowThreadProcessId": (wintypes.DWORD, [H, ctypes.POINTER(wintypes.DWORD)]), "AllowSetForegroundWindow": (wintypes.BOOL, [wintypes.DWORD]),
    }
    for name, (res, args) in sig.items():
        f = getattr(u, name)
        f.restype, f.argtypes = res, args
    return u


# ---------------------------------------------------------------- the window
class AppWindow:
    def __init__(self, loader, url: str, title: str, data_dir: Path, keep_running=None, background: bool = False):
        self.loader, self.url, self.title, self.background = loader, url, title, background
        self.keep_running = keep_running    # while this returns True, closing the window only hides it
        self.user_data = data_dir / "webview2"
        self.u = _user32()
        self.hwnd = None
        self.hinstance = None
        self.environment = None
        self.controller = None
        self.webview = None
        self.hidden = False
        self.started = False
        self.restarts = 0
        self.saved_style = None
        self.saved_placement = None
        self.callbacks = []
        self._wndproc = WNDPROC(self._proc)

    def _callback(self, iid, argtypes, fn):
        cb = ComCallback(iid, argtypes, fn)
        self.callbacks.append(cb)
        return cb.ptr

    # ------------------------------------------------ Win32
    def _create_window(self):
        hinst = ctypes.WinDLL("kernel32").GetModuleHandleW
        hinst.restype, hinst.argtypes = wintypes.HMODULE, [wintypes.LPCWSTR]
        self.hinstance = hinst(None)
        brush = ctypes.WinDLL("gdi32").CreateSolidBrush
        brush.restype, brush.argtypes = wintypes.HANDLE, [wintypes.DWORD]
        large, small = wintypes.HICON(), wintypes.HICON()
        if core.FROZEN:
            extract = ctypes.WinDLL("shell32").ExtractIconExW
            extract.restype, extract.argtypes = wintypes.UINT, [wintypes.LPCWSTR, ctypes.c_int, ctypes.POINTER(wintypes.HICON), ctypes.POINTER(wintypes.HICON), wintypes.UINT]
            extract(sys.executable, 0, ctypes.byref(large), ctypes.byref(small), 1)
        wc = WNDCLASSEXW(cbSize=ctypes.sizeof(WNDCLASSEXW), lpfnWndProc=self._wndproc, hInstance=self.hinstance, hIcon=large.value, hIconSm=small.value,
                         hCursor=self.u.LoadCursorW(None, ctypes.c_void_p(IDC_ARROW)), hbrBackground=brush(BACKGROUND_RGB), lpszClassName=core.APP_WINDOW_CLASS)
        self.u.RegisterClassExW(ctypes.byref(wc))
        x, y, w, h = self._initial_rect()
        self.hwnd = self.u.CreateWindowExW(0, core.APP_WINDOW_CLASS, self.title, WS_OVERLAPPEDWINDOW, x, y, w, h, None, None, self.hinstance, None)
        if not self.hwnd:
            raise OSError("could not create the window")
        dark = wintypes.BOOL(True)
        try:
            ctypes.WinDLL("dwmapi").DwmSetWindowAttribute(self.hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ctypes.byref(dark), ctypes.sizeof(dark))
        except OSError:
            pass

    def _initial_rect(self):
        if self.background:
            return OFFSCREEN, OFFSCREEN, WINDOW_WIDTH, WINDOW_HEIGHT
        work = wintypes.RECT()
        self.u.SystemParametersInfoW(SPI_GETWORKAREA, 0, ctypes.byref(work), 0)
        scale = self.u.GetDpiForSystem() / 96
        w = min(int(WINDOW_WIDTH * scale), work.right - work.left)
        h = min(int(WINDOW_HEIGHT * scale), work.bottom - work.top)
        return work.left + (work.right - work.left - w) // 2, work.top + (work.bottom - work.top - h) // 2, w, h

    def _proc(self, hwnd, msg, wparam, lparam):
        try:
            if msg == WM_SIZE:
                self._fit_webview()
            elif msg == WM_MOVE and self.controller:
                com_call(self.controller, CTRL_NOTIFY_MOVED)
            elif msg == WM_SETFOCUS and self.controller:
                com_call(self.controller, CTRL_MOVE_FOCUS, (ctypes.c_int,), 0)
            elif msg == WM_GETMINMAXINFO:
                info = ctypes.cast(lparam, ctypes.POINTER(MINMAXINFO)).contents
                info.ptMinTrackSize.x, info.ptMinTrackSize.y = MIN_WIDTH, MIN_HEIGHT
                return 0
            elif msg == WM_DPICHANGED:
                r = ctypes.cast(lparam, ctypes.POINTER(wintypes.RECT)).contents
                self.u.SetWindowPos(hwnd, None, r.left, r.top, r.right - r.left, r.bottom - r.top, SWP_NOZORDER | SWP_NOACTIVATE)
                return 0
            elif msg == WM_TIMER and wparam == START_TIMER_ID:
                self.u.KillTimer(hwnd, START_TIMER_ID)
                if not self.started:
                    self.u.DestroyWindow(hwnd)
                return 0
            elif msg == WM_TIMER and wparam == IDLE_TIMER_ID:
                if not self.keep_running():
                    self.u.KillTimer(hwnd, IDLE_TIMER_ID)
                    self.u.DestroyWindow(hwnd)
                return 0
            elif msg == WM_CLOSE and self.keep_running and self.keep_running():
                self._hide_until_idle()
                return 0
            elif msg == WM_COPYDATA:
                return 1 if self._on_show_request(lparam) else 0
            elif msg == WM_DESTROY:
                self._close_webview()
                self.u.PostQuitMessage(0)
                return 0
        except Exception:
            traceback.print_exc()
        return self.u.DefWindowProcW(hwnd, msg, wparam, lparam)

    def _fit_webview(self):
        if self.controller:
            r = wintypes.RECT()
            self.u.GetClientRect(self.hwnd, ctypes.byref(r))
            com_call(self.controller, CTRL_PUT_BOUNDS, (wintypes.RECT,), r)

    def _close_webview(self):
        webview, self.webview = self.webview, None
        controller, self.controller = self.controller, None
        environment, self.environment = self.environment, None
        if webview:
            com_release(webview)
        if controller:
            try:
                com_call(controller, CTRL_CLOSE)
            except OSError:  # expected when the browser process has already died
                traceback.print_exc()
            com_release(controller)
        if environment:
            com_release(environment)

    def _hide_until_idle(self):
        """A live game is still being recorded: keep working out of sight, then exit when it ends."""
        self.hidden = True
        self.u.ShowWindow(self.hwnd, SW_HIDE)
        if self.controller:
            com_call(self.controller, CTRL_PUT_VISIBLE, (wintypes.BOOL,), False)
        self.u.SetTimer(self.hwnd, IDLE_TIMER_ID, IDLE_CHECK_MS, None)

    def _on_show_request(self, lparam) -> bool:
        data = ctypes.cast(lparam, ctypes.POINTER(COPYDATASTRUCT)).contents
        if data.dwData != COPYDATA_SHOW or not data.lpData or data.cbData > MAX_URL_BYTES:
            return False
        url = parse_show_request(ctypes.string_at(data.lpData, data.cbData), self.url)
        if not url:
            return False
        if self.hidden:
            self.hidden = False
            self.u.KillTimer(self.hwnd, IDLE_TIMER_ID)
            self.u.ShowWindow(self.hwnd, SW_SHOW)
            if self.controller:
                com_call(self.controller, CTRL_PUT_VISIBLE, (wintypes.BOOL,), True)
        if self.u.IsIconic(self.hwnd):
            self.u.ShowWindow(self.hwnd, SW_RESTORE)
        if self.webview and urllib.parse.urlsplit(url).query:  # a file was dropped on the exe; otherwise keep the current view
            com_call(self.webview, WV_NAVIGATE, (wintypes.LPCWSTR,), url)
        self.u.SetForegroundWindow(self.hwnd)
        return True

    def _monitor_rect(self):
        info = MONITORINFO(cbSize=ctypes.sizeof(MONITORINFO))
        self.u.GetMonitorInfoW(self.u.MonitorFromWindow(self.hwnd, MONITOR_DEFAULTTONEAREST), ctypes.byref(info))
        return info.rcMonitor

    def _set_fullscreen(self, on: bool):
        if on and self.saved_style is None:
            self.saved_style = self.u.GetWindowLongPtrW(self.hwnd, GWL_STYLE)
            self.saved_placement = WINDOWPLACEMENT(length=ctypes.sizeof(WINDOWPLACEMENT))
            self.u.GetWindowPlacement(self.hwnd, ctypes.byref(self.saved_placement))
            m = self._monitor_rect()
            self.u.SetWindowLongPtrW(self.hwnd, GWL_STYLE, self.saved_style & ~WS_OVERLAPPEDWINDOW)
            self.u.SetWindowPos(self.hwnd, None, m.left, m.top, m.right - m.left, m.bottom - m.top, SWP_NOOWNERZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED)
        elif not on and self.saved_style is not None:
            self.u.SetWindowLongPtrW(self.hwnd, GWL_STYLE, self.saved_style)
            self.u.SetWindowPlacement(self.hwnd, ctypes.byref(self.saved_placement))
            self.u.SetWindowPos(self.hwnd, None, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED)
            self.saved_style = None

    # ------------------------------------------------ WebView2 startup
    def _start_webview(self):
        create = self.loader.CreateCoreWebView2EnvironmentWithOptions
        create.restype, create.argtypes = HRESULT, [wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_void_p, ctypes.c_void_p]
        done = self._callback(IID_ENV_DONE, (HRESULT, ctypes.c_void_p), self._on_environment)
        hr = create(None, str(self.user_data), None, done)
        if hr < 0:
            raise OSError(f"WebView2 did not start (0x{hr & 0xFFFFFFFF:08X})")

    def _on_environment(self, error, env):
        if error < 0 or not env:
            return self._give_up()
        com_add_ref(env)
        self.environment = env
        done = self._callback(IID_CONTROLLER_DONE, (HRESULT, ctypes.c_void_p), self._on_controller)
        com_call(env, ENV_CREATE_CONTROLLER, (wintypes.HWND, ctypes.c_void_p), self.hwnd, done)
        return None

    def _give_up(self):
        if not self.started and self.hwnd:
            self.u.DestroyWindow(self.hwnd)

    def _on_controller(self, error, controller):
        if error < 0 or not controller:
            return self._give_up()
        com_add_ref(controller)
        self.controller = controller
        webview = self.webview = com_get_pointer(controller, CTRL_GET_WEBVIEW)
        self._apply_settings(webview)
        token = ctypes.c_int64()
        events = ((WV_ADD_NAVIGATION_STARTING, IID_NAVIGATION_STARTING, self._on_navigation), (WV_ADD_NEW_WINDOW, IID_NEW_WINDOW, self._on_new_window),
                  (WV_ADD_FULLSCREEN_CHANGED, IID_FULLSCREEN_CHANGED, self._on_fullscreen), (WV_ADD_PROCESS_FAILED, IID_PROCESS_FAILED, self._on_process_failed))
        for slot, iid, fn in events:
            handler = self._callback(iid, (ctypes.c_void_p, ctypes.c_void_p), fn)
            com_call(webview, slot, (ctypes.c_void_p, ctypes.POINTER(ctypes.c_int64)), handler, ctypes.byref(token))
        self._fit_webview()
        com_call(controller, CTRL_PUT_VISIBLE, (wintypes.BOOL,), True)
        com_call(webview, WV_NAVIGATE, (wintypes.LPCWSTR,), self.url)
        if not self.started:
            self.started = True
            self.u.ShowWindow(self.hwnd, SW_SHOWNOACTIVATE if self.background else SW_SHOW)
            if not self.background:
                self.u.SetForegroundWindow(self.hwnd)
        return None

    @staticmethod
    def _apply_settings(webview):
        settings = com_get_pointer(webview, WV_GET_SETTINGS)
        for slot, value in ((SET_STATUS_BAR, False), (SET_DEV_TOOLS, False), (SET_HOST_OBJECTS, False), (SET_WEB_MESSAGE, False)):
            com_call(settings, slot, (wintypes.BOOL,), value)
        newer = com_query(settings, IID_SETTINGS4)
        if newer:  # never offer to save the API key field as a password
            com_call(newer, SET_PASSWORD_AUTOSAVE, (wintypes.BOOL,), False)
            com_call(newer, SET_GENERAL_AUTOFILL, (wintypes.BOOL,), False)
            com_release(newer)
        com_release(settings)

    # ------------------------------------------------ WebView2 events
    @staticmethod
    def _read_uri(args, slot):
        out = ctypes.c_void_p()
        com_call(args, slot, (ctypes.POINTER(ctypes.c_void_p),), ctypes.byref(out))
        uri = ctypes.wstring_at(out.value) if out.value else ""
        ctypes.windll.ole32.CoTaskMemFree(out)
        return uri

    def _open_externally(self, uri):
        if is_external_link(uri):
            run = ctypes.WinDLL("shell32").ShellExecuteW
            run.restype, run.argtypes = wintypes.HINSTANCE, [wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_int]
            run(self.hwnd, "open", uri, None, None, SW_SHOWNORMAL)

    def _on_navigation(self, _sender, args):
        """The window only ever shows this app. Anything else opens in the normal browser."""
        uri = self._read_uri(args, NAV_GET_URI)
        if not is_app_url(uri, self.url):
            com_call(args, NAV_PUT_CANCEL, (wintypes.BOOL,), True)
            self._open_externally(uri)

    def _on_new_window(self, _sender, args):
        uri = self._read_uri(args, NEW_WINDOW_GET_URI)
        com_call(args, NEW_WINDOW_PUT_HANDLED, (wintypes.BOOL,), True)
        self._open_externally(uri)

    def _on_fullscreen(self, sender, _args):
        on = wintypes.BOOL()
        com_call(sender, WV_GET_FULLSCREEN, (ctypes.POINTER(wintypes.BOOL),), ctypes.byref(on))
        self._set_fullscreen(bool(on.value))

    def _on_process_failed(self, sender, args):
        kind = ctypes.c_int()
        com_call(args, FAILED_GET_KIND, (ctypes.POINTER(ctypes.c_int),), ctypes.byref(kind))
        if kind.value == PROCESS_RENDERER_EXITED:
            com_call(sender, WV_RELOAD)
        elif kind.value == PROCESS_BROWSER_EXITED:
            self._close_webview()
            self.restarts += 1
            if self.restarts <= MAX_RESTARTS:
                self._start_webview()
            else:
                self.u.PostMessageW(self.hwnd, WM_CLOSE, 0, 0)

    # ------------------------------------------------ run
    def run(self) -> bool:
        ole32 = ctypes.WinDLL("ole32")
        ole32.CoInitializeEx.restype, ole32.CoInitializeEx.argtypes = HRESULT, [ctypes.c_void_p, wintypes.DWORD]
        initialized = ole32.CoInitializeEx(None, COINIT_APARTMENTTHREADED)
        if initialized < 0:
            return False
        try:
            self._create_window()
            with _active_lock:
                _active.add(self)
            self.u.SetTimer(self.hwnd, START_TIMER_ID, START_TIMEOUT_MS, None)
            self._start_webview()
            msg = wintypes.MSG()
            while self.u.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
                self.u.TranslateMessage(ctypes.byref(msg))
                self.u.DispatchMessageW(ctypes.byref(msg))
        except OSError:
            traceback.print_exc()
            if self.hwnd:
                self.u.DestroyWindow(self.hwnd)
        finally:
            with _active_lock:
                _active.discard(self)
            self.u.UnregisterClassW(core.APP_WINDOW_CLASS, self.hinstance)
            ole32.CoUninitialize()
        return self.started


def _load_loader():
    if os.name != "nt":
        return None
    path = loader_path()
    if not path:
        return None
    try:
        loader = ctypes.WinDLL(str(path))
        return loader if runtime_version(loader) else None
    except (OSError, AttributeError):
        traceback.print_exc()
        return None


def available() -> bool:
    """True when both Microsoft's loader and the WebView2 runtime are present."""
    return _load_loader() is not None


def run(url: str, title: str, data_dir, keep_running=None, background: bool = False) -> bool:
    """Show the app until its window is closed. False means WebView2 could not start and nothing was shown."""
    loader = _load_loader()
    if not loader:
        return False
    data_dir = Path(data_dir)
    migrate_browser_storage(data_dir)
    try:
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(DPI_AWARENESS_PER_MONITOR_V2))
    except (OSError, AttributeError):
        pass
    args = f'--auto-select-desktop-capture-source="{core.LEAGUE_WINDOW}"'
    extra = os.environ.get("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
    os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = f"{extra} {args}" if extra else args
    os.environ["WEBVIEW2_DEFAULT_BACKGROUND_COLOR"] = BACKGROUND_ARGB
    try:
        return AppWindow(loader, url, title, data_dir, keep_running, background).run()
    except (OSError, AttributeError):
        traceback.print_exc()
        return False


def show_existing(url: str) -> bool:
    """A second launch: bring this app's open window forward, showing `url` if it names a file. False if there is none."""
    if os.name != "nt":
        return False
    u = _user32()
    raw = url.encode("utf-16-le") + b"\0\0"
    if len(raw) > MAX_URL_BYTES:
        return False
    buffer = ctypes.create_string_buffer(raw, len(raw))
    message = COPYDATASTRUCT(COPYDATA_SHOW, len(raw), ctypes.cast(buffer, ctypes.c_void_p))
    hwnd = None
    while True:  # each window only accepts its own address, so a second copy on another port is left alone
        hwnd = u.FindWindowExW(None, hwnd, core.APP_WINDOW_CLASS, None)
        if not hwnd:
            return False
        pid = wintypes.DWORD()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        u.AllowSetForegroundWindow(pid.value)
        answer = ctypes.c_size_t()
        sent = u.SendMessageTimeoutW(hwnd, WM_COPYDATA, 0, ctypes.addressof(message), SMTO_ABORTIFHUNG, SHOW_TIMEOUT_MS, ctypes.byref(answer))
        if sent and answer.value:
            return True


def request_close():
    """Ask every open window to close."""
    with _active_lock:
        windows = list(_active)
    for w in windows:
        if w.hwnd:
            w.u.PostMessageW(w.hwnd, WM_CLOSE, 0, 0)
