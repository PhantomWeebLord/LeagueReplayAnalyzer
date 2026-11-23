"""Characterization tests for lra_core: what the code does today, including defects listed in the audit (named test_known_*)."""
import base64
import http.client
import io
import json
import os
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace as NS

from tests import fixtures as fx
from tests.sandbox import SandboxTest, core

REAL_FIND_LOCKFILE = core.find_lockfile
REAL_INSTALL_DIRS = core.league_install_dirs
REAL_USER32 = core._user32
real_riot_get = core.riot_get


class Resp:
    headers = {}

    def __init__(self, body=b"", read_error=None):
        self.body = body.encode() if isinstance(body, str) else body
        self.read_error = read_error

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False

    def read(self, n=-1):
        if self.read_error:
            raise self.read_error
        return self.body if n < 0 else self.body[:n]


def http_error(url, code, body=b""):
    return urllib.error.HTTPError(url, code, "error", {}, io.BytesIO(body))


class ConfigTests(SandboxTest):
    def test_missing_config_is_empty(self):
        self.assertEqual(core.load_config(), {})

    def test_save_then_load(self):
        core.save_config({"apiKey": "RGAPI-test", "replayDir": "D:/r"})
        self.assertEqual(core.load_config()["replayDir"], "D:/r")

    def test_corrupt_config_is_empty(self):
        core.CONFIG_FILE.write_text("{broken", "utf-8")
        self.assertEqual(core.load_config(), {})

    def test_read_error_followed_by_save_keeps_key(self):
        core.save_config({"apiKey": "keep"})
        core.load_config()
        self.patch(time, "sleep", lambda _s: None)
        real = Path.read_text
        def locked(p, *a, **k):
            if p == core.CONFIG_FILE:
                raise PermissionError("sharing violation")
            return real(p, *a, **k)
        self.patch(Path, "read_text", locked)
        cfg = core.load_config()
        cfg["replayDir"] = "x"
        core.save_config(cfg)
        self.box.patches.pop().stop()
        self.assertEqual(core.load_config(), {"apiKey": "keep", "replayDir": "x"})

    def test_damaged_config_is_kept_for_recovery(self):
        core.CONFIG_FILE.write_text('{"apiKey": "half', "utf-8")
        self.assertEqual(core.load_config(), {})
        self.assertEqual((self.tmp / "config.damaged.json").read_text("utf-8"), '{"apiKey": "half')
        core.save_config({"replayDir": "x"})
        self.assertEqual((self.tmp / "config.damaged.json").read_text("utf-8"), '{"apiKey": "half')

    def test_config_of_the_wrong_shape_is_empty(self):
        core.CONFIG_FILE.write_text("[1, 2]", "utf-8")
        self.assertEqual(core.load_config(), {})

    def test_write_atomic_replaces_file_and_leaves_no_temp(self):
        f = self.tmp / "a.json"
        core.write_atomic(f, "one")
        core.write_atomic(f, "two")
        self.assertEqual(f.read_text("utf-8"), "two")
        self.assertEqual(list(self.tmp.glob("*.tmp")), [])

    def test_write_atomic_failure_keeps_old_file_and_removes_temp(self):
        f = self.tmp / "a.json"
        f.write_text("old", "utf-8")
        self.patch(os, "replace", lambda *_a: (_ for _ in ()).throw(OSError("disk")))
        with self.assertRaises(OSError):
            core.write_atomic(f, "new")
        self.assertEqual(f.read_text("utf-8"), "old")
        self.assertEqual(list(self.tmp.glob("*.tmp")), [])

    def test_write_waits_for_a_reader_to_finish(self):
        f = self.tmp / "busy.json"
        f.write_text("old", "utf-8")
        h = open(f, "rb")
        threading.Timer(0.03, h.close).start()
        core.write_atomic(f, "new")
        self.assertEqual(f.read_text("utf-8"), "new")

    def test_write_gives_up_if_the_file_stays_locked(self):
        f = self.tmp / "busy.json"
        f.write_text("old", "utf-8")
        real = time.sleep
        self.patch(time, "sleep", lambda _s: real(0))
        with open(f, "rb"):
            with self.assertRaises(PermissionError):
                core.write_atomic(f, "new")
        self.assertEqual(f.read_text("utf-8"), "old")
        self.assertEqual(list(self.tmp.glob("*.tmp")), [])

    def test_replay_dir_default_and_override(self):
        self.assertEqual(core.replay_dir(), core.DEFAULT_REPLAY_DIR)
        core.save_config({"replayDir": str(self.tmp / "x")})
        self.assertEqual(core.replay_dir(), self.tmp / "x")


