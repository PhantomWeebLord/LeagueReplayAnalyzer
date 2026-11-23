"""Synthetic, deterministic game data in Riot's real shapes. Contains no real players or real match data.

Champion and item IDs are real, so ID handling is exercised the way it is in production.
"""
import json
import random

# (numeric key, internal id, display name, role)
BLUE = [(62, "MonkeyKing", "Wukong", "TOP"), (9, "FiddleSticks", "Fiddlesticks", "JUNGLE"), (103, "Ahri", "Ahri", "MIDDLE"),
        (222, "Jinx", "Jinx", "BOTTOM"), (412, "Thresh", "Thresh", "UTILITY")]
RED = [(122, "Darius", "Darius", "TOP"), (120, "Hecarim", "Hecarim", "JUNGLE"), (7, "Leblanc", "LeBlanc", "MIDDLE"),
       (145, "Kaisa", "Kai'Sa", "BOTTOM"), (89, "Leona", "Leona", "UTILITY")]
CHAMPION_TABLE = [{"key": str(k), "id": i, "name": n} for k, i, n, _ in BLUE + RED]
START_ITEMS = {"TOP": 1054, "JUNGLE": 1103, "MIDDLE": 1056, "BOTTOM": 1055, "UTILITY": 3865}
CORE_ITEMS = [1036, 3006, 3031, 3089, 3078, 2055]
PATCHES = ("15.12", "16.10", "16.23")
LANE_PATH = {
    "TOP": [(1000, 7000), (1000, 10400), (2400, 13700)], "MIDDLE": [(4500, 4500), (6500, 6500), (7400, 7400)],
    "BOTTOM": [(7800, 1300), (10500, 1000), (13500, 2400)], "UTILITY": [(7900, 1500), (10300, 1200), (13300, 2500)],
    "JUNGLE": [(3800, 7950), (7000, 5400), (9800, 4400)],
}
FIGHTS = [(250, 1), (545, 2), (925, 4), (1330, 5), (1640, 6)]
TOWERS = [(860, "MID_LANE", "OUTER_TURRET"), (1010, "TOP_LANE", "OUTER_TURRET"), (1400, "BOT_LANE", "OUTER_TURRET"),
          (1560, "MID_LANE", "INNER_TURRET"), (1660, "MID_LANE", "BASE_TURRET")]


