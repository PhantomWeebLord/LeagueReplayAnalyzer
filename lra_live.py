"""
League Replay Analyzer - live game recorder.

Polls Riot's official Live Client Data API (https://127.0.0.1:2999, served by the game while you play or
watch a replay) and records a compact snapshot every ~2 s: every player's level, K/D/A, CS, vision score,
items and death state, plus your own gold and health. Nothing is shown to the player during a match beyond
their own stats (Riot does not allow apps to dictate decisions in real time); the recording is used for the
post-game debrief. While a replay is playing, the current game time is exposed so the app can follow along.
"""
import json
import re
import ssl
import threading
import time
import urllib.request
from datetime import datetime

import lra_core as core

RAW_CHAMP_PREFIX = "game_character_displayname_"


def norm_player(p):
    rid = p.get("riotId") or p.get("summonerName") or ""
    name = p.get("riotIdGameName") or rid.split("#")[0]
    tag = p.get("riotIdTagLine") or (rid.split("#", 1)[1] if "#" in rid else "")
    raw = p.get("rawChampionName") or ""
    champ_id = raw[len(RAW_CHAMP_PREFIX):] if raw.startswith(RAW_CHAMP_PREFIX) else core.champion_id_from_name(p.get("championName"))
    return {"riotId": rid or name, "name": name, "tag": tag, "champion": p.get("championName"), "championId": champ_id,
            "team": 100 if p.get("team") == "ORDER" else 200, "position": p.get("position") or "", "isBot": bool(p.get("isBot"))}


def make_snapshot(data, t, players):
    """Compact row per player (same order as session players):
    [level, kills, deaths, assists, cs, visionScore, dead, respawnTimer, [[itemId, count], ...]]"""
    ap = data.get("activePlayer") or {}
    st = ap.get("championStats") or {}
    mx = st.get("maxHealth") or 0
    by_key = {}
    for raw in data.get("allPlayers") or []:
        n = norm_player(raw)
        by_key[(n["team"], n["championId"], n["riotId"])] = raw
    rows = []
    for p in players:
        raw = by_key.get((p["team"], p["championId"], p["riotId"])) or {}
        sc = raw.get("scores") or {}
        items = [[int(i.get("itemID", 0)), int(i.get("count", 1) or 1)] for i in (raw.get("items") or [])]
        rows.append([raw.get("level", 0), sc.get("kills", 0), sc.get("deaths", 0), sc.get("assists", 0), sc.get("creepScore", 0),
                     round(float(sc.get("wardScore", 0) or 0), 1), 1 if raw.get("isDead") else 0,
                     round(float(raw.get("respawnTimer", 0) or 0), 1), items])
    return {"t": round(t, 1), "g": round(float(ap.get("currentGold", 0) or 0)), "hp": round(st.get("currentHealth", 0) / mx, 3) if mx else None, "p": rows}


def match_replay(players, since=None):
    """Find the replay file whose lobby matches these players (team + champion) -> (gameId, platform).
    since: for a game being played, only replays written after it started (a custom lobby can repeat the same picks)."""
    want = {(p["team"], str(p["championId"]).lower()) for p in players}
    best = None
    for r in core.list_replays().get("replays", []):
        if since and (r.get("mtime") or 0) < since:
            continue
        have = {(q.get("team"), str(q.get("champion")).lower()) for q in r.get("players", [])}
        n = len(want & have)
        if r.get("gameId") and n >= max(2, len(want) - 2) and (not best or n > best[0]):
            best = (n, r)
    return (int(best[1]["gameId"]), best[1]["platform"]) if best else None


def match_history(players, since=None):
    """After a game: find it in the League client's recent match history by champions -> gameId."""
    try:
        h = core.lcu_get("/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=6", timeout=10)
    except core.RiotError:
        return None
    names = core.champion_names()
    want = {(p["team"], str(p["championId"]).lower()) for p in players}
    for g in ((h or {}).get("games") or {}).get("games") or []:
        if since and (g.get("gameCreation") or 0) / 1000 < since - 900:  # an earlier game with the same picks
            continue
        have = {(q.get("teamId"), str(names.get(str(q.get("championId")), "")).lower()) for q in g.get("participants") or []}
        if len(want & have) >= max(2, len(want) - 2):
            return int(g["gameId"])
    return None