class RoflTests(SandboxTest):
    def write(self, blob, name="NA1-5000000001.rofl"):
        p = self.tmp / name
        p.write_bytes(blob)
        return p

    def test_parses_three_patch_versions(self):
        for patch in fx.PATCHES:
            with self.subTest(patch=patch):
                game = fx.make_game(patch)
                r = core.parse_rofl(self.write(fx.make_rofl(game, version=f"{patch}.700.1234")))
                self.assertEqual(r["version"], f"{patch}.700.1234")
                self.assertEqual(core.patch_of(r["version"]), patch)
                self.assertEqual(r["matchId"], "NA1_5000000001")
                self.assertEqual(len(r["players"]), 10)
                self.assertEqual(r["gameLength"], game["match"]["info"]["gameDuration"] * 1000)

    def test_player_fields(self):
        game = fx.make_game()
        p = core.parse_rofl(self.write(fx.make_rofl(game)))["players"][0]
        src = game["match"]["info"]["participants"][0]
        self.assertEqual((p["puuid"], p["name"], p["tag"], p["champion"], p["team"], p["position"]), (src["puuid"], src["riotIdGameName"], "TEST", "MonkeyKing", 100, "TOP"))
        self.assertEqual((p["kills"], p["deaths"], p["assists"], p["gold"]), (src["kills"], src["deaths"], src["assists"], src["goldEarned"]))
        self.assertEqual(p["cs"], src["totalMinionsKilled"] + src["neutralMinionsKilled"])
        self.assertIs(p["win"], True)

    def test_real_shape_with_empty_player_list(self):
        r = core.parse_rofl(self.write(fx.make_rofl(stats=[])))
        self.assertEqual(r["players"], [])

    def test_filename_sets_match_id(self):
        cases = {"EUW1-123.rofl": ("EUW1", "123", "EUW1_123"), "kr-99.rofl": ("KR", "99", "KR_99"), "renamed.rofl": (None, None, None), "NA1-77 copy.rofl": ("NA1", "77", "NA1_77")}
        for name, want in cases.items():
            with self.subTest(name=name):
                r = core.parse_rofl(self.write(fx.make_rofl(), name))
                self.assertEqual((r["platform"], r["gameId"], r["matchId"]), want)

    def test_missing_version_is_none(self):
        blob = b"RIOT" + b"\x00" * 80 + json.dumps({"gameLength": 1, "statsJson": "[]"}).encode()
        self.assertIsNone(core.parse_rofl(self.write(blob))["version"])

    def test_metadata_far_from_end_is_found(self):
        blob = b"RIOT" + b"\x00" * 80 + json.dumps({"gameLength": 7, "statsJson": "[]"}).encode() + b"\x00" * (9 << 20)
        self.assertEqual(core.parse_rofl(self.write(blob))["gameLength"], 7)

    def test_whole_file_scan_is_bounded(self):
        self.patch(core, "ROFL_MAX_SCAN_BYTES", 2 << 20)
        self.patch(core, "ROFL_TAIL_SEARCH_BYTES", (1 << 10,))
        blob = b"RIOT" + b"\x00" * 80 + json.dumps({"gameLength": 7, "statsJson": "[]"}).encode() + b"\x00" * (3 << 20)
        with self.assertRaises(ValueError):
            core.parse_rofl(self.write(blob))

    def test_last_metadata_block_wins(self):
        one = json.dumps({"gameLength": 1, "statsJson": "[]"}).encode()
        two = json.dumps({"gameLength": 2, "statsJson": "[]"}).encode()
        self.assertEqual(core.parse_rofl(self.write(b"RIOT" + b"\x00" * 80 + one + b"\x00" + two))["gameLength"], 2)

    def test_invalid_utf8_after_metadata_is_tolerated(self):
        self.assertEqual(core.parse_rofl(self.write(fx.make_rofl() + b"\xff\xfe"))["players"], [])

    def test_corrupted_files_raise(self):
        good = fx.make_rofl(fx.make_game())
        meta = lambda stats: b"RIOT" + b"\x00" * 60 + json.dumps({"gameLength": 1, "statsJson": stats}).encode()
        cases = {
            "empty": (b"", ValueError), "wrong magic": (b"NOPE" + good, ValueError), "no metadata": (b"RIOT" + b"\x00" * 200, ValueError),
            "truncated metadata": (good[:len(good) - 40], ValueError), "stats not JSON": (meta("nope"), ValueError),
            "stats is an object": (meta('{"a": 1}'), AttributeError), "player not an object": (meta("[1]"), AttributeError),
            "non-numeric team": (meta('[{"TEAM": "BLUE"}]'), ValueError),
        }
        for name, (blob, err) in cases.items():
            with self.subTest(name=name):
                with self.assertRaises(err):
                    core.parse_rofl(self.write(blob))

    def test_known_M4_reordered_metadata_keys_fail(self):
        blob = b"RIOT" + b"\x00" * 60 + json.dumps({"lastGameChunkId": 1, "gameLength": 5, "statsJson": "[]"}).encode()
        with self.assertRaisesRegex(ValueError, "metadata"):
            core.parse_rofl(self.write(blob))

    def test_missing_file_raises(self):
        with self.assertRaises(FileNotFoundError):
            core.parse_rofl(self.tmp / "nope.rofl")

    def test_summarize_defaults(self):
        s = core.summarize({"gameLength": 5}, [{"NAME": "OldName"}], "1.2.3.4", "NA1", "9", "f.rofl")
        p = s["players"][0]
        self.assertEqual((p["name"], p["team"], p["kills"], p["win"], p["cs"], p["level"]), ("OldName", 0, 0, False, 0, 0))
        self.assertEqual(s["matchId"], "NA1_9")

    def test_summarize_prefers_riot_id_and_team_position(self):
        p = core.summarize({}, [{"NAME": "o", "RIOT_ID_GAME_NAME": "new", "INDIVIDUAL_POSITION": "MID", "TEAM_POSITION": "TOP"}], None, None, None, "f")["players"][0]
        self.assertEqual((p["name"], p["position"]), ("new", "TOP"))
        self.assertEqual(core.summarize({}, [{"INDIVIDUAL_POSITION": "MID"}], None, None, None, "f")["players"][0]["position"], "MID")

    def test_summarize_without_ids_has_no_match(self):
        self.assertIsNone(core.summarize({}, [], None, None, None, "f")["matchId"])


class ListReplaysTests(SandboxTest):
    def rofl(self, name, mtime, blob=None):
        p = core.DEFAULT_REPLAY_DIR / name
        p.write_bytes(fx.make_rofl() if blob is None else blob)
        os.utime(p, (mtime, mtime))
        return p

    def test_missing_folder(self):
        core.save_config({"replayDir": str(self.tmp / "none")})
        r = core.list_replays()
        self.assertEqual((r["exists"], r["replays"]), (False, []))

    def test_empty_folder(self):
        self.assertEqual(core.list_replays()["replays"], [])

    def test_sorted_newest_first(self):
        self.rofl("NA1-1.rofl", 1000)
        self.rofl("NA1-2.rofl", 3000)
        self.rofl("NA1-3.rofl", 2000)
        self.assertEqual([r["file"] for r in core.list_replays()["replays"]], ["NA1-2.rofl", "NA1-3.rofl", "NA1-1.rofl"])

    def test_broken_file_listed_with_error(self):
        self.rofl("NA1-1.rofl", 1000, b"garbage")
        self.rofl("NA1-2.rofl", 2000)
        rows = core.list_replays()["replays"]
        self.assertEqual(len(rows), 2)
        self.assertIn("RIOT", rows[1]["error"])

    def test_cached_flag(self):
        self.rofl("NA1-5.rofl", 1000)
        self.assertFalse(core.list_replays()["replays"][0]["cached"])
        (core.CACHE / "NA1_5.json").write_text("{}", "utf-8")
        self.assertTrue(core.list_replays()["replays"][0]["cached"])

    def test_unchanged_file_is_not_reparsed(self):
        self.rofl("NA1-1.rofl", 1000)
        core.list_replays()
        self.patch(core, "parse_rofl", lambda *_a: self.fail("re-parsed"))
        self.assertEqual(len(core.list_replays()["replays"]), 1)

    def test_changed_file_is_reparsed(self):
        p = self.rofl("NA1-1.rofl", 1000)
        core.list_replays()
        os.utime(p, (2000, 2000))
        calls = []
        real = core.parse_rofl
        self.patch(core, "parse_rofl", lambda x: calls.append(x) or real(x))
        core.list_replays()
        self.assertEqual(len(calls), 1)


