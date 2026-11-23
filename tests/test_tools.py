"""Characterization tests for the build script and the training tools."""
import gzip
import http.client
import importlib.util
import json
import os
import struct
import sys
import threading
import time
import urllib.error
import urllib.request
import zlib
from pathlib import Path
from unittest import mock

from tests import fixtures as fx
from tests.sandbox import ROOT, SandboxTest
from tests.test_core import Resp, http_error

import build_exe as b


def load(name, rel, argv=None):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel)
    mod = importlib.util.module_from_spec(spec)
    with mock.patch.object(sys, "argv", argv or ["x"]):
        spec.loader.exec_module(mod)
    return mod


fh = load("fetch_highelo", "train/fetch_highelo.py")
ts = load("train_server", "train/train_server.py", ["x", "0"])


class IconTests(SandboxTest):
    def read_png(self, data):
        self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
        w, h, depth, ctype = struct.unpack(">IIBB", data[16:26])
        return w, h, depth, ctype

    def test_png_is_valid_rgba(self):
        data = b._png(4, lambda x, y, n: (x, y, n, 255))
        self.assertEqual(self.read_png(data), (4, 4, 8, 6))
        i = data.index(b"IDAT")
        n = struct.unpack(">I", data[i - 4:i])[0]
        raw = zlib.decompress(data[i + 4:i + 4 + n])
        self.assertEqual(raw[:5], bytes([0, 0, 0, 4, 255]))

    def test_mix(self):
        self.assertEqual(b._mix((0, 0, 0), (10, 20, 30), 0.5), (5, 10, 15))
        self.assertEqual(b._mix((0,), (10,), -1), (0,))
        self.assertEqual(b._mix((0,), (10,), 2), (10,))

    def test_triangle_distance_sign(self):
        self.assertLess(b._triangle_distance(0.5, 0.5), 0)
        self.assertGreater(b._triangle_distance(0.05, 0.05), 0)

    def test_logo_outside_tile_is_transparent(self):
        self.assertIsNone(b._logo_sample(0.001, 0.001, False))
        self.assertEqual(b._icon_pixel(0, 0, 32), (0, 0, 0, 0))

    def test_logo_center_is_gold_diamond_at_large_sizes(self):
        self.assertEqual(b._logo_sample(0.54, 0.50, False), (255, 209, 102))

    def test_icon_pixel_is_opaque_inside(self):
        self.assertEqual(b._icon_pixel(16, 16, 32)[3], 255)

    def test_make_icon_writes_all_sizes(self):
        self.patch(b, "ROOT", self.tmp)
        (self.tmp / "static").mkdir()
        self.patch(b, "_png", lambda size, _p: b"\x89PNG" + bytes([size % 256]))
        ico = b.make_icon(self.tmp / "out" / "app.ico")
        data = ico.read_bytes()
        self.assertEqual(struct.unpack("<HHH", data[:6]), (0, 1, 7))
        self.assertEqual([data[6 + 16 * i] for i in range(7)], [16, 24, 32, 48, 64, 128, 0])
        self.assertTrue((self.tmp / "static" / "logo.png").exists())

    def test_seed_copies_only_newer_files(self):
        src, dest = self.tmp / "src", self.tmp / "local"
        (src / "cache").mkdir(parents=True)
        (dest / "League Replay Analyzer" / "cache").mkdir(parents=True)
        a, c = src / "cache" / "a.json", dest / "League Replay Analyzer" / "cache" / "a.json"
        a.write_text("old"); c.write_text("new")
        os.utime(a, (1000, 1000)); os.utime(c, (2000, 2000))
        (src / "cache" / "b.json").write_text("b")
        (src / "config.json").write_text("{}")
        self.patch(b, "ROOT", src)
        with mock.patch.dict(os.environ, {"LOCALAPPDATA": str(dest)}), mock.patch("builtins.print"):
            b.seed_data_dir()
        self.assertEqual(c.read_text(), "new")
        self.assertTrue((c.parent / "b.json").exists())
        self.assertTrue((dest / "League Replay Analyzer" / "config.json").exists())

    def test_build_command_bundles_only_static_files(self):
        calls = []
        self.patch(b, "BUILD", self.tmp / "build")
        self.patch(b, "ROOT", self.tmp)
        (self.tmp / "static").mkdir()
        (self.tmp / "dist").mkdir()
        (self.tmp / "dist" / f"{b.NAME}.exe").write_bytes(b"x")
        self.patch(b, "make_icon", lambda p: p)
        self.patch(b.subprocess, "check_call", lambda cmd, cwd=None: calls.append(cmd))
        with mock.patch.object(sys, "argv", ["build_exe.py"]), mock.patch("builtins.print"):
            b.main()
        joined = " ".join(calls[0])
        self.assertIn("--onefile", joined)
        self.assertEqual(calls[0].count("--add-data"), 1)
        self.assertNotIn("anthropic", joined)