def _pos(team, role, minute, rng):
    if minute == 0:
        return (420, 420) if team == 100 else (14300, 14380)
    path = LANE_PATH[role]
    x, y = path[min(2, minute // 7)]
    if minute >= 21:
        x, y = 7400, 7400
    if team == 200:
        x, y = 14800 - x, 14800 - y
    return x + rng.randint(-250, 250), y + rng.randint(-250, 250)


def make_game(patch="16.23", seed=1, minutes=30, winner=100, match_id=None, queue=420, mode="CLASSIC", map_id=11):
    """A complete Riot Match-V5 match + timeline."""
    rng = random.Random(f"{patch}:{seed}")
    match_id = match_id or f"NA1_{5000000000 + seed}"
    parts = []
    for i, (key, cid, _, role) in enumerate(BLUE + RED):
        team = 100 if i < 5 else 200
        parts.append({
            "participantId": i + 1, "teamId": team, "championName": cid, "championId": key, "teamPosition": role, "individualPosition": role,
            "win": team == winner, "kills": 0, "deaths": 0, "assists": 0, "champLevel": 1, "goldEarned": 0, "visionScore": 18 + rng.randint(0, 22),
            "wardsPlaced": 8 + rng.randint(0, 9), "wardsKilled": rng.randint(1, 5), "visionWardsBoughtInGame": rng.randint(1, 4),
            "totalMinionsKilled": 0, "neutralMinionsKilled": 0, "riotIdGameName": f"Fixture{i + 1}", "riotIdTagline": "TEST", "puuid": f"fixture-puuid-{i + 1}",
        })
    frames = []
    for m in range(minutes + 1):
        pf = {}
        for p in parts:
            lead = 1.07 if p["teamId"] == winner else 1.0
            x, y = _pos(p["teamId"], p["teamPosition"], m, rng)
            gold = int((500 + m * (360 + rng.randint(-25, 25))) * lead)
            cs = 0 if p["teamPosition"] == "UTILITY" else int(m * (6.2 + rng.random()))
            pf[str(p["participantId"])] = {
                "position": {"x": x, "y": y}, "totalGold": gold, "currentGold": 150 + rng.randint(0, 900), "xp": int(m * 620 * lead),
                "level": min(18, 1 + m // 2), "minionsKilled": 0 if p["teamPosition"] == "JUNGLE" else cs, "jungleMinionsKilled": cs if p["teamPosition"] == "JUNGLE" else 0,
            }
        frames.append({"timestamp": m * 60000 + (17 if m else 0), "participantFrames": pf, "events": []})
    end_ms = minutes * 60000 + 5000
    events = _events(parts, frames, winner, patch, rng, end_ms)
    frames.append({"timestamp": end_ms, "participantFrames": frames[-1]["participantFrames"], "events": []})
    for e in events:
        idx = min(len(frames) - 1, e["timestamp"] // 60000 + 1)
        frames[idx]["events"].append(e)
    for f in frames:
        f["events"].sort(key=lambda e: e["timestamp"])
    for p in parts:
        last = frames[-1]["participantFrames"][str(p["participantId"])]
        p.update(goldEarned=last["totalGold"], champLevel=last["level"], totalMinionsKilled=last["minionsKilled"], neutralMinionsKilled=last["jungleMinionsKilled"])
    info = {"gameVersion": f"{patch}.700.1234", "gameDuration": end_ms // 1000, "gameCreation": 1760000000000 + seed * 3600000, "gameEndTimestamp": 1760000000000 + seed * 3600000 + end_ms,
            "mapId": map_id, "queueId": queue, "gameMode": mode, "platformId": "NA1",
            "teams": [{"teamId": 100, "win": winner == 100}, {"teamId": 200, "win": winner == 200}], "participants": parts}
    return {"source": "riot-api", "match": {"metadata": {"matchId": match_id}, "info": info},
            "timeline": {"metadata": {"matchId": match_id}, "info": {"frameInterval": 60000, "frames": frames}}}


def _events(parts, frames, winner, patch, rng, end_ms):
    ev = []
    by_team = {100: parts[:5], 200: parts[5:]}
    loser = 300 - winner
    for p in parts:
        pid = p["participantId"]
        ev.append({"type": "ITEM_PURCHASED", "participantId": pid, "itemId": START_ITEMS[p["teamPosition"]], "timestamp": 3000 + pid * 100})
        for lvl in range(2, min(18, 1 + (end_ms // 60000) // 2) + 1):
            ev.append({"type": "LEVEL_UP", "participantId": pid, "level": lvl, "timestamp": (lvl - 1) * 120000 - 3000})
        for n, item in enumerate(CORE_ITEMS):
            at = (6 + n * 4) * 60000 + 7000 + pid * 900
            if at < end_ms - 60000:
                ev.append({"type": "ITEM_PURCHASED", "participantId": pid, "itemId": item, "timestamp": at})
    for m in range(1, end_ms // 60000):
        for team in (100, 200):
            sup = by_team[team][4]["participantId"]
            ev.append({"type": "WARD_PLACED", "creatorId": sup, "wardType": "CONTROL_WARD" if m % 10 == 0 else "YELLOW_TRINKET", "timestamp": m * 60000 + 11000})
        if m % 4 == 0:
            ev.append({"type": "WARD_KILL", "killerId": by_team[winner][1]["participantId"], "wardType": "YELLOW_TRINKET", "timestamp": m * 60000 + 31000})
    for at, size in FIGHTS:
        if at * 1000 >= end_ms - 20000:
            continue
        x, y = 7000 + rng.randint(-700, 700), 7400 + rng.randint(-700, 700)
        for n in range(size):
            side = loser if n % 3 != 2 else winner
            victim = by_team[side][(n + at) % 5]
            killer = by_team[300 - side][(n + at + 1) % 5]
            mate = by_team[300 - side][(n + at + 2) % 5]
            ev.append({"type": "CHAMPION_KILL", "timestamp": (at + n * 2) * 1000 + 40, "victimId": victim["participantId"], "killerId": killer["participantId"],
                       "assistingParticipantIds": [mate["participantId"]], "position": {"x": x + n * 40, "y": y - n * 40}, "bounty": 300, "shutdownBounty": 150 if n == 3 else 0, "killStreakLength": n})
            killer["kills"] += 1; victim["deaths"] += 1; mate["assists"] += 1
    def monster(at, team, kind, sub=None, pos=(9866, 4414)):
        killer = by_team[team][1]["participantId"]
        e = {"type": "ELITE_MONSTER_KILL", "timestamp": at, "killerId": killer, "killerTeamId": team, "monsterType": kind, "position": {"x": pos[0], "y": pos[1]},
             "assistingParticipantIds": [by_team[team][2]["participantId"]], "bounty": 0}
        if sub:
            e["monsterSubType"] = sub
        ev.append(e)
    for n in range(3):
        monster(490000 + n * 7000, winner, "HORDE", pos=(5007, 10471))
    monster(900000, loser, "RIFTHERALD", pos=(5007, 10471))
    drakes = ["FIRE_DRAGON", "WATER_DRAGON", "HEXTECH_DRAGON", "CHEMTECH_DRAGON"]
    for n, sub in enumerate(drakes):
        at = (330 + n * 300) * 1000
        if at < end_ms - 60000:
            monster(at, winner if n != 1 else loser, "DRAGON", sub)
    if end_ms > 1450000:
        monster(1400000, winner, "DRAGON", "AIR_DRAGON")
        ev.append({"type": "DRAGON_SOUL_GIVEN", "teamId": winner, "name": "Cloud", "timestamp": 1400000})
    if patch.startswith("15.") and end_ms > 1250000:
        monster(1215000, winner, "ATAKHAN", pos=(5000, 10000))
    if end_ms > 1560000:
        monster(1540000, winner, "BARON_NASHOR", pos=(5007, 10471))
    for at, lane, tier in TOWERS:
        if at * 1000 < end_ms - 20000:
            ev.append({"type": "BUILDING_KILL", "timestamp": at * 1000, "teamId": loser, "killerId": by_team[winner][0]["participantId"], "buildingType": "TOWER_BUILDING",
                       "laneType": lane, "towerType": tier, "position": {"x": 7000, "y": 7000}, "bounty": 250})
    if end_ms > 1000000:
        ev.append({"type": "TURRET_PLATE_DESTROYED", "timestamp": 610000, "teamId": loser, "killerId": by_team[winner][0]["participantId"], "laneType": "TOP_LANE", "position": {"x": 1000, "y": 10000}})
    if end_ms > 1700000:
        ev.append({"type": "BUILDING_KILL", "timestamp": 1690000, "teamId": loser, "killerId": by_team[winner][0]["participantId"], "buildingType": "INHIBITOR_BUILDING",
                   "laneType": "MID_LANE", "position": {"x": 11598, "y": 11667}, "bounty": 50})
    ev.append({"type": "GAME_END", "timestamp": end_ms, "winningTeam": winner, "gameId": 1, "realTimestamp": 1})
    return ev


def to_lcu_wire(game):
    """The same game as the League client's match-history endpoints return it (fewer event types, no bounties)."""
    info = game["match"]["info"]
    parts, ident = [], []
    for p in info["participants"]:
        pid = p["participantId"]
        parts.append({"participantId": pid, "teamId": p["teamId"], "championId": p["championId"], "spell1Id": 11 if p["teamPosition"] == "JUNGLE" else 4, "spell2Id": 14,
                      "timeline": {"lane": {"BOTTOM": "BOTTOM", "UTILITY": "BOTTOM", "MIDDLE": "MIDDLE", "TOP": "TOP", "JUNGLE": "JUNGLE"}[p["teamPosition"]],
                                   "role": "DUO_SUPPORT" if p["teamPosition"] == "UTILITY" else "SOLO"},
                      "stats": {"kills": p["kills"], "deaths": p["deaths"], "assists": p["assists"], "win": p["win"], "goldEarned": p["goldEarned"], "champLevel": p["champLevel"],
                                "visionScore": p["visionScore"], "wardsPlaced": p["wardsPlaced"], "wardsKilled": p["wardsKilled"], "visionWardsBoughtInGame": p["visionWardsBoughtInGame"],
                                "totalMinionsKilled": p["totalMinionsKilled"], "neutralMinionsKilled": p["neutralMinionsKilled"]}})
        ident.append({"participantId": pid, "player": {"puuid": p["puuid"], "gameName": p["riotIdGameName"], "tagLine": p["riotIdTagline"]}})
    keep = {"CHAMPION_KILL", "BUILDING_KILL", "ELITE_MONSTER_KILL"}
    frames = []
    for f in game["timeline"]["info"]["frames"]:
        evs = [{k: v for k, v in e.items() if k not in ("bounty", "shutdownBounty")} for e in f["events"] if e["type"] in keep]
        frames.append({"timestamp": f["timestamp"], "participantFrames": f["participantFrames"], "events": evs})
    wire = {"gameId": int(game["match"]["metadata"]["matchId"].split("_")[1]), "gameDuration": info["gameDuration"], "mapId": info["mapId"], "queueId": info["queueId"],
            "gameMode": info["gameMode"], "gameVersion": info["gameVersion"], "gameCreation": info["gameCreation"], "participants": parts, "participantIdentities": ident,
            "teams": [{"teamId": t["teamId"], "win": "Win" if t["win"] else "Fail"} for t in info["teams"]]}
    return wire, {"participants": [], "frames": frames}


def rofl_stats(game):
    out = []
    for p in game["match"]["info"]["participants"]:
        out.append({"PUUID": p["puuid"], "RIOT_ID_GAME_NAME": p["riotIdGameName"], "RIOT_ID_TAG_LINE": p["riotIdTagline"], "SKIN": p["championName"], "TEAM": str(p["teamId"]),
                    "TEAM_POSITION": p["teamPosition"], "WIN": "Win" if p["win"] else "Fail", "CHAMPIONS_KILLED": str(p["kills"]), "NUM_DEATHS": str(p["deaths"]), "ASSISTS": str(p["assists"]),
                    "GOLD_EARNED": str(p["goldEarned"]), "VISION_SCORE": str(p["visionScore"]), "WARD_PLACED": str(p["wardsPlaced"]), "WARD_KILLED": str(p["wardsKilled"]),
                    "MINIONS_KILLED": str(p["totalMinionsKilled"]), "NEUTRAL_MINIONS_KILLED": str(p["neutralMinionsKilled"]), "LEVEL": str(p["champLevel"])})
    return out


def make_rofl(game=None, version="16.23.840.6595", stats=None, packets=512):
    """ROFL v2 layout: magic, version in the header, packet data, trailing JSON metadata."""
    if stats is None:
        stats = rofl_stats(game) if game else []
    duration = game["match"]["info"]["gameDuration"] * 1000 if game else 1800000
    head = b"RIOT\x00\x02" + version.encode("ascii") + b"\x00" * (64 - 6 - len(version))
    meta = json.dumps({"gameLength": duration, "lastGameChunkId": 12, "lastKeyFrameId": 6, "statsJson": json.dumps(stats)}).encode()
    return head + bytes(i % 251 for i in range(packets)) + meta