class RiotGetTests(SandboxTest):
    def setUp(self):
        super().setUp()
        self.sleeps = []
        self.patch(time, "sleep", self.sleeps.append)

    def test_request_and_response(self):
        seen = {}
        def fake(req, timeout=None, context=None):
            seen.update(url=req.full_url, token=req.get_header("X-riot-token"), ua=req.get_header("User-agent"), timeout=timeout)
            return Resp('{"ok": 1}')
        self.patch(urllib.request, "urlopen", fake)
        self.assertEqual(core.riot_get("americas", "/lol/x", "KEY"), {"ok": 1})
        self.assertEqual((seen["url"], seen["token"], seen["timeout"]), ("https://americas.api.riotgames.com/lol/x", "KEY", 30))
        self.assertIn("LeagueReplayAnalyzer", seen["ua"])

    def test_http_errors_become_riot_errors(self):
        for code, text in ((401, "invalid"), (403, "expire"), (404, "not found"), (429, "Rate limited"), (500, "server body")):
            with self.subTest(code=code):
                def fake(req, **_k):
                    raise http_error(req.full_url, code, b"server body")
                self.patch(urllib.request, "urlopen", fake)
                with self.assertRaises(core.RiotError) as c:
                    core.riot_get("americas", "/x", "k")
                self.assertEqual(c.exception.status, code)
                self.assertIn(text.lower(), str(c.exception).lower())

    def test_network_failures_become_502(self):
        for err in (urllib.error.URLError("dns"), TimeoutError("slow"), ConnectionResetError("reset")):
            with self.subTest(err=type(err).__name__):
                def fake(*_a, **_k):
                    raise err
                self.patch(urllib.request, "urlopen", fake)
                with self.assertRaises(core.RiotError) as c:
                    core.riot_get("americas", "/x", "k")
                self.assertEqual(c.exception.status, 502)

    def test_oversized_response_becomes_502(self):
        self.patch(core, "MAX_API_RESPONSE", 10)
        self.patch(urllib.request, "urlopen", lambda *_a, **_k: Resp('{"padding": "' + "x" * 50 + '"}'))
        with self.assertRaises(core.RiotError) as c:
            core.riot_get("americas", "/x", "k")
        self.assertEqual(c.exception.status, 502)

    def test_bad_json_becomes_502(self):
        self.patch(urllib.request, "urlopen", lambda *_a, **_k: Resp("not json"))
        with self.assertRaises(core.RiotError) as c:
            core.riot_get("americas", "/x", "k")
        self.assertEqual(c.exception.status, 502)

    def test_cut_connection_becomes_502(self):
        self.patch(urllib.request, "urlopen", lambda *_a, **_k: Resp(read_error=http.client.IncompleteRead(b"{")))
        with self.assertRaises(core.RiotError) as c:
            core.riot_get("americas", "/x", "k")
        self.assertEqual(c.exception.status, 502)

    def sequence(self, *steps):
        calls = []
        def fake(req, **_k):
            step = steps[min(len(calls), len(steps) - 1)]
            calls.append(1)
            if isinstance(step, int):
                raise urllib.error.HTTPError(req.full_url, step, "e", {"Retry-After": "3"} if step == 429 else {}, io.BytesIO(b""))
            if isinstance(step, Exception):
                raise step
            return Resp(step)
        self.patch(urllib.request, "urlopen", fake)
        return calls

    def test_429_honours_retry_after(self):
        calls = self.sequence(429, '{"ok": 1}')
        self.assertEqual(core.riot_get("americas", "/x", "k"), {"ok": 1})
        self.assertEqual((len(calls), self.sleeps), (2, [3.0]))

    def test_server_errors_back_off_exponentially(self):
        calls = self.sequence(500, 503, 504, '{"ok": 1}')
        self.assertEqual(core.riot_get("americas", "/x", "k"), {"ok": 1})
        self.assertEqual((len(calls), self.sleeps), (4, [1.0, 2.0, 4.0]))

    def test_network_errors_are_retried(self):
        calls = self.sequence(urllib.error.URLError("dns"), '{"ok": 1}')
        self.assertEqual(core.riot_get("americas", "/x", "k"), {"ok": 1})
        self.assertEqual(len(calls), 2)

    def test_gives_up_after_limited_attempts(self):
        calls = self.sequence(503)
        with self.assertRaises(core.RiotError) as c:
            core.riot_get("americas", "/x", "k")
        self.assertEqual((c.exception.status, len(calls)), (503, core.RIOT_MAX_ATTEMPTS))

    def test_long_retry_after_is_not_waited_for(self):
        def fake(req, **_k):
            raise urllib.error.HTTPError(req.full_url, 429, "e", {"Retry-After": "900"}, io.BytesIO(b""))
        self.patch(urllib.request, "urlopen", fake)
        with self.assertRaises(core.RiotError) as c:
            core.riot_get("americas", "/x", "k")
        self.assertEqual((c.exception.status, self.sleeps), (429, []))

    def test_client_errors_are_not_retried(self):
        for code in (400, 401, 403, 404):
            with self.subTest(code=code):
                calls = self.sequence(code)
                with self.assertRaises(core.RiotError):
                    core.riot_get("americas", "/x", "k")
                self.assertEqual(len(calls), 1)

    def test_rate_limit_comes_from_riot_headers(self):
        class R(Resp):
            headers = {"X-App-Rate-Limit": "10:1,50:60"}
        self.patch(urllib.request, "urlopen", lambda *_a, **_k: R("{}"))
        core.riot_get("americas", "/x", "k")
        self.assertEqual(core.RIOT_LIMITER.windows, [(9, 1.0), (47, 60.0)])

    def test_limiter_spaces_out_calls(self):
        clock = [100.0]
        self.patch(time, "monotonic", lambda: clock[0])
        self.patch(time, "sleep", lambda s: clock.__setitem__(0, clock[0] + s))
        lim = core.RateLimiter([(2, 10.0)])
        for _ in range(3):
            self.assertTrue(lim.acquire(30))
        self.assertGreaterEqual(clock[0], 110.0)

    def test_limiter_refuses_a_long_wait(self):
        clock = [100.0]
        self.patch(time, "monotonic", lambda: clock[0])
        lim = core.RateLimiter([(1, 100.0)])
        self.assertTrue(lim.acquire(5))
        self.assertFalse(lim.acquire(5))

    def test_limiter_ignores_bad_headers(self):
        lim = core.RateLimiter([(5, 1.0)])
        for bad in (None, "", "garbage", "5:x"):
            lim.update(bad)
        self.assertEqual(lim.windows, [(5, 1.0)])


