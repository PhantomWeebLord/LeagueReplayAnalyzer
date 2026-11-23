"""Characterization tests for lra_live, the live game recorder."""
import json
import threading
import time
import urllib.request

from tests import fixtures as fx
from tests.sandbox import SandboxTest, core
from tests.test_core import Resp

import lra_live as L


def raw_player(i, team="ORDER", **extra):
    p = {"riotId": f"P{i}#NA1", "riotIdGameName": f"P{i}", "riotIdTagLine": "NA1", "summonerName": f"P{i}", "championName": f"Champ{i}",
         "rawChampionName": f"game_character_displayname_Champ{i}", "team": team, "position": "JUNGLE", "level": 5,
         "scores": {"kills": 1, "deaths": 2, "assists": 3, "creepScore": 40, "wardScore": 7.25}, "items": [{"itemID": 3031, "count": 1}, {"itemID": 2003, "count": 2}],
         "isDead": False, "respawnTimer": 0.0}
    p.update(extra)
    return p


def lobby():
    return [raw_player(i, "ORDER" if i < 5 else "CHAOS") for i in range(10)]


def payload(t, active=True, events=(), players=None):
    ap = {"riotId": "P0#NA1", "riotIdGameName": "P0", "currentGold": 512.6, "championStats": {"currentHealth": 50.0, "maxHealth": 200.0}} if active else {"error": "spectator"}
    return {"gameData": {"gameTime": t, "gameMode": "CLASSIC", "mapNumber": 11}, "activePlayer": ap, "allPlayers": players or lobby(), "events": {"Events": list(events)}}


class NormPlayerTests(SandboxTest):
    def test_full_player(self):
        n = L.norm_player(raw_player(1, "CHAOS"))
        self.assertEqual((n["riotId"], n["name"], n["tag"], n["champion"], n["championId"], n["team"], n["isBot"]), ("P1#NA1", "P1", "NA1", "Champ1", "Champ1", 200, False))

    def test_old_summoner_name(self):
        n = L.norm_player({"summonerName": "Old#EUW", "championName": "Ahri", "team": "ORDER"})
        self.assertEqual((n["riotId"], n["name"], n["tag"], n["team"]), ("Old#EUW", "Old", "EUW", 100))

    def test_champion_id_from_display_name_when_raw_is_missing(self):
        core._champ_table = fx.CHAMPION_TABLE
        self.assertEqual(L.norm_player({"championName": "Wukong"})["championId"], "MonkeyKing")

    def test_empty_player(self):
        n = L.norm_player({})
        self.assertEqual((n["riotId"], n["name"], n["tag"], n["team"], n["position"]), ("", "", "", 200, ""))

    def test_bot_flag(self):
        self.assertTrue(L.norm_player({"isBot": True})["isBot"])


class SnapshotTests(SandboxTest):
    def players(self):
        return [L.norm_player(p) for p in lobby()]

    def test_row_layout(self):
        s = L.make_snapshot(payload(61.26), 61.26, self.players())
        self.assertEqual((s["t"], s["g"], s["hp"]), (61.3, 513, 0.25))
        self.assertEqual(s["p"][0], [5, 1, 2, 3, 40, 7.2, 0, 0.0, [[3031, 1], [2003, 2]]])

    def test_dead_player(self):
        pl = lobby()
        pl[1].update(isDead=True, respawnTimer=12.34)
        row = L.make_snapshot(payload(5, players=pl), 5, self.players())["p"][1]
        self.assertEqual((row[6], row[7]), (1, 12.3))

    def test_missing_player_gets_zero_row(self):
        row = L.make_snapshot(payload(5, players=lobby()[1:]), 5, self.players())["p"][0]
        self.assertEqual(row, [0, 0, 0, 0, 0, 0.0, 0, 0.0, []])

    def test_no_active_player(self):
        s = L.make_snapshot({"allPlayers": lobby()}, 1, self.players())
        self.assertEqual((s["g"], s["hp"]), (0, None))

    def test_zero_max_health(self):
        d = payload(1)
        d["activePlayer"]["championStats"]["maxHealth"] = 0
        self.assertIsNone(L.make_snapshot(d, 1, self.players())["hp"])

    def test_item_count_default(self):
        pl = lobby()
        pl[0]["items"] = [{"itemID": "3006"}]
        self.assertEqual(L.make_snapshot(payload(1, players=pl), 1, self.players())["p"][0][8], [[3006, 1]])

    def test_bad_item_id_raises(self):
        pl = lobby()
        pl[0]["items"] = [{"itemID": "x"}]
        with self.assertRaises(ValueError):
            L.make_snapshot(payload(1, players=pl), 1, self.players())


