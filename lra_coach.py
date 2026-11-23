"""
In-app Claude chat ("Ask Claude").

The page sends the question plus a snapshot of the game being reviewed (the selected move, the state at that moment,
nearby events). Claude answers with the help of tools that query a local index of NA Master+ solo-queue games
(coach/highelo_index.json.gz, built by train/build_coach_index.py), so advice like "take the dragon here" is backed by
what high-elo teams actually did in comparable situations and how those games ended.

The Anthropic SDK is imported lazily, so the rest of the app runs without it.
"""
import gzip
import json
import math
import os
import statistics
import threading
import time
import uuid
from collections import Counter

import lra_core as core

MODEL = "claude-opus-5-5"
INDEX_PATH = core.RES_ROOT / "coach" / "highelo_index.json.gz"
INDEX_META = core.RES_ROOT / "coach" / "highelo_index.meta.json"  # game count + patches, without loading the whole index
# USD per million tokens (claude-opus-5-5): input, output, cache read, cache write (5-min)
PRICE = {"in": 4.0, "out": 20.0, "cache_read": 0.20, "cache_write": 5.0}
EPIC = ("dragon", "elder", "grubs", "herald", "baron", "atakhan")
OBJ_NAME = {"dragon": "dragon", "elder": "Elder dragon", "grubs": "void grubs", "herald": "Rift Herald", "baron": "Baron",
            "atakhan": "Atakhan", "tower": "tower", "inhib": "inhibitor", "plates": "tower plates"}


# ================================================================ Master+ index
def obj_kind(raw):
    if raw == "ELDER_DRAGON":
        return "elder"
    if raw.endswith("_DRAGON") or raw == "DRAGON":
        return "dragon"
    return {"HORDE": "grubs", "RIFTHERALD": "herald", "BARON_NASHOR": "baron", "ATAKHAN": "atakhan"}.get(raw)


def zone(x, y, team=None):
    """Map area of a point (game units). With team, jungles/sides are named relative to that team ("own"/"enemy")."""
    if math.hypot(x, y) < 4600:
        side = 100
        base = True
    elif math.hypot(14800 - x, 14800 - y) < 4600:
        side = 200
        base = True
    else:
        s = x + y
        side = 100 if s < 13100 else 200 if s > 16500 else 0
        base = False
    rel = lambda sd: ("own" if sd == team else "enemy") if team else ("blue" if sd == 100 else "red")
    if base:
        return f"{rel(side)} base"
    if x < 2100 or y > 12700:
        return "top lane"
    if y < 2100 or x > 12700:
        return "bot lane"
    if abs(x - y) < 1500:
        return "mid lane"
    if side == 0:
        return "top river (Baron side)" if y > x else "bot river (dragon side)"
    return f"{rel(side)} jungle, {'top' if y > x else 'bot'} side"


class Game:
    __slots__ = ("id", "patch", "dur", "winner", "champs", "stats", "gold", "xp", "pos", "wards", "kills", "objs", "builds",
                 "plates", "bench", "fights", "first_tower")

    def __init__(self, r):
        self.id, self.patch, self.dur, self.winner = r["id"], r["v"], r["d"], r["w"]
        self.champs = r["c"]  # [champion, team, role] by participant id - 1
        self.stats = r["s"]   # [k, d, a, gold, cs, vision] by participant id - 1
        self.gold, self.xp, self.pos, self.wards = r["g"], r["x"], r["p"], r["wd"]
        self.kills = [(k[0], k[1], k[2], k[3], k[4], k[5] * 10, k[6] * 10) for k in r["k"]]
        self.objs = [(o[0], o[1], obj_kind(o[2])) for o in r["o"] if obj_kind(o[2])]
        self.builds = [(b[0], b[1], "inhib" if b[2] == "INHIB" else "tower", b[3]) for b in r["b"]]
        self.plates = [(p[0], p[1]) for p in r["pl"]]
        self.bench = r.get("bm") or {}
        self.first_tower = next((b for b in self.builds if b[2] == "tower"), None)
        self.fights = self._fights()

    def _fights(self):
        """Kills grouped into fights the same way the app does (within 15 s and 3,500 units of each other)."""
        out = []
        for k in self.kills:
            f = out[-1] if out else None
            if f and k[0] - f["end"] <= 15 and math.hypot(k[5] - f["x"], k[6] - f["y"]) < 3500:
                f["kills"].append(k)
                f["end"] = k[0]
                f["x"] = sum(q[5] for q in f["kills"]) / len(f["kills"])
                f["y"] = sum(q[6] for q in f["kills"]) / len(f["kills"])
            else:
                out.append({"start": k[0], "end": k[0], "x": k[5], "y": k[6], "kills": [k]})
        for f in out:
            f["by"] = {100: sum(1 for k in f["kills"] if k[1] == 100), 200: sum(1 for k in f["kills"] if k[1] == 200)}
        return out

    def minutes(self):
        return len(self.gold)

    def gold_diff(self, minute, team):
        m = max(0, min(int(minute), len(self.gold) - 1))
        d = self.gold[m][0] - self.gold[m][1]
        return d if team == 100 else -d

    def gold_diff_at(self, t, team):
        """Gold difference at time t (s), interpolated between the minute frames."""
        m = t / 60
        a = max(0, min(int(m), len(self.gold) - 1))
        b = min(a + 1, len(self.gold) - 1)
        w = m - a if b != a else 0
        d = (1 - w) * (self.gold[a][0] - self.gold[a][1]) + w * (self.gold[b][0] - self.gold[b][1])
        return d if team == 100 else -d

    def count(self, t, team, kind):
        """How many of `kind` (an objective, 'tower', 'inhib' or 'kill') `team` had taken before time t."""
        if kind == "kill":
            return sum(1 for k in self.kills if k[0] < t and k[1] == team)
        if kind in ("tower", "inhib"):
            return sum(1 for b in self.builds if b[0] < t and b[1] == team and b[2] == kind)
        return sum(1 for o in self.objs if o[0] < t and o[1] == team and o[2] == kind)

    def taken_between(self, a, b, team):
        """Counter of what `team` took in (a, b]: epic objectives, towers, inhibitors, plates, kills."""
        c = Counter()
        for o in self.objs:
            if a < o[0] <= b and o[1] == team:
                c[o[2]] += 1
        for s in self.builds:
            if a < s[0] <= b and s[1] == team:
                c[s[2]] += 1
        for p in self.plates:
            if a < p[0] <= b and p[1] == team:
                c["plates"] += 1
        for k in self.kills:
            if a < k[0] <= b and k[1] == team:
                c["kills"] += 1
        return c

    def player_pos(self, minute, pid):
        m = max(0, min(int(minute), len(self.pos) - 1))
        row = self.pos[m]
        return row[2 * (pid - 1)] * 10, row[2 * (pid - 1) + 1] * 10