class GetMatchTests(SandboxTest):
    def setUp(self):
        super().setUp()
        self.game = fx.make_game()
        self.api_calls = []
        self.lcu_calls = []
        self.patch(core, "riot_get", self.fake_api)
        self.patch(core, "lcu_match", self.fake_lcu)
        self.api_error = None

    def fake_api(self, region, path, key):
        self.api_calls.append((region, path, key))
        if self.api_error:
            raise self.api_error
        return self.game["timeline"] if path.endswith("/timeline") else self.game["match"]

    def fake_lcu(self, mid):
        self.lcu_calls.append(mid)
        return self.valid("lcu", "from-client")

    def valid(self, source, marker="cached", **extra):
        g = json.loads(json.dumps(self.game))
        g.update(source=source, marker=marker, **extra)
        return g

    def cache(self, mid, source, marker="cached", **extra):
        (core.CACHE / f"{mid}.json").write_text(json.dumps(self.valid(source, marker, **extra)), "utf-8")

    def stored(self, mid):
        return json.loads((core.CACHE / f"{mid}.json").read_text("utf-8"))

    def test_api_success_is_cached(self):
        core.save_config({"apiKey": "k"})
        r = core.get_match("NA1_1")
        self.assertEqual(r["source"], "riot-api")
        self.assertEqual(self.api_calls[0][:2], ("americas", "/lol/match/v5/matches/NA1_1"))
        self.assertEqual(self.stored("NA1_1")["source"], "riot-api")

    def test_cached_api_game_makes_no_calls(self):
        core.save_config({"apiKey": "k"})
        self.cache("NA1_1", "riot-api")
        self.assertEqual(core.get_match("NA1_1")["marker"], "cached")
        self.assertEqual((self.api_calls, self.lcu_calls), ([], []))

    def test_routing_by_platform(self):
        core.save_config({"apiKey": "k"})
        for mid, region in (("EUW1_1", "europe"), ("KR_1", "asia"), ("OC1_1", "sea"), ("BR1_1", "americas")):
            with self.subTest(mid=mid):
                core.get_match(mid)
                self.assertEqual(self.api_calls[-1][0], region)

    def test_unknown_platform(self):
        with self.assertRaises(core.RiotError) as c:
            core.get_match("XX9_1")
        self.assertEqual(c.exception.status, 400)

    def test_no_key_uses_client(self):
        r = core.get_match("NA1_1")
        self.assertEqual(r["source"], "lcu")
        self.assertEqual(self.api_calls, [])
        self.assertIs(self.stored("NA1_1")["apiMissing"], False)

    def test_client_game_upgraded_when_key_exists(self):
        core.save_config({"apiKey": "k"})
        self.cache("NA1_1", "lcu")
        self.assertEqual(core.get_match("NA1_1")["source"], "riot-api")

    def test_api_missing_game_not_retried(self):
        core.save_config({"apiKey": "k"})
        self.cache("NA1_1", "lcu", apiMissing=True)
        core.get_match("NA1_1")
        self.assertEqual(self.api_calls, [])

    def test_fresh_404_is_checked_again_later(self):
        core.save_config({"apiKey": "k"})
        self.game["match"]["info"]["gameCreation"] = int(time.time() * 1000) - 60000
        self.api_error = core.RiotError(404, "not published yet")
        core.get_match("NA1_1")
        saved = self.stored("NA1_1")
        self.assertIs(saved["apiMissing"], False)
        self.assertGreater(saved["apiRetryAt"], time.time())
        n = len(self.api_calls)
        core.get_match("NA1_1")
        self.assertEqual(len(self.api_calls), n)
        saved["apiRetryAt"] = time.time() - 1
        (core.CACHE / "NA1_1.json").write_text(json.dumps(saved), "utf-8")
        self.api_error = None
        self.assertEqual(core.get_match("NA1_1")["source"], "riot-api")

    def test_old_game_404_is_final(self):
        core.save_config({"apiKey": "k"})
        self.game["match"]["info"]["gameCreation"] = int((time.time() - 3 * 86400) * 1000)
        self.api_error = core.RiotError(404, "custom game")
        core.get_match("NA1_1")
        self.assertIs(self.stored("NA1_1")["apiMissing"], True)

    def test_404_on_cached_client_game_sets_missing(self):
        core.save_config({"apiKey": "k"})
        self.cache("NA1_1", "lcu")
        self.api_error = core.RiotError(404, "x")
        core.get_match("NA1_1")
        self.assertTrue(self.stored("NA1_1")["apiMissing"])

    def test_rejected_key_is_remembered(self):
        core.save_config({"apiKey": "k"})
        self.api_error = core.RiotError(403, "expired")
        core.get_match("NA1_1")
        self.assertIn("k", core.rejected_keys)
        n = len(self.api_calls)
        core.get_match("NA1_2")
        self.assertEqual(len(self.api_calls), n)

    def test_firewall_block_does_not_reject_the_key(self):
        core.save_config({"apiKey": "k"})
        self.patch(core, "riot_get", real_riot_get)
        calls = []
        def blocked(req, **_k):
            calls.append(1)
            raise http_error(req.full_url, 403, b"error code: 1010")
        self.patch(urllib.request, "urlopen", blocked)
        core.get_match("NA1_1")
        self.assertNotIn("k", core.rejected_keys)
        self.assertEqual(len(calls), 1)

    def test_401_also_rejects_key(self):
        core.save_config({"apiKey": "k"})
        self.api_error = core.RiotError(401, "bad")
        core.get_match("NA1_1")
        self.assertIn("k", core.rejected_keys)

    def test_server_error_does_not_reject_key(self):
        core.save_config({"apiKey": "k"})
        self.api_error = core.RiotError(500, "down")
        core.get_match("NA1_1")
        self.assertNotIn("k", core.rejected_keys)

    def test_refresh_redownloads(self):
        core.save_config({"apiKey": "k"})
        self.cache("NA1_1", "riot-api")
        self.assertNotIn("marker", core.get_match("NA1_1", refresh=True))

    def test_refresh_failure_keeps_riot_data(self):
        core.save_config({"apiKey": "k"})
        self.cache("NA1_1", "riot-api")
        self.api_error = core.RiotError(500, "down")
        self.assertEqual(core.get_match("NA1_1", refresh=True)["marker"], "cached")
        self.assertEqual(self.lcu_calls, [])

    def test_refresh_of_client_game_uses_client(self):
        self.cache("NA1_1", "lcu")
        self.assertEqual(core.get_match("NA1_1", refresh=True)["marker"], "from-client")

    def test_refresh_client_failure_returns_cached(self):
        self.cache("NA1_1", "lcu")
        self.patch(core, "lcu_match", lambda _m: (_ for _ in ()).throw(core.RiotError(503, "closed")))
        self.assertEqual(core.get_match("NA1_1", refresh=True)["marker"], "cached")

    def test_damaged_cache_redownloaded(self):
        (core.CACHE / "NA1_1.json").write_text('{"source": "lcu"', "utf-8")
        self.assertEqual(core.get_match("NA1_1")["source"], "lcu")
        self.assertEqual(self.stored("NA1_1")["source"], "lcu")

    def test_no_sources_raises_503(self):
        self.patch(core, "lcu_match", lambda _m: (_ for _ in ()).throw(core.RiotError(503, "closed")))
        with self.assertRaises(core.RiotError) as c:
            core.get_match("NA1_1")
        self.assertEqual(c.exception.status, 503)
        self.assertIn("No Riot API key", str(c.exception))
        self.assertIn("League client", str(c.exception))

    def test_rejected_key_message(self):
        core.save_config({"apiKey": "k"})
        core.rejected_keys.add("k")
        self.patch(core, "lcu_match", lambda _m: (_ for _ in ()).throw(core.RiotError(503, "closed")))
        with self.assertRaisesRegex(core.RiotError, "rejected"):
            core.get_match("NA1_1")

    def test_malformed_200_is_never_cached(self):
        core.save_config({"apiKey": "k"})
        for bad in ({"status": {"message": "odd"}}, {"info": {}}, {"info": {"participants": []}}, {"info": {"participants": [1]}}, [], None):
            with self.subTest(bad=bad):
                self.patch(core, "riot_get", lambda *_a: bad)
                self.assertEqual(core.get_match("NA1_1", refresh=True)["source"], "lcu")
                self.assertEqual(self.stored("NA1_1")["source"], "lcu")

    def test_malformed_timeline_is_never_cached(self):
        core.save_config({"apiKey": "k"})
        self.patch(core, "riot_get", lambda _r, path, _k: {"info": {"frames": []}} if path.endswith("/timeline") else self.game["match"])
        self.assertEqual(core.get_match("NA1_1")["source"], "lcu")

    def test_cache_of_the_wrong_shape_is_replaced(self):
        for bad in ("[1, 2]", '{"source": "riot-api"}', '{"source": "lcu", "match": {}, "timeline": {}}', "null"):
            with self.subTest(bad=bad):
                (core.CACHE / "NA1_1.json").write_text(bad, "utf-8")
                self.assertEqual(core.get_match("NA1_1")["marker"], "from-client")

    def test_match_is_kept_when_the_timeline_fails(self):
        core.save_config({"apiKey": "k"})
        paths, fail = [], [True]
        def half(_r, path, _k):
            paths.append(path)
            if path.endswith("/timeline"):
                if fail[0]:
                    raise core.RiotError(500, "x")
                return self.game["timeline"]
            return self.game["match"]
        self.patch(core, "riot_get", half)
        core.get_match("NA1_1")
        fail[0] = False
        (core.CACHE / "NA1_1.json").unlink()
        self.assertEqual(core.get_match("NA1_1")["source"], "riot-api")
        self.assertEqual(paths.count("/lol/match/v5/matches/NA1_1"), 1)
        self.assertEqual(list(core.CACHE.glob("*.part.json")), [])

    def test_refresh_ignores_a_saved_partial(self):
        core.save_config({"apiKey": "k"})
        (core.CACHE / "NA1_1.part.json").write_text(json.dumps(self.game["match"]), "utf-8")
        core.get_match("NA1_1", refresh=True)
        self.assertEqual([p for _r, p, _k in self.api_calls].count("/lol/match/v5/matches/NA1_1"), 1)

    def test_damaged_partial_is_ignored(self):
        core.save_config({"apiKey": "k"})
        (core.CACHE / "NA1_1.part.json").write_text("{bad", "utf-8")
        self.assertEqual(core.get_match("NA1_1")["source"], "riot-api")

    def test_simultaneous_opens_download_once(self):
        core.save_config({"apiKey": "k"})
        barrier = threading.Barrier(4)
        real = self.fake_api
        def slow(*a):
            time.sleep(0.02)
            return real(*a)
        self.patch(core, "riot_get", slow)
        def worker():
            barrier.wait()
            core.get_match("NA1_1")
        threads = [threading.Thread(target=worker) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(self.api_calls), 2)


