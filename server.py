"""
League Replay Analyzer - local app server.

From source:  python server.py [replay.rofl] [--port N] [--no-browser] [--live-url URL] [--no-live]
Packaged:     "Replay Analyzer v2.exe" [replay.rofl]      (or drag a .rofl onto the exe)

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
import traceback
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import lra_core as core
import lra_live
import lra_window
from lra_core import RiotError

VERSION = "3.0-replay"
APP_ID = "lra2"                  # how a new launch recognizes an instance that is already running
APP_TITLE = "Replay Analyzer v2"  # page title = app window title
MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".png": "image/png", ".json": "application/json",
    ".svg": "image/svg+xml", ".ico": "image/x-icon",
}
DEFAULT_PORT = 8766


def valid_port(value, default: int) -> int:
    """A bad port must not crash the windowed exe, which has no console to show the error."""
    try:
        port = int(value)
    except (TypeError, ValueError):
        return default
    return port if 1 <= port <= 65535 else default


OPTS = {"port": valid_port(os.environ.get("LRA_PORT"), DEFAULT_PORT), "browser": True, "file": None, "live": True,
        "live_url": os.environ.get("LRA_LIVE_URL", "https://127.0.0.1:2999"), "auto_exit": core.FROZEN, "background": False}
MATCH_ID_ANY_CASE = re.compile(r"[A-Za-z]+\d*_\d+")
MATCH_ID = re.compile(r"[A-Z]+\d*_\d+")
MIN_REPLAY_SPEED, MAX_REPLAY_SPEED = 0.125, 16.0
SAFE_CAMERA_MODES = (None, "top")    # third-person / free-fly modes crashed League's replay player in testing
LISTEN_BACKLOG = 128
MAX_BODY_BYTES = 1 << 20             # the app's own requests are a few hundred bytes
REQUEST_TIMEOUT = 30                 # seconds a client may stall on the socket
MAX_LOG_BYTES = 2 << 20
PORT_SEARCH_RANGE = 10
STATUS_CACHE_SECONDS = 2.5
CLOSE_POLLS, CLOSE_POLL_SECONDS = 12, 0.25
WATCHDOG_TICK = 10
EXIT_AFTER_CLOSE = 25                # seconds after the window closes (a reload pings again within this time)
EXIT_WHEN_IDLE = 6 * 3600
REAL_GAME_PHASES = ("GameStart", "InProgress", "Reconnect")   # a replay reports WatchInProgress instead
CONTENT_SECURITY_POLICY = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
                           "media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'")
TASKKILL = str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "taskkill.exe")  # never one found on PATH
RECORDER = None
LAST_PING = [time.time()]
BYE_AT = [None]


def parse_args(argv):
    it = iter(argv)
    for a in it:
        if a == "--port":
            OPTS["port"] = valid_port(next(it, None), OPTS["port"])
        elif a == "--no-browser":
            OPTS["browser"] = False
        elif a == "--live-url":
            OPTS["live_url"] = next(it, OPTS["live_url"])
        elif a == "--no-live":
            OPTS["live"] = False
        elif a == "--auto-exit":
            OPTS["auto_exit"] = True
        elif a == "--no-auto-exit":
            OPTS["auto_exit"] = False
        elif a == "--background-window":  # automated tests: open off-screen without taking focus
            OPTS["background"] = True
        elif not a.startswith("--"):
            OPTS["file"] = a


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "ReplayAnalyzer/" + VERSION
    timeout = REQUEST_TIMEOUT

    def log_message(self, fmt, *args):
        pass

    def _local_ok(self):
        """Only answer our own page: blocks other websites (CSRF) and DNS-rebinding tricks."""
        port = OPTS["port"]
        host = (self.headers.get("Host") or "").lower()
        if host not in (f"127.0.0.1:{port}", f"localhost:{port}"):
            return False
        origin = (self.headers.get("Origin") or "").lower()
        if origin and origin not in (f"http://127.0.0.1:{port}", f"http://localhost:{port}"):
            return False
        # A plain <img> or fetch from another site sends no Origin, but browsers do send Sec-Fetch-Site.
        if (self.headers.get("Sec-Fetch-Site") or "").lower() in ("cross-site", "same-site"):
            return self.headers.get("Sec-Fetch-Mode") == "navigate" and not self.path.startswith("/api/")
        return True

    def send_json(self, obj, status=200):
        b = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(b)

    def send_bytes(self, b, ctype, cache=False):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "max-age=86400" if cache else "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        if ctype.startswith("text/html"):
            self.send_header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        self.end_headers()
        self.wfile.write(b)

    def _internal_error(self):
        """The details go to the log (app.log in the packaged app), never to the page."""
        traceback.print_exc()
        return self.send_json({"error": "Something went wrong in the app. Details are in its log."}, 500)

    def send_empty(self, status):
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _arg(self, key, default=""):
        return (self.query.get(key) or [default])[0]

    # ------------------------------------------------ GET routes
    def _get_ping(self):
        LAST_PING[0] = time.time()
        return self.send_json({"app": APP_ID, "version": VERSION, "frozen": core.FROZEN})

    def _get_replays(self):
        return self.send_json(core.list_replays())

    def _get_config(self):
        k = core.riot_api_key()
        return self.send_json({"hasKey": bool(k), "keyHint": "…" + k[-4:] if k else "",
                               "replayDir": str(core.replay_dir()), "lcu": bool(core.find_lockfile()),
                               "keyRejected": bool(k) and k in core.rejected_keys, "dataDir": str(core.DATA),
                               "frozen": core.FROZEN, "live": bool(RECORDER), "version": VERSION})

    def _get_champions(self):
        return self.send_json({c["id"]: c["name"] for c in core.champion_table()})

    def _get_me(self):
        try:
            me = core.lcu_get("/lol-summoner/v1/current-summoner", timeout=5)
            return self.send_json({"gameName": me.get("gameName"), "tagLine": me.get("tagLine"), "puuid": me.get("puuid")})
        except RiotError as e:
            return self.send_json({"error": str(e)})

    def _get_match(self):
        mid = self._arg("id")
        if not MATCH_ID_ANY_CASE.fullmatch(mid):
            return self.send_json({"error": "Bad match id"}, 400)
        try:
            return self.send_json(core.get_match(mid.upper(), self._arg("refresh") == "1"))
        except RiotError as e:
            return self.send_json({"error": str(e), "status": e.status})

    def _get_replay_file(self):
        """Open a .rofl from anywhere on disk (drag & drop onto the exe, "open with")."""
        p = Path(self._arg("path"))
        if p.suffix.lower() != ".rofl" or not p.is_file():
            return self.send_json({"error": "Not a .rofl file"}, 400)
        try:
            meta = core.parse_rofl(p)
            meta["path"] = str(p)
            return self.send_json(meta)
        except ValueError as e:  # the parser's messages are written for the player
            return self.send_json({"error": f"Could not read this replay: {e}"})
        except Exception:
            traceback.print_exc()
            return self.send_json({"error": "Could not read this replay."})

    def _get_live_state(self):
        return self.send_json(RECORDER.state() if RECORDER else {"status": "disabled"})

    def _get_live_sessions(self):
        return self.send_json(RECORDER.sessions() if RECORDER else [])

    def _get_live_session(self):
        s = RECORDER.session_file(self._arg("id")) if RECORDER else None
        return self.send_json(s if s else {"error": "not found"}, 200 if s else 404)

    def _get_playback(self):
        try:
            return self.send_json(RECORDER.live_get("/replay/playback", timeout=1.5))
        except Exception:
            return self.send_json({"error": "Replay control is not available", "enabledInConfig": core.replay_api_enabled()})

    def _get_replay_status(self):
        return self.send_json(replay_status(self._arg("matchId").upper(), self._arg("version")))

    def _get_render(self):
        try:
            return self.send_json(RECORDER.live_get("/replay/render", timeout=1.5))
        except Exception:
            return self.send_json({"error": "Replay control is not available"})

    def _get_replay_players(self):
        """In-replay player names: the Replay API selects a player by this name."""
        try:
            pl = RECORDER.live_get("/liveclientdata/playerlist", timeout=2)
            return self.send_json([{"name": p.get("riotIdGameName") or (p.get("summonerName") or "").split("#")[0],
                                    "champ": str(p.get("rawChampionName") or "").replace("game_character_displayname_", ""),
                                    "champName": p.get("championName"), "team": 100 if p.get("team") == "ORDER" else 200}
                                   for p in pl or []])
        except Exception:
            return self.send_json({"error": "No replay running"})

    def _get_asset(self, path):
        parts = path.split("/")
        kind = parts[2] if len(parts) > 2 else ""
        name = urllib.parse.unquote(parts[3]).rsplit(".", 1)[0] if len(parts) > 3 else ""
        b = core.get_asset(kind, name)
        return self.send_bytes(b, "image/png", cache=True) if b is not None else self.send_empty(404)

    def _get_static(self, path):
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        fp = (core.STATIC / rel).resolve()
        if core.STATIC.resolve() not in fp.parents or not fp.is_file():
            return self.send_empty(404)
        return self.send_bytes(fp.read_bytes(), MIME.get(fp.suffix, "application/octet-stream"))

    GET_ROUTES = {
        "/api/ping": _get_ping, "/api/replays": _get_replays, "/api/config": _get_config, "/api/champions": _get_champions, "/api/me": _get_me,
        "/api/match": _get_match, "/api/replay-file": _get_replay_file, "/api/live/state": _get_live_state, "/api/live/sessions": _get_live_sessions,
        "/api/live/session": _get_live_session, "/api/replay/playback": _get_playback, "/api/replay/status": _get_replay_status,
        "/api/replay/render": _get_render, "/api/replay/players": _get_replay_players,
    }

    def do_GET(self):
        if not self._local_ok():
            return self.send_json({"error": "forbidden"}, 403)
        u = urllib.parse.urlparse(self.path)
        self.query = urllib.parse.parse_qs(u.query)
        try:
            route = self.GET_ROUTES.get(u.path)
            if route:
                return route(self)
            if u.path.startswith("/asset/"):
                return self._get_asset(u.path)
            return self._get_static(u.path)
        except ConnectionError:  # the page went away mid-response
            self.close_connection = True
            return None
        except Exception:
            return self._internal_error()

    # ------------------------------------------------ POST routes
    def _post_config(self, data):
        cfg = core.load_config()
        if "apiKey" in data:
            cfg["apiKey"] = str(data["apiKey"]).strip()
            core.rejected_keys.discard(cfg["apiKey"])
        if "replayDir" in data:
            cfg["replayDir"] = str(data["replayDir"]).strip()
        core.save_config(cfg)
        return self.send_json({"ok": True})

    def _post_render(self, data):
        body = {k: data[k] for k in RENDER_KEYS if k in data}
        if body.get("cameraMode") not in SAFE_CAMERA_MODES:
            body.pop("cameraMode")
        try:
            return self.send_json(RECORDER.live_post("/replay/render", body))
        except Exception:
            return self.send_json({"error": "Replay control is not available."})

    def _post_window(self, data):
        return self.send_json({"ok": core.arrange_windows(str(data.get("action")), APP_TITLE)})

    def _post_start_client(self, _data):
        try:
            return self.send_json({"ok": core.start_league_client()})
        except RiotError as e:
            return self.send_json({"error": str(e)})

    def _post_close(self, _data):
        return self.send_json(close_replay())

    def _post_playback(self, data):
        body = {}
        try:
            if "time" in data:
                body["time"] = max(0.0, float(data["time"]))
            if "speed" in data:
                body["speed"] = min(MAX_REPLAY_SPEED, max(MIN_REPLAY_SPEED, float(data["speed"])))
            if "paused" in data:
                body["paused"] = bool(data["paused"])
        except (TypeError, ValueError):
            return self.send_json({"error": "Bad playback values"}, 400)
        try:
            return self.send_json(RECORDER.live_post("/replay/playback", body))
        except Exception:
            return self.send_json({"error": "Replay control is not available.", "enabledInConfig": core.replay_api_enabled()})

    def _post_watch(self, data):
        mid = str(data.get("matchId") or "").upper()
        if not MATCH_ID.fullmatch(mid):
            return self.send_json({"error": "Bad match id"}, 400)
        try:
            core.watch_replay(mid, data.get("path"))
            return self.send_json({"ok": True})
        except RiotError as e:
            return self.send_json({"error": f"Could not start the replay in League: {e}"})
        except OSError:
            traceback.print_exc()
            return self.send_json({"error": "Could not start the replay in League."})

    def _post_enable_api(self, _data):
        try:
            core.enable_replay_api()
            return self.send_json({"ok": True})
        except RiotError as e:
            return self.send_json({"error": str(e)})
        except OSError:
            traceback.print_exc()
            return self.send_json({"error": "Could not update League's settings file."})

    POST_ROUTES = {
        "/api/config": _post_config, "/api/replay/render": _post_render, "/api/replay/window": _post_window, "/api/replay/start-client": _post_start_client,
        "/api/replay/close": _post_close, "/api/replay/playback": _post_playback, "/api/replay/watch": _post_watch, "/api/replay/enable-api": _post_enable_api,
    }

    def do_POST(self):
        allowed = self._local_ok()
        u = urllib.parse.urlparse(self.path)
        try:
            n = max(0, int(self.headers.get("Content-Length") or 0))
        except ValueError:
            return self.send_json({"error": "forbidden"}, 403) if not allowed else self.send_json({"error": "Bad Content-Length"}, 400)
        if n > MAX_BODY_BYTES:
            self.close_connection = True
            return self.send_json({"error": "forbidden"}, 403) if not allowed else self.send_json({"error": "Request too large"}, 413)
        # read before answering: closing with unread data makes Windows reset the socket, and the client can lose the reply
        body = self.rfile.read(n) if n else b""
        if not allowed:
            return self.send_json({"error": "forbidden"}, 403)
        if u.path == "/api/bye":  # page closed (sendBeacon) - lets the app exit when its window is gone
            BYE_AT[0] = time.time()
            return self.send_empty(204)
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            return self.send_json({"error": "JSON body required"}, 415)
        try:
            data = json.loads(body or b"{}")
        except ValueError:
            return self.send_json({"error": "Invalid JSON"}, 400)
        if not isinstance(data, dict):
            return self.send_json({"error": "Invalid JSON"}, 400)
        try:
            route = self.POST_ROUTES.get(u.path)
            return route(self, data) if route else self.send_json({"error": "not found"}, 404)
        except ConnectionError:  # the page went away mid-response
            self.close_connection = True
            return None
        except Exception:
            return self._internal_error()


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
    if not rp and MATCH_ID.fullmatch(match_id or ""):
        rp = replay_patch_for(match_id)
    out["replayPatch"] = rp
    out["compatible"] = (rp == cp) if (rp and cp) else None
    now = time.time()
    if lcu and now - _status_cache["at"] > STATUS_CACHE_SECONDS:
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


def _client_in_real_game():
    try:
        return core.lcu_get("/lol-gameflow/v1/gameflow-phase", timeout=3) in REAL_GAME_PHASES
    except RiotError:
        return False


def close_replay():
    """Close the League replay window. Only a session positively identified as a replay is ever closed:
    during loading, a freeze or a reconnect the live API goes quiet, and that must never end a real game."""
    st = RECORDER.state() if RECORDER else {}
    if st.get("status") == "play" or _client_in_real_game():
        return {"error": "You're in a game - not closing it."}
    if st.get("status") != "spectate":
        if core.find_window(core.LEAGUE_WINDOW):
            return {"error": "League isn't reporting a replay right now, so it was left open. Close it in League."}
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
        subprocess.run([TASKKILL, "/PID", str(pid)], capture_output=True, timeout=10)
        for _ in range(CLOSE_POLLS):  # give League a moment to close itself, then force it (it's only a replay)
            time.sleep(CLOSE_POLL_SECONDS)
            if not core.find_window(core.LEAGUE_WINDOW):
                return {"ok": True}
        subprocess.run([TASKKILL, "/F", "/PID", str(pid)], capture_output=True, timeout=10)
        return {"ok": True}
    except Exception:
        traceback.print_exc()
        return {"error": "Could not close the replay. Close it in League."}


# ---------------------------------------------------------------- app window & lifecycle
class AppServer(ThreadingHTTPServer):
    # Python's default listen backlog is 5. On Windows a page load (about ten scripts, styles and API calls at
    # once) overflows it and the extra connections are reset, so parts of the app silently failed to load.
    request_queue_size = LISTEN_BACKLOG
    daemon_threads = True
    # On Windows SO_REUSEADDR lets a second process bind the same port, so "port in use" would never be detected.
    allow_reuse_address = os.name != "nt"


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
    """Fallback when the app's own window can't start: an Edge/Chrome --app window, then the default browser."""
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


def show_running(url):
    """The app is already running: bring its window forward, or open a browser window if it has none."""
    if not lra_window.show_existing(url):
        open_window(url)


def recording():
    return RECORDER is not None and RECORDER.busy()


def run_with_window(srv, url):
    """Windows needs the UI on the main thread, so the server runs behind it. Closing the window quits the app,
    unless a live game is being recorded: then the window hides and the app exits when the game ends."""
    server = threading.Thread(target=srv.serve_forever, name="http", daemon=True)
    server.start()
    shown = lra_window.run(url, APP_TITLE, core.DATA, keep_running=recording, background=OPTS["background"])
    if shown and OPTS["auto_exit"]:
        return
    if not shown:
        open_window(url)
        if OPTS["auto_exit"]:
            threading.Thread(target=watchdog, name="watchdog", daemon=True).start()
    try:
        while server.is_alive():
            server.join(1)
    except KeyboardInterrupt:
        pass


def watchdog():
    """Browser-window fallback: quit after the page has closed - but never while a live game is being recorded."""
    while True:
        time.sleep(WATCHDOG_TICK)
        now = time.time()
        if recording():
            continue
        bye = BYE_AT[0]
        if bye and now - bye > EXIT_AFTER_CLOSE and LAST_PING[0] < bye:
            os._exit(0)
        if now - LAST_PING[0] > EXIT_WHEN_IDLE:
            os._exit(0)


def open_log(path: Path):
    """Append to the log, keeping one previous file so it can never grow without limit."""
    try:
        if path.stat().st_size > MAX_LOG_BYTES:
            os.replace(path, path.with_name(path.name + ".1"))
    except OSError:
        pass
    return open(path, "a", encoding="utf-8", buffering=1)


def main():
    parse_args(sys.argv[1:])
    if core.FROZEN:  # windowed exe has no console: keep a log in the data folder
        log = open_log(core.DATA / "app.log")
        sys.stdout = sys.stderr = log
        print(f"\n--- start {time.ctime()} v{VERSION} data={core.DATA}")
    port = OPTS["port"]
    if instance_running(port):  # already open: just show it (with the dropped file, if any)
        show_running(app_url(port, OPTS["file"]))
        return
    srv = None
    for p in range(port, port + PORT_SEARCH_RANGE):
        try:
            srv = AppServer(("127.0.0.1", p), Handler)
            OPTS["port"] = p
            break
        except OSError:
            if instance_running(p):
                show_running(app_url(p, OPTS["file"]))
                return
    if srv is None:
        print("No free port found.")
        return
    global RECORDER
    if OPTS["live"]:
        RECORDER = lra_live.LiveRecorder(OPTS["live_url"]).start()
    url = app_url(OPTS["port"], OPTS["file"])
    print(f"League Replay Analyzer running at {url}  (data: {core.DATA})  Ctrl+C to stop")
    if OPTS["browser"] and lra_window.available():
        run_with_window(srv, url)
        return
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