class Index:
    def __init__(self, games):
        self.games = [Game(r) for r in games]
        patches = sorted({g.patch for g in self.games}, key=lambda v: [int(x) for x in v.split(".") if x.isdigit()])
        self.patches = patches
        # win rate by (minute, gold-difference bucket of 500), both teams' points of view
        self.wr = {}
        for g in self.games:
            for m in range(min(g.minutes(), 41)):
                for team in (100, 200):
                    key = (m, max(-24, min(24, round(g.gold_diff(m, team) / 500))))
                    w, n = self.wr.get(key, (0, 0))
                    self.wr[key] = (w + (g.winner == team), n + 1)

    def expected_wr(self, minute, gold_diff):
        """High-elo win rate for a team `gold_diff` ahead at `minute`, from gold alone (pooled over nearby buckets)."""
        m = max(0, min(40, int(minute)))
        b = round(gold_diff / 500)
        w = n = 0
        for spread in range(0, 6):
            for mm in range(m - (spread > 2), m + 1 + (spread > 2)):
                for bb in (b - spread, b + spread) if spread else (b,):
                    ww, nn = self.wr.get((mm, max(-24, min(24, bb))), (0, 0))
                    w += ww
                    n += nn
            if n >= 60:
                break
        return (w / n if n else 0.5), n

    def summary(self):
        return {"games": len(self.games), "patches": f"{self.patches[0]}–{self.patches[-1]}" if self.patches else "",
                "source": "NA Master+ ranked solo queue"}


_index = None
_index_lock = threading.Lock()


def get_index():
    global _index
    with _index_lock:
        if _index is None:
            with gzip.open(INDEX_PATH, "rt", encoding="utf-8") as fh:
                _index = Index(json.load(fh)["games"])
        return _index


def index_available():
    return INDEX_PATH.is_file()


def index_summary():
    """What the chat panel shows. Reads the small sidecar file: opening the panel must not load every game into memory."""
    if not index_available():
        return None
    try:
        return json.loads(INDEX_META.read_text("utf-8"))
    except (OSError, ValueError):
        return get_index().summary()


# ================================================================ tools Claude can call
def pct(a, n):
    return None if not n else round(100 * a / n, 1)


def rate(rows, key="win"):
    return {"n": len(rows), "win_rate_pct": pct(sum(1 for r in rows if r[key]), len(rows))}


def sample_note(n):
    return "small sample - treat as a rough hint" if n < 30 else ("moderate sample" if n < 100 else "solid sample")


def in_range(v, lo, hi):
    return (lo is None or v >= lo) and (hi is None or v <= hi)