class LockfileTests(SandboxTest):
    def lockfile(self, text="LeagueClient:1234:50000:secret:https"):
        p = self.tmp / "lockfile"
        p.write_text(text, "utf-8")
        return p

    def test_config_dir_is_checked_first(self):
        self.patch(core, "find_lockfile", REAL_FIND_LOCKFILE)
        self.lockfile()
        core.save_config({"leagueDir": str(self.tmp)})
        self.patch(core, "_lockfile_live", lambda _p: True)
        self.assertEqual(core.find_lockfile(), self.tmp / "lockfile")

    def test_none_when_no_live_lockfile(self):
        self.patch(core, "find_lockfile", REAL_FIND_LOCKFILE)
        self.patch(core, "_lockfile_live", lambda _p: False)
        self.assertIsNone(core.find_lockfile())

    def test_probe_errors_are_skipped(self):
        self.patch(core, "find_lockfile", REAL_FIND_LOCKFILE)
        self.patch(Path, "exists", lambda _p: (_ for _ in ()).throw(OSError("drive not ready")))
        self.assertIsNone(core.find_lockfile())

    def test_lockfile_live_rules(self):
        lf = self.lockfile()
        for image, want in ((r"C:\Riot\LeagueClient.exe", True), (r"C:\Riot\LeagueClientUx.exe", True), ("", True), (r"C:\x\notepad.exe", False), (None, False)):
            with self.subTest(image=image):
                self.patch(core, "_pid_image", lambda _pid: image)
                self.assertEqual(core._lockfile_live(lf), want)

    def test_lockfile_live_bad_files(self):
        for text in ("", "only", "x:notapid:1:2"):
            with self.subTest(text=text):
                self.assertFalse(core._lockfile_live(self.lockfile(text)))
        self.assertFalse(core._lockfile_live(self.tmp / "missing"))

    def test_pid_image_of_this_process(self):
        self.assertTrue(core._pid_image(os.getpid()).lower().endswith(".exe"))

    def test_pid_image_of_missing_process(self):
        self.assertIsNone(core._pid_image(999999))

    def test_process_name(self):
        self.patch(core, "_pid_image", lambda _p: r"C:\Games\League of Legends.exe")
        self.assertEqual(core.process_name(1), "League of Legends.exe")
        self.patch(core, "_pid_image", lambda _p: None)
        self.assertIsNone(core.process_name(1))


class LcuRequestTests(SandboxTest):
    def setUp(self):
        super().setUp()
        lf = self.tmp / "lockfile"
        lf.write_text("LeagueClient:1234:50000:secret:https", "utf-8")
        self.patch(core, "find_lockfile", lambda: lf)

    def test_not_running(self):
        self.patch(core, "find_lockfile", lambda: None)
        with self.assertRaises(core.RiotError) as c:
            core.lcu_get("/x")
        self.assertEqual(c.exception.status, 503)

    def test_get_uses_port_and_auth(self):
        seen = {}
        def fake(req, timeout=None, context=None):
            seen.update(url=req.full_url, auth=req.get_header("Authorization"), method=req.get_method(), timeout=timeout)
            return Resp('{"a": 1}')
        self.patch(urllib.request, "urlopen", fake)
        self.assertEqual(core.lcu_get("/x", timeout=7), {"a": 1})
        self.assertEqual((seen["url"], seen["method"], seen["timeout"]), ("https://127.0.0.1:50000/x", "GET", 7))
        self.assertEqual(seen["auth"], "Basic " + base64.b64encode(b"riot:secret").decode())

    def test_post_sends_json(self):
        seen = {}
        def fake(req, **_k):
            seen.update(body=req.data, ctype=req.get_header("Content-type"), method=req.get_method())
            return Resp("")
        self.patch(urllib.request, "urlopen", fake)
        self.assertIsNone(core.lcu_request("/x", "POST", {"a": 1}))
        self.assertEqual((seen["body"], seen["ctype"], seen["method"]), (b'{"a": 1}', "application/json", "POST"))

    def test_http_error_uses_client_message(self):
        def fake(req, **_k):
            raise http_error(req.full_url, 404, b'{"message": "no such game"}')
        self.patch(urllib.request, "urlopen", fake)
        with self.assertRaisesRegex(core.RiotError, "no such game") as c:
            core.lcu_get("/x")
        self.assertEqual(c.exception.status, 404)

    def test_http_error_with_plain_body(self):
        def fake(req, **_k):
            raise http_error(req.full_url, 500, b"plain")
        self.patch(urllib.request, "urlopen", fake)
        with self.assertRaisesRegex(core.RiotError, "plain"):
            core.lcu_get("/x")

    def test_connection_failures_become_503(self):
        for err in (urllib.error.URLError("refused"), ConnectionResetError("x"), TimeoutError("slow")):
            with self.subTest(err=type(err).__name__):
                def fake(*_a, **_k):
                    raise err
                self.patch(urllib.request, "urlopen", fake)
                with self.assertRaises(core.RiotError) as c:
                    core.lcu_get("/x")
                self.assertEqual(c.exception.status, 503)

    def test_lockfile_race_is_a_client_error(self):
        self.patch(core, "find_lockfile", lambda: self.tmp / "gone")
        with self.assertRaises(core.RiotError) as c:
            core.lcu_get("/x")
        self.assertEqual(c.exception.status, 503)

    def test_partial_lockfile_is_a_client_error(self):
        p = self.tmp / "partial"
        p.write_text("LeagueClient:1", "utf-8")
        self.patch(core, "find_lockfile", lambda: p)
        with self.assertRaises(core.RiotError) as c:
            core.lcu_get("/x")
        self.assertEqual(c.exception.status, 503)

    def test_cut_or_malformed_client_response_is_a_client_error(self):
        for resp in (Resp(read_error=http.client.IncompleteRead(b"{")), Resp("not json")):
            with self.subTest(resp=resp.body):
                self.patch(urllib.request, "urlopen", lambda *_a, **_k: resp)
                with self.assertRaises(core.RiotError) as c:
                    core.lcu_get("/x")
                self.assertEqual(c.exception.status, 503)


