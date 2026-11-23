"""
League Replay Analyzer - local app server.

From source:  python server.py [replay.rofl] [--port N] [--no-browser] [--live-url URL] [--no-live]
Packaged:     "Replay Analyzer.exe" [replay.rofl]      (or drag a .rofl onto the exe)

Serves the web UI on http://127.0.0.1:<port> (local only), reads replays, loads match data from the
Riot API / League client, and records live games for the post-game debrief. No third-party packages.
"""
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import lra_core as core
import lra_live
from lra_core import RiotError

VERSION = "3.0-replay"
APP_ID = "lra2"                  # v2 (real replay view) runs side by side with v1, on its own port
APP_TITLE = "Replay Analyzer v2"  # page title = app window title
MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".png": "image/png", ".json": "application/json",
    ".svg": "image/svg+xml", ".ico": "image/x-icon",
}
OPTS = {"port": int(os.environ.get("LRA_PORT", "8766")), "browser": True, "file": None, "live": True,
        "live_url": os.environ.get("LRA_LIVE_URL", "https://127.0.0.1:2999"), "auto_exit": core.FROZEN}
RECORDER = None
LAST_PING = [time.time()]
BYE_AT = [None]


def parse_args(argv):
    it = iter(argv)
    for a in it:
        if a == "--port":
            OPTS["port"] = int(next(it))
        elif a == "--no-browser":
            OPTS["browser"] = False
        elif a == "--live-url":
            OPTS["live_url"] = next(it)
        elif a == "--no-live":
            OPTS["live"] = False
        elif a == "--auto-exit":
            OPTS["auto_exit"] = True
        elif a == "--no-auto-exit":
            OPTS["auto_exit"] = False
        elif not a.startswith("--"):
            OPTS["file"] = a


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "ReplayAnalyzer/" + VERSION

    def log_message(self, fmt, *args):
        pass

    def _local_ok(self):
        """Only answer our own page: blocks other websites (CSRF) and DNS-rebinding tricks."""
        port = OPTS["port"]
        host = (self.headers.get("Host") or "").lower()
        if host not in (f"127.0.0.1:{port}", f"localhost:{port}"):
            return False
        origin = (self.headers.get("Origin") or "").lower()
        return not origin or origin in (f"http://127.0.0.1:{port}", f"http://localhost:{port}")

    def send_json(self, obj, status=200):
        b = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def send_bytes(self, b, ctype, cache=False):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "max-age=86400" if cache else "no-cache")
        self.end_headers()
        self.wfile.write(b)

    def send_empty(self, status):
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if not self._local_ok():
            return self.send_json({"error": "forbidden"}, 403)
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        arg = lambda k, d="": (q.get(k) or [d])[0]
        path = u.path
        try:
            if path == "/api/ping":
                LAST_PING[0] = time.time()
                return self.send_json({"app": APP_ID, "version": VERSION, "frozen": core.FROZEN})
            if path == "/api/replays":
                return self.send_json(core.list_replays())
            if path == "/api/config":
                cfg = core.load_config()
                k = cfg.get("apiKey") or ""
                return self.send_json({"hasKey": bool(k), "keyHint": (k[:6] + "…" + k[-4:]) if k else "",
                                       "replayDir": str(core.replay_dir()), "lcu": bool(core.find_lockfile()),
                                       "keyRejected": bool(k) and k in core.rejected_keys, "dataDir": str(core.DATA),
                                       "frozen": core.FROZEN, "live": bool(RECORDER), "version": VERSION})
            if path == "/api/champions":
                return self.send_json({c["id"]: c["name"] for c in core.champion_table()})
            if path == "/api/me":
                try:
                    me = core.lcu_get("/lol-summoner/v1/current-summoner", timeout=5)
                    return self.send_json({"gameName": me.get("gameName"), "tagLine": me.get("tagLine"), "puuid": me.get("puuid")})
                except RiotError as e:
                    return self.send_json({"error": str(e)})
            if path == "/api/match":
                mid = arg("id")
                if not re.fullmatch(r"[A-Za-z]+\d*_\d+", mid):
                    return self.send_json({"error": "Bad match id"}, 400)
                try:
                    return self.send_json(core.get_match(mid.upper(), arg("refresh") == "1"))
                except RiotError as e:
                    return self.send_json({"error": str(e), "status": e.status})
            if path == "/api/replay-file":
                # open a .rofl from anywhere on disk (drag & drop onto the exe, "open with")
                p = Path(arg("path"))
                if p.suffix.lower() != ".rofl" or not p.is_file():
                    return self.send_json({"error": "Not a .rofl file"}, 400)
                try:
                    meta = core.parse_rofl(p)
                    meta["path"] = str(p)
                    return self.send_json(meta)
                except Exception as e:
                    return self.send_json({"error": f"Could not read this replay: {e}"})
            if path == "/api/live/state":
                if not RECORDER:
                    return self.send_json({"status": "disabled"})
                return self.send_json(RECORDER.state())
            if path == "/api/live/sessions":
                return self.send_json(RECORDER.sessions() if RECORDER else [])
            if path == "/api/live/session":
                s = RECORDER.session_file(arg("id")) if RECORDER else None
                return self.send_json(s if s else {"error": "not found"}, 200 if s else 404)
            if path == "/api/replay/playback":
                try:
                    return self.send_json(RECORDER.live_get("/replay/playback", timeout=1.5))
                except Exception:
                    return self.send_json({"error": "Replay control is not available", "enabledInConfig": core.replay_api_enabled()})
            if path == "/api/replay/status":
                return self.send_json(replay_status(arg("matchId").upper(), arg("version")))
            if path == "/api/replay/render":
                try:
                    return self.send_json(RECORDER.live_get("/replay/render", timeout=1.5))
                except Exception:
                    return self.send_json({"error": "Replay control is not available"})
            if path == "/api/replay/players":
                # in-replay player names: the Replay API selects a player by this name
                try:
                    pl = RECORDER.live_get("/liveclientdata/playerlist", timeout=2)
                    return self.send_json([{"name": p.get("riotIdGameName") or (p.get("summonerName") or "").split("#")[0],
                                            "champ": str(p.get("rawChampionName") or "").replace("game_character_displayname_", ""),
                                            "champName": p.get("championName"), "team": 100 if p.get("team") == "ORDER" else 200}
                                           for p in pl or []])
                except Exception:
                    return self.send_json({"error": "No replay running"})
            if path.startswith("/asset/"):
                parts = path.split("/")
                kind = parts[2] if len(parts) > 2 else ""
                name = urllib.parse.unquote(parts[3]).rsplit(".", 1)[0] if len(parts) > 3 else ""
                b = core.get_asset(kind, name)
                return self.send_bytes(b, "image/png", cache=True) if b is not None else self.send_empty(404)
            # static files
            rel = "index.html" if path in ("/", "") else path.lstrip("/")
            fp = (core.STATIC / rel).resolve()
            if core.STATIC.resolve() not in fp.parents or not fp.is_file():
                return self.send_empty(404)
            return self.send_bytes(fp.read_bytes(), MIME.get(fp.suffix, "application/octet-stream"))
        except Exception as e:
            return self.send_json({"error": f"{type(e).__name__}: {e}"}, 500)

    def do_POST(self):
        if not self._local_ok():
            return self.send_json({"error": "forbidden"}, 403)
        u = urllib.parse.urlparse(self.path)
        try:
            n = max(0, int(self.headers.get("Content-Length") or 0))
        except ValueError:
            return self.send_json({"error": "Bad Content-Length"}, 400)
        body = self.rfile.read(n) if n else b""
        if u.path == "/api/bye":  # page closed (sendBeacon) - lets the app exit when its window is gone
            BYE_AT[0] = time.time()
            return self.send_empty(204)
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            return self.send_json({"error": "JSON body required"}, 415)
        try:
            data = json.loads(body or b"{}")
            if u.path == "/api/config":
                cfg = core.load_config()
                if "apiKey" in data:
                    cfg["apiKey"] = str(data["apiKey"]).strip()
                    core.rejected_keys.discard(cfg["apiKey"])
                if "replayDir" in data:
                    cfg["replayDir"] = str(data["replayDir"]).strip()
                core.save_config(cfg)
                return self.send_json({"ok": True})
            if u.path == "/api/replay/render":
                body = {k: data[k] for k in RENDER_KEYS if k in data}
                if body.get("cameraMode") not in (None, "top"):
                    body.pop("cameraMode")  # third-person / free-fly modes crashed League's replay player in testing
                try:
                    return self.send_json(RECORDER.live_post("/replay/render", body))
                except Exception as e:
                    return self.send_json({"error": f"Replay control is not available ({e})"})
            if u.path == "/api/replay/window":
                return self.send_json({"ok": core.arrange_windows(str(data.get("action")), APP_TITLE)})
            if u.path == "/api/replay/start-client":
                try:
                    return self.send_json({"ok": core.start_league_client()})
                except RiotError as e:
                    return self.send_json({"error": str(e)})
            if u.path == "/api/replay/close":
                return self.send_json(close_replay())
            if u.path == "/api/replay/playback":
                body = {}
                try:
                    if "time" in data:
                        body["time"] = max(0.0, float(data["time"]))
                    if "speed" in data:
                        body["speed"] = min(16.0, max(0.125, float(data["speed"])))
                    if "paused" in data:
                        body["paused"] = bool(data["paused"])
                except (TypeError, ValueError):
                    return self.send_json({"error": "Bad playback values"}, 400)
                try:
                    return self.send_json(RECORDER.live_post("/replay/playback", body))
                except Exception as e:
                    return self.send_json({"error": f"Replay control is not available ({e})", "enabledInConfig": core.replay_api_enabled()})
            if u.path == "/api/replay/watch":
                mid = str(data.get("matchId") or "").upper()
                if not re.fullmatch(r"[A-Z]+\d*_\d+", mid):
                    return self.send_json({"error": "Bad match id"}, 400)
                try:
                    core.watch_replay(mid, data.get("path"))
                    return self.send_json({"ok": True})
                except (RiotError, OSError) as e:
                    return self.send_json({"error": f"Could not start the replay in League: {e}"})
            if u.path == "/api/replay/enable-api":
                try:
                    core.enable_replay_api()
                    return self.send_json({"ok": True})
                except (RiotError, OSError) as e:
                    return self.send_json({"error": str(e)})
            return self.send_json({"error": "not found"}, 404)
        except Exception as e:
            return self.send_json({"error": f"{type(e).__name__}: {e}"}, 500)