def tool_similar_situations(minute, gold_diff, dragon_diff=None, tower_diff=None, kill_diff=None, next_minutes=3):
    ix = get_index()
    minute = int(minute)
    next_minutes = max(1, min(10, int(next_minutes)))
    tol = max(600, 0.2 * abs(gold_diff))
    rows = []
    for g in ix.games:
        if g.minutes() <= minute + 1:
            continue
        t = minute * 60
        for team in (100, 200):
            gd = g.gold_diff(minute, team)
            if abs(gd - gold_diff) > tol:
                continue
            en = 300 - team
            if dragon_diff is not None and g.count(t, team, "dragon") - g.count(t, en, "dragon") != int(dragon_diff):
                continue
            if tower_diff is not None and g.count(t, team, "tower") - g.count(t, en, "tower") != int(tower_diff):
                continue
            if kill_diff is not None and abs((g.count(t, team, "kill") - g.count(t, en, "kill")) - int(kill_diff)) > 2:
                continue
            end = t + next_minutes * 60
            mine, theirs = g.taken_between(t, end, team), g.taken_between(t, end, en)
            nxt = next((o for o in g.objs if t < o[0] <= end), None)
            rows.append({"win": g.winner == team, "mine": mine, "theirs": theirs,
                         "next_epic": None if not nxt else ("us" if nxt[1] == team else "them"),
                         "next_epic_kind": nxt[2] if nxt else None,
                         "gold_change": g.gold_diff(min(minute + next_minutes, g.minutes() - 1), team) - gd})
    if not rows:
        return {"n": 0, "note": "No Master+ games matched. Loosen the filters (drop dragon/tower/kill filters)."}
    n = len(rows)
    kinds = ("dragon", "grubs", "herald", "baron", "elder", "atakhan", "tower", "inhib", "plates")
    took = {OBJ_NAME[k]: {"us_pct": pct(sum(1 for r in rows if r["mine"][k]), n), "them_pct": pct(sum(1 for r in rows if r["theirs"][k]), n)}
            for k in kinds if any(r["mine"][k] or r["theirs"][k] for r in rows)}
    by = lambda f: rate([r for r in rows if f(r)])
    return {
        "matched": f"team {'ahead' if gold_diff >= 0 else 'behind'} by ~{abs(int(gold_diff))} gold (±{int(tol)}) at {minute}:00"
                   + (f", dragon diff {dragon_diff:+d}" if dragon_diff is not None else "")
                   + (f", tower diff {tower_diff:+d}" if tower_diff is not None else "")
                   + (f", kill diff ~{kill_diff:+d}" if kill_diff is not None else ""),
        "sample": sample_note(n), **rate(rows),
        f"next_{next_minutes}_min": {
            "took_at_least_one": took,
            "avg_kills_us": round(sum(r["mine"]["kills"] for r in rows) / n, 2),
            "avg_kills_them": round(sum(r["theirs"]["kills"] for r in rows) / n, 2),
            "avg_gold_diff_change": round(sum(r["gold_change"] for r in rows) / n),
        },
        "win_rate_by_what_happened_next": {
            "we_took_the_next_epic_objective": by(lambda r: r["next_epic"] == "us"),
            "they_took_the_next_epic_objective": by(lambda r: r["next_epic"] == "them"),
            "no_epic_objective": by(lambda r: r["next_epic"] is None),
            "we_won_the_kills": by(lambda r: r["mine"]["kills"] > r["theirs"]["kills"]),
            "they_won_the_kills": by(lambda r: r["mine"]["kills"] < r["theirs"]["kills"]),
            "we_took_a_tower": by(lambda r: r["mine"]["tower"] > 0),
        },
        "note": "Each game counts twice (once from each team's side) when both sides match. Win rates are what happened, not proof of cause.",
    }


