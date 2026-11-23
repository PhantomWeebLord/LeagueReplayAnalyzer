"""The app's own window: link rules, second launches, settings carried over, and how closing it ends the app."""
import ctypes
import threading
import unittest
import uuid
from unittest import mock

from tests.sandbox import SandboxTest, core, lra_window as w

import server as s

APP = "http://127.0.0.1:8766/"


class LinkRuleTests(unittest.TestCase):
    def test_pages_of_the_app_stay_in_the_window(self):
        for uri in (APP, APP + "?open=C%3A%5Cx.rofl", "http://127.0.0.1:8766/#review", "about:blank"):
            self.assertTrue(w.is_app_url(uri, APP), uri)

    def test_everything_else_leaves_the_window(self):
        for uri in ("https://developer.riotgames.com/", "http://127.0.0.1:8767/", "https://127.0.0.1:8766/", "http://localhost:8766/",
                    "http://127.0.0.1:8766@example.com/", "file:///C:/Windows/win.ini"):
            self.assertFalse(w.is_app_url(uri, APP), uri)

    def test_only_web_links_open_in_the_browser(self):
        self.assertTrue(w.is_external_link("https://developer.riotgames.com/"))
        for uri in ("file:///C:/Windows/system32/calc.exe", "ms-settings:privacy", "javascript:alert(1)", "about:blank", ""):
            self.assertFalse(w.is_external_link(uri), uri)


class ShowRequestTests(unittest.TestCase):
    def test_accepts_a_page_of_this_app(self):
        url = APP + "?open=C%3A%5Cgame.rofl"
        self.assertEqual(w.parse_show_request(url.encode("utf-16-le") + b"\0\0", APP), url)

    def test_refuses_other_addresses(self):
        for url in ("https://example.com/", "http://127.0.0.1:9999/", "about:blank", "file:///C:/x"):
            self.assertIsNone(w.parse_show_request(url.encode("utf-16-le"), APP), url)

    def test_refuses_malformed_data(self):
        for raw in (b"", b"abc", b"a" * (w.MAX_URL_BYTES + 2)):
            self.assertIsNone(w.parse_show_request(raw, APP))


class ComCallbackTests(unittest.TestCase):
    """Calls the callback the way WebView2 does: through its native function table."""

    IID = "4e8a3389-c9d8-4bd2-b6b5-124fee6cc14d"

    def query(self, cb, iid):
        guid = ctypes.create_string_buffer(uuid.UUID(iid).bytes_le, 16)
        out = ctypes.c_void_p()
        hr = w.com_method(cb.ptr, w.SLOT_QUERY_INTERFACE, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p))(cb.ptr, guid, ctypes.byref(out))
        return hr, out.value

    def test_reports_its_interfaces_only(self):
        cb = w.ComCallback(self.IID, (w.HRESULT, ctypes.c_void_p), lambda *_a: None)
        self.assertEqual(self.query(cb, self.IID), (w.S_OK, cb.ptr))
        self.assertEqual(self.query(cb, w.IID_UNKNOWN), (w.S_OK, cb.ptr))
        self.assertEqual(self.query(cb, w.IID_NEW_WINDOW), (w.E_NOINTERFACE, None))

    def test_invoke_passes_arguments(self):
        seen = []
        cb = w.ComCallback(self.IID, (w.HRESULT, ctypes.c_void_p), lambda e, p: seen.append((e, p)))
        hr = w.com_method(cb.ptr, 3, w.HRESULT, ctypes.c_void_p)(cb.ptr, 7, 1234)
        self.assertEqual((hr, seen), (w.S_OK, [(7, 1234)]))

    def test_python_error_never_reaches_native_code(self):
        def boom(*_a):
            raise ValueError("handler failed")
        cb = w.ComCallback(self.IID, (w.HRESULT, ctypes.c_void_p), boom)
        with mock.patch("traceback.print_exc"):
            self.assertEqual(w.com_method(cb.ptr, 3, w.HRESULT, ctypes.c_void_p)(cb.ptr, 0, None), w.S_OK)


class StartupTests(SandboxTest):
    def test_no_loader_means_no_window(self):
        real = mock.patch.object(w, "loader_path", lambda: None)
        with real:
            self.assertIsNone(w._load_loader())

    def test_broken_loader_means_no_window(self):
        bad = self.tmp / "WebView2Loader.dll"
        bad.write_bytes(b"not a dll")
        with mock.patch.object(w, "loader_path", lambda: bad), mock.patch("traceback.print_exc"):
            self.assertIsNone(w._load_loader())

    def test_loader_is_found_inside_the_exe(self):
        (self.tmp / "WebView2Loader.dll").write_bytes(b"x")
        self.patch(core, "RES_ROOT", self.tmp)
        self.assertEqual(w.loader_path(), self.tmp / "WebView2Loader.dll")