class MatchingTests(SandboxTest):
    def players(self):
        return [{"team": 100 if i < 5 else 200, "championId": f"C{i}"} for i in range(10)]

    def replay(self, gid, champs, mtime=1000):
        return {"gameId": str(gid), "platform": "NA1", "mtime": mtime, "players": [{"team": 100 if i < 5 else 200, "champion": c} for i, c in enumerate(champs)]}

    def use(self, *rows):
        self.patch(core, "list_replays", lambda: {"replays": list(rows)})

    def test_best_match(self):
        self.use(self.replay(1, [f"C{i}" for i in range(9)] + ["X"]), self.replay(2, [f"c{i}" for i in range(10)]))
        self.assertEqual(L.match_replay(self.players()), (2, "NA1"))

    def test_too_few_matching_champions(self):
        self.use(self.replay(1, ["C0", "C1", "X", "X", "X", "X", "X", "X", "X", "X"]))
        self.assertIsNone(L.match_replay(self.players()))

    def test_since_skips_older_replays(self):
        self.use(self.replay(1, [f"C{i}" for i in range(10)], mtime=100))
        self.assertIsNone(L.match_replay(self.players(), since=200))

    def history(self, gid, creation):
        names = {str(1000 + i): f"C{i}" for i in range(10)}
        self.patch(core, "champion_names", lambda: names)
        return {"gameId": gid, "gameCreation": creation, "participants": [{"teamId": 100 if i < 5 else 200, "championId": 1000 + i} for i in range(10)]}

    def test_history_match(self):
        g = self.history(77, 2_000_000)
        self.patch(core, "lcu_get", lambda *_a, **_k: {"games": {"games": [g]}})
        self.assertEqual(L.match_history(self.players()), 77)

    def test_history_skips_earlier_game(self):
        g = self.history(77, 100_000)
        self.patch(core, "lcu_get", lambda *_a, **_k: {"games": {"games": [g]}})
        self.assertIsNone(L.match_history(self.players(), since=10_000))

    def test_history_client_closed(self):
        self.patch(core, "lcu_get", lambda *_a, **_k: (_ for _ in ()).throw(core.RiotError(503, "x")))
        self.assertIsNone(L.match_history(self.players()))

    def test_history_empty(self):
        self.patch(core, "champion_names", lambda: {})
        self.patch(core, "lcu_get", lambda *_a, **_k: None)
        self.assertIsNone(L.match_history(self.players()))


