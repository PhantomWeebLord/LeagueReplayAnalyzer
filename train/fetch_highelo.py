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
             "euw1": "europe", "eun1": "europe", "tr1": "europe", "ru": "europe",
             "kr": "asia", "jp1": "asia", "oc1": "sea", "sg2": "sea", "tw2": "sea", "vn2": "sea"}

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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", type=int, default=4000)
    ap.add_argument("--days", type=int, default=60)
    ap.add_argument("--platform", default="na1")
    ap.add_argument("--per-player", type=int, default=40)
    ap.add_argument("--refresh-players", action="store_true", help="fetch the current ladder (needed after changing API key)")
    a = ap.parse_args()
    key = load_key()
    plat, region = a.platform, REGION_OF.get(a.platform, "americas")
    DATA.mkdir(parents=True, exist_ok=True)
    st = load_state()
    have = {p.name.split(".")[0] for p in DATA.glob("*.json.gz")}
    skipped = set(st.get("skipped", []))
    log(f"start: {len(have)} games on disk, target {a.target}")

    bad_ids = 0
    try:
        wait_for_key(plat, key)
        if a.refresh_players or not st["players"]:
            st["players"] = fetch_players(plat, key, int(time.time()))
            st["playerIdx"] = 0
            save_state(st)

        start_time = int(time.time()) - a.days * 86400
        queued = set(st["queue"])
        while len(have) < a.target:
            # keep a queue of match ids topped up from the next player's recent ranked games
            while len(st["queue"]) < 60 and st["playerIdx"] < len(st["players"]):
                pl = st["players"][st["playerIdx"]]
                st["playerIdx"] += 1
                puuid = pl.get("puuid")
                if not puuid and pl.get("summonerId"):
                    s = get(f"https://{plat}.api.riotgames.com/lol/summoner/v4/summoners/{pl['summonerId']}", key) or {}
                    puuid = s.get("puuid")
                if not puuid:
                    continue
                q = urllib.parse.urlencode({"queue": 420, "type": "ranked", "start": 0, "count": a.per_player, "startTime": start_time})
                try:
                    ids = get(f"https://{region}.api.riotgames.com/lol/match/v5/matches/by-puuid/{puuid}/ids?{q}", key) or []
                    bad_ids = 0
                except BadPlayerId:
                    bad_ids += 1
                    if bad_ids >= 5:  # the whole list belongs to an older key
                        log("player IDs no longer valid for this key: refreshing the ladder")
                        st["players"] = fetch_players(plat, key, int(time.time()))
                        st["playerIdx"] = 0
                        bad_ids = 0
                    continue
                except Transient:
                    continue
                new = [i for i in ids if i not in have and i not in queued and i not in skipped]
                st["queue"].extend(new)
                queued.update(new)
            if not st["queue"]:
                log("no more players / matches to fetch")
                break
            mid = st["queue"][0]  # only removed once it is saved or rejected, so a stop never loses it
            try:
                m = get(f"https://{region}.api.riotgames.com/lol/match/v5/matches/{mid}", key)
            except (Transient, BadPlayerId):  # keep it, but behind the others
                st["queue"].append(st["queue"].pop(0))
                time.sleep(5)
                continue
            ok = m and m.get("info") and m["info"].get("mapId") == 11 and m["info"].get("queueId") == 420 \
                and (m["info"].get("gameDuration") or 0) >= 600 and str(m["info"].get("gameVersion", "")).split(".")[0].isdigit() \
                and int(str(m["info"]["gameVersion"]).split(".")[0]) >= 16
            if not ok:
                st["queue"].pop(0); queued.discard(mid); skipped.add(mid); st["skipped"] = sorted(skipped)
                continue
            try:
                tl = get(f"https://{region}.api.riotgames.com/lol/match/v5/matches/{mid}/timeline", key)
            except (Transient, BadPlayerId):
                st["queue"].append(st["queue"].pop(0))
                time.sleep(5)
                continue
            if not tl or not tl.get("info"):
                st["queue"].pop(0); queued.discard(mid); skipped.add(mid); st["skipped"] = sorted(skipped)
                continue
            out = DATA / f"{mid}.json.gz"
            tmp = out.with_suffix(".tmp")
            with gzip.open(tmp, "wt", encoding="utf-8") as f:
                json.dump(strip(m, tl), f, separators=(",", ":"))
            os.replace(tmp, out)
            st["queue"].pop(0); queued.discard(mid)
            have.add(mid)
            if len(have) % 10 == 0:  # the state file is over 1 MB: do not rewrite it after every game
                save_state(st)
            if len(have) % 25 == 0:
                log(f"{len(have)} games (patch {m['info']['gameVersion'].split('.')[0]}.{m['info']['gameVersion'].split('.')[1]}, player {st['playerIdx']}/{len(st['players'])})")
    except KeyExpired as e:
        log(f"API key rejected ({e}) — the dev key has probably expired. Stopping with {len(have)} games.")
        save_state(st)
        sys.exit(2)
    except KeyboardInterrupt:
        save_state(st)
        return
    save_state(st)
    log(f"done: {len(have)} games on disk")


if __name__ == "__main__":
    main()