class SettingsMigrationTests(SandboxTest):
    def old(self):
        p = self.tmp / "window-v2" / "Default" / "Local Storage" / "leveldb"
        p.mkdir(parents=True)
        (p / "000003.log").write_bytes(b"saved settings")
        (p / "CURRENT").write_text("MANIFEST-000001")
        (p / "LOCK").write_bytes(b"")
        return p

    def new(self):
        return self.tmp / "webview2" / "EBWebView" / "Default" / "Local Storage" / "leveldb"

    def test_copies_saved_settings_and_keeps_the_original(self):
        old = self.old()
        w.migrate_browser_storage(self.tmp)
        self.assertEqual((self.new() / "000003.log").read_bytes(), b"saved settings")
        self.assertFalse((self.new() / "LOCK").exists())
        self.assertTrue((old / "000003.log").exists())

    def test_never_overwrites_newer_window_settings(self):
        self.old()
        self.new().mkdir(parents=True)
        (self.new() / "000009.log").write_bytes(b"newer")
        w.migrate_browser_storage(self.tmp)
        self.assertEqual([p.name for p in self.new().iterdir()], ["000009.log"])

    def test_nothing_to_migrate(self):
        w.migrate_browser_storage(self.tmp)
        self.assertFalse(self.new().exists())

    def test_failed_copy_does_not_block_startup_or_leave_a_partial_folder(self):
        self.old()
        with mock.patch.object(w.shutil, "copytree", side_effect=OSError("disk full")), mock.patch("traceback.print_exc"):
            w.migrate_browser_storage(self.tmp)
        self.assertFalse(self.new().exists())
        self.assertFalse(self.new().with_name("leveldb.migrating").exists())


class FakeServer:
    def __init__(self):
        self.stop = threading.Event()

    def serve_forever(self):
        self.stop.wait(5)


class LifecycleTests(SandboxTest):
    def launch(self, shown, auto_exit):
        srv = FakeServer()
        calls = {"opened": [], "kwargs": None, "watchdog": 0}

        def fake_run(url, title, data, **kw):
            calls["kwargs"] = kw
            if not auto_exit or not shown:
                srv.stop.set()
            return shown
        self.patch(w, "run", fake_run)
        self.patch(s, "open_window", calls["opened"].append)
        self.patch(s, "watchdog", lambda: calls.__setitem__("watchdog", calls["watchdog"] + 1))
        with mock.patch.dict(s.OPTS, {"auto_exit": auto_exit, "background": False}):
            s.run_with_window(srv, APP)
        srv.stop.set()
        return calls

    def test_closing_the_window_ends_the_packaged_app(self):
        calls = self.launch(shown=True, auto_exit=True)
        self.assertEqual(calls["opened"], [])
        self.assertEqual(calls["watchdog"], 0)

    def test_window_failure_falls_back_to_a_browser_window(self):
        calls = self.launch(shown=False, auto_exit=True)
        self.assertEqual(calls["opened"], [APP])

    def test_closing_waits_for_a_live_recording(self):
        calls = self.launch(shown=True, auto_exit=True)
        keep = calls["kwargs"]["keep_running"]
        self.patch(s, "RECORDER", None)
        self.assertFalse(keep())
        rec = mock.Mock()
        rec.busy.return_value = True
        self.patch(s, "RECORDER", rec)
        self.assertTrue(keep())
        rec.busy.return_value = False
        self.assertFalse(keep())

    def test_second_launch_uses_the_open_window(self):
        opened = []
        self.patch(w, "show_existing", lambda _u: True)
        self.patch(s, "open_window", opened.append)
        s.show_running(APP)
        self.assertEqual(opened, [])

    def test_second_launch_without_a_window_opens_the_browser(self):
        opened = []
        self.patch(s, "open_window", opened.append)
        s.show_running(APP)
        self.assertEqual(opened, [APP])

    def test_background_flag(self):
        with mock.patch.dict(s.OPTS, {"background": False}):
            s.parse_args(["--background-window"])
            self.assertTrue(s.OPTS["background"])


class WindowFinderTests(SandboxTest):
    def test_app_class_is_distinct_from_browser_windows(self):
        self.assertFalse(core.APP_WINDOW_CLASS.startswith("Chrome_WidgetWin"))
