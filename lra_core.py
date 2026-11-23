"""
League Replay Analyzer - core: paths, config, .rofl parsing, Riot API, League client (LCU), Data Dragon assets.
"""
import base64
import collections
import http.client
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

APP_NAME = "League Replay Analyzer"
FROZEN = bool(getattr(sys, "frozen", False))          # running as the packaged .exe
SRC_ROOT = Path(__file__).resolve().parent
RES_ROOT = Path(getattr(sys, "_MEIPASS", SRC_ROOT))  # bundled resources (static/) when frozen
STATIC = RES_ROOT / "static"


def _data_dir():
    """Where cache/config/live recordings live. Source checkout: the project folder.
    Packaged .exe: %LOCALAPPDATA%\\League Replay Analyzer (or the exe's folder if a portable.txt sits next to it)."""
    if not FROZEN:
        return SRC_ROOT
    exe_dir = Path(sys.executable).resolve().parent
    if (exe_dir / "portable.txt").exists():
        return exe_dir
    base = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
    return base / APP_NAME


DATA = _data_dir()
DATA.mkdir(parents=True, exist_ok=True)
CACHE = DATA / "cache"
CONFIG_FILE = DATA / "config.json"
LIVE_DIR = DATA / "live"
DEFAULT_REPLAY_DIR = Path(os.path.expanduser("~")) / "Documents" / "League of Legends" / "Replays"

PLATFORM_TO_REGION = {
    "NA1": "americas", "BR1": "americas", "LA1": "americas", "LA2": "americas",
    "EUW1": "europe", "EUN1": "europe", "TR1": "europe", "RU": "europe", "ME1": "europe",
    "KR": "asia", "JP1": "asia",
    "OC1": "sea", "PH2": "sea", "SG2": "sea", "TH2": "sea", "TW2": "sea", "VN2": "sea",
}

USER_AGENT = "LeagueReplayAnalyzer/1.0"
RIOT_API_BASE = "https://{region}.api.riotgames.com"
DDRAGON_BASE = "https://ddragon.leagueoflegends.com"
DDRAGON_FALLBACK_VERSION = "15.1.1"
DDRAGON_OLD_MAP_VERSION = "6.8.1"     # the last version that still serves the plain Summoner's Rift image
LCU_BASE = "https://127.0.0.1"
RIOT_TIMEOUT = 30
LCU_TIMEOUT = 30
DDRAGON_VERSIONS_TIMEOUT = 15
DDRAGON_CHAMPIONS_TIMEOUT = 20
DDRAGON_ASSET_TIMEOUT = 15

ROFL_MAGIC = b"RIOT"
ROFL_HEADER_BYTES = 64
ROFL_METADATA_MARKER = b'{"gameLength"'
ROFL_STATS_KEY = b'"statsJson"'               # fallback anchor if Riot ever reorders the metadata keys
ROFL_MAX_BRACE_STEPS = 32
ROFL_DAMAGED = "This replay file is damaged or incomplete."
ROFL_TAIL_SEARCH_BYTES = (1 << 20, 8 << 20)   # the metadata sits near the end of the file: try the cheap reads first
ROFL_MAX_SCAN_BYTES = 256 << 20               # never load more of a file than this into memory
MAX_API_RESPONSE = 64 << 20
MAX_ASSET_BYTES = 8 << 20

# Windows API values
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
ERROR_ACCESS_DENIED = 5
STILL_ACTIVE = 259
DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
VK_MENU = 0x12
KEYEVENTF_KEYUP = 2
SW_SHOWNOACTIVATE = 4
SW_RESTORE = 9
HWND_BOTTOM = 1
SWP_NOSIZE_NOMOVE_NOACTIVATE = 0x0001 | 0x0002 | 0x0010

REPLACE_ATTEMPTS = 8           # Windows refuses to replace a file while another thread is reading it
REPLACE_RETRY_SECONDS = 0.02

_lock = threading.Lock()
_meta_cache = {}  # path -> (mtime, summary)


# ---------------------------------------------------------------- config
CONFIG_READ_ATTEMPTS = 5
CONFIG_RETRY_SECONDS = 0.05
_last_config = {}


def _keep_damaged_config():
    """Saving would overwrite a damaged config (and the API key in it), so keep one copy for recovery."""
    copy = CONFIG_FILE.with_name("config.damaged.json")
    try:
        if not copy.exists():
            shutil.copy2(CONFIG_FILE, copy)
    except OSError:
        pass


def load_config() -> dict:
    """A missing or damaged file is an empty config. A brief read failure returns the last good one,
    because the next save would otherwise erase every setting."""
    global _last_config
    for _ in range(CONFIG_READ_ATTEMPTS):
        try:
            cfg = json.loads(CONFIG_FILE.read_text("utf-8"))
        except FileNotFoundError:
            return {}
        except OSError:
            time.sleep(CONFIG_RETRY_SECONDS)
            continue
        except ValueError:
            _keep_damaged_config()
            return {}
        if not isinstance(cfg, dict):
            _keep_damaged_config()
            return {}
        _last_config = cfg
        return dict(cfg)
    return dict(_last_config)


def read_limited(response, limit: int) -> bytes:
    """Read a network response, refusing one far larger than this kind of response can legitimately be."""
    body = response.read(limit + 1)
    if len(body) > limit:
        raise ValueError("response too large")
    return body


def replace_file(src, dst):
    """os.replace, waiting briefly if another thread still has the target open."""
    for attempt in range(REPLACE_ATTEMPTS):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if attempt == REPLACE_ATTEMPTS - 1:
                raise
            time.sleep(REPLACE_RETRY_SECONDS * (attempt + 1))