# ---------------------------------------------------------------- v2: replay status for the in-app replay view
RENDER_KEYS = ("cameraAttached", "selectionName", "selectionOffset", "cameraMode", "cameraPosition", "cameraRotation", "fieldOfView",
               "fogOfWar", "interfaceAll", "interfaceReplay", "interfaceTimeline", "interfaceScoreboard", "interfaceChat",
               "interfaceMinimap", "interfaceFrames", "interfaceScore", "interfaceKillCallouts", "interfaceAnnounce",
               "healthBarChampions", "outlineSelect", "outlineHover", "floatingText", "banners")
_status_cache = {"at": 0.0, "cfg": None}
_patch_cache = {}  # match id -> (rofl mtime, patch)


def replay_patch_for(match_id):
    f = core.replay_file_for(match_id)
    if not f:
        return None
    mt = f.stat().st_mtime
    c = _patch_cache.get(match_id)
    if not c or c[0] != mt:
        try:
            c = (mt, core.patch_of(core.parse_rofl(f).get("version")))
        except Exception:
            c = (mt, None)
        _patch_cache[match_id] = c
    return c[1]


def replay_status(match_id, version):
    """Everything the replay view needs to decide what to show: can League play this replay, is it playing it, can we control it."""
    lcu = bool(core.find_lockfile())
    out = {"lcu": lcu, "apiEnabled": core.replay_api_enabled(), "window": core.league_window_info()}
    cp = core.client_patch() if lcu else None
    if lcu and not cp:
        lcu = out["lcu"] = False  # lockfile left behind by a closed client
    out["clientPatch"] = cp or core.installed_game_patch()  # the game's own version works with the client closed
    cp = out["clientPatch"]
    rp = core.patch_of(version)
    if not rp and re.fullmatch(r"[A-Z]+\d*_\d+", match_id or ""):
        rp = replay_patch_for(match_id)
    out["replayPatch"] = rp
    out["compatible"] = (rp == cp) if (rp and cp) else None
    now = time.time()
    if lcu and now - _status_cache["at"] > 2.5:
        try:
            _status_cache["cfg"] = core.lcu_get("/lol-replays/v1/configuration", timeout=3)
        except RiotError:
            _status_cache["cfg"] = None
        _status_cache["at"] = now
    cfg = _status_cache["cfg"] if lcu else None
    out["clientPlayingGame"] = bool(cfg and cfg.get("isPlayingGame"))
    out["clientPlayingReplay"] = bool(cfg and cfg.get("isPlayingReplay"))
    out["clientPatching"] = bool(cfg and cfg.get("isPatching"))
    st = RECORDER.state() if RECORDER else {}
    sess = st.get("session") or {}
    out["spectating"] = st.get("status") == "spectate"
    out["playingMatch"] = sess.get("matchId") if out["spectating"] else None
    out["inGame"] = st.get("status") == "play"
    pb = None
    if RECORDER and not out["inGame"] and (out["spectating"] or out["window"]):
        try:
            pb = RECORDER.live_get("/replay/playback", timeout=1.0)
        except Exception:
            pb = None
    out["playback"] = pb if isinstance(pb, dict) and "time" in pb else None
    return out


