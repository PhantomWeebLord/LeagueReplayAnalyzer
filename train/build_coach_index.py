"""Builds coach/highelo_index.json.gz: a compact copy of the Master+ games that the in-app Claude chat queries.

The raw games (train/data/*.json.gz, downloaded by fetch_highelo.py) are ~60 MB of full Riot timelines. The chat only
needs per-minute team gold/XP, positions, wards and the timeline's kills, epic monsters and buildings, so this keeps
those and drops the rest (~5x smaller). Read-only on the source folder.

usage: python train/build_coach_index.py [--data <folder with *.json.gz>] [--out coach/highelo_index.json.gz]
"""
import argparse
import glob
import gzip
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BENCH_MINUTES = (5, 10, 15, 20)
DEFAULT_DATA = [os.path.join(HERE, "data"), os.path.join(os.path.dirname(ROOT), "League Replay Analyzer", "train", "data")]


def compact(game):
    info, tl = game["match"]["info"], game["timeline"]["info"]
    if info.get("mapId", 11) != 11 or info.get("queueId", 420) != 420:
        return None
    frames = tl.get("frames") or []
    if len(frames) < 6:
        return None
    parts = sorted(info["participants"], key=lambda p: p["participantId"])
    if len(parts) != 10:
        return None
    team_of = {p["participantId"]: p["teamId"] for p in parts}
    winner = next((t["teamId"] for t in info.get("teams", []) if t.get("win")), None)
    events = [e for f in frames for e in f.get("events", [])]
    end = next((e for e in events if e["type"] == "GAME_END"), None)
    if winner is None and end:
        winner = end.get("winningTeam")
    if winner not in (100, 200):
        return None
    dur = info["gameDuration"]
    dur = dur / 1000 if dur > 10000 else dur

    gold, xp, pos, bench = [], [], [], {}
    for m, f in enumerate(frames):
        if m in BENCH_MINUTES:  # per-player gold, CS, XP, level at fixed minutes (for champion benchmarks)
            pf = f.get("participantFrames") or {}
            bench[str(m)] = [[d.get("totalGold", 0), d.get("minionsKilled", 0) + d.get("jungleMinionsKilled", 0), d.get("xp", 0), d.get("level", 1)]
                             for d in (pf.get(str(p["participantId"])) or pf.get(p["participantId"]) or {} for p in parts)]
        pf = f.get("participantFrames") or {}
        gb = gr = xb = xr = 0
        row = []
        for p in parts:
            d = pf.get(str(p["participantId"])) or pf.get(p["participantId"]) or {}
            g, x = d.get("totalGold", 0), d.get("xp", 0)
            if team_of[p["participantId"]] == 100:
                gb += g; xb += x
            else:
                gr += g; xr += x
            ps = d.get("position") or {}
            row += [round(ps.get("x", 0) / 10), round(ps.get("y", 0) / 10)]
        gold.append([gb, gr]); xp.append([xb, xr]); pos.append(row)

    minutes = len(frames)
    wards = [[0, 0] for _ in range(minutes)]
    kills, objs, builds, plates = [], [], [], []
    for e in events:
        t = round(e["timestamp"] / 1000, 1)
        ty = e["type"]
        if ty == "CHAMPION_KILL":
            v = e.get("victimId", 0)
            ps = e.get("position") or {}
            # [time, killer team, victim id, killer id (0 = execute), assist ids, x/10, y/10, gold bounty]
            kills.append([t, 300 - team_of.get(v, 100) if v in team_of else 0, v, e.get("killerId", 0),
                          list(e.get("assistingParticipantIds") or []), round(ps.get("x", 0) / 10), round(ps.get("y", 0) / 10),
                          e.get("bounty", 0) + e.get("shutdownBounty", 0)])
        elif ty == "ELITE_MONSTER_KILL":
            kind = e.get("monsterType", "")
            if kind == "DRAGON" and e.get("monsterSubType"):
                kind = e["monsterSubType"]
            objs.append([t, e.get("killerTeamId") or team_of.get(e.get("killerId"), 0), kind])
        elif ty == "BUILDING_KILL":
            # teamId is the team that LOST the building; store the team that destroyed it
            lost = e.get("teamId")
            builds.append([t, 300 - lost if lost in (100, 200) else 0, "INHIB" if e.get("buildingType") == "INHIBITOR_BUILDING" else e.get("towerType", "TOWER"),
                           (e.get("laneType") or "").replace("_LANE", "")])
        elif ty == "TURRET_PLATE_DESTROYED":
            lost = e.get("teamId")
            plates.append([t, 300 - lost if lost in (100, 200) else 0, (e.get("laneType") or "").replace("_LANE", "")])
        elif ty == "WARD_PLACED":
            c = e.get("creatorId")
            if c in team_of:
                m = min(minutes - 1, int(t // 60))
                wards[m][0 if team_of[c] == 100 else 1] += 1
    return {
        "id": "",
        "v": ".".join(info.get("gameVersion", "").split(".")[:2]),
        "d": round(dur),
        "w": winner,
        "c": [[p["championName"], p["teamId"], p.get("teamPosition") or p.get("individualPosition") or ""] for p in parts],
        "s": [[p.get("kills", 0), p.get("deaths", 0), p.get("assists", 0), p.get("goldEarned", 0),
               p.get("totalMinionsKilled", 0) + p.get("neutralMinionsKilled", 0), p.get("visionScore", 0)] for p in parts],
        "g": gold, "x": xp, "p": pos, "wd": wards, "k": kills, "o": objs, "b": builds, "pl": plates, "bm": bench,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data")
    ap.add_argument("--out", default=os.path.join(ROOT, "coach", "highelo_index.json.gz"))
    a = ap.parse_args()
    data = a.data or next((d for d in DEFAULT_DATA if glob.glob(os.path.join(d, "*.json.gz"))), None)
    if not data:
        sys.exit("No Master+ games found. Pass --data <folder with the *.json.gz games from fetch_highelo.py>.")
    files = sorted(glob.glob(os.path.join(data, "*.json.gz")))
    out, skipped = [], 0
    for i, f in enumerate(files):
        try:
            with gzip.open(f) as fh:
                c = compact(json.load(fh))
        except (OSError, ValueError, KeyError, TypeError):
            c = None
        if c:
            c["id"] = f"g{len(out) + 1}"  # no match IDs: they could link a game back to its players
            out.append(c)
        else:
            skipped += 1
        if (i + 1) % 500 == 0:
            print(f"{i + 1}/{len(files)}")
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    tmp = a.out + ".tmp"
    with gzip.open(tmp, "wt", encoding="utf-8", compresslevel=9) as fh:
        json.dump({"version": 1, "source": "NA Master+ solo queue", "games": out}, fh, separators=(",", ":"))
    os.replace(tmp, a.out)
    patches = sorted({g["v"] for g in out}, key=lambda v: [int(x) for x in v.split(".") if x.isdigit()])
    meta = a.out.replace(".json.gz", ".meta.json")
    with open(meta, "w", encoding="utf-8") as fh:
        json.dump({"games": len(out), "patches": f"{patches[0]}–{patches[-1]}" if patches else "", "source": "NA Master+ ranked solo queue"}, fh, ensure_ascii=False)
    print(f"{len(out)} games ({skipped} skipped) -> {a.out} ({os.path.getsize(a.out) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