def write_atomic_bytes(path, data: bytes):
    """Write via a temp file so a crash or a second request can never leave a half-written file behind."""
    path = Path(path)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        tmp.write_bytes(data)
        replace_file(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def write_atomic(path, text: str):
    write_atomic_bytes(path, text.encode("utf-8"))


def save_config(cfg: dict):
    global _last_config
    write_atomic(CONFIG_FILE, json.dumps(cfg, indent=2))
    _last_config = dict(cfg)


def replay_dir():
    d = load_config().get("replayDir")
    return Path(d) if d else DEFAULT_REPLAY_DIR


# ---------------------------------------------------------------- rofl parsing
def _metadata_text(blob: bytes):
    """Text starting at the metadata JSON, or None. Prefers the usual first key, else walks back from the stats key."""
    idx = blob.rfind(ROFL_METADATA_MARKER)
    if idx >= 0:
        return blob[idx:].decode("utf-8", "replace")
    start = blob.rfind(ROFL_STATS_KEY)
    for _ in range(ROFL_MAX_BRACE_STEPS):
        if start <= 0:
            return None
        start = blob.rfind(b"{", 0, start)
        if start < 0:
            return None
        text = blob[start:].decode("utf-8", "replace")
        try:
            obj, _end = json.JSONDecoder().raw_decode(text)
        except ValueError:
            continue
        if isinstance(obj, dict) and "statsJson" in obj:
            return text
    return None


def _read_rofl_metadata(path: Path, size: int):
    """Return (first header bytes, text starting at the metadata JSON)."""
    with open(path, "rb") as f:
        head = f.read(ROFL_HEADER_BYTES)
        if not head.startswith(ROFL_MAGIC):
            raise ValueError("This is not a League replay file.")
        text = None
        for tail_len in ROFL_TAIL_SEARCH_BYTES:
            f.seek(size - min(size, tail_len))
            text = _metadata_text(f.read())
            if text:
                break
        if not text:
            f.seek(max(0, size - ROFL_MAX_SCAN_BYTES))
            text = _metadata_text(f.read())
        if not text:
            raise ValueError("Could not find the game data in this replay file.")
    return head, text


def _player_stats(raw) -> list:
    """The per-player stats, keeping only well-formed entries. A replay can legitimately have none."""
    try:
        stats = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return []
    return [p for p in stats if isinstance(p, dict)] if isinstance(stats, list) else []


def _ids_from_filename(stem: str):
    """'NA1-5123456789' -> ('NA1', '5123456789'); (None, None) for a renamed file."""
    m = re.match(r"([A-Za-z]+\d*)-(\d+)", stem)
    return (m.group(1).upper(), m.group(2)) if m else (None, None)


def parse_rofl(path: Path) -> dict:
    """Return dict with version, gameLength, players, platform, gameId."""
    path = Path(path)
    head, text = _read_rofl_metadata(path, path.stat().st_size)
    try:
        meta, _ = json.JSONDecoder().raw_decode(text)
    except ValueError:
        raise ValueError(ROFL_DAMAGED) from None
    if not isinstance(meta, dict):
        raise ValueError(ROFL_DAMAGED)
    stats = _player_stats(meta.get("statsJson"))
    m = re.search(rb"(\d+\.\d+\.\d+\.\d+)", head)
    version = m.group(1).decode() if m else None
    platform, game_id = _ids_from_filename(path.stem)
    return summarize(meta, stats, version, platform, game_id, path.name)


def _stat(player: dict, key: str) -> int:
    try:
        return int(player.get(key, 0) or 0)
    except (TypeError, ValueError):
        return 0


def _summarize_player(p: dict) -> dict:
    return {
        "puuid": p.get("PUUID"),
        "name": p.get("RIOT_ID_GAME_NAME") or p.get("NAME"),
        "tag": p.get("RIOT_ID_TAG_LINE"),
        "champion": p.get("SKIN"),
        "team": _stat(p, "TEAM"),
        "position": p.get("TEAM_POSITION") or p.get("INDIVIDUAL_POSITION"),
        "win": p.get("WIN") == "Win",
        "kills": _stat(p, "CHAMPIONS_KILLED"),
        "deaths": _stat(p, "NUM_DEATHS"),
        "assists": _stat(p, "ASSISTS"),
        "gold": _stat(p, "GOLD_EARNED"),
        "visionScore": _stat(p, "VISION_SCORE"),
        "wardsPlaced": _stat(p, "WARD_PLACED"),
        "wardsKilled": _stat(p, "WARD_KILLED"),
        "cs": _stat(p, "MINIONS_KILLED") + _stat(p, "NEUTRAL_MINIONS_KILLED"),
        "level": _stat(p, "LEVEL"),
    }


def summarize(meta: dict, stats: list, version, platform, game_id, filename: str) -> dict:
    return {
        "file": filename,
        "version": version,
        "gameLength": meta.get("gameLength"),
        "platform": platform,
        "gameId": game_id,
        "matchId": f"{platform}_{game_id}" if platform and game_id else None,
        "players": [_summarize_player(p) for p in stats],
    }


def list_replays():
    d = replay_dir()
    out = []
    if not d.exists():
        return {"dir": str(d), "exists": False, "replays": []}
    stamped = []
    for p in d.glob("*.rofl"):
        try:
            stamped.append((p.stat().st_mtime, p))
        except OSError:  # deleted or moved while listing
            continue
    for mt, p in sorted(stamped, key=lambda x: x[0], reverse=True):
        with _lock:
            cached = _meta_cache.get(str(p))
        if cached and cached[0] == mt:
            s = cached[1]
        else:
            try:
                s = parse_rofl(p)
            except ValueError as e:  # keep listing even if one file is broken
                s = {"file": p.name, "error": str(e)}
            except Exception:
                s = {"file": p.name, "error": "Could not read this replay file."}
            with _lock:
                _meta_cache[str(p)] = (mt, s)
        s = dict(s)
        s["mtime"] = mt
        s["cached"] = bool(s.get("matchId")) and (CACHE / f"{s['matchId']}.json").exists()
        out.append(s)
    return {"dir": str(d), "exists": True, "replays": out}


# ---------------------------------------------------------------- Riot API
class RiotError(Exception):
    def __init__(self, status, msg, retry_after=None):
        super().__init__(msg)
        self.status = status
        self.retry_after = retry_after


RIOT_DEV_KEY_LIMITS = ((20, 1.0), (100, 120.0))
RIOT_MAX_ATTEMPTS = 4
RIOT_BACKOFF_SECONDS = 1.0
RIOT_MAX_WAIT_SECONDS = 20      # longer than this, fall back to the League client rather than freeze the page
RIOT_RETRY_STATUSES = {429, 500, 502, 503, 504}
RIOT_FIREWALL_BLOCK = 520       # our own status: not retried, and the key stays valid


class RateLimiter:
    """Sliding-window limiter shared by all Riot API calls; updated from Riot's X-App-Rate-Limit header."""

    def __init__(self, windows=RIOT_DEV_KEY_LIMITS):
        self.windows = list(windows)
        self.calls = collections.deque()
        self.lock = threading.Lock()

    def update(self, header):
        try:
            limits = [part.split(":") for part in header.split(",")]
            parsed = [(max(1, int(int(n) * 0.95)), float(s)) for n, s in limits]
        except (AttributeError, ValueError):
            return
        with self.lock:
            self.windows = parsed

    def _wait_needed(self, now):
        longest = max(s for _, s in self.windows)
        while self.calls and now - self.calls[0] > longest:
            self.calls.popleft()
        wait = 0.0
        for n, s in self.windows:
            inside = [t for t in self.calls if now - t < s]
            if len(inside) >= n:
                wait = max(wait, s - (now - inside[-n]))
        return wait

    def acquire(self, max_wait: float) -> bool:
        """Take a slot, waiting if needed. False if that would take longer than max_wait."""
        deadline = time.monotonic() + max_wait
        while True:
            with self.lock:
                now = time.monotonic()
                wait = self._wait_needed(now)
                if wait <= 0:
                    self.calls.append(now)
                    return True
            if now + wait > deadline:
                return False
            time.sleep(wait)


RIOT_LIMITER = RateLimiter()


RIOT_ERROR_HINTS = {
    401: "API key missing or invalid.",
    403: "API key rejected (development keys expire every 24h - generate a new one).",
    404: "Match not found (Riot keeps match history for about 2 years; custom games may not be available).",
    429: "Rate limited by Riot - wait a minute and try again.",
}


def _retry_after(headers):
    try:
        return float(headers.get("Retry-After"))
    except (AttributeError, TypeError, ValueError):
        return None


def _riot_request(url: str, key: str):
    req = urllib.request.Request(url, headers={"X-Riot-Token": key, "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=RIOT_TIMEOUT, context=ssl.create_default_context()) as r:
            RIOT_LIMITER.update(r.headers.get("X-App-Rate-Limit"))
            return json.loads(read_limited(r, MAX_API_RESPONSE).decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:300]
        if e.code == 403 and body.startswith("error code:"):   # Riot's firewall, not a verdict on the API key
            raise RiotError(RIOT_FIREWALL_BLOCK, "Riot's firewall blocked this request. Try again later.")
        raise RiotError(e.code, RIOT_ERROR_HINTS.get(e.code, f"Riot API error (HTTP {e.code})."), _retry_after(e.headers))
    except urllib.error.URLError:
        raise RiotError(502, "Could not reach Riot's servers.")
    except (TimeoutError, ConnectionError, ValueError, http.client.HTTPException):  # slow or cut-off response
        raise RiotError(502, "Riot's response could not be read.")


def riot_get(region: str, path: str, key: str):
    """GET from the Riot API with rate limiting, and exponential backoff on rate limits and server errors."""
    url = RIOT_API_BASE.format(region=region) + path
    for attempt in range(RIOT_MAX_ATTEMPTS):
        if not RIOT_LIMITER.acquire(RIOT_MAX_WAIT_SECONDS):
            raise RiotError(429, RIOT_ERROR_HINTS[429])
        try:
            return _riot_request(url, key)
        except RiotError as e:
            wait = e.retry_after if e.retry_after is not None else RIOT_BACKOFF_SECONDS * 2 ** attempt
            if e.status not in RIOT_RETRY_STATUSES or attempt == RIOT_MAX_ATTEMPTS - 1 or wait > RIOT_MAX_WAIT_SECONDS:
                raise
            time.sleep(wait)


rejected_keys = set()


def is_match_payload(m) -> bool:
    """The parts of a Match-V5 match the analysis cannot work without."""
    info = m.get("info") if isinstance(m, dict) else None
    parts = info.get("participants") if isinstance(info, dict) else None
    return isinstance(parts, list) and bool(parts) and all(isinstance(p, dict) and "participantId" in p and "teamId" in p for p in parts)


def is_timeline_payload(t) -> bool:
    info = t.get("info") if isinstance(t, dict) else None
    frames = info.get("frames") if isinstance(info, dict) else None
    return isinstance(frames, list) and bool(frames) and all(isinstance(f, dict) for f in frames)


def is_game_data(d) -> bool:
    return isinstance(d, dict) and is_match_payload(d.get("match")) and is_timeline_payload(d.get("timeline"))


def _read_cached_match(path: Path):
    """The cached game, or None if it is missing, damaged or not a complete game (it is then downloaded again)."""
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    return data if is_game_data(data) else None


def _read_partial_match(path: Path):
    try:
        match = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    return match if is_match_payload(match) else None


def _fetch_riot_match(region: str, match_id: str, key: str, resume: bool = True) -> dict:
    """A match whose timeline call failed is kept in a .part file, so a retry only requests the timeline."""
    part = CACHE / f"{match_id}.part.json"
    match = _read_partial_match(part) if resume else None
    if match is None:
        match = riot_get(region, f"/lol/match/v5/matches/{match_id}", key)
        if not is_match_payload(match):
            raise RiotError(502, "Riot returned an unexpected response for this match.")
        write_atomic(part, json.dumps(match))
    timeline = riot_get(region, f"/lol/match/v5/matches/{match_id}/timeline", key)
    if not is_timeline_payload(timeline):
        raise RiotError(502, "Riot returned an unexpected response for this match.")
    part.unlink(missing_ok=True)
    return {"source": "riot-api", "match": match, "timeline": timeline}


API_PUBLISH_WINDOW = 24 * 3600   # a 404 for a game newer than this may just mean Riot hasn't published it yet
API_RECHECK_SECONDS = 600
_match_locks = {}


def _note_missing_on_api(data: dict):
    created = (data.get("match", {}).get("info") or {}).get("gameCreation")
    if created and time.time() - created / 1000 < API_PUBLISH_WINDOW:
        data["apiRetryAt"] = time.time() + API_RECHECK_SECONDS
    else:
        data["apiMissing"] = True


def get_match(match_id: str, refresh: bool = False) -> dict:
    """One download per match at a time: a second request for the same game waits and then reads the cache."""
    with _lock:
        match_lock = _match_locks.setdefault(match_id, threading.Lock())
    with match_lock:
        return _load_match(match_id, refresh)


def _load_match(match_id: str, refresh: bool) -> dict:
    """Match + timeline. Sources: local cache -> Riot API (needs key) -> running League client (no key)."""
    CACHE.mkdir(exist_ok=True)
    cf = CACHE / f"{match_id}.json"
    key = load_config().get("apiKey")
    cached = _read_cached_match(cf)
    if cached:
        # an API key gives richer data (wards, items, levels) than the client; upgrade client-sourced caches
        upgradable = cached.get("source") == "lcu" and key and not cached.get("apiMissing") and time.time() >= cached.get("apiRetryAt", 0)
        if not refresh and not upgradable:
            return cached
    platform = match_id.split("_")[0].upper()
    region = PLATFORM_TO_REGION.get(platform)
    if not region:
        raise RiotError(400, f"Unknown platform '{platform}'")
    errors = []
    api_missing = False
    if key and key in rejected_keys:
        errors.append("Riot API: key was rejected (expired?) - paste a fresh one")
    elif key:
        try:
            data = _fetch_riot_match(region, match_id, key, resume=not refresh)
            write_atomic(cf, json.dumps(data))
            return data
        except RiotError as e:
            if e.status in (401, 403):
                rejected_keys.add(key)
            if e.status == 404:  # custom / tournament games are not published to Match-V5
                api_missing = True
            errors.append(f"Riot API: {e}")
    # never replace richer Riot API data with the client's, and don't re-download a usable copy just because the API failed
    if cached and (cached.get("source") == "riot-api" or not refresh):
        if api_missing and cached.get("source") == "lcu" and not cached.get("apiMissing"):
            _note_missing_on_api(cached)
            write_atomic(cf, json.dumps(cached))
        return cached
    try:
        data = lcu_match(match_id)
        data["apiMissing"] = False
        if api_missing:
            _note_missing_on_api(data)
        write_atomic(cf, json.dumps(data))
        return data
    except RiotError as e:
        errors.append(f"League client: {e}")
    if cached:
        return cached
    if not key:
        errors.insert(0, "No Riot API key set")
    raise RiotError(503, " · ".join(errors))


# ---------------------------------------------------------------- League client (LCU) - no API key needed
def _configured_league_dir():
    d = load_config().get("leagueDir")
    return Path(d) if d else None


def _riot_install_dirs() -> list:
    """League folders from the Riot Client's own install list (finds installs outside the usual paths)."""
    try:
        inst = Path(os.environ.get("ProgramData", r"C:\ProgramData")) / "Riot Games" / "RiotClientInstalls.json"
        return [Path(k) for k in (json.loads(inst.read_text("utf-8")).get("associated_client") or {}) if "League of Legends" in k]
    except (OSError, ValueError, AttributeError):
        return []


LOCKFILE_CACHE_SECONDS = 2      # every poll asks for this; probing several drives each time can stall on a sleeping disk
_lockfile_cache = {"at": 0.0, "dir": None, "path": None}


def find_lockfile():
    cfg_dir = _configured_league_dir()
    now = time.time()
    if now - _lockfile_cache["at"] < LOCKFILE_CACHE_SECONDS and _lockfile_cache["dir"] == cfg_dir:
        return _lockfile_cache["path"]
    cands = [cfg_dir / "lockfile"] if cfg_dir else []
    cands += [d / "lockfile" for d in _riot_install_dirs()]
    for drive in "CDEFGH":
        cands += [Path(f"{drive}:/Riot Games/League of Legends/lockfile"),
                  Path(f"{drive}:/Program Files/Riot Games/League of Legends/lockfile"),
                  Path(f"{drive}:/Games/Riot Games/League of Legends/lockfile")]
    found = None
    for c in dict.fromkeys(cands):
        try:
            if c.exists() and _lockfile_live(c):
                found = c
                break
        except OSError:
            continue
    _lockfile_cache.update(at=now, dir=cfg_dir, path=found)
    return found


def _pid_image(pid):
    """Full exe path of a running process; None if it isn't running ('' if it's running but unreadable)."""
    if os.name != "nt":
        return ""
    import ctypes
    from ctypes import wintypes
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.OpenProcess.restype, k.OpenProcess.argtypes = wintypes.HANDLE, [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    k.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    k.CloseHandle.argtypes = [wintypes.HANDLE]
    h = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not h:
        return "" if ctypes.get_last_error() == ERROR_ACCESS_DENIED else None  # access denied: it exists
    try:
        code = wintypes.DWORD()
        if k.GetExitCodeProcess(h, ctypes.byref(code)) and code.value != STILL_ACTIVE:
            return None
        buf, n = ctypes.create_unicode_buffer(1024), wintypes.DWORD(1024)
        return buf.value if k.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n)) else ""
    finally:
        k.CloseHandle(h)


def _lockfile_live(lf):
    """A lockfile stays behind when the client doesn't exit cleanly. Talking to its dead port costs ~2 s per
    request on Windows, so only trust it while its process (LeagueClient.exe) is running."""
    try:
        parts = lf.read_text().split(":")
        img = _pid_image(int(parts[1]))
    except (OSError, ValueError, IndexError):
        return False
    return img is not None and (img == "" or Path(img).name.lower().startswith("leagueclient"))


def process_name(pid):
    """Image name of a running process ('League of Legends.exe'), or None."""
    img = _pid_image(pid)
    return Path(img).name if img else None


def lcu_request(path: str, method: str = "GET", body=None, timeout: float = LCU_TIMEOUT):
    lf = find_lockfile()
    if not lf:
        raise RiotError(503, "League client is not running (open League to load matches without an API key).")
    try:
        parts = lf.read_text().split(":")
        port, pw = parts[2], parts[3]
    except (OSError, IndexError):  # the client is closing or still writing the file
        raise RiotError(503, "League client not reachable. Is it logged in?")
    auth = base64.b64encode(f"riot:{pw}".encode()).decode()
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": f"Basic {auth}"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{LCU_BASE}:{port}{path}", data=data, method=method, headers=headers)
    try:
        # the client uses a self-signed certificate on localhost
        with urllib.request.urlopen(req, timeout=timeout, context=ssl._create_unverified_context()) as r:
            raw = read_limited(r, MAX_API_RESPONSE).decode("utf-8")
            return json.loads(raw) if raw.strip() else None
    except urllib.error.HTTPError as e:
        msg = e.read().decode("utf-8", "replace")[:200]
        try:
            msg = json.loads(msg).get("message") or msg
        except Exception:
            pass
        raise RiotError(e.code, f"client returned HTTP {e.code}: {msg}")
    except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException):
        raise RiotError(503, "League client not reachable. Is it logged in?")


