"""
Download recent high-elo (Challenger / Grandmaster / Master) ranked solo-queue games from the Riot API,
for training the win-probability model.

    python train/fetch_highelo.py [--target 4000] [--days 60] [--platform na1]

- Respects the key's rate limits (reads X-App-Rate-Limit; dev keys: 20/s and 100/2min).
- Resumable: already-downloaded games are skipped. Stops cleanly when the key expires (401/403).
- Stores a stripped copy of each match + timeline (no player names or PUUIDs) as train/data/<id>.json.gz.
"""
import argparse
import collections
import gzip
import json
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DATA = HERE / "data"
STATE = HERE / "fetch_state.json"
LOG = HERE / "fetch.log"
REGION_OF = {"na1": "americas", "br1": "americas", "la1": "americas", "la2": "americas",
             "euw1": "europe", "eun1": "europe", "tr1": "europe", "ru": "europe", "me1": "europe",
             "kr": "asia", "jp1": "asia", "oc1": "sea", "ph2": "sea", "sg2": "sea", "th2": "sea", "tw2": "sea", "vn2": "sea"}

RANKED_SOLO_QUEUE = 420
RIFT_MAP_ID = 11
MIN_GAME_SECONDS = 600
MIN_MAJOR_PATCH = 16
QUEUE_LOW_WATER = 60        # top the match queue up from the next player below this size
MAX_BAD_PLAYER_IDS = 5      # this many HTTP 400s in a row means the stored ladder belongs to an older key
REQUEUE_DELAY = 5
MAX_GAME_ATTEMPTS = 5       # a game that keeps failing is skipped, or the run could loop on it forever
SAVE_STATE_EVERY = 10       # the state file is over 1 MB: do not rewrite it after every game
LOG_EVERY = 25
SECONDS_PER_DAY = 86400

KEEP_EVENTS = {"CHAMPION_KILL", "CHAMPION_SPECIAL_KILL", "WARD_PLACED", "WARD_KILL", "BUILDING_KILL", "ELITE_MONSTER_KILL",
               "TURRET_PLATE_DESTROYED", "DRAGON_SOUL_GIVEN", "ITEM_PURCHASED", "LEVEL_UP", "GAME_END"}
KEEP_PFRAME = ("position", "totalGold", "currentGold", "xp", "level", "minionsKilled", "jungleMinionsKilled")
KEEP_PART = ("participantId", "teamId", "championName", "championId", "teamPosition", "individualPosition", "win",
             "kills", "deaths", "assists", "champLevel", "goldEarned", "visionScore", "wardsPlaced", "wardsKilled",
             "visionWardsBoughtInGame", "totalMinionsKilled", "neutralMinionsKilled")


