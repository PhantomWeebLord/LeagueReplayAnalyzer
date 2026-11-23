"""Characterization and HTTP integration tests for server.py, run against a real local server inside the sandbox."""
import contextlib
import http.client
import io
import json
import os
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from unittest import mock

from tests import fixtures as fx
from tests.sandbox import SandboxTest, core
from tests.test_core import Resp

import server as s


class FakeRecorder:
    def __init__(self, status="idle", session=None):
        self.st = {"status": status}
        if session:
            self.st["session"] = session
        self.posts = []
        self.get_result = {"time": 12.0, "paused": False, "speed": 1.0}
        self.get_error = None

    def state(self):
        return self.st

    def sessions(self):
        return [{"id": "a"}]

    def session_file(self, sid):
        return {"id": sid} if sid == "good" else None

    def live_get(self, path, timeout=1.5):
        if self.get_error:
            raise self.get_error
        if path == "/liveclientdata/playerlist":
            return [{"riotIdGameName": "A", "rawChampionName": "game_character_displayname_Ahri", "championName": "Ahri", "team": "ORDER"},
                    {"summonerName": "B#NA1", "championName": "Jinx", "team": "CHAOS"}]
        if path == "/replay/game":
            return {"processID": 999999}
        return self.get_result

    def live_post(self, path, body, timeout=3):
        if self.get_error:
            raise self.get_error
        self.posts.append((path, body))
        return {"ok": True}

    def busy(self):
        return False