def close_replay():
    """Close the League replay window (only ever a replay/spectate session - never a game you're playing)."""
    st = RECORDER.state() if RECORDER else {}
    if st.get("status") == "play":
        return {"error": "You're in a game - not closing it."}
    if not st.get("status") == "spectate" and not core.find_window(core.LEAGUE_WINDOW):
        return {"error": "No replay is open in League."}
    pid = core.league_window_pid()
    if not pid:
        try:
            pid = int(RECORDER.live_get("/replay/game", timeout=1.5).get("processID"))  # Replay API (replays only)
        except Exception:
            return {"error": "No replay is open in League."}
    if (core.process_name(pid) or "").lower() != "league of legends.exe":
        return {"error": "Could not identify League's replay window - close it in League."}  # never touch anything else
    try:
        subprocess.run(["taskkill", "/PID", str(pid)], capture_output=True, timeout=10)
        for _ in range(12):  # give League a moment to close itself, then force it (it's only a replay)
            time.sleep(0.25)
            if not core.find_window(core.LEAGUE_WINDOW):
                return {"ok": True}
        subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, timeout=10)
        return {"ok": True}
    except Exception as e:
        return {"error": str(e)}


# ---------------------------------------------------------------- app window & lifecycle
class AppServer(ThreadingHTTPServer):
    # Python's default listen backlog is 5. On Windows a page load (about ten scripts, styles and API calls at
    # once) overflows it and the extra connections are reset, so parts of the app silently failed to load.
    request_queue_size = 128
    daemon_threads = True