def tool_objective_value(objective, minute_from=0, minute_to=60, gold_diff_min=None, gold_diff_max=None):
    ix = get_index()
    objective = str(objective).lower().replace(" ", "_")
    alias = {"drake": "dragon", "void_grubs": "grubs", "voidgrubs": "grubs", "rift_herald": "herald", "baron_nashor": "baron",
             "elder_dragon": "elder", "turret": "tower", "inhibitor": "inhib", "first_turret": "first_tower"}
    objective = alias.get(objective, objective)
    if objective not in EPIC + ("tower", "first_tower", "inhib"):
        return {"error": f"Unknown objective '{objective}'. Use one of: {', '.join(EPIC + ('tower', 'first_tower', 'inhib'))}."}
    rows = []
    for g in ix.games:
        if objective in EPIC:
            evs = [(o[0], o[1]) for o in g.objs if o[2] == objective]
        elif objective == "first_tower":
            evs = [(g.first_tower[0], g.first_tower[1])] if g.first_tower else []
        else:
            evs = [(b[0], b[1]) for b in g.builds if b[2] == objective]
        for t, team in evs:
            if team not in (100, 200) or not (minute_from * 60 <= t <= minute_to * 60):
                continue
            gd = g.gold_diff_at(max(0, t - 30), team)
            if not in_range(gd, gold_diff_min, gold_diff_max):
                continue
            en = 300 - team
            before_us, before_them = g.taken_between(t - 45, t, team)["kills"], g.taken_between(t - 45, t, en)["kills"]
            trade = g.taken_between(t, t + 90, en)
            rows.append({"win": g.winner == team, "gd": gd, "exp": ix.expected_wr(t / 60, gd)[0],
                         "after_fight": before_us > before_them, "lost_fight_first": before_us < before_them,
                         "traded": bool(trade["tower"] or any(trade[k] for k in EPIC)),
                         "trade": trade, "t": t})
    if not rows:
        return {"n": 0, "note": "No matching events. Widen the minute or gold range."}
    n = len(rows)
    exp = sum(r["exp"] for r in rows) / n
    won = sum(1 for r in rows if r["win"]) / n
    by = lambda f: rate([r for r in rows if f(r)])
    trades = Counter()
    for r in rows:
        for k in ("tower", "plates", "kills") + EPIC:
            if r["trade"][k]:
                trades[OBJ_NAME.get(k, k)] += 1
    return {
        "objective": OBJ_NAME.get(objective, objective.replace("_", " ")),
        "filter": f"taken between {minute_from}:00 and {minute_to}:00"
                  + (f", taker's gold diff {gold_diff_min if gold_diff_min is not None else '-inf'}..{gold_diff_max if gold_diff_max is not None else '+inf'}" if gold_diff_min is not None or gold_diff_max is not None else ""),
        "sample": sample_note(n), "n": n,
        "median_time": f"{int(statistics.median(r['t'] for r in rows) // 60)}:{int(statistics.median(r['t'] for r in rows) % 60):02d}",
        "taker_win_rate_pct": round(100 * won, 1),
        "expected_win_rate_from_gold_alone_pct": round(100 * exp, 1),
        "lift_pct_points": round(100 * (won - exp), 1),
        "taken_right_after_winning_a_fight": by(lambda r: r["after_fight"]),
        "taken_without_a_fight_win": by(lambda r: not r["after_fight"]),
        "enemy_traded_tower_or_objective_within_90s": by(lambda r: r["traded"]),
        "no_trade": by(lambda r: not r["traded"]),
        "what_the_enemy_took_within_90s_pct": {k: pct(v, n) for k, v in trades.most_common()},
        "note": "lift = taker win rate minus the win rate expected from the gold lead at that moment. It mixes the objective's value with whatever made the team able to take it.",
    }


def tool_after_fight(minute_from=0, minute_to=60, min_kill_margin=2, gold_diff_min=None, gold_diff_max=None, area=None):
    ix = get_index()
    margin = max(1, int(min_kill_margin))
    area = (area or "").lower() or None
    rows = []
    for g in ix.games:
        for f in g.fights:
            if not (minute_from * 60 <= f["start"] <= minute_to * 60):
                continue
            w = 100 if f["by"][100] - f["by"][200] >= margin else 200 if f["by"][200] - f["by"][100] >= margin else 0
            if not w:
                continue
            z = zone(f["x"], f["y"], w)
            if area and area not in z:
                continue
            gd = g.gold_diff_at(max(0, f["start"] - 20), w)
            if not in_range(gd, gold_diff_min, gold_diff_max):
                continue
            nxt = g.taken_between(f["end"], f["end"] + 90, w)
            lost = g.taken_between(f["end"], f["end"] + 90, 300 - w)
            conv = next((k for k in ("baron", "elder", "atakhan", "dragon", "herald", "grubs") if nxt[k]), None) \
                or ("inhibitor" if nxt["inhib"] else "tower" if nxt["tower"] else "plates only" if nxt["plates"] else "nothing")
            rows.append({"win": g.winner == w, "conv": OBJ_NAME.get(conv, conv), "zone": z, "size": len(f["kills"]),
                         "counter": lost["kills"] > nxt["kills"]})
    if not rows:
        return {"n": 0, "note": "No fights matched. Widen the filters."}
    n = len(rows)
    conv = Counter(r["conv"] for r in rows)
    return {
        "filter": f"fights won by {margin}+ kills between {minute_from}:00 and {minute_to}:00" + (f" in '{area}'" if area else ""),
        "sample": sample_note(n), "n": n, "fight_winner_win_rate_pct": pct(sum(1 for r in rows if r["win"]), n),
        "what_the_winners_took_in_the_next_90s_pct": {k: pct(v, n) for k, v in conv.most_common()},
        "win_rate_by_conversion": {k: rate([r for r in rows if r["conv"] == k]) for k, _ in conv.most_common()},
        "winners_got_counter_killed_harder_after_pct": pct(sum(1 for r in rows if r["counter"]), n),
        "where_the_fights_were_pct": {k: pct(v, n) for k, v in Counter(r["zone"] for r in rows).most_common(6)},
    }