class ServerCase(SandboxTest):
    def setUp(self):
        super().setUp()
        self.srv = s.AppServer(("127.0.0.1", 0), s.Handler)
        self.port = self.srv.server_address[1]
        p = mock.patch.dict(s.OPTS, {"port": self.port})
        p.start()
        self.addCleanup(p.stop)
        self.patch(s, "RECORDER", None)
        t = threading.Thread(target=self.srv.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        t.start()
        self.addCleanup(self.srv.server_close)
        self.addCleanup(self.srv.shutdown)

    def req(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = dict(headers or {})
        if isinstance(body, (dict, list)):
            body = json.dumps(body)
            h.setdefault("Content-Type", "application/json")
        c.request(method, path, body=body, headers=h)
        r = c.getresponse()
        data = r.read()
        hdrs = dict(r.getheaders())
        c.close()
        return r.status, data, hdrs

    def get(self, path, **kw):
        st, data, _ = self.req("GET", path, **kw)
        return st, json.loads(data) if data else None

    def post(self, path, body=None, **kw):
        st, data, _ = self.req("POST", path, {} if body is None else body, **kw)
        return st, json.loads(data) if data else None


class GuardTests(ServerCase):
    def test_get_requires_local_host(self):
        for host in ("evil.example", f"evil.example:{self.port}", "127.0.0.1:1", ""):
            with self.subTest(host=host):
                st, _, _ = self.req("GET", "/api/ping", headers={"Host": host})
                self.assertEqual(st, 403)

    def test_localhost_name_allowed(self):
        self.assertEqual(self.req("GET", "/api/ping", headers={"Host": f"localhost:{self.port}"})[0], 200)

    def test_foreign_origin_blocked(self):
        for m in ("GET", "POST"):
            with self.subTest(method=m):
                self.assertEqual(self.req(m, "/api/config", headers={"Origin": "https://evil.example", "Content-Type": "application/json", "Content-Length": "0"})[0], 403)

    def test_own_origin_allowed(self):
        self.assertEqual(self.req("GET", "/api/ping", headers={"Origin": f"http://127.0.0.1:{self.port}"})[0], 200)

    def test_cross_site_requests_cannot_reach_the_api(self):
        hits = []
        self.patch(core, "get_match", lambda m, refresh=False: hits.append((m, refresh)) or {"ok": 1})
        for site, mode in (("cross-site", "no-cors"), ("same-site", "no-cors"), ("cross-site", "navigate")):
            with self.subTest(site=site, mode=mode):
                st, _, _ = self.req("GET", "/api/match?id=NA1_1&refresh=1", headers={"Sec-Fetch-Site": site, "Sec-Fetch-Mode": mode})
                self.assertEqual(st, 403)
        self.assertEqual(hits, [])

    def test_opening_the_app_from_a_link_still_works(self):
        self.assertEqual(self.req("GET", "/", headers={"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate"})[0], 200)

    def test_cross_site_cannot_load_app_files(self):
        self.assertEqual(self.req("GET", "/app.js", headers={"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors"})[0], 403)

    def test_own_page_requests_are_allowed(self):
        for site in ("same-origin", "none"):
            with self.subTest(site=site):
                self.assertEqual(self.req("GET", "/api/ping", headers={"Sec-Fetch-Site": site})[0], 200)

    def raw_post(self, headers, body=b""):
        """Runs do_POST on an in-memory request, so what it reads can be checked exactly."""
        h = s.Handler.__new__(s.Handler)
        h.headers, h.rfile, h.wfile = headers, io.BytesIO(body), io.BytesIO()
        h.path, h.command, h.request_version, h.requestline = "/api/config", "POST", "HTTP/1.1", "POST /api/config HTTP/1.1"
        h.client_address, h.close_connection = ("127.0.0.1", 0), True
        h.do_POST()
        return h, int(h.wfile.getvalue().split(b" ", 2)[1])

    def test_rejected_post_reads_its_body_first(self):
        # closing with unread data makes Windows reset the socket, and the client can lose the 403
        h, st = self.raw_post({"Host": f"127.0.0.1:{self.port}", "Origin": "https://evil.example", "Content-Length": "10"}, b"x" * 10)
        self.assertEqual((st, h.rfile.tell()), (403, 10))

    def test_oversized_post_is_refused_unread(self):
        h, st = self.raw_post({"Host": f"127.0.0.1:{self.port}", "Content-Type": "application/json", "Content-Length": str(s.MAX_BODY_BYTES + 1)}, b"x")
        self.assertEqual((st, h.rfile.tell()), (413, 0))

    def test_negative_content_length_is_empty(self):
        _, st = self.raw_post({"Host": f"127.0.0.1:{self.port}", "Content-Type": "application/json", "Content-Length": "-5"})
        self.assertEqual(st, 200)

    def test_bad_length_from_foreign_origin_is_403(self):
        _, st = self.raw_post({"Host": f"127.0.0.1:{self.port}", "Origin": "https://evil.example", "Content-Length": "nope"})
        self.assertEqual(st, 403)

    def test_slow_clients_time_out(self):
        self.assertGreater(s.Handler.timeout, 0)

    def test_post_requires_json(self):
        self.assertEqual(self.req("POST", "/api/config", body="{}", headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.req("POST", "/api/config", body="{}")[0], 415)

    def test_bad_content_length(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.putrequest("POST", "/api/config")
        c.putheader("Content-Length", "nope")
        c.endheaders()
        self.assertEqual(c.getresponse().status, 400)
        c.close()

    def test_bad_json_is_a_400_without_internal_text(self):
        for body in ("{bad", "[1, 2]", '"text"'):
            with self.subTest(body=body):
                st, d, _ = self.req("POST", "/api/config", body=body, headers={"Content-Type": "application/json"})
                self.assertEqual(st, 400)
                self.assertNotIn(b"Error", d)

    def test_unknown_post(self):
        self.assertEqual(self.post("/api/nope")[0], 404)

    def test_bye_records_close(self):
        self.patch(s, "BYE_AT", [None])
        self.assertEqual(self.req("POST", "/api/bye", body="")[0], 204)
        self.assertIsNotNone(s.BYE_AT[0])


class StaticTests(ServerCase):
    def test_index(self):
        st, d, h = self.req("GET", "/")
        self.assertEqual((st, h["Content-Type"]), (200, "text/html; charset=utf-8"))
        self.assertIn(b"Replay Analyzer", d)

    def test_security_headers(self):
        _, _, page = self.req("GET", "/")
        csp = page["Content-Security-Policy"]
        for rule in ("default-src 'self'", "script-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'"):
            self.assertIn(rule, csp)
        self.assertNotIn("unsafe-eval", csp)
        self.assertEqual(page["X-Content-Type-Options"], "nosniff")
        self.assertEqual(self.req("GET", "/api/ping")[2]["X-Content-Type-Options"], "nosniff")

    def test_mime_types(self):
        for path, ctype in (("/app.js", "text/javascript; charset=utf-8"), ("/style.css", "text/css; charset=utf-8"), ("/logo.png", "image/png")):
            with self.subTest(path=path):
                st, _, h = self.req("GET", path)
                self.assertEqual((st, h["Content-Type"]), (200, ctype))

    def test_missing_file(self):
        self.assertEqual(self.req("GET", "/nope.js")[0], 404)

    def test_traversal_blocked(self):
        for path in ("/../server.py", "/%2e%2e/server.py", "/..%5cserver.py", "/C:/Windows/win.ini", "//C:/Windows/win.ini"):
            with self.subTest(path=path):
                self.assertEqual(self.req("GET", path)[0], 404)

    def test_asset_route(self):
        self.patch(core, "get_asset", lambda kind, name: b"PNG" if (kind, name) == ("champ", "Ahri") else None)
        st, d, h = self.req("GET", "/asset/champ/Ahri.png")
        self.assertEqual((st, d, h["Cache-Control"]), (200, b"PNG", "max-age=86400"))
        self.assertEqual(self.req("GET", "/asset/champ/Nope.png")[0], 404)
        self.assertEqual(self.req("GET", "/asset/")[0], 404)


class ApiTests(ServerCase):
    def test_ping(self):
        st, d = self.get("/api/ping")
        self.assertEqual((st, d["app"], d["version"], d["frozen"]), (200, s.APP_ID, s.VERSION, False))

    def test_replays(self):
        (core.DEFAULT_REPLAY_DIR / "NA1-5.rofl").write_bytes(fx.make_rofl(fx.make_game()))
        st, d = self.get("/api/replays")
        self.assertEqual((st, d["exists"], len(d["replays"]), d["replays"][0]["matchId"]), (200, True, 1, "NA1_5"))

    def test_config_get_without_key(self):
        _, d = self.get("/api/config")
        self.assertEqual((d["hasKey"], d["keyHint"], d["lcu"], d["keyRejected"], d["live"]), (False, "", False, False, False))

    def test_config_get_never_returns_full_key(self):
        key = "RGAPI-12345678-aaaa-bbbb-cccc-1234567890ab"
        core.save_config({"apiKey": key})
        st, data, _ = self.req("GET", "/api/config")
        self.assertNotIn(key.encode(), data)
        self.assertEqual(json.loads(data)["keyHint"], "RGAPI-…90ab")

    def test_config_post_key(self):
        core.rejected_keys.add("NEWKEY")
        self.assertEqual(self.post("/api/config", {"apiKey": "  NEWKEY "})[1], {"ok": True})
        self.assertEqual(core.load_config()["apiKey"], "NEWKEY")
        self.assertNotIn("NEWKEY", core.rejected_keys)

    def test_config_post_replay_dir(self):
        self.post("/api/config", {"replayDir": " D:/x "})
        self.assertEqual(core.load_config()["replayDir"], "D:/x")

    def test_config_ignores_other_fields(self):
        self.post("/api/config", {"leagueDir": "C:/evil"})
        self.assertNotIn("leagueDir", core.load_config())

    def test_champions(self):
        core._champ_table = fx.CHAMPION_TABLE
        self.assertEqual(self.get("/api/champions")[1]["MonkeyKing"], "Wukong")

    def test_me(self):
        self.patch(core, "lcu_get", lambda *_a, **_k: {"gameName": "G", "tagLine": "T", "puuid": "P", "secret": "no"})
        self.assertEqual(self.get("/api/me")[1], {"gameName": "G", "tagLine": "T", "puuid": "P"})

    def test_me_without_client(self):
        self.assertIn("error", self.get("/api/me")[1])

    def test_match(self):
        calls = []
        self.patch(core, "get_match", lambda m, r=False: calls.append((m, r)) or {"source": "x"})
        self.assertEqual(self.get("/api/match?id=na1_12")[1], {"source": "x"})
        self.get("/api/match?id=NA1_12&refresh=1")
        self.assertEqual(calls, [("NA1_12", False), ("NA1_12", True)])

    def test_match_rejects_bad_ids(self):
        for mid in ("", "NA1", "NA1_abc", "../x", "NA1_1%2F..", "1_2"):
            with self.subTest(mid=mid):
                self.assertEqual(self.get(f"/api/match?id={mid}")[0], 400)

    def test_match_error_is_200_with_error(self):
        self.patch(core, "get_match", lambda *_a: (_ for _ in ()).throw(core.RiotError(503, "unavailable")))
        self.assertEqual(self.get("/api/match?id=NA1_1"), (200, {"error": "unavailable", "status": 503}))

    def test_unexpected_exception_is_500(self):
        self.patch(core, "list_replays", lambda: (_ for _ in ()).throw(RuntimeError("boom")))
        with contextlib.redirect_stderr(io.StringIO()) as log:
            st, d = self.get("/api/replays")
        self.assertEqual(st, 500)
        self.assertNotIn("boom", d["error"])
        self.assertNotIn("RuntimeError", d["error"])
        self.assertIn("boom", log.getvalue())

    def test_unexpected_post_exception_hides_details(self):
        self.patch(core, "save_config", lambda _c: (_ for _ in ()).throw(RuntimeError(r"C:\\Users\\secret\\path")))
        with contextlib.redirect_stderr(io.StringIO()):
            st, d = self.post("/api/config", {"replayDir": "x"})
        self.assertEqual(st, 500)
        self.assertNotIn("secret", d["error"])

    def test_disconnected_client_is_not_an_app_error(self):
        h = s.Handler.__new__(s.Handler)
        h.headers = {"Host": f"127.0.0.1:{self.port}"}
        h.path, h.command, h.request_version, h.requestline = "/api/ping", "GET", "HTTP/1.1", "GET /api/ping HTTP/1.1"
        h.client_address, h.close_connection, h.rfile = ("127.0.0.1", 0), True, io.BytesIO()
        class Gone:
            def write(self, _b):
                raise ConnectionAbortedError("client left")
            def flush(self):
                pass
        h.wfile = Gone()
        h.do_GET()

    def test_replay_file(self):
        p = self.tmp / "NA1-9.rofl"
        p.write_bytes(fx.make_rofl(fx.make_game()))
        st, d = self.get("/api/replay-file?path=" + urllib.parse.quote(str(p)))
        self.assertEqual((st, d["matchId"], d["path"]), (200, "NA1_9", str(p)))

    def test_replay_file_rejects(self):
        other = self.tmp / "a.txt"
        other.write_text("x")
        for path in (str(other), str(self.tmp / "none.rofl"), ""):
            with self.subTest(path=path):
                self.assertEqual(self.get("/api/replay-file?path=" + urllib.parse.quote(path))[0], 400)

    def test_replay_file_corrupt(self):
        p = self.tmp / "bad.rofl"
        p.write_bytes(b"junk")
        st, d = self.get("/api/replay-file?path=" + urllib.parse.quote(str(p)))
        self.assertEqual(st, 200)
        self.assertIn("Could not read this replay", d["error"])
        self.assertNotIn("Traceback", d["error"])

    def test_live_routes_disabled(self):
        self.assertEqual(self.get("/api/live/state")[1], {"status": "disabled"})
        self.assertEqual(self.get("/api/live/sessions")[1], [])
        self.assertEqual(self.get("/api/live/session?id=a")[0], 404)

    def test_live_routes_enabled(self):
        self.patch(s, "RECORDER", FakeRecorder("play"))
        self.assertEqual(self.get("/api/live/state")[1]["status"], "play")
        self.assertEqual(self.get("/api/live/sessions")[1], [{"id": "a"}])
        self.assertEqual(self.get("/api/live/session?id=good")[1], {"id": "good"})
        self.assertEqual(self.get("/api/live/session?id=bad")[0], 404)

    def test_playback_get(self):
        self.patch(s, "RECORDER", FakeRecorder())
        self.assertEqual(self.get("/api/replay/playback")[1]["time"], 12.0)

    def test_playback_get_unavailable(self):
        d = self.get("/api/replay/playback")[1]
        self.assertEqual((d["error"], d["enabledInConfig"]), ("Replay control is not available", False))

    def test_render_get(self):
        self.patch(s, "RECORDER", FakeRecorder())
        self.assertIn("time", self.get("/api/replay/render")[1])
        s.RECORDER.get_error = OSError("x")
        self.assertIn("error", self.get("/api/replay/render")[1])

    def test_replay_players(self):
        self.patch(s, "RECORDER", FakeRecorder())
        d = self.get("/api/replay/players")[1]
        self.assertEqual(d[0], {"name": "A", "champ": "Ahri", "champName": "Ahri", "team": 100})
        self.assertEqual((d[1]["name"], d[1]["team"]), ("B", 200))

    def test_replay_players_unavailable(self):
        self.assertEqual(self.get("/api/replay/players")[1], {"error": "No replay running"})

    def test_render_post_filters_keys(self):
        self.patch(s, "RECORDER", FakeRecorder())
        self.post("/api/replay/render", {"fogOfWar": False, "evil": 1, "cameraMode": "top"})
        self.assertEqual(s.RECORDER.posts, [("/replay/render", {"fogOfWar": False, "cameraMode": "top"})])

    def test_render_post_blocks_crashing_camera_modes(self):
        self.patch(s, "RECORDER", FakeRecorder())
        for mode in ("tps", "fps", "focus"):
            with self.subTest(mode=mode):
                self.post("/api/replay/render", {"cameraMode": mode})
                self.assertEqual(s.RECORDER.posts[-1], ("/replay/render", {}))

    def test_render_post_unavailable(self):
        self.assertIn("not available", self.post("/api/replay/render", {"fogOfWar": True})[1]["error"])

    def test_playback_post_clamps(self):
        self.patch(s, "RECORDER", FakeRecorder())
        self.post("/api/replay/playback", {"time": -5, "speed": 100, "paused": 1, "evil": 2})
        self.assertEqual(s.RECORDER.posts[-1], ("/replay/playback", {"time": 0.0, "speed": 16.0, "paused": True}))
        self.post("/api/replay/playback", {"speed": 0})
        self.assertEqual(s.RECORDER.posts[-1][1], {"speed": 0.125})

    def test_playback_post_bad_values(self):
        self.patch(s, "RECORDER", FakeRecorder())
        self.assertEqual(self.post("/api/replay/playback", {"time": "soon"})[0], 400)

    def test_playback_post_unavailable(self):
        d = self.post("/api/replay/playback", {"paused": True})[1]
        self.assertIn("not available", d["error"])

    def test_window(self):
        calls = []
        self.patch(core, "arrange_windows", lambda a, t: calls.append((a, t)) or True)
        self.assertEqual(self.post("/api/replay/window", {"action": "front"})[1], {"ok": True})
        self.assertEqual(calls, [("front", s.APP_TITLE)])

    def test_start_client(self):
        self.patch(core, "start_league_client", lambda: True)
        self.assertEqual(self.post("/api/replay/start-client")[1], {"ok": True})
        self.patch(core, "start_league_client", lambda: (_ for _ in ()).throw(core.RiotError(404, "no client")))
        self.assertEqual(self.post("/api/replay/start-client")[1], {"error": "no client"})

    def test_watch(self):
        calls = []
        self.patch(core, "watch_replay", lambda m, p: calls.append((m, p)))
        self.assertEqual(self.post("/api/replay/watch", {"matchId": "na1_5", "path": "x.rofl"})[1], {"ok": True})
        self.assertEqual(calls, [("NA1_5", "x.rofl")])

    def test_watch_bad_id(self):
        self.assertEqual(self.post("/api/replay/watch", {"matchId": "../x"})[0], 400)

    def test_watch_failure(self):
        self.patch(core, "watch_replay", lambda *_a: (_ for _ in ()).throw(core.RiotError(404, "gone")))
        self.assertIn("Could not start", self.post("/api/replay/watch", {"matchId": "NA1_5"})[1]["error"])

    def test_enable_api(self):
        self.patch(core, "enable_replay_api", lambda: True)
        self.assertEqual(self.post("/api/replay/enable-api")[1], {"ok": True})
        self.patch(core, "enable_replay_api", lambda: (_ for _ in ()).throw(OSError("denied")))
        self.assertEqual(self.post("/api/replay/enable-api")[1], {"error": "denied"})

    def test_close_route(self):
        self.patch(s, "close_replay", lambda: {"ok": True})
        self.assertEqual(self.post("/api/replay/close")[1], {"ok": True})


class ReplayStatusTests(SandboxTest):
    def setUp(self):
        super().setUp()
        self.patch(s, "RECORDER", None)
        self.patch(s, "_status_cache", {"at": 0.0, "cfg": None})
        self.patch(s, "_patch_cache", {})

    def client(self, patch="16.23", cfg=None):
        self.patch(core, "find_lockfile", lambda: self.tmp / "lockfile")
        self.patch(core, "client_patch", lambda: patch)
        self.patch(core, "lcu_get", lambda *_a, **_k: cfg or {})

    def test_client_closed(self):
        r = s.replay_status("NA1_1", "16.23.1")
        self.assertEqual((r["lcu"], r["clientPatch"], r["replayPatch"], r["compatible"], r["inGame"], r["spectating"]), (False, None, "16.23", None, False, False))

    def test_compatible_patch(self):
        self.client()
        self.assertTrue(s.replay_status("NA1_1", "16.23.840.1")["compatible"])

    def test_old_replay_patch(self):
        self.client()
        self.assertFalse(s.replay_status("NA1_1", "16.10.1.1")["compatible"])

    def test_future_replay_patch(self):
        self.client()
        self.assertFalse(s.replay_status("NA1_1", "17.1.1.1")["compatible"])

    def test_stale_lockfile(self):
        self.client(patch=None)
        self.assertFalse(s.replay_status("NA1_1", "")["lcu"])

    def test_installed_patch_used_when_client_closed(self):
        self.patch(core, "installed_game_patch", lambda: "16.23")
        r = s.replay_status("NA1_1", "16.23.1")
        self.assertEqual((r["clientPatch"], r["compatible"]), ("16.23", True))

    def test_patch_read_from_replay_file(self):
        (core.DEFAULT_REPLAY_DIR / "NA1-5.rofl").write_bytes(fx.make_rofl(version="16.10.1.2"))
        self.assertEqual(s.replay_status("NA1_5", "")["replayPatch"], "16.10")

    def test_replay_patch_for(self):
        self.assertIsNone(s.replay_patch_for("NA1_5"))
        f = core.DEFAULT_REPLAY_DIR / "NA1-5.rofl"
        f.write_bytes(b"junk")
        self.assertIsNone(s.replay_patch_for("NA1_5"))
        f.write_bytes(fx.make_rofl(version="16.10.1.2"))
        os.utime(f, (5000, 5000))
        self.assertEqual(s.replay_patch_for("NA1_5"), "16.10")

    def test_client_flags(self):
        self.client(cfg={"isPlayingGame": True, "isPlayingReplay": True, "isPatching": True})
        r = s.replay_status("NA1_1", "")
        self.assertTrue(r["clientPlayingGame"] and r["clientPlayingReplay"] and r["clientPatching"])

    def test_client_config_is_cached(self):
        calls = []
        self.client()
        self.patch(core, "lcu_get", lambda *_a, **_k: calls.append(1) or {})
        s.replay_status("NA1_1", "")
        s.replay_status("NA1_1", "")
        self.assertEqual(len(calls), 1)

    def test_client_config_failure(self):
        self.client()
        self.patch(core, "lcu_get", lambda *_a, **_k: (_ for _ in ()).throw(core.RiotError(503, "x")))
        self.assertFalse(s.replay_status("NA1_1", "")["clientPlayingReplay"])

    def test_spectating_with_playback(self):
        self.patch(s, "RECORDER", FakeRecorder("spectate", {"matchId": "NA1_1"}))
        r = s.replay_status("NA1_1", "")
        self.assertEqual((r["spectating"], r["playingMatch"], r["playback"]["time"]), (True, "NA1_1", 12.0))

    def test_in_game_never_queries_replay_api(self):
        rec = FakeRecorder("play")
        rec.live_get = lambda *_a, **_k: self.fail("replay API called during a game")
        self.patch(s, "RECORDER", rec)
        r = s.replay_status("NA1_1", "")
        self.assertEqual((r["inGame"], r["playback"]), (True, None))

    def test_bad_playback_payload(self):
        rec = FakeRecorder("spectate")
        rec.get_result = {"unexpected": 1}
        self.patch(s, "RECORDER", rec)
        self.assertIsNone(s.replay_status("NA1_1", "")["playback"])

    def test_playback_failure(self):
        rec = FakeRecorder("spectate")
        rec.get_error = OSError("x")
        self.patch(s, "RECORDER", rec)
        self.assertIsNone(s.replay_status("NA1_1", "")["playback"])


class CloseReplayTests(SandboxTest):
    def setUp(self):
        super().setUp()
        self.kills = []
        self.patch(subprocess, "run", lambda a, **_k: self.kills.append(a))
        self.patch(time, "sleep", lambda _s: None)

    def window(self, stays=False):
        calls = [0]
        def find(_t, prefix=False):
            calls[0] += 1
            return True if stays or calls[0] == 1 else None
        self.patch(core, "find_window", find)
        self.patch(core, "league_window_pid", lambda: 999999)
        self.patch(core, "process_name", lambda _p: "League of Legends.exe")

    def test_refuses_during_a_game(self):
        self.patch(s, "RECORDER", FakeRecorder("play"))
        self.assertIn("in a game", s.close_replay()["error"])
        self.assertEqual(self.kills, [])

    def test_nothing_open(self):
        self.patch(s, "RECORDER", FakeRecorder("idle"))
        self.assertIn("No replay", s.close_replay()["error"])

    def test_closes_spectated_replay(self):
        self.patch(s, "RECORDER", FakeRecorder("spectate"))
        self.window()
        self.assertEqual(s.close_replay(), {"ok": True})
        self.assertEqual(self.kills, [[s.TASKKILL, "/PID", "999999"]])
        self.assertTrue(s.TASKKILL.lower().endswith(r"\system32\taskkill.exe"))

    def test_forces_when_replay_stays_open(self):
        self.patch(s, "RECORDER", FakeRecorder("spectate"))
        self.window(stays=True)
        self.assertEqual(s.close_replay(), {"ok": True})
        self.assertEqual(self.kills[1], [s.TASKKILL, "/F", "/PID", "999999"])

    def test_refuses_other_processes(self):
        self.patch(s, "RECORDER", FakeRecorder("spectate"))
        self.window()
        self.patch(core, "process_name", lambda _p: "notepad.exe")
        self.assertIn("Could not identify", s.close_replay()["error"])
        self.assertEqual(self.kills, [])

    def test_pid_from_replay_api(self):
        self.patch(s, "RECORDER", FakeRecorder("spectate"))
        self.window()
        self.patch(core, "league_window_pid", lambda: None)
        self.assertEqual(s.close_replay(), {"ok": True})

    def test_no_pid_available(self):
        rec = FakeRecorder("spectate")
        rec.get_error = OSError("x")
        self.patch(s, "RECORDER", rec)
        self.window()
        self.patch(core, "league_window_pid", lambda: None)
        self.assertIn("No replay", s.close_replay()["error"])

    def test_taskkill_failure(self):
        self.patch(s, "RECORDER", FakeRecorder("spectate"))
        self.window()
        self.patch(subprocess, "run", lambda *_a, **_k: (_ for _ in ()).throw(OSError("denied")))
        self.assertEqual(s.close_replay(), {"error": "denied"})

    def test_never_kills_when_the_live_api_is_silent(self):
        self.patch(s, "RECORDER", FakeRecorder("idle"))
        self.window(stays=True)
        self.assertIn("Close it in League", s.close_replay()["error"])
        self.assertEqual(self.kills, [])

    def test_never_kills_when_the_client_reports_a_real_game(self):
        for phase in ("InProgress", "Reconnect", "GameStart"):
            with self.subTest(phase=phase):
                self.patch(s, "RECORDER", FakeRecorder("spectate"))
                self.window(stays=True)
                self.patch(core, "lcu_get", lambda *_a, **_k: phase)
                self.assertIn("in a game", s.close_replay()["error"])
                self.assertEqual(self.kills, [])

    def test_closes_when_the_client_reports_a_replay(self):
        self.patch(s, "RECORDER", FakeRecorder("spectate"))
        self.window()
        self.patch(core, "lcu_get", lambda *_a, **_k: "WatchInProgress")
        self.assertEqual(s.close_replay(), {"ok": True})


class LifecycleTests(SandboxTest):
    def setUp(self):
        super().setUp()
        p = mock.patch.dict(s.OPTS, {"port": 8766, "browser": True, "file": None, "live": True, "live_url": "https://127.0.0.1:2999", "auto_exit": False})
        p.start()
        self.addCleanup(p.stop)

    def test_parse_args(self):
        s.parse_args(["game.rofl", "--port", "9000", "--no-browser", "--live-url", "http://x", "--no-live", "--auto-exit"])
        self.assertEqual((s.OPTS["file"], s.OPTS["port"], s.OPTS["browser"], s.OPTS["live_url"], s.OPTS["live"], s.OPTS["auto_exit"]), ("game.rofl", 9000, False, "http://x", False, True))
        s.parse_args(["--no-auto-exit"])
        self.assertFalse(s.OPTS["auto_exit"])

    def test_parse_args_ignores_unknown_flags(self):
        s.parse_args(["--whatever"])
        self.assertIsNone(s.OPTS["file"])

    def test_parse_args_bad_port_keeps_default(self):
        for args in (["--port", "abc"], ["--port", "0"], ["--port", "70000"], ["--port"]):
            with self.subTest(args=args):
                s.OPTS["port"] = 8766
                with contextlib.redirect_stdout(io.StringIO()):
                    s.parse_args(args)
                self.assertEqual(s.OPTS["port"], 8766)

    def test_parse_args_missing_live_url_is_ignored(self):
        s.parse_args(["--live-url"])
        self.assertEqual(s.OPTS["live_url"], "https://127.0.0.1:2999")

    def test_port_from_environment(self):
        for value, want in (("9001", 9001), ("abc", s.DEFAULT_PORT), ("", s.DEFAULT_PORT), ("99999", s.DEFAULT_PORT)):
            with self.subTest(value=value):
                self.assertEqual(s.valid_port(value, s.DEFAULT_PORT), want)

    def test_app_url(self):
        self.assertEqual(s.app_url(8766), "http://127.0.0.1:8766/")
        u = s.app_url(8766, self.tmp / "a b.rofl")
        self.assertTrue(u.startswith("http://127.0.0.1:8766/?open="))
        self.assertIn("a%20b.rofl", u)

    def test_instance_running(self):
        self.patch(urllib.request, "urlopen", lambda *_a, **_k: Resp(json.dumps({"app": s.APP_ID})))
        self.assertTrue(s.instance_running(1))
        self.patch(urllib.request, "urlopen", lambda *_a, **_k: Resp(json.dumps({"app": "other"})))
        self.assertFalse(s.instance_running(1))
        self.patch(urllib.request, "urlopen", lambda *_a, **_k: (_ for _ in ()).throw(OSError()))
        self.assertFalse(s.instance_running(1))

    def test_find_app_browser(self):
        exe = self.tmp / "Microsoft" / "Edge" / "Application" / "msedge.exe"
        exe.parent.mkdir(parents=True)
        exe.write_bytes(b"x")
        self.patch(os, "environ", {"ProgramFiles(x86)": str(self.tmp), "ProgramFiles": str(self.tmp / "no"), "LOCALAPPDATA": str(self.tmp / "no")})
        self.assertEqual(s.find_app_browser().replace("/", "\\"), str(exe).replace("/", "\\"))

    def test_find_app_browser_none(self):
        self.patch(os, "environ", {"ProgramFiles(x86)": str(self.tmp), "ProgramFiles": str(self.tmp), "LOCALAPPDATA": str(self.tmp)})
        self.assertIsNone(s.find_app_browser())

    def test_open_window_as_app(self):
        seen = []
        self.patch(s, "find_app_browser", lambda: "edge.exe")
        self.patch(subprocess, "Popen", lambda a, **_k: seen.append(a))
        s.open_window("http://127.0.0.1:1/")
        self.assertEqual(seen[0][:2], ["edge.exe", "--app=http://127.0.0.1:1/"])
        self.assertTrue(any(x.startswith("--user-data-dir=") for x in seen[0]))
        self.assertTrue(any("League of Legends (TM) Client" in x for x in seen[0]))

    def test_open_window_falls_back(self):
        opened = []
        self.patch(s, "find_app_browser", lambda: None)
        self.patch(s.webbrowser, "open", lambda u: opened.append(u))
        s.open_window("u1")
        self.patch(s, "find_app_browser", lambda: "edge.exe")
        self.patch(subprocess, "Popen", lambda *_a, **_k: (_ for _ in ()).throw(OSError()))
        s.open_window("u2")
        self.assertEqual(opened, ["u1", "u2"])

    def run_watchdog(self, recorder, bye, ping):
        exited = []
        class Stop(Exception):
            pass
        ticks = [0]
        def tick(_s):
            ticks[0] += 1
            if ticks[0] > 1:
                raise Stop
        self.patch(s, "RECORDER", recorder)
        self.patch(s, "BYE_AT", [bye])
        self.patch(s, "LAST_PING", [ping])
        self.patch(time, "sleep", tick)
        def fake_exit(code):
            exited.append(code)
            raise Stop
        self.patch(os, "_exit", fake_exit)
        with self.assertRaises(Stop):
            s.watchdog()
        return exited

    def test_watchdog_exits_after_window_closed(self):
        now = time.time()
        self.assertEqual(self.run_watchdog(None, now - 30, now - 40), [0])

    def test_watchdog_waits_after_recent_close(self):
        now = time.time()
        self.assertEqual(self.run_watchdog(None, now - 5, now - 40), [])

    def test_watchdog_stays_if_page_came_back(self):
        now = time.time()
        self.assertEqual(self.run_watchdog(None, now - 30, now - 1), [])

    def test_watchdog_never_exits_during_a_game(self):
        now = time.time()
        rec = FakeRecorder("play")
        rec.busy = lambda: True
        self.assertEqual(self.run_watchdog(rec, now - 30, now - 40), [])

    def test_watchdog_exits_after_six_idle_hours(self):
        self.assertEqual(self.run_watchdog(None, None, time.time() - 6 * 3600 - 1), [0])

    def test_main_reuses_running_instance(self):
        opened = []
        self.patch(s, "parse_args", lambda _a: None)
        self.patch(s, "instance_running", lambda _p: True)
        self.patch(s, "open_window", lambda u: opened.append(u))
        s.main()
        self.assertEqual(opened, ["http://127.0.0.1:8766/"])

    def test_main_no_free_port(self):
        self.patch(s, "parse_args", lambda _a: None)
        self.patch(s, "instance_running", lambda _p: False)
        self.patch(s, "AppServer", lambda *_a: (_ for _ in ()).throw(OSError("in use")))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            s.main()
        self.assertIn("No free port", out.getvalue())

    def test_main_finds_instance_on_next_port(self):
        opened = []
        self.patch(s, "parse_args", lambda _a: None)
        self.patch(s, "instance_running", lambda p: p == 8767)
        self.patch(s, "AppServer", lambda *_a: (_ for _ in ()).throw(OSError("in use")))
        self.patch(s, "open_window", lambda u: opened.append(u))
        s.OPTS["port"] = 8766
        real = s.instance_running
        self.patch(s, "instance_running", lambda p: p == 8767 and real(p))
        s.main()
        self.assertEqual(opened, ["http://127.0.0.1:8767/"])

    def test_second_server_cannot_share_the_port(self):
        a = s.AppServer(("127.0.0.1", 0), s.Handler)
        self.addCleanup(a.server_close)
        with self.assertRaises(OSError):
            s.AppServer(("127.0.0.1", a.server_address[1]), s.Handler)

    def test_port_is_free_again_right_after_a_restart(self):
        a = s.AppServer(("127.0.0.1", 0), s.Handler)
        port = a.server_address[1]
        p = mock.patch.dict(s.OPTS, {"port": port})
        p.start()
        self.addCleanup(p.stop)
        threading.Thread(target=a.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        c.request("GET", "/api/ping")
        self.assertEqual(c.getresponse().status, 200)
        c.close()
        a.shutdown()
        a.server_close()
        b = s.AppServer(("127.0.0.1", port), s.Handler)
        b.server_close()

    def test_backlog_is_large_enough_for_a_page_load(self):
        self.assertGreaterEqual(s.AppServer.request_queue_size, 64)