class FetchToolTests(SandboxTest):
    def setUp(self):
        super().setUp()
        self.patch(fh, "LOG", self.tmp / "fetch.log")
        self.patch(fh, "STATE", self.tmp / "state.json")
        self.patch(fh, "ROOT", self.tmp)
        self.patch(time, "sleep", lambda _s: None)
        fh.LIM.windows = [(1000, 1.0)]
        fh.LIM.hist.clear()

    def test_load_key_from_config(self):
        (self.tmp / "config.json").write_text(json.dumps({"apiKey": " RGAPI-x "}), "utf-8")
        self.assertEqual(fh.load_key(), "RGAPI-x")

    def test_load_key_alternate_names(self):
        (self.tmp / "config.json").write_text(json.dumps({"riotApiKey": "k2"}), "utf-8")
        self.assertEqual(fh.load_key(), "k2")

    def test_load_key_missing_exits(self):
        with mock.patch.dict(os.environ, {"LOCALAPPDATA": str(self.tmp / "none")}):
            with self.assertRaises(SystemExit):
                fh.load_key()

    def test_limiter_reads_header(self):
        l = fh.Limiter()
        l.set_from_header("20:1,100:120")
        self.assertEqual(l.windows, [(19, 1.0), (95, 120.0)])

    def test_limiter_ignores_bad_header(self):
        l = fh.Limiter()
        before = list(l.windows)
        l.set_from_header("garbage")
        self.assertEqual(l.windows, before)

    def test_limiter_records_calls(self):
        l = fh.Limiter()
        l.windows = [(5, 1.0)]
        for _ in range(3):
            l.wait()
        self.assertEqual(len(l.hist), 3)

    def test_get_success_updates_limits(self):
        class R(Resp):
            headers = {"X-App-Rate-Limit": "10:1"}
        self.patch(urllib.request, "urlopen", lambda *_a, **_k: R('{"a": 1}'))
        self.assertEqual(fh.get("http://x", "k"), {"a": 1})
        self.assertEqual(fh.LIM.windows, [(9, 1.0)])
        fh.LIM.windows = [(1000, 1.0)]

    def responses(self, *items):
        seq = list(items)
        def fake(req, **_k):
            x = seq.pop(0)
            if isinstance(x, int):
                raise urllib.error.HTTPError(req.full_url, x, "e", {"Retry-After": "0"}, None)
            if isinstance(x, Exception):
                raise x
            class R(Resp):
                headers = {}
            return R(x)
        self.patch(urllib.request, "urlopen", fake)

    def test_get_key_errors(self):
        for code in (401, 403):
            with self.subTest(code=code):
                self.responses(code)
                with self.assertRaises(fh.KeyExpired):
                    fh.get("http://x", "k")

    def test_get_404_is_none(self):
        self.responses(404)
        self.assertIsNone(fh.get("http://x", "k"))

    def test_get_400_is_bad_player(self):
        self.responses(400)
        with self.assertRaises(fh.BadPlayerId):
            fh.get("http://x", "k")

    def test_get_retries_429_and_500(self):
        self.responses(429, 503, '{"ok": 1}')
        self.assertEqual(fh.get("http://x", "k"), {"ok": 1})

    def test_get_network_retry_then_transient(self):
        self.responses(*[urllib.error.URLError("x")] * 6)
        with self.assertRaises(fh.Transient):
            fh.get("http://x", "k")

    def test_strip_removes_identity(self):
        g = fx.make_game()
        out = fh.strip(g["match"], g["timeline"])
        text = json.dumps(out)
        self.assertNotIn("fixture-puuid", text)
        self.assertNotIn("Fixture1", text)
        p = out["match"]["info"]["participants"][0]
        self.assertEqual((p["puuid"], p["riotIdGameName"], p["championId"]), ("anon-1", "MonkeyKing", 62))

    def test_strip_keeps_needed_events_only(self):
        g = fx.make_game()
        g["timeline"]["info"]["frames"][1]["events"].append({"type": "PAUSE_END", "timestamp": 1})
        out = fh.strip(g["match"], g["timeline"])
        types = {e["type"] for f in out["timeline"]["info"]["frames"] for e in f["events"]}
        self.assertNotIn("PAUSE_END", types)
        self.assertIn("CHAMPION_KILL", types)

    def test_state_roundtrip_and_default(self):
        self.assertEqual(fh.load_state(), {"players": [], "playerIdx": 0, "queue": [], "skipped": []})
        fh.save_state({"players": [1], "playerIdx": 2, "queue": [], "skipped": []})
        self.assertEqual(fh.load_state()["playerIdx"], 2)

    def test_fetch_players_mixes_tiers(self):
        data = {"challenger": [{"puuid": f"c{i}"} for i in range(2)], "grandmaster": [{"puuid": f"g{i}"} for i in range(4)], "master": [{"puuid": f"m{i}"} for i in range(6)]}
        self.patch(fh, "get", lambda url, _k: {"entries": next(v for t, v in data.items() if f"/{t}leagues/" in url)})
        with mock.patch("builtins.print"):
            out = fh.fetch_players("na1", "k", 1)
        self.assertEqual([p["tier"] for p in out[:6]], ["challenger", "grandmaster", "grandmaster", "master", "master", "master"])
        self.assertEqual(len(out), 12)

    def test_wait_for_key_retries_until_active(self):
        calls = []
        def fake(_u, _k):
            calls.append(1)
            if len(calls) < 3:
                raise fh.KeyExpired("401")
        self.patch(fh, "get", fake)
        fh.wait_for_key("na1", "k")
        self.assertEqual(len(calls), 3)

    def test_wait_for_key_gives_up(self):
        self.patch(fh, "get", lambda *_a: (_ for _ in ()).throw(fh.KeyExpired("401")))
        with self.assertRaises(fh.KeyExpired):
            fh.wait_for_key("na1", "k", minutes=0)

    def test_known_L6_region_tables_differ(self):
        import lra_core as core
        self.assertEqual(sorted(k for k in core.PLATFORM_TO_REGION if k.lower() not in fh.REGION_OF), ["ME1", "PH2", "TH2"])