def tool_jungle_patterns(champion=None, minute_from=1, minute_to=15):
    ix = get_index()
    want = (champion or "").lower().replace(" ", "").replace("'", "") or None
    minute_from, minute_to = max(0, int(minute_from)), max(int(minute_from), min(40, int(minute_to)))
    groups = [(a, min(b, minute_to)) for a, b in ((1, 3), (4, 6), (7, 9), (10, 12), (13, 15), (16, 20), (21, 25), (26, 30), (31, 40))
              if b >= minute_from and a <= minute_to]
    zones = {gr: Counter() for gr in groups}
    first_kp, first_lane, start_side, first_epic, wins, kda, gold10 = [], Counter(), Counter(), Counter(), 0, [0, 0, 0], []
    n = 0
    for g in ix.games:
        for i, (ch, team, role) in enumerate(g.champs):
            if role != "JUNGLE" or (want and ch.lower().replace(" ", "").replace("'", "") != want):
                continue
            pid = i + 1
            n += 1
            wins += g.winner == team
            for j in range(3):
                kda[j] += g.stats[i][j]
            if "10" in g.bench:
                gold10.append(g.bench["10"][i][0])
            for gr in groups:
                for m in range(max(gr[0], minute_from), gr[1] + 1):
                    if m < g.minutes():
                        zones[gr][zone(*g.player_pos(m, pid), team)] += 1
            x, y = g.player_pos(2, pid)
            z2 = zone(x, y, team)
            start_side["top side" if "top side" in z2 else "bot side" if "bot side" in z2 else z2] += 1
            k = next((k for k in g.kills if k[0] < 900 and (k[3] == pid or pid in k[4])), None)
            if k:
                first_kp.append(k[0])
                first_lane[zone(k[5], k[6], team)] += 1
            o = next((o for o in g.objs if o[1] == team), None)
            if o:
                first_epic[f"{OBJ_NAME[o[2]]}"] += 1
    if not n:
        return {"n": 0, "note": f"No Master+ games with {champion} in the jungle. Call again without a champion for all junglers."}
    fmt = lambda s: f"{int(s // 60)}:{int(s % 60):02d}"
    return {
        "junglers": champion or "all junglers", "sample": sample_note(n), "n": n, "win_rate_pct": pct(wins, n),
        "avg_kda": "/".join(f"{v / n:.1f}" for v in kda),
        "median_gold_at_10": int(statistics.median(gold10)) if gold10 else None,
        "where_they_are_pct_by_minutes": {(f"{a}-{b} min" if b > a else f"{a} min"): {k: pct(v, sum(c.values())) for k, v in c.most_common(6)}
                                          for (a, b), c in zones.items() if c},
        "position_at_2_00_pct": {k: pct(v, n) for k, v in start_side.most_common(4)},
        "first_kill_or_assist_before_15": {"games_pct": pct(len(first_kp), n),
                                           "median_time": fmt(statistics.median(first_kp)) if first_kp else None,
                                           "where_pct": {k: pct(v, len(first_kp)) for k, v in first_lane.most_common(5)}},
        "their_team_first_epic_objective_pct": {k: pct(v, n) for k, v in first_epic.most_common()},
        "note": "Positions are sampled once a minute from Riot's timeline (a snapshot, not a path).",
    }


def tool_champion_benchmarks(champion, role=None):
    ix = get_index()
    want = str(champion).lower().replace(" ", "").replace("'", "")
    role = (role or "").upper() or None
    alias = {"JUNGLER": "JUNGLE", "MID": "MIDDLE", "ADC": "BOTTOM", "BOT": "BOTTOM", "SUPPORT": "UTILITY", "SUP": "UTILITY"}
    role = alias.get(role, role)
    rows = []
    for g in ix.games:
        for i, (ch, team, r) in enumerate(g.champs):
            if ch.lower().replace(" ", "").replace("'", "") == want and (not role or r == role):
                rows.append((g, i, team, r))
    if not rows:
        return {"n": 0, "note": f"No Master+ games with {champion}" + (f" as {role}" if role else "") + "."}
    n = len(rows)
    out = {"champion": champion, "role": role or "any", "sample": sample_note(n), "n": n,
           "roles_pct": {k: pct(v, n) for k, v in Counter(r for _, _, _, r in rows).most_common()},
           "win_rate_pct": pct(sum(1 for g, _, t, _ in rows if g.winner == t), n),
           "avg_kda": "/".join(f"{sum(g.stats[i][j] for g, i, _, _ in rows) / n:.1f}" for j in range(3)),
           "avg_vision_score": round(sum(g.stats[i][5] for g, i, _, _ in rows) / n, 1),
           "avg_game_minutes": round(sum(g.dur for g, _, _, _ in rows) / n / 60, 1)}
    for m in ("5", "10", "15", "20"):
        vals = [g.bench[m][i] for g, i, _, _ in rows if m in g.bench]
        if len(vals) >= 5:
            q = lambda j: [int(v) for v in statistics.quantiles([v[j] for v in vals], n=4)] if len(vals) >= 4 else None
            out[f"at_{m}_min"] = {"median_gold": int(statistics.median(v[0] for v in vals)), "gold_p25_p75": q(0)[::2],
                                  "median_cs": int(statistics.median(v[1] for v in vals)), "median_level": int(statistics.median(v[3] for v in vals))}
    return out