class ChampionDataTests(SandboxTest):
    DATA = {"data": {c["id"]: c for c in fx.CHAMPION_TABLE}}

    def net(self, version="16.23.1"):
        def fake(url, timeout=None):
            if "versions.json" in url:
                return Resp(json.dumps([version, "16.22.1"]))
            if "champion.json" in url:
                return Resp(json.dumps(self.DATA))
            raise urllib.error.URLError("x")
        self.patch(urllib.request, "urlopen", fake)

    def test_download_and_cache(self):
        self.net()
        self.assertEqual(len(core.champion_table()), 10)
        self.assertTrue((core.CACHE / "champdata_16.23.1.json").exists())

    def test_table_is_memoized(self):
        self.net()
        first = core.champion_table()
        self.patch(urllib.request, "urlopen", lambda *_a, **_k: self.fail("network"))
        self.assertIs(core.champion_table(), first)

    def test_reads_version_cache(self):
        core._dd_version = "1.1.1"
        (core.CACHE / "champdata_1.1.1.json").write_text(json.dumps(fx.CHAMPION_TABLE), "utf-8")
        self.assertEqual(len(core.champion_table()), 10)

    def test_offline_uses_newest_table(self):
        core._dd_version = "9.9.9"
        (core.CACHE / "champdata_1.json").write_text(json.dumps(fx.CHAMPION_TABLE[:2]), "utf-8")
        self.assertEqual(len(core.champion_table()), 2)
        self.assertIsNone(core._champ_table)

    def test_offline_skips_wrong_shape_older_table(self):
        core._dd_version = "9.9.9"
        (core.CACHE / "champdata_1.json").write_text('[{"oops": 1}]', "utf-8")
        self.assertEqual(core.champion_table(), [])

    def test_offline_skips_corrupt_older_table(self):
        core._dd_version = "9.9.9"
        (core.CACHE / "champdata_1.json").write_text("{bad", "utf-8")
        self.assertEqual(core.champion_table(), [])

    def test_offline_with_nothing_is_empty(self):
        core._dd_version = "9.9.9"
        self.assertEqual(core.champion_table(), [])

    def test_corrupt_current_table_is_downloaded_again(self):
        self.net("9.9.9")
        (core.CACHE / "champdata_9.9.9.json").write_text("{bad", "utf-8")
        self.assertEqual(len(core.champion_table()), 10)
        self.assertEqual(len(json.loads((core.CACHE / "champdata_9.9.9.json").read_text("utf-8"))), 10)

    def test_table_of_the_wrong_shape_is_ignored(self):
        core._dd_version = "9.9.9"
        (core.CACHE / "champdata_9.9.9.json").write_text('{"a": 1}', "utf-8")
        self.assertEqual(core.champion_table(), [])

    def test_champion_names_maps_numeric_key_to_internal_id(self):
        core._champ_table = fx.CHAMPION_TABLE
        self.assertEqual(core.champion_names()["62"], "MonkeyKing")

    def test_champion_id_from_name(self):
        core._champ_table = fx.CHAMPION_TABLE
        for given, want in (("Wukong", "MonkeyKing"), ("MonkeyKing", "MonkeyKing"), ("Kai'Sa", "Kaisa"), ("kaisa", "Kaisa"), ("LeBlanc", "Leblanc"), ("New Champ", "New Champ"), ("", ""), (None, None)):
            with self.subTest(given=given):
                self.assertEqual(core.champion_id_from_name(given), want)

    def test_ddragon_version_latest(self):
        self.net("16.24.1")
        self.assertEqual(core.ddragon_version(), "16.24.1")
        self.assertEqual((core.CACHE / "ddragon_version.txt").read_text(), "16.24.1")

    def test_ddragon_version_from_file_when_offline(self):
        (core.CACHE / "ddragon_version.txt").write_text("16.20.1")
        self.assertEqual(core.ddragon_version(), "16.20.1")

    def test_offline_start_recovers_when_back_online(self):
        self.assertEqual(core.ddragon_version(), "15.1.1")
        self.net("16.24.1")
        self.assertEqual(core.ddragon_version(), "15.1.1")   # not re-checked on every request
        core._dd_retry_at = time.time() - 1
        self.assertEqual(core.ddragon_version(), "16.24.1")
        self.assertEqual(core._dd_retry_at, 0)

    def test_unexpected_version_list_is_ignored(self):
        self.patch(urllib.request, "urlopen", lambda *_a, **_k: Resp("[1, 2]"))
        self.assertEqual(core.ddragon_version(), "15.1.1")


PNG = b"\x89PNG\r\n\x1a\n" + b"pixels" + b"IEND\xaeB`\x82"


class AssetTests(SandboxTest):
    def setUp(self):
        super().setUp()
        core._dd_version = "16.23.1"
        self.urls = []

    def net(self, ok=lambda _u: True):
        def fake(url, timeout=None):
            self.urls.append(url)
            if ok(url):
                return Resp(PNG)
            raise urllib.error.URLError("x")
        self.patch(urllib.request, "urlopen", fake)

    def test_oversized_image_is_refused(self):
        self.patch(core, "MAX_ASSET_BYTES", 5)
        self.net()
        self.assertIsNone(core.get_asset("champ", "Ahri"))

    def test_truncated_download_is_not_saved(self):
        self.patch(urllib.request, "urlopen", lambda *_a, **_k: Resp(PNG[:12]))
        self.assertIsNone(core.get_asset("champ", "Ahri"))
        self.assertFalse((core.CACHE / "assets" / "champ_Ahri.png").exists())

    def test_truncated_cached_image_is_replaced(self):
        self.net()
        (core.CACHE / "assets").mkdir()
        (core.CACHE / "assets" / "champ_Ahri.png").write_bytes(PNG[:12])
        self.assertEqual(core.get_asset("champ", "Ahri"), PNG)
        self.assertEqual((core.CACHE / "assets" / "champ_Ahri.png").read_bytes(), PNG)

    def test_champion_download_and_cache(self):
        self.net()
        self.assertEqual(core.get_asset("champ", "Ahri"), PNG)
        self.assertTrue((core.CACHE / "assets" / "champ_Ahri.png").exists())
        core.get_asset("champ", "Ahri")
        self.assertEqual(len(self.urls), 1)

    def test_champion_name_is_sanitized(self):
        self.net()
        core.get_asset("champ", "../../Ah ri")
        self.assertTrue(self.urls[0].endswith("/img/champion/Ahri.png"))

    def test_fiddlesticks_id_fix(self):
        self.net()
        core.get_asset("champ", "FiddleSticks")
        self.assertTrue(self.urls[0].endswith("/Fiddlesticks.png"))

    def test_map_falls_back_to_old_cdn(self):
        self.net(lambda u: "6.8.1" in u)
        self.assertEqual(core.get_asset("map", "map11"), PNG)
        self.assertEqual(len(self.urls), 2)

    def test_all_sources_fail(self):
        self.net(lambda _u: False)
        self.assertIsNone(core.get_asset("champ", "Ahri"))

    def test_unknown_kind(self):
        self.assertIsNone(core.get_asset("../secret", "x"))