class TrainServerTests(SandboxTest):
    def setUp(self):
        super().setUp()
        self.data, self.cache, self.out, self.static = self.tmp / "d", self.tmp / "c", self.tmp / "o", self.tmp / "static"
        for d in (self.data, self.cache, self.static):
            d.mkdir()
        for k, v in (("DATA", self.data), ("CACHE", self.cache), ("OUT", self.out), ("STATIC", self.static), ("ROOT", self.tmp)):
            self.patch(ts, k, v)
        srv = ts.ThreadingHTTPServer(("127.0.0.1", 0), ts.H)
        self.port = srv.server_address[1]
        self.patch(ts, "PORT", self.port)
        threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)

    def req(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request(method, path, body=body, headers=headers or {})
        r = c.getresponse()
        d = r.read()
        st, loc = r.status, r.getheader("Location")
        c.close()
        return st, d, loc

    def test_root_redirects(self):
        st, _, loc = self.req("GET", "/")
        self.assertEqual((st, loc), (302, "/train/train.html"))

    def test_foreign_host_blocked(self):
        self.assertEqual(self.req("GET", "/api/list", headers={"Host": "evil.example"})[0], 403)
        self.assertEqual(self.req("POST", "/api/save?name=x", body=b"1", headers={"Origin": "https://evil.example"})[0], 403)

    def test_list_and_game(self):
        with gzip.open(self.data / "NA1_123456.json.gz", "wt") as f:
            json.dump({"a": 1}, f)
        self.assertEqual(json.loads(self.req("GET", "/api/list")[1]), ["NA1_123456"])
        self.assertEqual(json.loads(self.req("GET", "/api/game?id=NA1_123456")[1]), {"a": 1})

    def test_game_rejects_bad_ids(self):
        for mid in ("../x", "NA1_1", "NA1_999999"):
            with self.subTest(mid=mid):
                self.assertEqual(self.req("GET", f"/api/game?id={mid}")[0], 404)

    def test_user_games(self):
        (self.cache / "NA1_222222.json").write_text('{"b": 2}')
        (self.cache / "champdata_1.json").write_text("[]")
        self.assertEqual(json.loads(self.req("GET", "/api/user-list")[1]), ["NA1_222222"])
        self.assertEqual(json.loads(self.req("GET", "/api/user-game?id=NA1_222222")[1]), {"b": 2})
        self.assertEqual(self.req("GET", "/api/user-game?id=NA1_333333")[0], 404)

    def test_config_exposes_only_identity_settings(self):
        (self.tmp / "config.json").write_text(json.dumps({"apiKey": "SECRET", "myPuuids": ["p"], "myNames": ["n"]}), "utf-8")
        d = json.loads(self.req("GET", "/api/config")[1])
        self.assertEqual(d, {"myPuuids": ["p"], "myNames": ["n"]})

    def test_config_missing(self):
        self.assertEqual(json.loads(self.req("GET", "/api/config")[1]), {"myPuuids": [], "myNames": []})

    def test_save_model_and_output(self):
        self.assertEqual(self.req("POST", "/api/save?name=wp_model.js", body=b"model")[0], 200)
        self.assertEqual((self.static / "wp_model.js").read_bytes(), b"model")
        self.assertEqual(self.req("POST", "/api/save?name=report.json", body=b"out")[0], 200)
        self.assertEqual((self.out / "report.json").read_bytes(), b"out")

    def test_save_rejects_bad_names(self):
        for name in ("../x", "a/b", "", "a b"):
            with self.subTest(name=name):
                self.assertEqual(self.req("POST", "/api/save?name=" + name.replace(" ", "%20"), body=b"x")[0], 404)

    def test_static_paths_cannot_escape(self):
        (self.tmp / "secret.txt").write_text("s")
        (self.static / "ok.js").write_text("js")
        self.assertEqual(self.req("GET", "/static/ok.js")[1], b"js")
        self.assertEqual(self.req("GET", "/static/../secret.txt")[0], 404)

    def test_unknown_get(self):
        self.assertEqual(self.req("GET", "/nope")[0], 404)