TOOL_FUNCS = {
    "similar_situations": tool_similar_situations,
    "objective_value": tool_objective_value,
    "after_fight": tool_after_fight,
    "jungle_patterns": tool_jungle_patterns,
    "champion_benchmarks": tool_champion_benchmarks,
}
_num = {"type": "integer"}
TOOLS = [
    {"name": "similar_situations",
     "description": "Find Master+ games where a team was in a similar spot at a given minute (gold lead, optionally dragon/tower/kill "
                    "difference) and report how those games ended and what high-elo teams did over the next few minutes (objectives, "
                    "towers, kills), with win rates split by what happened next. Use it to judge whether a decision made sense from that state.",
     "input_schema": {"type": "object", "properties": {
         "minute": {"type": "integer", "description": "Game minute (0-40)."},
         "gold_diff": {"type": "integer", "description": "Team gold lead at that minute from the team of interest's side (negative = behind)."},
         "dragon_diff": {"type": "integer", "description": "Optional: that team's dragons minus the enemy's."},
         "tower_diff": {"type": "integer", "description": "Optional: towers destroyed by that team minus by the enemy."},
         "kill_diff": {"type": "integer", "description": "Optional: kill difference (matched within ±2)."},
         "next_minutes": {"type": "integer", "description": "How many minutes after to look at (default 3)."}},
         "required": ["minute", "gold_diff"], "additionalProperties": False}},
    {"name": "objective_value",
     "description": "How much an objective was worth in Master+ games: win rate of the team that took it vs the win rate expected from "
                    "their gold lead alone, whether it was taken off a won fight, and what the enemy traded within 90 s. Objectives: dragon, "
                    "elder, grubs, herald, baron, atakhan, tower, first_tower, inhib.",
     "input_schema": {"type": "object", "properties": {
         "objective": {"type": "string", "enum": ["dragon", "elder", "grubs", "herald", "baron", "atakhan", "tower", "first_tower", "inhib"]},
         "minute_from": {"type": "integer"}, "minute_to": {"type": "integer"},
         "gold_diff_min": {"type": "integer", "description": "Optional: only when the taking team's gold lead was at least this."},
         "gold_diff_max": {"type": "integer", "description": "Optional: only when the taking team's gold lead was at most this."}},
         "required": ["objective"], "additionalProperties": False}},
    {"name": "after_fight",
     "description": "What Master+ teams did in the 90 s after winning a fight (by at least N kills): which objective or tower they converted "
                    "into, and win rates by conversion. Optional area filter, e.g. 'bot river', 'top river', 'enemy jungle', 'mid lane'.",
     "input_schema": {"type": "object", "properties": {
         "minute_from": {"type": "integer"}, "minute_to": {"type": "integer"},
         "min_kill_margin": {"type": "integer", "description": "Fight won by at least this many kills (default 2)."},
         "gold_diff_min": {"type": "integer"}, "gold_diff_max": {"type": "integer"},
         "area": {"type": "string", "description": "Optional substring of the fight's map area."}},
         "additionalProperties": False}},
    {"name": "jungle_patterns",
     "description": "Where Master+ junglers are by game minute (own/enemy jungle side, lanes, river), where they start, when and where "
                    "they first get a kill or assist, and their team's first epic objective. Optionally for one champion.",
     "input_schema": {"type": "object", "properties": {
         "champion": {"type": "string", "description": "Champion name as in the game data, e.g. 'Hecarim', 'LeeSin', 'MonkeyKing' (Wukong)."},
         "minute_from": {"type": "integer"}, "minute_to": {"type": "integer"}},
         "additionalProperties": False}},
    {"name": "champion_benchmarks",
     "description": "Master+ benchmarks for a champion (optionally in a role): win rate, KDA, vision score, and median gold, CS and level "
                    "at 5/10/15/20 minutes. Use it to compare the user's numbers with high-elo players on the same champion.",
     "input_schema": {"type": "object", "properties": {
         "champion": {"type": "string"}, "role": {"type": "string", "description": "Optional: TOP, JUNGLE, MIDDLE, BOTTOM or UTILITY."}},
         "required": ["champion"], "additionalProperties": False}},
]
for _t in TOOLS:
    _t["eager_input_streaming"] = True  # inputs stream as generated; run_tool validates them before running


def run_tool(name, args):
    """Validate the model's input against the tool's schema, then run it. Returns (result json text, is_error)."""
    spec = next((t for t in TOOLS if t["name"] == name), None)
    if not spec or not isinstance(args, dict):
        return json.dumps({"INVALID_JSON": json.dumps(args, default=str)[:500]}), True
    props = spec["input_schema"]["properties"]
    clean = {}
    for k, v in args.items():
        if k not in props:
            return json.dumps({"error": f"Unknown parameter '{k}'"}), True
        if v is None:
            continue
        typ = props[k]["type"]
        if typ == "integer":
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
                return json.dumps({"error": f"'{k}' must be an integer"}), True
            v = int(v)
        elif typ == "string" and not isinstance(v, str):
            return json.dumps({"error": f"'{k}' must be a string"}), True
        clean[k] = v
    missing = [k for k in spec["input_schema"].get("required", []) if k not in clean]
    if missing:
        return json.dumps({"error": f"Missing: {', '.join(missing)}"}), True
    try:
        res = TOOL_FUNCS[name](**clean)
        return json.dumps(res, default=str), bool(isinstance(res, dict) and res.get("error"))
    except Exception as e:  # a bad combination of filters: tell Claude rather than failing the chat
        return json.dumps({"error": f"{type(e).__name__}: {e}"}), True