class RecorderTests(SandboxTest):
    def setUp(self):
        super().setUp()
        self.resolved = []
        self.patch(L.LiveRecorder, "_resolve_ids", lambda _self, s: self.resolved.append(s))
        self.rec = L.LiveRecorder("https://127.0.0.1:1/")
        self.rec.stop = True

    def files(self):
        return list(core.LIVE_DIR.glob("*.json")) if core.LIVE_DIR.exists() else []

    def test_url_is_normalized(self):
        self.assertEqual(self.rec.live_url, "https://127.0.0.1:1")

    def test_http_get_post(self):
        seen = []
        def fake(req, timeout=None, context=None):
            seen.append((req.full_url, req.get_method(), req.data, timeout, context is not None))
            return Resp('{"ok": 1}' if len(seen) == 1 else "")
        self.patch(urllib.request, "urlopen", fake)
        self.assertEqual(self.rec.live_get("/a", timeout=2), {"ok": 1})
        self.assertIsNone(self.rec.live_post("/b", {"x": 1}))
        self.assertEqual(seen[0], ("https://127.0.0.1:1/a", "GET", None, 2, True))
        self.assertEqual(seen[1][:3], ("https://127.0.0.1:1/b", "POST", b'{"x": 1}'))

    def test_plain_http_url_has_no_tls_context(self):
        rec = L.LiveRecorder("http://127.0.0.1:1")
        seen = []
        self.patch(urllib.request, "urlopen", lambda req, timeout=None, context=None: seen.append(context) or Resp("{}"))
        rec.live_get("/a")
        self.assertIsNone(seen[0])

    def test_first_data_starts_session(self):
        self.rec._on_data(payload(30))
        s = self.rec.session
        self.assertEqual((self.rec.status, s["mode"], s["me"], len(s["snaps"]), s["gameMode"]), ("play", "play", 0, 1, "CLASSIC"))
        self.assertTrue(self.rec.busy())
        self.assertEqual(self.resolved, [s])

    def test_snapshots_every_two_seconds(self):
        for t in (10, 11, 12.5, 13):
            self.rec._on_data(payload(t))
        self.assertEqual([x["t"] for x in self.rec.session["snaps"]], [10, 12.5])

    def test_spectate_session_records_nothing(self):
        self.rec._on_data(payload(10, active=False))
        self.assertEqual((self.rec.status, self.rec.session["mode"], self.rec.session["snaps"]), ("spectate", "spectate", []))
        self.assertFalse(self.rec.busy())

    def test_blip_without_active_player_keeps_session(self):
        self.rec._on_data(payload(10))
        sid = self.rec.session
        self.rec._on_data(payload(12, active=False))
        self.assertIs(self.rec.session, sid)
        self.assertEqual(self.rec.status, "play")

    def test_game_end_saves(self):
        self.rec._on_data(payload(10))
        self.rec._on_data(payload(12, events=[{"EventName": "GameEnd", "Result": "Win"}]))
        s = self.rec.session
        self.assertEqual((s["ended"], s["result"]), (True, "Win"))
        saved = json.loads(self.files()[0].read_text("utf-8"))
        self.assertTrue(saved["ended"])
        self.assertNotIn("sig", saved)

    def test_periodic_flush(self):
        self.rec._on_data(payload(10))
        self.assertEqual(len(self.files()), 1)

    def test_failed_final_save_is_retried(self):
        self.rec._on_data(payload(10))
        calls = []
        def flaky(_s):
            calls.append(1)
            if len(calls) == 1:
                raise PermissionError("busy")
        self.rec._save = flaky
        self.rec._on_data(payload(12, events=[{"EventName": "GameEnd", "Result": "Win"}]))
        self.assertIn("busy", self.rec.last_error)
        self.rec._on_data(payload(14, events=[{"EventName": "GameEnd", "Result": "Win"}]))
        self.assertEqual(len(calls), 2)
        self.rec._on_data(payload(16, events=[{"EventName": "GameEnd", "Result": "Win"}]))
        self.assertEqual(len(calls), 2)

    def test_failed_save_is_retried_after_the_game_closes(self):
        self.rec._on_data(payload(10))
        calls = []
        def flaky(_s):
            calls.append(1)
            if len(calls) == 1:
                raise OSError("disk full")
        self.rec._save = flaky
        self.rec.session["lastSeen"] = time.time() - 10
        self.rec._on_no_game()
        self.rec._on_no_game()
        self.assertEqual(len(calls), 2)

    def test_no_game_after_timeout_ends_session(self):
        self.rec._on_data(payload(10))
        self.rec.session["lastSeen"] = time.time() - 10
        self.rec._on_no_game()
        self.assertEqual((self.rec.session["ended"], self.rec.session["endReason"], self.rec.status), (True, "game client closed", "idle"))

    def test_no_game_within_timeout_keeps_playing(self):
        self.rec._on_data(payload(10))
        self.rec._on_no_game()
        self.assertEqual((self.rec.session["ended"], self.rec.status), (False, "play"))

    def test_spectate_session_is_dropped(self):
        self.rec._on_data(payload(10, active=False))
        self.rec.session["lastSeen"] = time.time() - 10
        self.rec._on_no_game()
        self.assertIsNone(self.rec.session)
        self.assertEqual(self.rec.status, "idle")

    def test_no_game_without_session(self):
        self.rec.status = "play"
        self.rec._on_no_game()
        self.assertEqual(self.rec.status, "idle")

    def test_reconnect_resumes(self):
        self.rec._on_data(payload(100))
        s = self.rec.session
        s["lastSeen"] = time.time() - 10
        self.rec._on_no_game()
        self.rec._on_data(payload(130))
        self.assertIs(self.rec.session, s)
        self.assertFalse(s["ended"])
        self.assertNotIn("endReason", s)

    def test_same_lobby_new_game(self):
        self.rec._on_data(payload(100))
        s = self.rec.session
        s.update(ended=True, endReason="game client closed")
        self.rec._on_data(payload(5))
        self.assertIsNot(self.rec.session, s)

    def test_finished_game_is_not_resumed(self):
        self.rec._on_data(payload(100))
        self.rec._on_data(payload(102, events=[{"EventName": "GameEnd", "Result": "Loss"}]))
        s = self.rec.session
        self.rec._on_data(payload(104))
        self.assertIs(self.rec.session, s)
        self.assertEqual([x["t"] for x in s["snaps"]], [100, 102])

    def test_different_lobby_finalizes_previous(self):
        self.rec._on_data(payload(100))
        first = self.rec.session
        pl = lobby()
        pl[0]["championName"] = "Other"; pl[0]["rawChampionName"] = "game_character_displayname_Other"
        self.rec._on_data(payload(10, players=pl))
        self.assertIsNot(self.rec.session, first)
        self.assertEqual(first["endReason"], "new game detected")

    def test_finalize_without_snaps_saves_nothing(self):
        self.rec.session = {"mode": "play", "snaps": [], "ended": False}
        self.rec._finalize()
        self.assertFalse(self.rec.session["ended"])

    def test_identifies_me_by_game_name(self):
        d = payload(10)
        d["activePlayer"] = {"riotIdGameName": "P3", "championStats": {"currentHealth": 1, "maxHealth": 2}}
        self.rec._on_data(d)
        self.assertEqual(self.rec.session["me"], 3)

    def test_unknown_me(self):
        d = payload(10)
        d["activePlayer"] = {"riotIdGameName": "Nobody", "championStats": {"currentHealth": 1, "maxHealth": 2}}
        self.rec._on_data(d)
        self.assertIsNone(self.rec.session["me"])

    def test_loop_survives_errors(self):
        rec = L.LiveRecorder("https://127.0.0.1:1")
        rec.live_get = lambda *_a, **_k: payload(1)
        rec._on_data = lambda _d: (_ for _ in ()).throw(RuntimeError("boom"))
        def stop(_s):
            rec.stop = True
        self.patch(time, "sleep", stop)
        rec._loop()
        self.assertIn("boom", rec.last_error)

    def test_loop_without_game(self):
        rec = L.LiveRecorder("https://127.0.0.1:1")
        rec.live_get = lambda *_a, **_k: (_ for _ in ()).throw(OSError("no game"))
        calls = []
        rec._on_no_game = lambda: calls.append(1)
        def stop(_s):
            rec.stop = True
        self.patch(time, "sleep", stop)
        rec._loop()
        self.assertEqual(calls, [1])

    def test_start_returns_self_with_daemon_thread(self):
        rec = L.LiveRecorder("https://127.0.0.1:1")
        rec.stop = True
        self.assertIs(rec.start(), rec)
        self.assertTrue(all(t.daemon for t in threading.enumerate() if t.name == "live-recorder"))