def log(msg):
    line = time.strftime("%H:%M:%S ") + msg
    print(line, flush=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def load_key():
    if os.environ.get("RIOT_API_KEY"):
        return os.environ["RIOT_API_KEY"].strip()
    for p in (ROOT / "config.json", Path(os.environ.get("LOCALAPPDATA", "")) / "League Replay Analyzer" / "config.json"):
        try:
            c = json.loads(p.read_text(encoding="utf-8"))
            k = c.get("apiKey") or c.get("api_key") or c.get("riotApiKey")
            if k:
                return k.strip()
        except Exception:
            pass
    sys.exit("No Riot API key found in config.json")


class KeyExpired(Exception):
    pass


class Transient(Exception):
    """The request kept failing (network / server): try the game again later instead of discarding it."""


class BadPlayerId(Exception):
    """HTTP 400: PUUIDs are encrypted per key, so a stored list can stop working when the key changes."""


class Limiter:
    """Sliding-window limiter for several (count, seconds) windows; updated from the response headers."""

    def __init__(self):
        self.windows = [(18, 1.0), (95, 120.0)]  # a little under the dev-key limits
        self.hist = collections.deque()

    def set_from_header(self, h):
        try:
            w = []
            for part in h.split(","):
                n, s = part.split(":")
                w.append((max(1, int(int(n) * 0.95)), float(s)))
            if w:
                self.windows = w
        except Exception:
            pass

    def wait(self):
        while True:
            now = time.time()
            longest = max(s for _, s in self.windows)
            while self.hist and now - self.hist[0] > longest:
                self.hist.popleft()
            delay = 0.0
            for n, s in self.windows:
                inside = [t for t in self.hist if now - t < s]
                if len(inside) >= n:
                    delay = max(delay, s - (now - inside[-n]) + 0.05)
            if delay <= 0:
                self.hist.append(now)
                return
            time.sleep(min(delay, 5))


LIM = Limiter()


def get(url, key, tries=6):
    for attempt in range(tries):
        LIM.wait()
        req = urllib.request.Request(url, headers={"X-Riot-Token": key, "User-Agent": "LeagueReplayAnalyzer/2.0 (training)"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                h = r.headers.get("X-App-Rate-Limit")
                if h:
                    LIM.set_from_header(h)
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise KeyExpired(f"HTTP {e.code}")
            if e.code == 404:
                return None
            if e.code == 429:
                ra = float(e.headers.get("Retry-After") or 10)
                log(f"rate limited, waiting {ra:.0f}s")
                time.sleep(ra + 1)
                continue
            if e.code == 400:
                raise BadPlayerId(url)
            if e.code >= 500:
                time.sleep(2 + attempt * 3)
                continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError):
            time.sleep(2 + attempt * 3)
    raise Transient(url)


def strip(match, timeline):
    info = match["info"]
    m = {"metadata": {"matchId": match["metadata"]["matchId"]},
         "info": {k: info.get(k) for k in ("gameVersion", "gameDuration", "gameCreation", "gameEndTimestamp", "mapId", "queueId", "platformId")}}
    m["info"]["teams"] = [{"teamId": t["teamId"], "win": t["win"]} for t in info["teams"]]
    m["info"]["participants"] = []
    for p in info["participants"]:
        q = {k: p.get(k) for k in KEEP_PART}
        q["riotIdGameName"] = p.get("championName")  # anonymised: no player names / PUUIDs are stored
        q["puuid"] = f"anon-{p['participantId']}"
        m["info"]["participants"].append(q)
    frames = []
    for f in timeline["info"]["frames"]:
        pf = {}
        for pid, v in (f.get("participantFrames") or {}).items():
            pf[pid] = {k: v.get(k) for k in KEEP_PFRAME if k in v}
        evs = []
        for e in f.get("events") or []:
            if e.get("type") not in KEEP_EVENTS:
                continue
            e = {k: v for k, v in e.items() if k not in ("victimDamageDealt", "victimDamageReceived")}
            evs.append(e)
        frames.append({"timestamp": f["timestamp"], "participantFrames": pf, "events": evs})
    t = {"metadata": {"matchId": timeline["metadata"]["matchId"]}, "info": {"frameInterval": timeline["info"].get("frameInterval"), "frames": frames}}
    return {"match": m, "timeline": t, "source": "riot-api"}


def load_state():
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except Exception:
        return {"players": [], "playerIdx": 0, "queue": [], "skipped": []}


def save_state(st):
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(st), encoding="utf-8")
    os.replace(tmp, STATE)


def fetch_players(plat, key, seed):
    players = []
    for tier in ("challengerleagues", "grandmasterleagues", "masterleagues"):
        d = get(f"https://{plat}.api.riotgames.com/lol/league/v4/{tier}/by-queue/RANKED_SOLO_5x5", key) or {}
        ents = d.get("entries") or []
        random.Random(seed).shuffle(ents)
        for e in ents:
            if e.get("puuid"):
                players.append({"puuid": e["puuid"], "tier": tier[:-7]})
            elif e.get("summonerId"):
                players.append({"summonerId": e["summonerId"], "tier": tier[:-7]})
        log(f"{tier}: {len(ents)} players")
    # mix the tiers so a run is not only the same few hundred Challenger accounts
    by = {t: [x for x in players if x["tier"] == t] for t in ("challenger", "grandmaster", "master")}
    mixed = []
    while any(by.values()):
        for t, n in (("challenger", 1), ("grandmaster", 2), ("master", 3)):
            for _ in range(n):
                if by[t]:
                    mixed.append(by[t].pop(0))
    return mixed


def wait_for_key(plat, key, minutes=5):
    """A newly generated dev key can return 401 for a minute or two before it activates."""
    url = f"https://{plat}.api.riotgames.com/lol/status/v4/platform-data"
    end = time.time() + minutes * 60
    while True:
        try:
            get(url, key)
            return
        except KeyExpired:
            if time.time() > end:
                raise
            time.sleep(15)


def _is_training_game(m):
    """Ranked solo queue on Summoner's Rift, long enough to be a real game, from a current season."""
    info = (m or {}).get("info")
    if not info:
        return False
    major = str(info.get("gameVersion", "")).split(".")[0]
    return info.get("mapId") == RIFT_MAP_ID and info.get("queueId") == RANKED_SOLO_QUEUE \
        and (info.get("gameDuration") or 0) >= MIN_GAME_SECONDS and major.isdigit() and int(major) >= MIN_MAJOR_PATCH


class Fetcher:
    """One download run: keeps a queue of match ids topped up from the ladder and saves each game."""

    def __init__(self, args, key, state):
        self.args, self.key, self.st = args, key, state
        self.plat, self.region = args.platform, REGION_OF.get(args.platform, "americas")
        self.have = {p.name.split(".")[0] for p in DATA.glob("*.json.gz")}
        self.skipped = set(state.get("skipped", []))
        self.queued = set()
        self.bad_ids = 0
        self.start_time = 0
        self.attempts = collections.Counter()

    def _match_url(self, suffix):
        return f"https://{self.region}.api.riotgames.com/lol/match/v5/matches/{suffix}"

    def _refresh_ladder(self):
        self.st["players"] = fetch_players(self.plat, self.key, int(time.time()))
        self.st["playerIdx"] = 0

    def _player_puuid(self, pl):
        puuid = pl.get("puuid")
        if not puuid and pl.get("summonerId"):
            s = get(f"https://{self.plat}.api.riotgames.com/lol/summoner/v4/summoners/{pl['summonerId']}", self.key) or {}
            puuid = s.get("puuid")
        return puuid

    def _queue_player_games(self, puuid):
        q = urllib.parse.urlencode({"queue": RANKED_SOLO_QUEUE, "type": "ranked", "start": 0, "count": self.args.per_player, "startTime": self.start_time})
        try:
            ids = get(self._match_url(f"by-puuid/{puuid}/ids?{q}"), self.key) or []
            self.bad_ids = 0
        except BadPlayerId:
            self.bad_ids += 1
            if self.bad_ids >= MAX_BAD_PLAYER_IDS:
                log("player IDs no longer valid for this key: refreshing the ladder")
                self._refresh_ladder()
                self.bad_ids = 0
            return
        except Transient:
            return
        new = [i for i in ids if i not in self.have and i not in self.queued and i not in self.skipped]
        self.st["queue"].extend(new)
        self.queued.update(new)

    def refill_queue(self):
        st = self.st
        while len(st["queue"]) < QUEUE_LOW_WATER and st["playerIdx"] < len(st["players"]):
            pl = st["players"][st["playerIdx"]]
            st["playerIdx"] += 1
            puuid = self._player_puuid(pl)
            if puuid:
                self._queue_player_games(puuid)

    def _try_later(self, mid):
        self.attempts[mid] += 1
        if self.attempts[mid] >= MAX_GAME_ATTEMPTS:
            return self._reject(mid)
        self.st["queue"].append(self.st["queue"].pop(0))
        time.sleep(REQUEUE_DELAY)
        return None

    def _reject(self, mid):
        self.st["queue"].pop(0)
        self.queued.discard(mid)
        self.skipped.add(mid)
        self.st["skipped"] = sorted(self.skipped)

    def _save_game(self, mid, m, tl):
        out = DATA / f"{mid}.json.gz"
        tmp = out.with_suffix(".tmp")
        with gzip.open(tmp, "wt", encoding="utf-8") as f:
            json.dump(strip(m, tl), f, separators=(",", ":"))
        os.replace(tmp, out)
        self.st["queue"].pop(0)
        self.queued.discard(mid)
        self.have.add(mid)
        if len(self.have) % SAVE_STATE_EVERY == 0:
            save_state(self.st)
        if len(self.have) % LOG_EVERY == 0:
            v = m["info"]["gameVersion"].split(".")
            log(f"{len(self.have)} games (patch {v[0]}.{v[1]}, player {self.st['playerIdx']}/{len(self.st['players'])})")

    def download_next(self):
        """The game stays in the queue until it is saved or rejected, so a stop never loses it."""
        mid = self.st["queue"][0]
        try:
            m = get(self._match_url(mid), self.key)
        except (Transient, BadPlayerId):
            return self._try_later(mid)
        if not _is_training_game(m):
            return self._reject(mid)
        try:
            tl = get(self._match_url(f"{mid}/timeline"), self.key)
        except (Transient, BadPlayerId):
            return self._try_later(mid)
        if not tl or not tl.get("info"):
            return self._reject(mid)
        return self._save_game(mid, m, tl)

    def run(self):
        st = self.st
        log(f"start: {len(self.have)} games on disk, target {self.args.target}")
        try:
            wait_for_key(self.plat, self.key)
            if self.args.refresh_players or not st["players"]:
                self._refresh_ladder()
                save_state(st)
            self.start_time = int(time.time()) - self.args.days * SECONDS_PER_DAY
            self.queued = set(st["queue"])
            while len(self.have) < self.args.target:
                self.refill_queue()
                if not st["queue"]:
                    log("no more players / matches to fetch")
                    break
                self.download_next()
        except KeyExpired as e:
            log(f"API key rejected ({e}) — the dev key has probably expired. Stopping with {len(self.have)} games.")
            save_state(st)
            sys.exit(2)
        except KeyboardInterrupt:
            save_state(st)
            return
        save_state(st)
        log(f"done: {len(self.have)} games on disk")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", type=int, default=4000)
    ap.add_argument("--days", type=int, default=60)
    ap.add_argument("--platform", default="na1")
    ap.add_argument("--per-player", type=int, default=40)
    ap.add_argument("--refresh-players", action="store_true", help="fetch the current ladder (needed after changing API key)")
    a = ap.parse_args()
    key = load_key()
    DATA.mkdir(parents=True, exist_ok=True)
    Fetcher(a, key, load_state()).run()


if __name__ == "__main__":
    main()