def tool_label(name, args):
    a = args if isinstance(args, dict) else {}
    if name == "similar_situations":
        return f"Looking up Master+ games at {a.get('minute', '?')}:00 with a similar gold lead"
    if name == "objective_value":
        return f"Checking what {OBJ_NAME.get(a.get('objective'), a.get('objective', 'that objective'))} was worth in Master+ games"
    if name == "after_fight":
        return "Checking what Master+ teams did after winning fights"
    if name == "jungle_patterns":
        return f"Checking Master+ {a.get('champion') or 'jungler'} pathing"
    if name == "champion_benchmarks":
        return f"Checking Master+ {a.get('champion', '')} benchmarks"
    return "Looking something up"


# ================================================================ chat
def system_prompt():
    s = index_summary() or {"games": 0, "patches": "", "source": ""}
    return f"""You are the coach inside Replay Analyzer, a desktop app where a League of Legends player reviews their own replays \
chess.com-style: every action is graded (Brilliant ... Blunder) by a win-probability model trained on Master+ games, and the real \
replay plays in the app. The player asks you about specific plays and decisions.

What you get:
- A <game_context> block with the game being reviewed: who the player is, both teams, the moment they're looking at (time, gold/XP \
difference, objectives, towers, champions alive, their team's win chance), the move they selected with the app's grade and explanation, \
and the events around it. It comes from Riot's match timeline: positions once per minute plus every kill, objective and tower. There is \
no vision, cooldown, health or item-state data, so say so when a question depends on it.
- Tools over {s['games']:,} {s['source']} games (patches {s['patches']}). They return counts and win rates for comparable situations.

How to answer:
- Ground judgments about decisions in the tools: look up comparable situations (match the minute, gold lead, objectives) before saying \
what high-elo players do or what a play was worth. Quote the numbers briefly with the sample size, and flag small samples (under ~30).
- Win rates show what happened, not what caused it. Combine them with game knowledge and with what the context shows (numbers, \
timers, positions, who was dead) to explain WHY a decision was right or wrong, and what the better option was.
- Be direct and concrete, like a good coach reviewing VOD: the decision, the reason, the alternative, the habit to build. Short \
paragraphs or a few bullets; no long preambles. Times as m:ss. Refer to the player as "you".
- If the app's grade looks wrong given the context, say so and explain; the grade is a model estimate, not ground truth.
- Champion names in tools use Riot's internal names (e.g. MonkeyKing for Wukong, LeeSin, KSante).
- If something can't be answered from the data, say what you'd need (e.g. watching the replay at that moment) instead of guessing."""


CHATS = {}
CHATS_LOCK = threading.Lock()


class ChatError(Exception):
    def __init__(self, msg, code="error"):
        super().__init__(msg)
        self.code = code


def api_key():
    return os.environ.get("ANTHROPIC_API_KEY") or core.load_config().get("anthropicKey") or ""


def chat_status():
    try:
        import anthropic  # noqa: F401
        sdk = True
    except ImportError:
        sdk = False
    k = api_key()
    src = "env" if os.environ.get("ANTHROPIC_API_KEY") else "app" if k else None
    return {"ready": bool(sdk and k and index_available()), "sdk": sdk, "hasKey": bool(k), "keySource": src,
            "keyHint": (k[:10] + "…" + k[-4:]) if k and src == "app" else "", "model": MODEL,
            "index": index_summary(), "effort": effort()}


def effort():
    e = core.load_config().get("chatEffort") or "high"
    return e if e in ("low", "medium", "high", "xhigh", "max") else "high"


def save_key(key):
    cfg = core.load_config()
    key = (key or "").strip()
    if key:
        cfg["anthropicKey"] = key
    else:
        cfg.pop("anthropicKey", None)
    core.save_config(cfg)


def format_context(ctx):
    return json.dumps(ctx, indent=1, ensure_ascii=False, default=str)[:30000]


def _client():
    try:
        import anthropic
    except ImportError:
        raise ChatError("The Anthropic Python package is missing (pip install anthropic).", "setup")
    k = api_key()
    if not k:
        raise ChatError("Add your Anthropic API key to use the chat.", "setup")
    # explicit base URL: a stray ANTHROPIC_BASE_URL in the environment (set by other tools) must not redirect the key;
    # LRA_ANTHROPIC_BASE_URL is the app's own override (tests, proxies)
    base = os.environ.get("LRA_ANTHROPIC_BASE_URL") or "https://api.anthropic.com"
    return anthropic, anthropic.Anthropic(api_key=k, base_url=base, max_retries=2)