class ResolveIdsTests(SandboxTest):
    def setUp(self):
        super().setUp()
        self.rec = L.LiveRecorder("https://127.0.0.1:1")
        self.sess = {"id": "2026-01-01_00-00-00", "mode": "play", "players": [], "startedAt": 100.0, "ended": False, "gameId": None, "platform": None, "matchId": None, "snaps": [], "events": []}
        self.rec.session = self.sess
        self.patch(L, "match_replay", lambda *_a: None)
        self.patch(L, "match_history", lambda *_a: None)
        self.patch(core, "lcu_platform", lambda: "NA1")

    def test_gameflow_session(self):
        self.patch(core, "lcu_get", lambda *_a, **_k: {"phase": "InProgress", "gameData": {"gameId": 55}})
        self.rec._resolve_ids(self.sess)
        self.assertEqual((self.sess["gameId"], self.sess["matchId"]), (55, "NA1_55"))
        self.assertTrue(list(core.LIVE_DIR.glob("*.json")))

    def test_matching_replay(self):
        self.patch(core, "lcu_get", lambda *_a, **_k: {})
        self.patch(L, "match_replay", lambda *_a: (66, "EUW1"))
        self.rec._resolve_ids(self.sess)
        self.assertEqual(self.sess["matchId"], "EUW1_66")

    def test_history_after_game_end(self):
        self.sess["ended"] = True
        self.patch(core, "lcu_get", lambda *_a, **_k: (_ for _ in ()).throw(core.RiotError(503, "x")))
        self.patch(L, "match_history", lambda *_a: 77)
        self.rec._resolve_ids(self.sess)
        self.assertEqual(self.sess["matchId"], "NA1_77")

    def test_replaced_spectate_session_stops(self):
        s = dict(self.sess, mode="spectate")
        self.rec._resolve_ids(s)
        self.assertIsNone(s["gameId"])

    def test_stops_with_recorder(self):
        self.rec.stop = True
        self.rec._resolve_ids(self.sess)
        self.assertIsNone(self.sess["gameId"])