def lcu_get(path: str, timeout: float = LCU_TIMEOUT):
    return lcu_request(path, timeout=timeout)


_champ_table = None


def _read_champion_table(path: Path):
    """The saved champion table, or None if it is damaged."""
    try:
        table = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    valid = isinstance(table, list) and all(isinstance(c, dict) and {"key", "id", "name"} <= c.keys() for c in table)
    return table if valid else None


def champion_table():
    """[{key: '62', id: 'MonkeyKing', name: 'Wukong'}, ...] from Data Dragon (cached)."""
    global _champ_table
    if _champ_table is not None:
        return _champ_table
    CACHE.mkdir(exist_ok=True)
    cf = CACHE / f"champdata_{ddragon_version()}.json"
    table = _read_champion_table(cf) if cf.exists() else None
    if table is not None:
        _champ_table = table
        return _champ_table
    try:
        url = f"{DDRAGON_BASE}/cdn/{ddragon_version()}/data/en_US/champion.json"
        with urllib.request.urlopen(url, timeout=DDRAGON_CHAMPIONS_TIMEOUT) as r:
            data = json.loads(read_limited(r, MAX_API_RESPONSE))["data"]
        _champ_table = [{"key": v["key"], "id": v["id"], "name": v["name"]} for v in data.values()]
        write_atomic(cf, json.dumps(_champ_table))
    except Exception:  # offline on a new patch: use the newest table we have, and try again next time
        older = sorted(CACHE.glob("champdata_*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        return next((t for t in map(_read_champion_table, older) if t is not None), [])
    return _champ_table


def champion_names():
    return {c["key"]: c["id"] for c in champion_table()}


def champion_id_from_name(display_or_id):
    """'Wukong' / 'MonkeyKing' / 'Kai'Sa' -> internal id ('MonkeyKing')."""
    if not display_or_id:
        return display_or_id
    norm = re.sub(r"[^a-z0-9]", "", str(display_or_id).lower())
    for c in champion_table():
        if norm in (re.sub(r"[^a-z0-9]", "", c["id"].lower()), re.sub(r"[^a-z0-9]", "", c["name"].lower())):
            return c["id"]
    return display_or_id


def replay_meta_for(match_id):
    platform, gid = match_id.split("_", 1)
    p = replay_dir() / f"{platform}-{gid}.rofl"
    if p.exists():
        try:
            return parse_rofl(p)
        except Exception:
            return None
    return None


LANE_TO_POSITION = {"TOP": "TOP", "JUNGLE": "JUNGLE", "MIDDLE": "MIDDLE", "MID": "MIDDLE", "BOTTOM": "BOTTOM", "BOT": "BOTTOM"}
SMITE_SPELL_ID = 11


def _guess_position(p: dict) -> str:
    """Custom games often have no position: Smite means jungle, and the bot lane's support is marked by its role."""
    tline = p.get("timeline") or {}
    if SMITE_SPELL_ID in (p.get("spell1Id"), p.get("spell2Id")):
        return "JUNGLE"
    if tline.get("role") == "DUO_SUPPORT":
        return "UTILITY"
    return LANE_TO_POSITION.get(tline.get("lane", ""), "")


def _lcu_participant(p: dict, player: dict, replay_player: dict, names: dict) -> dict:
    st = p.get("stats", {})
    champ = replay_player.get("champion") or names.get(str(p.get("championId")), str(p.get("championId")))
    return {
        "participantId": p["participantId"], "puuid": player.get("puuid"), "teamId": p["teamId"], "championName": champ,
        "riotIdGameName": player.get("gameName") or player.get("summonerName") or champ, "riotIdTagline": player.get("tagLine", ""),
        "teamPosition": replay_player.get("position") or _guess_position(p),
        "kills": st.get("kills", 0), "deaths": st.get("deaths", 0), "assists": st.get("assists", 0), "win": bool(st.get("win")),
        "goldEarned": st.get("goldEarned", 0), "visionScore": st.get("visionScore", replay_player.get("visionScore", 0)),
        "wardsPlaced": st.get("wardsPlaced", replay_player.get("wardsPlaced", 0)), "wardsKilled": st.get("wardsKilled", replay_player.get("wardsKilled", 0)),
        "visionWardsBoughtInGame": st.get("visionWardsBoughtInGame", 0), "champLevel": st.get("champLevel", 0),
        "totalMinionsKilled": st.get("totalMinionsKilled", 0), "neutralMinionsKilled": st.get("neutralMinionsKilled", 0),
    }


def lcu_match(match_id: str) -> dict:
    gid = match_id.split("_", 1)[1]
    g = lcu_get(f"/lol-match-history/v1/games/{gid}")
    tl = lcu_get(f"/lol-match-history/v1/game-timelines/{gid}")
    if not (g or {}).get("participants") or not (tl or {}).get("frames"):  # don't cache an empty game forever
        raise RiotError(404, "The League client has no timeline for this game.")
    names = champion_names()
    meta = replay_meta_for(match_id)
    meta_by_puuid = {p["puuid"]: p for p in (meta or {}).get("players", [])}
    ident = {i["participantId"]: i.get("player", {}) for i in g.get("participantIdentities", [])}
    parts = []
    for p in g.get("participants", []):
        player = ident.get(p["participantId"], {})
        parts.append(_lcu_participant(p, player, meta_by_puuid.get(player.get("puuid"), {}), names))
    match = {"metadata": {"matchId": match_id}, "info": {
        "gameId": g.get("gameId"), "gameDuration": g.get("gameDuration"), "mapId": g.get("mapId"), "queueId": g.get("queueId"),
        "gameMode": g.get("gameMode"), "gameVersion": g.get("gameVersion"), "gameCreation": g.get("gameCreation"),
        "participants": parts,
        "teams": [{"teamId": t["teamId"], "win": t.get("win") == "Win"} for t in g.get("teams", [])],
    }}
    timeline = {"metadata": {"matchId": match_id}, "info": {"frameInterval": 60000, "frames": tl.get("frames", [])}}
    return {"source": "lcu", "match": match, "timeline": timeline}


def lcu_platform():
    try:
        v = lcu_get("/lol-platform-config/v1/namespaces/LoginDataPacket/platformId", timeout=5)
        if isinstance(v, str) and v:
            return v.upper()
    except RiotError:
        pass
    plats = [r.get("platform") for r in list_replays().get("replays", []) if r.get("platform")]
    return max(set(plats), key=plats.count) if plats else "NA1"


# ---------------------------------------------------------------- assets (cached Data Dragon)
_dd_version = None
_dd_retry_at = 0
DDRAGON_RETRY_SECONDS = 300


def ddragon_version() -> str:
    """The latest Data Dragon version. After a failed lookup the saved one is used, and checked again in a few minutes."""
    global _dd_version, _dd_retry_at
    if _dd_version and (not _dd_retry_at or time.time() < _dd_retry_at):
        return _dd_version
    vf = CACHE / "ddragon_version.txt"
    try:
        with urllib.request.urlopen(f"{DDRAGON_BASE}/api/versions.json", timeout=DDRAGON_VERSIONS_TIMEOUT) as r:
            latest = json.loads(read_limited(r, MAX_API_RESPONSE))[0]
        if not isinstance(latest, str):
            raise ValueError("unexpected version list")
        CACHE.mkdir(exist_ok=True)
        write_atomic(vf, latest)
        _dd_version, _dd_retry_at = latest, 0
    except Exception:
        _dd_version = vf.read_text().strip() if vf.exists() else DDRAGON_FALLBACK_VERSION
        _dd_retry_at = time.time() + DDRAGON_RETRY_SECONDS
    return _dd_version


def _is_complete_png(b: bytes) -> bool:
    return b.startswith(b"\x89PNG\r\n\x1a\n") and b"IEND" in b[-16:]


CHAMP_FIX = {"FiddleSticks": "Fiddlesticks"}


def get_asset(kind, name):
    adir = CACHE / "assets"
    adir.mkdir(parents=True, exist_ok=True)
    if kind == "map":
        local = adir / "map11.png"
        urls = [f"{DDRAGON_BASE}/cdn/{ddragon_version()}/img/map/map11.png",
                f"{DDRAGON_BASE}/cdn/{DDRAGON_OLD_MAP_VERSION}/img/map/map11.png"]
    elif kind == "champ":
        name = re.sub(r"[^A-Za-z0-9]", "", name)
        name = CHAMP_FIX.get(name, name)
        local = adir / f"champ_{name}.png"
        urls = [f"{DDRAGON_BASE}/cdn/{ddragon_version()}/img/champion/{name}.png"]
    else:
        return None
    if local.exists():
        b = local.read_bytes()
        if _is_complete_png(b):
            return b
    for u in urls:
        try:
            with urllib.request.urlopen(u, timeout=DDRAGON_ASSET_TIMEOUT) as r:
                b = read_limited(r, MAX_ASSET_BYTES)
            if _is_complete_png(b):
                write_atomic_bytes(local, b)
                return b
        except Exception:
            continue
    return None


# ---------------------------------------------------------------- League game config (Replay API toggle)
def game_cfg_path():
    lf = find_lockfile()
    d = _configured_league_dir() or (lf.parent if lf else None)
    if not d:
        dirs = league_install_dirs()
        d = dirs[0] if dirs else None
    return d / "Config" / "game.cfg" if d else None


def replay_api_enabled():
    p = game_cfg_path()
    try:
        return bool(p and re.search(r"(?im)^\s*EnableReplayApi\s*=\s*1\s*$", p.read_text("utf-8", "replace")))
    except OSError:
        return False


def _with_replay_api(txt: str) -> str:
    newline = "\r\n" if "\r\n" in txt else "\n"
    if re.search(r"(?im)^[ \t]*EnableReplayApi[ \t]*=", txt):
        return re.sub(r"(?im)^[ \t]*EnableReplayApi[ \t]*=[^\r\n]*", "EnableReplayApi=1", txt)
    header = re.search(r"(?im)^\[General\][ \t]*(\r?\n|\Z)", txt)
    if not header:
        return f"[General]{newline}EnableReplayApi=1{newline}" + txt
    insert = f"{'' if header.group(1) else newline}EnableReplayApi=1{newline}"
    return txt[:header.end()] + insert + txt[header.end():]


def enable_replay_api():
    """Adds EnableReplayApi=1 under [General] in League's game.cfg. Every other byte is preserved, the write is atomic,
    and a backup of the original is kept next to it."""
    p = game_cfg_path()
    if not p or not p.exists():
        raise RiotError(404, "Could not find League's Config/game.cfg (open the League client first).")
    raw = p.read_bytes()
    backup = p.with_name("game.cfg.lra-backup")
    if not backup.exists():
        write_atomic_bytes(backup, raw)
    txt = raw.decode("utf-8", "surrogateescape")  # keeps any non-UTF-8 bytes in League's file intact
    write_atomic_bytes(p, _with_replay_api(txt).encode("utf-8", "surrogateescape"))
    return True


# ---------------------------------------------------------------- v2: the real replay, played by League and shown in the app
LEAGUE_WINDOW = "League of Legends (TM) Client"   # title of the game window (also used to auto-pick it for capture)
_cv = {"v": None, "at": 0.0}


def patch_of(version):
    """'16.22.834.8910' -> '16.22'"""
    m = re.match(r"(\d+)\.(\d+)", str(version or ""))
    return f"{m.group(1)}.{m.group(2)}" if m else None


def client_patch():
    """Patch of the installed game, from the League client (cached for a minute). None if the client is closed."""
    now = time.time()
    if _cv["v"] and now - _cv["at"] < 60:
        return _cv["v"]
    if not _cv["v"] and now - _cv["at"] < 10:
        return None
    try:
        v = lcu_get("/lol-patch/v1/game-version", timeout=4)
    except RiotError:
        _cv.update(v=None, at=now)
        return None
    _cv.update(v=patch_of(v), at=now)
    return _cv["v"]


def league_install_dirs():
    configured = _configured_league_dir()
    out = [configured] if configured else []
    lf = find_lockfile()
    if lf:
        out.append(lf.parent)
    out += _riot_install_dirs()
    out += [Path(f"{d}:/Riot Games/League of Legends") for d in "CDEF"]
    return [d for d in dict.fromkeys(out) if (d / "Game" / "League of Legends.exe").is_file()]


_ip = {"v": None, "at": 0.0}


def _exe_major_minor(exe: str):
    """(major, minor) from a Windows exe's version resource, or None."""
    import ctypes
    from ctypes import wintypes
    size = ctypes.windll.version.GetFileVersionInfoSizeW(exe, None)
    if not size:
        return None
    buf = ctypes.create_string_buffer(size)
    if not ctypes.windll.version.GetFileVersionInfoW(exe, 0, size, buf):
        return None
    ptr, ln = ctypes.c_void_p(), wintypes.UINT()
    if not ctypes.windll.version.VerQueryValueW(buf, "\\", ctypes.byref(ptr), ctypes.byref(ln)):
        return None
    ms = ctypes.cast(ptr, ctypes.POINTER(wintypes.DWORD * 4))[0][2]  # VS_FIXEDFILEINFO.dwFileVersionMS
    return ms >> 16, ms & 0xFFFF


def installed_game_patch():
    """Patch of the installed game read from the game exe's version (works with the League client closed)."""
    now = time.time()
    if _ip["at"] and now - _ip["at"] < 300:
        return _ip["v"]
    _ip["at"] = now
    if os.name != "nt":
        return None
    versions = [v for v in (_exe_major_minor(str(d / "Game" / "League of Legends.exe")) for d in league_install_dirs()) if v]
    best = max(versions) if versions else None
    _ip["v"] = f"{best[0]}.{best[1]}" if best else None
    return _ip["v"]


def client_replay_folder():
    try:
        d = lcu_get("/lol-replays/v1/rofls/path", timeout=4)
        return Path(d) if d else None
    except RiotError:
        return None


def replay_file_for(match_id):
    platform, gid = match_id.split("_", 1)
    for d in {replay_dir(), DEFAULT_REPLAY_DIR}:
        p = d / f"{platform}-{gid}.rofl"
        if p.exists():
            return p
    return None


def ensure_in_client_folder(match_id, src_path=None):
    """League only plays replays that sit in its own Replays folder as PLATFORM-GAMEID.rofl: copy it there if needed."""
    platform, gid = match_id.split("_", 1)
    folder = client_replay_folder() or replay_dir()
    dest = folder / f"{platform}-{gid}.rofl"
    if dest.exists():
        return dest
    src = Path(src_path) if src_path else replay_file_for(match_id)
    if not src or not src.is_file() or src.suffix.lower() != ".rofl":
        raise RiotError(404, "League can't find this replay file. Put it in your League Replays folder.")
    folder.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)
    try:
        lcu_request("/lol-replays/v1/rofls/scan", "POST", {}, timeout=10)
    except RiotError:
        pass
    return dest


def watch_replay(match_id, src_path=None):
    ensure_in_client_folder(match_id, src_path)
    gid = int(match_id.split("_", 1)[1])
    lcu_request(f"/lol-replays/v1/rofls/{gid}/watch", "POST", {"componentType": "replay-button_match-history"}, timeout=15)


def start_league_client():
    """Start League through the Riot Client (same as clicking Play in the Riot Client)."""
    inst = Path(os.environ.get("ProgramData", r"C:\ProgramData")) / "Riot Games" / "RiotClientInstalls.json"
    exe = None
    try:
        j = json.loads(inst.read_text("utf-8"))
        exe = j.get("rc_live") or j.get("rc_default")
    except Exception:
        pass
    if not exe or not Path(exe).is_file():
        raise RiotError(404, "Could not find the Riot Client. Start League yourself.")
    args = [exe, "--launch-product=league_of_legends", "--launch-patchline=live"]
    # fully detached: League must keep running when this app closes
    flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    try:
        subprocess.Popen(args, close_fds=True, creationflags=flags | CREATE_BREAKAWAY_FROM_JOB)
    except OSError:
        subprocess.Popen(args, close_fds=True, creationflags=flags)
    return True


# ---- windows (Win32 via ctypes; no extra packages)
_u32 = []


def _user32():
    if os.name != "nt":
        return None
    if _u32:
        return _u32[0]
    import ctypes
    from ctypes import wintypes
    u = ctypes.WinDLL("user32", use_last_error=True)
    H = wintypes.HWND
    sig = {
        "FindWindowW": (H, [wintypes.LPCWSTR, wintypes.LPCWSTR]), "GetForegroundWindow": (H, []),
        "IsWindowVisible": (wintypes.BOOL, [H]), "IsIconic": (wintypes.BOOL, [H]), "ShowWindow": (wintypes.BOOL, [H, ctypes.c_int]),
        "SetForegroundWindow": (wintypes.BOOL, [H]), "GetWindowTextW": (ctypes.c_int, [H, wintypes.LPWSTR, ctypes.c_int]),
        "GetClassNameW": (ctypes.c_int, [H, wintypes.LPWSTR, ctypes.c_int]),
        "GetClientRect": (wintypes.BOOL, [H, ctypes.POINTER(wintypes.RECT)]),
        "GetWindowThreadProcessId": (wintypes.DWORD, [H, ctypes.POINTER(wintypes.DWORD)]),
        "SetWindowPos": (wintypes.BOOL, [H, H, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]),
        "keybd_event": (None, [wintypes.BYTE, wintypes.BYTE, wintypes.DWORD, ctypes.c_void_p]),
    }
    for name, (res, args) in sig.items():
        f = getattr(u, name)
        f.restype, f.argtypes = res, args
    _u32.append(u)
    return u


def find_window(title, prefix=False):
    """Handle of the top-level window with this title. prefix=True: the first visible browser window
    (Edge/Chrome) whose title starts with it - the app's own window."""
    u = _user32()
    if not u:
        return None
    if not prefix:
        return u.FindWindowW(None, title) or None
    import ctypes
    from ctypes import wintypes
    found = []
    buf = ctypes.create_unicode_buffer(512)
    cls = ctypes.create_unicode_buffer(256)

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        if u.IsWindowVisible(hwnd):
            u.GetWindowTextW(hwnd, buf, 512)
            u.GetClassNameW(hwnd, cls, 256)
            if buf.value.startswith(title) and cls.value.startswith("Chrome_WidgetWin"):
                found.append(hwnd)
                return False
        return True
    u.EnumWindows.argtypes = [ctypes.c_void_p, wintypes.LPARAM]
    u.EnumWindows(cb, 0)
    return found[0] if found else None


def league_window_pid():
    """Process id behind League's game window (None if there's no such window)."""
    u = _user32()
    hwnd = find_window(LEAGUE_WINDOW) if u else None
    if not hwnd:
        return None
    import ctypes
    from ctypes import wintypes
    pid = wintypes.DWORD()
    u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value or None


def league_window_info():
    u = _user32()
    hwnd = find_window(LEAGUE_WINDOW)
    if not hwnd:
        return None
    import ctypes
    from ctypes import wintypes
    r = wintypes.RECT()
    u.GetClientRect(hwnd, ctypes.byref(r))
    return {"minimized": bool(u.IsIconic(hwnd)), "w": r.right - r.left, "h": r.bottom - r.top,
            "foreground": u.GetForegroundWindow() == hwnd}


def _force_foreground(u, hwnd):
    # Windows only lets the foreground app hand focus over; a synthetic Alt press satisfies that rule.
    u.keybd_event(VK_MENU, 0, 0, None)
    u.SetForegroundWindow(hwnd)
    u.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, None)


def arrange_windows(action, app_title):
    """'behind': un-minimise League (a minimised window can't be captured) and tuck it behind every other window.
    'app':    bring the app's window to the front (League pops up on top when it opens a replay).
    'front':  bring League's own window forward (to use its own controls directly)."""
    u = _user32()
    if not u:
        return False
    if action == "app":
        aw = find_window(app_title, prefix=True)
        if not aw:
            return False
        if u.IsIconic(aw):
            u.ShowWindow(aw, SW_RESTORE)
        _force_foreground(u, aw)
        return True
    lw = find_window(LEAGUE_WINDOW)
    if not lw:
        return False
    if action == "front":
        if u.IsIconic(lw):
            u.ShowWindow(lw, SW_RESTORE)
        _force_foreground(u, lw)
        return True
    if action == "behind":
        if u.IsIconic(lw):
            u.ShowWindow(lw, SW_SHOWNOACTIVATE)
        u.SetWindowPos(lw, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOSIZE_NOMOVE_NOACTIVATE)
        return True
    return False