def app_url(port, file=None):
    url = f"http://127.0.0.1:{port}/"
    if file:
        url += "?open=" + urllib.parse.quote(str(Path(file).resolve()))
    return url


def instance_running(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=1.5) as r:
            return json.loads(r.read()).get("app") == APP_ID
    except Exception:
        return False


def find_app_browser():
    env = os.environ.get
    cands = [
        Path(env("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Microsoft/Edge/Application/msedge.exe",
        Path(env("ProgramFiles", r"C:\Program Files")) / "Microsoft/Edge/Application/msedge.exe",
        Path(env("LOCALAPPDATA", "")) / "Microsoft/Edge/Application/msedge.exe",
        Path(env("ProgramFiles", r"C:\Program Files")) / "Google/Chrome/Application/chrome.exe",
        Path(env("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe",
    ]
    return next((str(c) for c in cands if c.is_file()), None)


def open_window(url):
    """Open the UI as its own app window (Edge/Chrome --app), falling back to the default browser."""
    exe = find_app_browser()
    if exe:
        try:
            # Its own browser profile, so the window can pick the League replay window for capture without a
            # picker dialog (and stays separate from your normal browser).
            prof = core.DATA / "window-v2"
            subprocess.Popen([exe, f"--app={url}", "--window-size=1640,1000", f"--user-data-dir={prof}", "--no-first-run",
                              "--no-default-browser-check", f"--auto-select-desktop-capture-source={core.LEAGUE_WINDOW}"],
                             close_fds=True)
            return
        except OSError:
            pass
    webbrowser.open(url)


def watchdog():
    """Packaged app: quit after its window has been closed - but never while a live game is being recorded."""
    while True:
        time.sleep(10)
        now = time.time()
        if RECORDER is not None and RECORDER.busy():
            continue
        bye = BYE_AT[0]
        if bye and now - bye > 25 and LAST_PING[0] < bye:
            os._exit(0)
        if now - LAST_PING[0] > 6 * 3600:
            os._exit(0)


def main():
    parse_args(sys.argv[1:])
    if core.FROZEN:  # windowed exe has no console: keep a log in the data folder
        log = open(core.DATA / "app.log", "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr = log
        print(f"\n--- start {time.ctime()} v{VERSION} data={core.DATA}")
    port = OPTS["port"]
    if instance_running(port):  # already open: just show it (with the dropped file, if any)
        open_window(app_url(port, OPTS["file"]))
        return
    srv = None
    for p in range(port, port + 10):
        try:
            srv = AppServer(("127.0.0.1", p), Handler)
            OPTS["port"] = p
            break
        except OSError:
            if instance_running(p):
                open_window(app_url(p, OPTS["file"]))
                return
    if srv is None:
        print("No free port found.")
        return
    global RECORDER
    if OPTS["live"]:
        RECORDER = lra_live.LiveRecorder(OPTS["live_url"]).start()
    url = app_url(OPTS["port"], OPTS["file"])
    print(f"League Replay Analyzer running at {url}  (data: {core.DATA})  Ctrl+C to stop")
    if OPTS["browser"]:
        threading.Timer(0.4, lambda: open_window(url)).start()
    if OPTS["auto_exit"]:
        threading.Thread(target=watchdog, name="watchdog", daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