class ClientStateTests(SandboxTest):
    def setUp(self):
        super().setUp()
        self.patch(L.LiveRecorder, "_resolve_ids", lambda *_a: None)
        self.rec = L.LiveRecorder("https://127.0.0.1:1")
        self.rec.stop = True
        core._champ_table = fx.CHAMPION_TABLE

    def test_phase_is_cached(self):
        calls = []
        self.patch(core, "lcu_get", lambda *_a, **_k: calls.append(1) or "Lobby")
        self.assertEqual((self.rec.phase(), self.rec.phase()), ("Lobby", "Lobby"))
        self.assertEqual(len(calls), 1)

    def test_phase_failure(self):
        self.patch(core, "lcu_get", lambda *_a, **_k: (_ for _ in ()).throw(core.RiotError(503, "x")))
        self.assertIsNone(self.rec.phase())

    def test_champ_select(self):
        self.patch(core, "lcu_get", lambda *_a, **_k: {"localPlayerCellId": 2, "myTeam": [{"cellId": 1, "championId": 7}, {"cellId": 2, "championId": 120, "assignedPosition": "jungle"}]})
        self.assertEqual(self.rec.champ_select(), {"championKey": 120, "champion": "Hecarim", "position": "JUNGLE", "locked": True})

    def test_champ_select_hover(self):
        self.patch(core, "lcu_get", lambda *_a, **_k: {"localPlayerCellId": 1, "myTeam": [{"cellId": 1, "championId": 0, "championPickIntent": 62}]})
        c = self.rec.champ_select()
        self.assertEqual((c["champion"], c["locked"]), ("MonkeyKing", False))

    def test_champ_select_no_pick(self):
        self.patch(core, "lcu_get", lambda *_a, **_k: {"localPlayerCellId": 1, "myTeam": [{"cellId": 1, "championId": 0}]})
        self.assertIsNone(self.rec.champ_select()["champion"])

    def test_champ_select_absent_or_failing(self):
        self.patch(core, "lcu_get", lambda *_a, **_k: {"localPlayerCellId": 5, "myTeam": []})
        self.assertIsNone(self.rec.champ_select())
        self.rec._cs = (0, None)
        self.patch(core, "lcu_get", lambda *_a, **_k: (_ for _ in ()).throw(core.RiotError(404, "x")))
        self.assertIsNone(self.rec.champ_select())

    def test_state_idle(self):
        self.patch(core, "lcu_get", lambda *_a, **_k: "None")
        self.assertEqual(self.rec.state(), {"status": "idle", "phase": "None"})

    def test_state_with_session(self):
        self.patch(core, "lcu_get", lambda *_a, **_k: "InProgress")
        self.rec._on_data(payload(10))
        st = self.rec.state()
        self.assertEqual((st["status"], st["session"]["snaps"], st["last"]["t"]), ("play", 1, 10))
        self.assertNotIn("sig", st["session"])

    def test_state_in_champ_select(self):
        self.patch(core, "lcu_get", lambda *_a, **_k: "ChampSelect")
        self.rec.champ_select = lambda: {"champion": "Ahri"}
        self.assertEqual(self.rec.state()["champSelect"], {"champion": "Ahri"})