class LiveRecorder:
    def __init__(self, live_url="https://127.0.0.1:2999"):
        self.live_url = live_url.rstrip("/")
        self.lock = threading.RLock()
        self.session = None
        self.status = "idle"   # idle | play | spectate
        self.stop = False
        self._flush_at = 0
        self._phase = (0, None)
        self._cs = (0, None)
        self._index = {}       # file -> (mtime, summary)
        self.last_error = None

    # ------------------------------------------------ http to the game client
    def _open(self, path, data=None, method=None, timeout=1.5):
        url = self.live_url + path
        ctx = ssl._create_unverified_context() if url.startswith("https") else None  # the game uses a self-signed cert
        headers = {"Content-Type": "application/json"} if data is not None else {}
        req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None, method=method, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            raw = r.read().decode("utf-8")
            return json.loads(raw) if raw.strip() else None

    def live_get(self, path, timeout=1.5):
        return self._open(path, timeout=timeout)

    def live_post(self, path, body, timeout=3):
        return self._open(path, data=body, method="POST", timeout=timeout)

    # ------------------------------------------------ loop
    def start(self):
        threading.Thread(target=self._loop, name="live-recorder", daemon=True).start()
        return self

    def _loop(self):
        while not self.stop:
            try:
                data = self.live_get("/liveclientdata/allgamedata")
            except Exception:
                data = None
            try:
                if isinstance(data, dict) and data.get("gameData") and data.get("allPlayers"):
                    self._on_data(data)
                    time.sleep(1.0)
                else:
                    self._on_no_game()
                    time.sleep(3.0)
            except Exception as e:  # never let the recorder thread die
                self.last_error = repr(e)
                time.sleep(2.0)

    def busy(self):
        """True while a game you are playing is being recorded (keeps the app alive)."""
        with self.lock:
            return self.status == "play" and self.session is not None and not self.session.get("ended")

    def _on_data(self, data):
        now = time.time()
        gd = data.get("gameData") or {}
        t = float(gd.get("gameTime") or 0)
        ap = data.get("activePlayer")
        spectate = (not isinstance(ap, dict)) or ("error" in ap) or not ap.get("championStats")
        mode = "spectate" if spectate else "play"
        players = [norm_player(p) for p in data.get("allPlayers") or []]
        sig = sorted(f"{p['team']}|{p['championId']}|{p['riotId']}" for p in players)
        with self.lock:
            s = self.session
            if s and s["mode"] == "play" and mode == "spectate" and not s["ended"] and s["sig"] == sig:
                return  # the game briefly answered without the active player: don't split the recording in two
            if s and mode == "play" and s["mode"] == "play" and s["sig"] == sig and s["ended"] \
                    and s.get("endReason") == "game client closed" and t >= s["gameTime"] - 5:
                s["ended"] = False  # a freeze or reconnect, not the end of the game: keep recording
                s.pop("endedAt", None)
                s.pop("endReason", None)
            new = s is None or s["sig"] != sig or s["mode"] != mode
            if not new and mode == "play" and s.get("ended") and t + 30 < s["gameTime"]:
                new = True  # same lobby, new game
            if new:
                self._finalize()
                s = self._new_session(mode, players, sig, gd, ap if not spectate else {})
            s["gameTime"] = t
            s["lastSeen"] = now
            self.status = mode
            if mode == "play" and not s["ended"]:
                if not s["snaps"] or t - s["snaps"][-1]["t"] >= 2.0:
                    s["snaps"].append(make_snapshot(data, t, s["players"]))
                evs = (data.get("events") or {}).get("Events") or []
                if evs:
                    s["events"] = evs
                end = next((e for e in evs if e.get("EventName") == "GameEnd"), None)
                if end:
                    s["ended"], s["result"], s["endedAt"] = True, end.get("Result"), now
                    self._save(s)
                elif now - self._flush_at > 30:
                    self._save(s)
                    self._flush_at = now

    def _on_no_game(self):
        with self.lock:
            s = self.session
            if s and time.time() - s["lastSeen"] > 6:
                if s["mode"] == "play" and not s["ended"] and s["snaps"]:
                    s["ended"], s["endedAt"], s["endReason"] = True, time.time(), "game client closed"
                    self._save(s)
                if s["mode"] == "spectate":
                    self.session = None
            if not s or time.time() - s["lastSeen"] > 6:
                self.status = "idle"

    def _new_session(self, mode, players, sig, gd, ap):
        me = None
        if mode == "play":
            rid = ap.get("riotId") or ap.get("summonerName") or ""
            me_name = ap.get("riotIdGameName") or rid.split("#")[0]
            for i, p in enumerate(players):
                if (rid and p["riotId"] == rid) or (me_name and p["name"] == me_name):
                    me = i
                    break
        s = {"v": 1, "id": datetime.now().strftime("%Y-%m-%d_%H-%M-%S"), "mode": mode, "sig": sig, "startedAt": time.time(),
             "gameMode": gd.get("gameMode"), "mapNumber": gd.get("mapNumber"), "gameId": None, "platform": None, "matchId": None,
             "me": me, "players": players, "snaps": [], "events": [], "ended": False, "result": None,
             "gameTime": 0.0, "lastSeen": time.time()}
        self.session = s
        threading.Thread(target=self._resolve_ids, args=(s,), name="live-resolve", daemon=True).start()
        return s

    def _finalize(self):
        s = self.session
        if s and s["mode"] == "play" and s["snaps"] and not s["ended"]:
            s["ended"], s["endedAt"], s["endReason"] = True, time.time(), "new game detected"
            self._save(s)

    def _resolve_ids(self, s):
        """Link the session to its match id: League client game session, else a matching replay file,
        else (after the game) the client's recent match history."""
        deadline = time.time() + 20 * 60
        while time.time() < deadline and not self.stop:
            if s is not self.session and (s.get("gameId") or s["mode"] == "spectate"):
                return  # replaced: a replay session nobody watches any more doesn't need an id
            gid = plat = None
            if s["mode"] == "play":
                try:
                    gf = core.lcu_get("/lol-gameflow/v1/session", timeout=5) or {}
                    if gf.get("phase") in ("InProgress", "Reconnect", "WaitingForStats", "PreEndOfGame", "EndOfGame"):
                        gid = (gf.get("gameData") or {}).get("gameId") or None
                except Exception:
                    pass
            if not gid:
                m = match_replay(s["players"], s["startedAt"] if s["mode"] == "play" else None)
                if m:
                    gid, plat = m
            if not gid and s.get("ended"):
                gid = match_history(s["players"], s["startedAt"])
            if gid:
                plat = plat or core.lcu_platform()
                with self.lock:
                    s["gameId"], s["platform"], s["matchId"] = int(gid), plat, f"{plat}_{gid}"
                    if s["mode"] == "play":
                        self._save(s)
                return
            time.sleep(5)

    def _save(self, s):
        core.LIVE_DIR.mkdir(parents=True, exist_ok=True)
        out = {k: v for k, v in s.items() if k != "sig"}
        p = core.LIVE_DIR / f"{s['id']}.json"
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(out), "utf-8")
        tmp.replace(p)

    # ------------------------------------------------ league client state (cached briefly)
    def phase(self):
        at, val = self._phase
        if time.time() - at > 3:
            try:
                val = core.lcu_get("/lol-gameflow/v1/gameflow-phase", timeout=3)
            except Exception:
                val = None
            self._phase = (time.time(), val)
        return val

    def champ_select(self):
        at, val = self._cs
        if time.time() - at > 3:
            val = None
            try:
                cs = core.lcu_get("/lol-champ-select/v1/session", timeout=3) or {}
                cell = cs.get("localPlayerCellId")
                mine = next((m for m in cs.get("myTeam") or [] if m.get("cellId") == cell), None)
                if mine:
                    cid = mine.get("championId") or mine.get("championPickIntent") or 0
                    val = {"championKey": cid, "champion": core.champion_names().get(str(cid)) if cid else None,
                           "position": (mine.get("assignedPosition") or "").upper(), "locked": bool(mine.get("championId"))}
            except Exception:
                val = None
            self._cs = (time.time(), val)
        return val

    # ------------------------------------------------ API for the web app
    def state(self):
        with self.lock:
            s = self.session
            out = {"status": self.status}
            if s:
                sess = {k: s.get(k) for k in ("id", "mode", "gameMode", "gameId", "matchId", "platform", "me", "players",
                                               "ended", "result", "gameTime", "startedAt", "endReason")}
                sess["snaps"] = len(s["snaps"])
                out["session"] = sess
                out["last"] = s["snaps"][-1] if s["snaps"] else None
        out["phase"] = self.phase()
        if out["phase"] == "ChampSelect":
            out["champSelect"] = self.champ_select()
        return out

    def sessions(self):
        core.LIVE_DIR.mkdir(parents=True, exist_ok=True)
        out = []
        for f in sorted(core.LIVE_DIR.glob("*.json"), reverse=True):
            mt = f.stat().st_mtime
            c = self._index.get(f.name)
            if not c or c[0] != mt:
                try:
                    s = json.loads(f.read_text("utf-8"))
                    me = s["players"][s["me"]] if s.get("me") is not None else None
                    summ = {"id": s["id"], "matchId": s.get("matchId"), "gameMode": s.get("gameMode"), "result": s.get("result"),
                            "ended": s.get("ended"), "startedAt": s.get("startedAt"), "snaps": len(s.get("snaps") or []),
                            "champion": me and me.get("championId"), "duration": (s.get("snaps") or [{}])[-1].get("t")}
                except Exception as e:
                    summ = {"id": f.stem, "error": str(e)}
                c = (mt, summ)
                self._index[f.name] = c
            out.append(c[1])
        return out

    def session_file(self, sid):
        if not re.fullmatch(r"[\w\-]+", sid or ""):
            return None
        p = core.LIVE_DIR / f"{sid}.json"
        return json.loads(p.read_text("utf-8")) if p.exists() else None