class LcuMatchTests(SandboxTest):
    def setUp(self):
        super().setUp()
        core._champ_table = fx.CHAMPION_TABLE
        self.game = fx.make_game()
        self.wire, self.tl = fx.to_lcu_wire(self.game)
        self.patch(core, "lcu_get", self.fake)

    def fake(self, path, timeout=30):
        return self.tl if "game-timelines" in path else self.wire

    def test_builds_match_v5_shape(self):
        r = core.lcu_match("NA1_5000000001")
        info = r["match"]["info"]
        self.assertEqual(r["source"], "lcu")
        self.assertEqual((info["mapId"], info["queueId"], len(info["participants"])), (11, 420, 10))
        self.assertEqual(r["timeline"]["info"]["frameInterval"], 60000)
        self.assertEqual([t["win"] for t in info["teams"]], [True, False])

    def test_champion_comes_from_numeric_id(self):
        self.assertEqual(core.lcu_match("NA1_5000000001")["match"]["info"]["participants"][0]["championName"], "MonkeyKing")

    def test_unknown_champion_id_is_kept(self):
        self.wire["participants"][0]["championId"] = 9999
        self.assertEqual(core.lcu_match("NA1_5000000001")["match"]["info"]["participants"][0]["championName"], "9999")

    def test_replay_metadata_overrides(self):
        (core.DEFAULT_REPLAY_DIR / "NA1-5000000001.rofl").write_bytes(fx.make_rofl(self.game))
        self.wire["participants"][0]["timeline"]["lane"] = "NONE"
        self.assertEqual(core.lcu_match("NA1_5000000001")["match"]["info"]["participants"][0]["teamPosition"], "TOP")

    def test_role_inference_without_replay(self):
        roles = [p["teamPosition"] for p in core.lcu_match("NA1_5000000001")["match"]["info"]["participants"]]
        self.assertEqual(roles[:5], ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"])

    def test_unknown_lane_gets_no_role(self):
        self.wire["participants"][0]["timeline"]["lane"] = "NONE"
        self.assertEqual(core.lcu_match("NA1_5000000001")["match"]["info"]["participants"][0]["teamPosition"], "")

    def test_empty_timeline_is_rejected(self):
        for wire, tl in (({}, self.tl), (self.wire, {"frames": []}), (None, None)):
            with self.subTest(wire=bool(wire)):
                self.patch(core, "lcu_get", lambda p, timeout=30: tl if "timelines" in p else wire)
                with self.assertRaises(core.RiotError) as c:
                    core.lcu_match("NA1_1")
                self.assertEqual(c.exception.status, 404)

    def test_missing_participant_id_raises(self):
        del self.wire["participants"][0]["participantId"]
        with self.assertRaises(KeyError):
            core.lcu_match("NA1_1")

    def test_replay_meta_for(self):
        self.assertIsNone(core.replay_meta_for("NA1_5"))
        (core.DEFAULT_REPLAY_DIR / "NA1-5.rofl").write_bytes(b"bad")
        self.assertIsNone(core.replay_meta_for("NA1_5"))
        (core.DEFAULT_REPLAY_DIR / "NA1-5.rofl").write_bytes(fx.make_rofl(self.game))
        self.assertEqual(len(core.replay_meta_for("NA1_5")["players"]), 10)

    def test_lcu_platform(self):
        self.patch(core, "lcu_get", lambda *_a, **_k: "euw1")
        self.assertEqual(core.lcu_platform(), "EUW1")

    def test_lcu_platform_from_replays_then_default(self):
        self.patch(core, "lcu_get", lambda *_a, **_k: (_ for _ in ()).throw(core.RiotError(503, "x")))
        self.assertEqual(core.lcu_platform(), "NA1")
        (core.DEFAULT_REPLAY_DIR / "KR-1.rofl").write_bytes(fx.make_rofl())
        self.assertEqual(core.lcu_platform(), "KR")


class GameConfigTests(SandboxTest):
    def cfg(self, data):
        p = self.tmp / "Config" / "game.cfg"
        p.parent.mkdir(exist_ok=True)
        p.write_bytes(data)
        self.patch(core, "game_cfg_path", lambda: p)
        return p

    def test_path_from_config_dir(self):
        core.save_config({"leagueDir": str(self.tmp)})
        self.assertEqual(core.game_cfg_path(), self.tmp / "Config" / "game.cfg")

    def test_path_from_lockfile(self):
        self.patch(core, "find_lockfile", lambda: self.tmp / "lockfile")
        self.assertEqual(core.game_cfg_path(), self.tmp / "Config" / "game.cfg")

    def test_path_from_install_dirs_or_none(self):
        self.assertIsNone(core.game_cfg_path())
        self.patch(core, "league_install_dirs", lambda: [self.tmp])
        self.assertEqual(core.game_cfg_path(), self.tmp / "Config" / "game.cfg")

    def test_enabled_detection(self):
        for data, want in ((b"[General]\nEnableReplayApi=1\n", True), (b"enablereplayapi = 1\n", True), (b"EnableReplayApi=0\n", False), (b"", False)):
            with self.subTest(data=data):
                self.cfg(data)
                self.assertEqual(core.replay_api_enabled(), want)

    def test_enabled_without_file(self):
        self.patch(core, "game_cfg_path", lambda: self.tmp / "none.cfg")
        self.assertFalse(core.replay_api_enabled())
        self.patch(core, "game_cfg_path", lambda: None)
        self.assertFalse(core.replay_api_enabled())

    def test_enable_adds_under_general(self):
        p = self.cfg(b"[General]\nWindowMode=2\n")
        core.enable_replay_api()
        self.assertTrue(core.replay_api_enabled())
        self.assertIn("EnableReplayApi=1", p.read_text("utf-8").split("[General]")[1])

    def test_enable_replaces_existing_value(self):
        p = self.cfg(b"[General]\nEnableReplayApi=0\nX=1\n")
        core.enable_replay_api()
        txt = p.read_text("utf-8")
        self.assertEqual(txt.count("EnableReplayApi"), 1)
        self.assertIn("EnableReplayApi=1", txt)

    def test_enable_without_general_section(self):
        p = self.cfg(b"[Other]\nX=1\n")
        core.enable_replay_api()
        self.assertTrue(p.read_text("utf-8").startswith("[General]"))

    def test_backup_keeps_first_original(self):
        p = self.cfg(b"[General]\nA=1\n")
        core.enable_replay_api()
        p.write_bytes(b"[General]\nA=2\n")
        core.enable_replay_api()
        self.assertIn("A=1", p.with_name("game.cfg.lra-backup").read_text("utf-8"))

    def test_non_utf8_bytes_survive(self):
        p = self.cfg(b"[General]\nName=caf\xe9\n")
        core.enable_replay_api()
        self.assertIn(b"caf\xe9", p.read_bytes())

    def test_missing_file_raises(self):
        self.patch(core, "game_cfg_path", lambda: None)
        with self.assertRaises(core.RiotError):
            core.enable_replay_api()

    def test_edit_preserves_every_other_byte(self):
        cases = {b"[General]\n\nWindowMode=2\n": b"[General]\nEnableReplayApi=1\n\nWindowMode=2\n",
                 b"[General]\r\n\r\nWindowMode=2\r\n": b"[General]\r\nEnableReplayApi=1\r\n\r\nWindowMode=2\r\n",
                 b"[A]\r\nX=1\r\n[General]\r\nY=2": b"[A]\r\nX=1\r\n[General]\r\nEnableReplayApi=1\r\nY=2",
                 b"[General]\r\nEnableReplayApi=0\r\nX=1\r\n": b"[General]\r\nEnableReplayApi=1\r\nX=1\r\n",
                 b"[General]": b"[General]\nEnableReplayApi=1\n", b"[Other]\r\nX=1\r\n": b"[General]\r\nEnableReplayApi=1\r\n[Other]\r\nX=1\r\n"}
        for before, after in cases.items():
            with self.subTest(before=before):
                p = self.cfg(before)
                p.with_name("game.cfg.lra-backup").unlink(missing_ok=True)
                core.enable_replay_api()
                self.assertEqual(p.read_bytes(), after)
                self.assertEqual(p.with_name("game.cfg.lra-backup").read_bytes(), before)

    def test_failed_write_leaves_game_cfg_untouched(self):
        p = self.cfg(b"[General]\nA=1\n")
        self.patch(os, "replace", lambda *_a: (_ for _ in ()).throw(OSError("disk")))
        with self.assertRaises(OSError):
            core.enable_replay_api()
        self.assertEqual(p.read_bytes(), b"[General]\nA=1\n")


class PatchAndClientTests(SandboxTest):
    def test_patch_of(self):
        for given, want in (("16.22.834.8910", "16.22"), ("15.1", "15.1"), ("16", None), ("", None), (None, None), ("abc", None)):
            with self.subTest(given=given):
                self.assertEqual(core.patch_of(given), want)

    def test_client_patch_is_cached(self):
        calls = []
        self.patch(core, "lcu_get", lambda *_a, **_k: calls.append(1) or "16.23.840.1")
        self.assertEqual(core.client_patch(), "16.23")
        self.assertEqual(core.client_patch(), "16.23")
        self.assertEqual(len(calls), 1)

    def test_client_patch_failure_is_cached_briefly(self):
        calls = []
        def fail(*_a, **_k):
            calls.append(1)
            raise core.RiotError(503, "x")
        self.patch(core, "lcu_get", fail)
        self.assertIsNone(core.client_patch())
        self.assertIsNone(core.client_patch())
        self.assertEqual(len(calls), 1)

    def test_installed_patch_without_install(self):
        self.assertIsNone(core.installed_game_patch())

    def test_install_dirs_filter_to_real_installs(self):
        self.patch(core, "league_install_dirs", REAL_INSTALL_DIRS)
        d = self.tmp / "LoL"
        (d / "Game").mkdir(parents=True)
        (d / "Game" / "League of Legends.exe").write_bytes(b"x")
        core.save_config({"leagueDir": str(d)})
        self.assertIn(d, core.league_install_dirs())

    def test_client_replay_folder(self):
        self.patch(core, "lcu_get", lambda *_a, **_k: str(self.tmp))
        self.assertEqual(core.client_replay_folder(), self.tmp)
        self.patch(core, "lcu_get", lambda *_a, **_k: "")
        self.assertIsNone(core.client_replay_folder())
        self.patch(core, "lcu_get", lambda *_a, **_k: (_ for _ in ()).throw(core.RiotError(503, "x")))
        self.assertIsNone(core.client_replay_folder())

    def test_replay_file_for(self):
        self.assertIsNone(core.replay_file_for("NA1_1"))
        p = core.DEFAULT_REPLAY_DIR / "NA1-1.rofl"
        p.write_bytes(b"x")
        self.assertEqual(core.replay_file_for("NA1_1"), p)

    def test_ensure_existing_file_is_not_copied(self):
        self.patch(core, "client_replay_folder", lambda: core.DEFAULT_REPLAY_DIR)
        p = core.DEFAULT_REPLAY_DIR / "NA1-1.rofl"
        p.write_bytes(b"x")
        self.assertEqual(core.ensure_in_client_folder("NA1_1"), p)

    def test_ensure_copies_and_rescans(self):
        dest = self.tmp / "client"
        src = self.tmp / "anywhere.rofl"
        src.write_bytes(b"data")
        scans = []
        self.patch(core, "client_replay_folder", lambda: dest)
        self.patch(core, "lcu_request", lambda path, *_a, **_k: scans.append(path))
        self.assertEqual(core.ensure_in_client_folder("NA1_1", src).read_bytes(), b"data")
        self.assertEqual(scans, ["/lol-replays/v1/rofls/scan"])

    def test_ensure_survives_scan_failure(self):
        src = self.tmp / "a.rofl"
        src.write_bytes(b"x")
        self.patch(core, "client_replay_folder", lambda: self.tmp / "c")
        self.patch(core, "lcu_request", lambda *_a, **_k: (_ for _ in ()).throw(core.RiotError(503, "x")))
        self.assertTrue(core.ensure_in_client_folder("NA1_1", src).exists())

    def test_ensure_rejects_missing_or_wrong_file(self):
        self.patch(core, "client_replay_folder", lambda: self.tmp / "c")
        bad = self.tmp / "a.txt"
        bad.write_bytes(b"x")
        for src in (None, self.tmp / "none.rofl", bad):
            with self.subTest(src=src):
                with self.assertRaises(core.RiotError):
                    core.ensure_in_client_folder("NA1_1", src)

    def test_watch_replay(self):
        calls = []
        self.patch(core, "ensure_in_client_folder", lambda *a: calls.append(a))
        self.patch(core, "lcu_request", lambda path, method, body, timeout=0: calls.append((path, method, body)))
        core.watch_replay("NA1_55")
        self.assertEqual(calls[1], ("/lol-replays/v1/rofls/55/watch", "POST", {"componentType": "replay-button_match-history"}))

    def test_start_client_not_installed(self):
        self.patch(os, "environ", {**os.environ, "ProgramData": str(self.tmp)})
        with self.assertRaises(core.RiotError):
            core.start_league_client()

    def test_start_client_launches_detached(self):
        d = self.tmp / "Riot Games"
        d.mkdir()
        exe = self.tmp / "RiotClientServices.exe"
        exe.write_bytes(b"x")
        (d / "RiotClientInstalls.json").write_text(json.dumps({"rc_live": str(exe)}), "utf-8")
        self.patch(os, "environ", {**os.environ, "ProgramData": str(self.tmp)})
        seen = []
        def popen(args, **kw):
            seen.append((args, kw["creationflags"]))
            if len(seen) == 1:
                raise OSError("job does not allow breakaway")
        self.patch(subprocess, "Popen", popen)
        self.assertTrue(core.start_league_client())
        self.assertEqual(seen[0][0][1:], ["--launch-product=league_of_legends", "--launch-patchline=live"])
        self.assertEqual(seen[0][1] & 0x01000000, 0x01000000)
        self.assertEqual(seen[1][1] & 0x01000000, 0)


class FakeUser32:
    def __init__(self, hwnd=77, iconic=False, foreground=None):
        self.hwnd, self.iconic, self.fg = hwnd, iconic, foreground if foreground is not None else 1
        self.log = []

    def FindWindowW(self, _c, _t):
        return self.hwnd

    def GetForegroundWindow(self):
        return self.fg

    def IsIconic(self, _h):
        return self.iconic

    def ShowWindow(self, h, cmd):
        self.log.append(("show", cmd))

    def SetForegroundWindow(self, h):
        self.log.append(("fg", h))

    def keybd_event(self, *a):
        self.log.append(("key", a[2]))

    def SetWindowPos(self, h, after, *a):
        self.log.append(("pos", after, a[-1]))

    def GetClientRect(self, _h, r):
        r._obj.right, r._obj.bottom = 1920, 1080

    def GetWindowThreadProcessId(self, _h, pid):
        pid._obj.value = 4321


class WindowTests(SandboxTest):
    def use(self, **kw):
        u = FakeUser32(**kw)
        self.patch(core, "_user32", lambda: u)
        return u

    def test_no_user32(self):
        self.assertIsNone(core.find_window("x"))
        self.assertIsNone(core.league_window_pid())
        self.assertFalse(core.arrange_windows("front", "app"))

    def test_find_window_exact(self):
        self.use()
        self.assertEqual(core.find_window("title"), 77)
        self.use(hwnd=0)
        self.assertIsNone(core.find_window("title"))

    def test_real_user32_signatures_load(self):
        self.assertIsNotNone(REAL_USER32())

    def test_window_pid(self):
        self.use()
        self.assertEqual(core.league_window_pid(), 4321)
        self.use(hwnd=0)
        self.assertIsNone(core.league_window_pid())

    def test_window_info(self):
        self.use(iconic=True, foreground=77)
        self.assertEqual(core.league_window_info(), {"minimized": True, "w": 1920, "h": 1080, "foreground": True})
        self.use(hwnd=0)
        self.assertIsNone(core.league_window_info())

    def test_arrange_behind_restores_minimized_and_sends_to_bottom(self):
        u = self.use(iconic=True)
        self.assertTrue(core.arrange_windows("behind", "app"))
        self.assertIn(("show", 4), u.log)
        self.assertEqual([x for x in u.log if x[0] == "pos"], [("pos", 1, 0x13)])

    def test_arrange_front(self):
        u = self.use(iconic=True)
        self.assertTrue(core.arrange_windows("front", "app"))
        self.assertIn(("show", 9), u.log)
        self.assertEqual([x for x in u.log if x[0] != "show"], [("key", 0), ("fg", 77), ("key", 2)])

    def test_arrange_app_needs_app_window(self):
        self.use()
        self.patch(core, "find_window", lambda t, prefix=False: None)
        self.assertFalse(core.arrange_windows("app", "Replay Analyzer"))
        self.patch(core, "find_window", lambda t, prefix=False: 88 if prefix else None)
        self.assertTrue(core.arrange_windows("app", "Replay Analyzer"))

    def test_arrange_without_league_or_unknown_action(self):
        self.use(hwnd=0)
        self.assertFalse(core.arrange_windows("front", "app"))
        self.use()
        self.assertFalse(core.arrange_windows("nonsense", "app"))