class StoredSessionTests(SandboxTest):
    def setUp(self):
        super().setUp()
        self.rec = L.LiveRecorder("https://127.0.0.1:1")
        core.LIVE_DIR.mkdir()

    def store(self, sid, data):
        p = core.LIVE_DIR / f"{sid}.json"
        p.write_text(json.dumps(data) if not isinstance(data, str) else data, "utf-8")
        return p

    def test_empty(self):
        self.assertEqual(self.rec.sessions(), [])

    def test_summary(self):
        self.store("2026-01-02", {"id": "2026-01-02", "matchId": "NA1_5", "gameMode": "CLASSIC", "result": "Win", "ended": True, "startedAt": 9.0, "me": 0,
                                  "players": [{"championId": "Ahri"}], "snaps": [{"t": 1}, {"t": 1800.5}]})
        s = self.rec.sessions()[0]
        self.assertEqual((s["matchId"], s["snaps"], s["champion"], s["duration"], s["result"]), ("NA1_5", 2, "Ahri", 1800.5, "Win"))

    def test_newest_first(self):
        for n in ("2026-01-01", "2026-01-03", "2026-01-02"):
            self.store(n, {"id": n, "players": [], "snaps": []})
        self.assertEqual([x["id"] for x in self.rec.sessions()], ["2026-01-03", "2026-01-02", "2026-01-01"])

    def test_corrupt_file_listed_with_error(self):
        self.store("bad", "{broken")
        s = self.rec.sessions()[0]
        self.assertEqual(s["id"], "bad")
        self.assertIn("error", s)

    def test_summary_is_cached_by_mtime(self):
        self.store("a", {"id": "a", "players": [], "snaps": []})
        self.rec.sessions()
        real = json.loads
        self.patch(L.json, "loads", lambda *_a, **_k: self.fail("re-read"))
        self.rec.sessions()
        self.patch(L.json, "loads", real)

    def test_session_file(self):
        self.store("2026-01-02_10-00-00", {"id": "x"})
        self.assertEqual(self.rec.session_file("2026-01-02_10-00-00"), {"id": "x"})

    def test_session_file_rejects_bad_ids(self):
        for sid in ("../config", "a/b", "a.b", "", None):
            with self.subTest(sid=sid):
                self.assertIsNone(self.rec.session_file(sid))

    def test_session_file_missing(self):
        self.assertIsNone(self.rec.session_file("nope"))

    def test_session_file_corrupt_raises(self):
        self.store("bad", "{broken")
        with self.assertRaises(ValueError):
            self.rec.session_file("bad")