def cost_of(usage):
    if not usage:
        return 0.0
    g = lambda k: getattr(usage, k, 0) or 0
    return (g("input_tokens") * PRICE["in"] + g("output_tokens") * PRICE["out"] + g("cache_read_input_tokens") * PRICE["cache_read"]
            + g("cache_creation_input_tokens") * PRICE["cache_write"]) / 1e6


def reset_chat(chat_id):
    with CHATS_LOCK:
        CHATS.pop(chat_id, None)


def run_chat(chat_id, text, context, emit):
    """One user turn. emit(dict) streams events to the page: status, text, tool, done, error."""
    anthropic, client = _client()
    if not index_available():
        raise ChatError("The Master+ data index is missing (coach/highelo_index.json.gz).", "setup")
    with CHATS_LOCK:
        chat = CHATS.get(chat_id)
        if not chat:
            chat = CHATS[chat_id] = {"messages": [], "ctx": None, "lock": threading.Lock(), "cost": 0.0}
        for cid in [c for c, v in CHATS.items() if c != chat_id and time.time() - v.get("used", 0) > 6 * 3600]:
            CHATS.pop(cid, None)  # forget chats idle for 6 h
        chat["used"] = time.time()
    if not chat["lock"].acquire(blocking=False):
        raise ChatError("Still answering the previous question.", "busy")
    try:
        system = [{"type": "text", "text": system_prompt()}]
        content = []
        sig = json.dumps(context, sort_keys=True, default=str) if context else None
        if sig and sig != chat["ctx"]:  # the history is append-only: a changed context is sent as a new block
            content.append({"type": "text", "text": "<game_context>\n" + format_context(context) + "\n</game_context>"})
            chat["ctx"] = sig
        content.append({"type": "text", "text": text})
        msgs = chat["messages"]
        msgs.append({"role": "user", "content": content})
        turn_cost, bad_json = 0.0, 0
        for _ in range(10):  # model turns (each tool round is one)
            emit({"type": "status", "text": "Thinking…"})
            try:
                with client.beta.messages.stream(
                        model=MODEL, max_tokens=64000, system=system, tools=TOOLS, messages=msgs,
                        thinking={"type": "adaptive"}, output_config={"effort": effort()},
                        cache_control={"type": "ephemeral"},
                        betas=["server-side-fallback-2026-07-01"], fallbacks="default") as stream:
                    for ev in stream:
                        if ev.type == "text":
                            emit({"type": "text", "text": ev.text})
                        elif ev.type == "content_block_start" and getattr(ev.content_block, "type", "") == "tool_use":
                            emit({"type": "status", "text": "Looking it up…"})
                    resp = stream.get_final_message()
                bad_json = 0
            except ValueError:
                # tool input the SDK could not parse at all: no tool_use block to answer, so re-issue the turn
                bad_json += 1
                if bad_json > 2:
                    raise ChatError("Claude's tool call could not be read. Try asking again.")
                continue
            turn_cost += cost_of(resp.usage)
            if resp.stop_reason == "refusal":
                emit({"type": "error", "text": "Claude declined to answer that one."})
                msgs.append({"role": "assistant", "content": resp.content})
                break
            uses = [b for b in resp.content if b.type == "tool_use"]
            if resp.stop_reason == "max_tokens" and uses:
                emit({"type": "error", "text": "The answer got too long and was cut off."})
                break  # not appended: a tool call without its result would break the next request
            msgs.append({"role": "assistant", "content": resp.content})
            if resp.stop_reason == "pause_turn":
                continue
            if not uses:
                if resp.stop_reason == "max_tokens":
                    emit({"type": "error", "text": "The answer got too long and was cut off."})
                break
            results = []
            for b in uses:
                emit({"type": "tool", "text": tool_label(b.name, b.input)})
                out, err = run_tool(b.name, b.input)
                results.append({"type": "tool_result", "tool_use_id": b.id, "content": out, **({"is_error": True} if err else {})})
            msgs.append({"role": "user", "content": results})
        else:
            emit({"type": "error", "text": "Stopped after 10 rounds of lookups without a final answer. Try a narrower question."})
        chat["cost"] += turn_cost
        emit({"type": "done", "cost": round(turn_cost, 4), "chatCost": round(chat["cost"], 4)})
    except ChatError:
        raise
    except Exception as e:
        name = type(e).__name__
        if name == "AuthenticationError":
            raise ChatError("Anthropic rejected the API key. Check it in the chat settings.", "setup")
        if name == "PermissionDeniedError":
            raise ChatError("This API key doesn't have access to the model.", "setup")
        if name == "RateLimitError":
            raise ChatError("Rate limited by the Anthropic API. Wait a moment and try again.")
        if name == "APIConnectionError":
            raise ChatError("Couldn't reach the Anthropic API. Check your internet connection.")
        if name == "BadRequestError" and "credit balance" in str(e).lower():
            raise ChatError("Your Anthropic account is out of credits (console.anthropic.com → Billing).", "setup")
        raise ChatError(f"{name}: {getattr(e, 'message', None) or e}")
    finally:
        chat["lock"].release()


def new_chat_id():
    return uuid.uuid4().hex
