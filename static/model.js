'use strict';
/* =====================================================================
   Game model: turns Riot Match-V5 match + timeline into
   - per-player movement tracks (exact at minute frames and at events,
     interpolated in between, with deaths / recalls modelled)
   - per-moment "control" state (gold, xp, vision, territory, objectives, numbers)
   - macro insights (phases, swings, fights, objective setups, player report)
   ===================================================================== */

const SR = { minX: -120, minY: -120, maxX: 14870, maxY: 14980 };
const FOUNTAIN = { 100: { x: 420, y: 420 }, 200: { x: 14300, y: 14380 } };
const TEAM_NAME = { 100: 'Blue', 200: 'Red' };
const ENEMY = { 100: 200, 200: 100 };
const WEIGHTS = { gold: 0.26, xp: 0.08, vision: 0.14, map: 0.22, obj: 0.18, numbers: 0.12 };
const FACTOR_LABEL = { gold: 'Gold', xp: 'Experience', vision: 'Vision', map: 'Map control', obj: 'Objectives', numbers: 'Numbers' };
const BRW = [6, 6, 8, 8, 10, 12, 16, 21, 26, 32.5, 35, 37.5, 40, 42.5, 45, 47.5, 50, 52.5];
const ROLE_ORDER = { TOP: 0, JUNGLE: 1, MIDDLE: 2, BOTTOM: 3, UTILITY: 4 };
const ROLE_SHORT = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'Bot', UTILITY: 'Support' };
const SAMPLE_STEP = 2; // seconds
const RIFT_MAP_ID = 11;
const POSITION_LIMITS = { min: -600, max: 15600 }; // anything further out is bad data, not a real position
// game rules, in seconds unless noted
const INHIB_RESPAWN = 300, NEXUS_TURRET_RESPAWN = 180;
const BARON_BUFF = 180, ELDER_BUFF = 150, HERALD_EFFECT = 240;
const GRUB_GROUP_WINDOW = 40;           // Voidgrubs killed this close together count as one take
const FIGHT_GAP = 15, FIGHT_RADIUS = 3500; // kills join the same fight within this time and distance (map units)
const WALK_SPEED = 370;                 // map units per second, for estimating when a recall happened
const KILL_BOUNTY_DEFAULT = 300;        // League-client timelines don't record bounties
const ASSIST_GOLD_FACTOR = 1.5;         // a kill with assists pays out about this much in total
const PHASE_LEAD = 0.12;                // smoothed control beyond this means one team leads the phase
const MIN_PHASE_SECONDS = 50;
const MOMENT_HALF_WINDOW = 40, MOMENT_MIN_GAP = 100, MOMENT_MIN_SWING = 0.16, MAX_MOMENTS = 10;

// [team, kind, lane, tier, x, y]
const STRUCTURES = [
  [100, 'tower', 'TOP_LANE', 'OUTER_TURRET', 981, 10441], [100, 'tower', 'TOP_LANE', 'INNER_TURRET', 1512, 6699],
  [100, 'tower', 'TOP_LANE', 'BASE_TURRET', 1169, 4287], [100, 'tower', 'MID_LANE', 'OUTER_TURRET', 5846, 6396],
  [100, 'tower', 'MID_LANE', 'INNER_TURRET', 5048, 4812], [100, 'tower', 'MID_LANE', 'BASE_TURRET', 3651, 3696],
  [100, 'tower', 'BOT_LANE', 'OUTER_TURRET', 10504, 1029], [100, 'tower', 'BOT_LANE', 'INNER_TURRET', 6919, 1483],
  [100, 'tower', 'BOT_LANE', 'BASE_TURRET', 4281, 1253], [100, 'tower', 'MID_LANE', 'NEXUS_TURRET', 1748, 2270],
  [100, 'tower', 'MID_LANE', 'NEXUS_TURRET', 2177, 1807],
  [100, 'inhib', 'TOP_LANE', '', 1171, 3571], [100, 'inhib', 'MID_LANE', '', 3203, 3208], [100, 'inhib', 'BOT_LANE', '', 3452, 1236],
  [100, 'nexus', '', '', 1551, 1659],
  [200, 'tower', 'TOP_LANE', 'OUTER_TURRET', 4318, 13875], [200, 'tower', 'TOP_LANE', 'INNER_TURRET', 7943, 13411],
  [200, 'tower', 'TOP_LANE', 'BASE_TURRET', 10481, 13650], [200, 'tower', 'MID_LANE', 'OUTER_TURRET', 8955, 8510],
  [200, 'tower', 'MID_LANE', 'INNER_TURRET', 9767, 10113], [200, 'tower', 'MID_LANE', 'BASE_TURRET', 11134, 11207],
  [200, 'tower', 'BOT_LANE', 'OUTER_TURRET', 13866, 4505], [200, 'tower', 'BOT_LANE', 'INNER_TURRET', 13327, 8226],
  [200, 'tower', 'BOT_LANE', 'BASE_TURRET', 13624, 10572], [200, 'tower', 'MID_LANE', 'NEXUS_TURRET', 12611, 13084],
  [200, 'tower', 'MID_LANE', 'NEXUS_TURRET', 13052, 12612],
  [200, 'inhib', 'TOP_LANE', '', 11261, 13676], [200, 'inhib', 'MID_LANE', '', 11598, 11667], [200, 'inhib', 'BOT_LANE', '', 13604, 11316],
  [200, 'nexus', '', '', 13180, 13180],
];
const TIER_NAME = { OUTER_TURRET: 'outer', INNER_TURRET: 'inner', BASE_TURRET: 'inhibitor', NEXUS_TURRET: 'nexus' };
const LANE_NAME = { TOP_LANE: 'top', MID_LANE: 'mid', BOT_LANE: 'bot' };
const MONSTER_NAME = {
  FIRE_DRAGON: 'Infernal Drake', WATER_DRAGON: 'Ocean Drake', EARTH_DRAGON: 'Mountain Drake', AIR_DRAGON: 'Cloud Drake',
  HEXTECH_DRAGON: 'Hextech Drake', CHEMTECH_DRAGON: 'Chemtech Drake', ELDER_DRAGON: 'Elder Dragon',
  BARON_NASHOR: 'Baron Nashor', RIFTHERALD: 'Rift Herald', HORDE: 'Voidgrubs', ATAKHAN: 'Atakhan (2025 objective)',
};

// ---------------------------------------------------------------- utils
// champion internal id (e.g. MonkeyKing) -> display name (Wukong); filled by the app from Data Dragon
const CHAMP_NAMES = {};
const champName = id => CHAMP_NAMES[id] || CHAMP_NAMES[String(id).replace(/[^A-Za-z0-9]/g, '')] || id;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, f) => a + (b - a) * f;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function fmtTime(s) { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function fmtGold(g, sign = true) {
  const a = Math.abs(g); const v = a >= 1000 ? (a / 1000).toFixed(1) + 'k' : String(Math.round(a));
  return (sign ? (g < 0 ? '−' : '+') : '') + v;
}
function interpSeries(times, vals, t) {
  const n = times.length; if (!n) return 0;
  if (t <= times[0]) return vals[0];
  if (t >= times[n - 1]) return vals[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (times[m] <= t) lo = m; else hi = m; }
  return lerp(vals[lo], vals[hi], (t - times[lo]) / (times[hi] - times[lo] || 1));
}

function zoneOf(x, y) {
  const s = x + y;
  if (Math.hypot(x, y) < 4600) return { name: 'Blue base', side: 100 };
  if (Math.hypot(14800 - x, 14800 - y) < 4600) return { name: 'Red base', side: 200 };
  const side = s < 13100 ? 100 : s > 16500 ? 200 : 0;
  const sideTxt = side === 100 ? ' (Blue side)' : side === 200 ? ' (Red side)' : ' (river)';
  if (x < 2100 || y > 12700) return { name: 'Top lane' + sideTxt, side, lane: 'top' };
  if (y < 2100 || x > 12700) return { name: 'Bot lane' + sideTxt, side, lane: 'bot' };
  if (Math.abs(x - y) < 1500) return { name: 'Mid lane' + sideTxt, side, lane: 'mid' };
  if (side === 0) return { name: y > x ? 'Top river (Baron side)' : 'Bot river (Dragon side)', side: 0 };
  return { name: `${TEAM_NAME[side]} jungle (${y > x ? 'top' : 'bot'} side)`, side };
}

function deathTimer(level, t) {
  const m = t / 60;
  let f = 0.0085 * clamp(m - 15, 0, 15) + 0.006 * clamp(m - 30, 0, 15) + 0.029 * clamp(m - 45, 0, 10);
  f = Math.min(f, 0.5);
  return BRW[clamp(level, 1, 18) - 1] * (1 + f);
}


// ---------------------------------------------------------------- live-recording enrichment
// A game recorded with the live coach has 2-second snapshots of every player's items, level, CS and vision score,
// plus your own gold and health. Where the match timeline lacks detail (League-client data has no item, level or
// ward events), synthesise those events, and attach precise series for vision, deaths and your gold/health.
const NON_PURCHASE_ITEMS = new Set([3865, 3866, 3867, 3869, 3870, 3871, 3876, 3877, // support quest line (upgrades anywhere)
  3042, 3040, 3121, 3513, 3599, 3600, 2052]); // Muramana / Seraph's / Fimbulwinter transforms, Eye of the Herald, Kalista spear, Poro-snax
function isUsableRecording(live) {
  if (!live || !Array.isArray(live.snaps) || live.snaps.length < 5 || !Array.isArray(live.players)) return false;
  const n = live.players.length;
  return live.snaps.every(s => s && isNum(s.t) && Array.isArray(s.p) && s.p.length === n && s.p.every(Array.isArray));
}
function enrichWithLive(data, live) {
  if (!isUsableRecording(live)) return data; // a damaged recording must not block the review of the game
  const parts = data.match.info.participants;
  const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const pids = live.players.map(lp => {
    const m = parts.find(p => p.teamId === lp.team && norm(p.championName) === norm(lp.championId))
      || parts.find(p => norm(p.riotIdGameName) && norm(p.riotIdGameName) === norm(lp.name));
    return m ? m.participantId : null;
  });
  const frames = data.timeline.info.frames;
  const has = type => frames.some(f => (f.events || []).some(e => e.type === type));
  const add = [];
  const S = live.snaps;
  if (!has('ITEM_PURCHASED')) {
    live.players.forEach((lp, i) => {
      if (!pids[i]) return;
      let prev = new Map();
      S.forEach((s, k) => {
        const cur = new Map(); for (const [id, c] of s.p[i][8] || []) cur.set(id, (cur.get(id) || 0) + c);
        if (k > 0 && s.t > 20) for (const [id, c] of cur) if (c > (prev.get(id) || 0) && !NON_PURCHASE_ITEMS.has(id))
          add.push({ type: 'ITEM_PURCHASED', participantId: pids[i], itemId: id, timestamp: Math.round(s.t * 1000), synthetic: true });
        prev = cur;
      });
    });
  }
  if (!has('LEVEL_UP')) {
    live.players.forEach((lp, i) => {
      if (!pids[i]) return;
      for (let k = 1; k < S.length; k++) {
        const a = S[k - 1].p[i][0], b = S[k].p[i][0];
        for (let L = a + 1; L <= b; L++) add.push({ type: 'LEVEL_UP', participantId: pids[i], level: L, timestamp: Math.round(S[k].t * 1000), synthetic: true });
      }
    });
  }
  for (const e of add) {
    let fi = frames.findIndex(f => f.timestamp >= e.timestamp); if (fi < 0) fi = frames.length - 1;
    (frames[fi].events = frames[fi].events || []).push(e);
  }
  for (const f of frames) if (f.events) f.events.sort((a, b) => a.timestamp - b.timestamp);
  const out = { t: S.map(s => s.t), vision: { 100: [], 200: [] }, dead: {}, me: null, gold: S.map(s => s.g), hp: S.map(s => s.hp), synthetic: add.length };
  for (const s of S) {
    let vb = 0, vr = 0;
    s.p.forEach((row, i) => { if (live.players[i].team === 100) vb += row[5] || 0; else vr += row[5] || 0; });
    out.vision[100].push(vb); out.vision[200].push(vr);
  }
  live.players.forEach((lp, i) => {
    if (!pids[i]) return;
    const iv = []; let start = null;
    for (const s of S) { const d = s.p[i][6]; if (d && start == null) start = s.t; if (!d && start != null) { iv.push([start, s.t]); start = null; } }
    if (start != null) iv.push([start, S[S.length - 1].t]);
    out.dead[pids[i]] = iv;
  });
  if (live.me != null && pids[live.me]) out.me = pids[live.me];
  return Object.assign({}, data, { live: out });
}

// ---------------------------------------------------------------- input checks
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const num = (v, fallback = 0) => { const n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v ?? NaN); return Number.isFinite(n) ? n : fallback; };
function validPos(pos) {
  if (!pos || !Number.isFinite(pos.x === null ? NaN : Number(pos.x)) || !Number.isFinite(pos.y === null ? NaN : Number(pos.y))) return null;
  return { x: clamp(Number(pos.x), POSITION_LIMITS.min, POSITION_LIMITS.max), y: clamp(Number(pos.y), POSITION_LIMITS.min, POSITION_LIMITS.max) };
}
// Data the analysis cannot work with gets a clear error here, instead of a confident review of nothing.
function validateGameData(data) {
  const info = data && data.match && data.match.info, tl = data && data.timeline && data.timeline.info;
  if (!info || !tl) throw new Error('The match data is incomplete.');
  if (info.mapId && info.mapId !== RIFT_MAP_ID) throw new Error(`Only Summoner's Rift games are supported (this game was on map ${info.mapId}).`);
  const players = info.participants;
  if (!Array.isArray(players) || !players.length) throw new Error('The match data has no players.');
  if (players.some(p => !p || p.participantId == null || !ENEMY[p.teamId])) throw new Error('The match data has invalid players.');
  if (!Array.isArray(tl.frames) || !tl.frames.some(f => f && isNum(f.timestamp))) throw new Error('The match timeline is empty.');
}

// What the player should know before trusting this review.
const patchKey = v => { const m = String(v || '').match(/^(\d+)\.(\d+)/); return m ? +m[1] * 1000 + +m[2] : null; };
function analysisNotes(game) {
  const notes = [...(game.dataNotes || [])];
  const mode = game.info.gameMode;
  if (mode && mode !== 'CLASSIC') notes.push(`This is a ${mode} game. Grades compare it with normal Summoner's Rift games, so treat them as rough.`);
  const trained = (typeof window !== 'undefined' && window.WP_MODEL && window.WP_MODEL.patches) || [];
  const keys = trained.map(patchKey).filter(k => k != null), here = patchKey(game.info.gameVersion);
  if (keys.length && here != null && (here < Math.min(...keys) || here > Math.max(...keys))) {
    const patch = String(game.info.gameVersion).split('.').slice(0, 2).join('.');
    notes.push(`This game is from patch ${patch}. The grades use a model trained on patches ${trained[0]}–${trained[trained.length - 1]}, so treat them as approximate.`);
  }
  return notes;
}

// ---------------------------------------------------------------- build
function buildGame(data, opts) {
  validateGameData(data);
  const info = data.match.info;
  const tlInfo = data.timeline.info;
  const frames = tlInfo.frames.filter(f => f && isNum(f.timestamp));
  const events = [];
  let droppedEvents = 0;
  for (const f of frames) for (const e of f.events || []) {
    if (!e || !isNum(e.timestamp)) { droppedEvents++; continue; }
    events.push(Object.assign({ t: e.timestamp / 1000 }, e));
  }
  events.sort((a, b) => a.t - b.t);
  const endEv = events.find(e => e.type === 'GAME_END');
  const lastFrameT = frames.length ? frames[frames.length - 1].timestamp / 1000 : 0;
  const duration = endEv ? endEv.t : Math.max(lastFrameT, info.gameDuration > 10000 ? info.gameDuration / 1000 : info.gameDuration || 0);
  if (!(duration > 0)) throw new Error('This match has no game time to analyse.');

  const ps = info.participants.map(p => ({
    id: p.participantId, puuid: p.puuid, team: p.teamId, champ: p.championName || String(p.championId ?? 'Unknown'), cname: champName(p.championName || String(p.championId ?? 'Unknown')),
    name: p.riotIdGameName || p.summonerName || p.championName || 'Unknown', tag: p.riotIdTagline || '',
    role: p.teamPosition || p.individualPosition || '', final: p,
  }));
  ps.sort((a, b) => a.team - b.team || (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9));
  const byId = {}; ps.forEach(p => (byId[p.id] = p));
  const winner = (info.teams || []).find(t => t.win)?.teamId || (endEv && endEv.winningTeam) || null;

  // --- frame series
  const ft = frames.map(f => f.timestamp / 1000);
  for (const p of ps) {
    const s = { gold: [], xp: [], cs: [], x: [], y: [], level: [], cur: [] };
    let prev = null;
    for (const f of frames) {
      const pf = (f.participantFrames && (f.participantFrames[p.id] || f.participantFrames[String(p.id)])) || prev;
      prev = pf;
      s.gold.push(pf ? num(pf.totalGold) : 0);
      s.xp.push(pf ? num(pf.xp) : 0);
      s.cs.push(pf ? num(pf.minionsKilled) + num(pf.jungleMinionsKilled) : 0);
      s.level.push(pf ? num(pf.level) || 1 : 1);
      s.cur.push(pf ? num(pf.currentGold) : 0);
      const at = validPos(pf && pf.position) || FOUNTAIN[p.team];
      s.x.push(at.x);
      s.y.push(at.y);
    }
    p.series = s;
    p.levelUps = []; p.deaths = []; p.kills = []; p.assistsAt = [];
  }

  for (const e of events) if (e.type === 'LEVEL_UP' && byId[e.participantId]) byId[e.participantId].levelUps.push({ t: e.t, level: e.level });

  const game = { info, events, duration, ps, byId, winner, ft, frames, matchId: data.match.metadata?.matchId, source: data.source || 'riot-api' };
  game.dataNotes = [];
  if (ps.length !== 10) game.dataNotes.push(`This game has ${ps.length} players, so team comparisons are approximate.`);
  if (droppedEvents) game.dataNotes.push(`${droppedEvents} timeline event${droppedEvents === 1 ? ' was' : 's were'} unreadable and left out.`);
  game.hasWards = events.some(e => e.type === 'WARD_PLACED');
  game.live = data.live || null;
  game.hasItems = events.some(e => e.type === 'ITEM_PURCHASED');
  game.hasLevels = events.some(e => e.type === 'LEVEL_UP');
  for (const p of ps) p._ft = ft;

  // --- kills & deaths
  game.kills = [];
  for (const e of events) {
    if (e.type !== 'CHAMPION_KILL' || !byId[e.victimId]) continue;
    const victim = byId[e.victimId];
    const pos = validPos(e.position) || { x: interpSeries(ft, victim.series.x, e.t), y: interpSeries(ft, victim.series.y, e.t) };
    const k = { t: e.t, killer: e.killerId, victim: e.victimId, assists: e.assistingParticipantIds || [], x: pos.x, y: pos.y,
      team: ENEMY[victim.team], bounty: (e.bounty || 0) + (e.shutdownBounty || 0) };
    game.kills.push(k);
    const respawn = Math.min(e.t + deathTimer(levelAt(victim, e.t), e.t), duration);
    victim.deaths.push({ t: e.t, respawn, x: pos.x, y: pos.y, kill: k });
    if (byId[e.killerId]) byId[e.killerId].kills.push(e.t);
    for (const a of k.assists) if (byId[a]) byId[a].assistsAt.push(e.t);
  }

  // live recording: exact respawn times
  if (game.live) for (const p of ps) {
    const iv = game.live.dead[p.id] || [];
    for (const d of p.deaths) { const m = iv.find(([a, b]) => Math.abs(a - d.t) <= 4 && b > d.t); if (m) d.respawn = Math.min(duration, m[1]); }
  }
  // Respawns are estimated from level and game time. A later death, or a kill/assist well after dying (assists can land
  // up to ~10 s after you die), proves the champion was already back.
  for (const p of ps) p.deaths.forEach((d, i) => {
    const next = p.deaths[i + 1];
    let back = next ? next.t - 0.5 : Infinity;
    for (const x of [...p.kills, ...p.assistsAt]) if (x > d.t + 14 && x < back) back = x;
    if (back < d.respawn) d.respawn = Math.max(d.t + 1, back);
  });
  buildTracks(game);
  buildStructures(game);
  buildObjectives(game);
  buildWards(game);
  buildWpSeries(game);
  game.visionScore = { 100: 0, 200: 0 };
  for (const p of ps) game.visionScore[p.team] += p.final.visionScore || 0;
  game.wpm = opts && opts.noModel ? null : wpModelFor(game);
  if (opts && opts.light) return game; // training: state only, no sampling / fights / review inputs
  sampleControl(game);
  game.fights = findFights(game);
  game.phases = findPhases(game);
  game.moments = findMoments(game);
  game.objectiveReview = reviewObjectives(game);
  return game;
}

function levelAt(p, t) {
  let lvl = 1;
  if (!p.levelUps.length && p._ft) { // no LEVEL_UP events (League-client data): use minute frames
    const ft = p._ft; for (let i = 0; i < ft.length && ft[i] <= t; i++) lvl = p.series.level[i];
    return clamp(lvl, 1, 18);
  }
  for (const l of p.levelUps) { if (l.t <= t) lvl = Math.max(lvl, l.level || lvl + 1); else break; }
  return clamp(lvl, 1, 18);
}
function isDead(p, t) { for (const d of p.deaths) if (t >= d.t && t < d.respawn) return d; return null; }
function countBefore(arr, t) { let n = 0; for (const x of arr) if (x <= t) n++; return n; }

// ---------------------------------------------------------------- movement tracks
// keyframe kinds: 0 frame snapshot, 1 event position, 2 teleport-to-fountain (recall / respawn), 3 death
function buildTracks(game) {
  const { ps, byId, events, ft } = game;
  const add = (id, t, x, y, k) => { const p = byId[id]; if (p && x != null) p.kf.push({ t, x, y, k }); };
  for (const p of ps) {
    p.kf = [];
    ft.forEach((t, i) => p.kf.push({ t, x: p.series.x[i], y: p.series.y[i], k: 0 }));
    for (const d of p.deaths) {
      p.kf.push({ t: d.t, x: d.x, y: d.y, k: 3 });
      p.kf.push({ t: d.respawn, x: FOUNTAIN[p.team].x, y: FOUNTAIN[p.team].y, k: 2 });
    }
  }
  for (const k of game.kills) {
    add(k.killer, k.t, k.x, k.y, 1);
    for (const a of k.assists) add(a, k.t, k.x, k.y, 1);
  }
  for (const e of events) {
    if ((e.type === 'BUILDING_KILL' || e.type === 'ELITE_MONSTER_KILL' || e.type === 'TURRET_PLATE_DESTROYED') && e.position) {
      add(e.killerId, e.t, e.position.x, e.position.y, 1);
      for (const a of e.assistingParticipantIds || []) add(a, e.t, e.position.x, e.position.y, 1);
    }
    // Items can only be bought / sold in the fountain: a purchase means the player recalled.
    if ((e.type === 'ITEM_PURCHASED' || e.type === 'ITEM_SOLD') && e.t > 75) {
      const p = byId[e.participantId];
      if (p && !isDead(p, e.t)) add(p.id, e.t, FOUNTAIN[p.team].x, FOUNTAIN[p.team].y, 2);
    }
  }
  // No purchase events (League-client data): infer recalls from gold being spent between frames,
  // and from minute snapshots that show the player standing in their fountain.
  if (!game.hasItems) {
    for (const p of ps) {
      const s = p.series; const F = FOUNTAIN[p.team];
      for (let i = 1; i < ft.length; i++) {
        const a = ft[i - 1], b = ft[i];
        const spent = s.cur[i - 1] + (s.gold[i] - s.gold[i - 1]) - s.cur[i];
        const diedHere = p.deaths.some(d => d.t < b && d.respawn > a);
        const pos = { x: s.x[i], y: s.y[i] };
        const atBase = dist(pos, F) < 1500;
        if (diedHere) continue;
        if (spent > 300 || atBase) {
          const walk = dist(pos, F) / WALK_SPEED; // seconds walking back out from fountain
          const tr = clamp(b - walk - 10, a + 5, b - 1);
          p.kf.push({ t: tr, x: F.x, y: F.y, k: 2 });
          p.recalls = p.recalls || []; p.recalls.push({ t: tr, from: a, to: b, spent: Math.max(0, spent), inferred: true });
        }
      }
    }
  } else {
    for (const p of ps) {
      p.recalls = [];
      for (const e of events) if (e.type === 'ITEM_PURCHASED' && e.participantId === p.id && e.t > 75 && !isDead(p, e.t)) {
        const last = p.recalls[p.recalls.length - 1];
        if (!last || e.t - last.t > 40) p.recalls.push({ t: e.t, inferred: false });
      }
    }
  }
  for (const p of ps) {
    p.recalls = p.recalls || [];
    // drop non-death keyframes while dead
    let kf = p.kf.filter(f => f.k === 3 || !p.deaths.some(d => f.t > d.t && f.t < d.respawn));
    kf.sort((a, b) => a.t - b.t || a.k - b.k);
    const out = [];
    for (const f of kf) {
      const last = out[out.length - 1];
      if (last && f.t - last.t < 1) { if (f.k >= last.k) out[out.length - 1] = f; }
      else out.push(f);
    }
    p.kf = out;
    buildSegments(p);
  }
}

// ---------------------------------------------------------------- navigation graph (approximate walkable routes)
// Hand-placed nodes along lanes, river and both jungles. Movement between known positions follows the shortest
// route through this graph (smoothed), instead of a straight line through walls. Red side mirrors blue side.
const NAV = (() => {
  const N = {
    BF: [400, 420], BN: [1550, 1660], RF: [14300, 14380], RN: [13180, 13180],
    T0: [1170, 3570], T1: [1050, 5500], T2: [1000, 7800], T3: [1000, 10400], T4: [1500, 12600], T5: [2400, 13700],
    T6: [4300, 13900], T7: [6600, 13650], T8: [8800, 13500], T9: [11260, 13680],
    M0: [3200, 3210], M1: [4500, 4500], M2: [5850, 6000], M3: [7400, 7400], M4: [8950, 8800], M5: [10300, 10300], M6: [11600, 11670],
    B0: [3450, 1240], B1: [5500, 1150], B2: [7800, 1300], B3: [10500, 1000], B4: [12600, 1500], B5: [13500, 2400],
    B6: [13870, 4500], B7: [13650, 6600], B8: [13450, 9000], B9: [13600, 11320],
    R1: [2900, 11900], R2: [4600, 10200], RB: [5000, 10500], R3: [6000, 8800], R4: [8800, 6000], R5: [10200, 4600], RD: [9870, 4420], R6: [11900, 2900],
    JBb: [3800, 7950], JBg: [2100, 8400], JBw: [3800, 6500], JBr: [7000, 5400], JBred: [7800, 4100], JBk: [8400, 2700],
    JB1: [2300, 5300], JB2: [4900, 8900], JB3: [9000, 3600], JB4: [6000, 3700],
  };
  const E = [
    'BF-BN', 'BN-T0', 'BN-M0', 'BN-B0', 'RF-RN', 'RN-T9', 'RN-M6', 'RN-B9',
    'T0-T1', 'T1-T2', 'T2-T3', 'T3-T4', 'T4-T5', 'T5-T6', 'T6-T7', 'T7-T8', 'T8-T9',
    'M0-M1', 'M1-M2', 'M2-M3', 'M3-M4', 'M4-M5', 'M5-M6',
    'B0-B1', 'B1-B2', 'B2-B3', 'B3-B4', 'B4-B5', 'B5-B6', 'B6-B7', 'B7-B8', 'B8-B9',
    'T4-R1', 'T5-R1', 'R1-R2', 'R2-RB', 'R2-R3', 'R3-M3', 'M3-R4', 'R4-R5', 'R5-RD', 'R5-R6', 'R6-B4', 'R6-B5',
    'JBg-JBb', 'JBb-JBw', 'T1-JB1', 'JB1-JBw', 'JBg-T2', 'JBb-JB2', 'JB2-R3', 'JB2-R2', 'JBw-M2', 'JBr-M2', 'JBr-R4',
    'JBr-JBred', 'JBred-JB3', 'JB3-R5', 'JB3-JBk', 'JBred-JBk', 'JBk-B2', 'JBred-JB4', 'JB4-M1', 'JB4-B1', 'JB1-M0',
  ];
  // mirror the blue jungle onto the red side (rotational symmetry around the map centre)
  const mir = { BF: 'RF', BN: 'RN', RF: 'BF', RN: 'BN', R1: 'R6', R2: 'R5', RB: 'RD', R3: 'R4', R6: 'R1', R5: 'R2', RD: 'RB', R4: 'R3' };
  const mirrorName = n => {
    if (n.startsWith('JB')) return 'JR' + n.slice(2);
    if (mir[n]) return mir[n];
    if (/^[TB]\d$/.test(n)) return (n[0] === 'T' ? 'B' : 'T') + (9 - +n[1]);
    if (/^M\d$/.test(n)) return 'M' + (6 - +n[1]);
    return null;
  };
  for (const k of Object.keys(N)) if (k.startsWith('JB')) N['JR' + k.slice(2)] = [14800 - N[k][0], 14800 - N[k][1]];
  const edges = new Set(E);
  for (const e of E) { const [a, b] = e.split('-'); if (a.startsWith('JB') || b.startsWith('JB')) { const ma = mirrorName(a), mb = mirrorName(b); if (ma && mb && N[ma] && N[mb]) edges.add(ma + '-' + mb); } }
  const names = Object.keys(N), idx = Object.fromEntries(names.map((n, i) => [n, i]));
  const pts = names.map(n => ({ x: N[n][0], y: N[n][1] }));
  const adj = names.map(() => []);
  for (const e of edges) { const [a, b] = e.split('-').map(n => idx[n]); const d = dist(pts[a], pts[b]); adj[a].push([b, d]); adj[b].push([a, d]); }
  return { pts, adj };
})();

function routeBetween(a, b) {
  // shortest path a -> nearest graph nodes -> ... -> b; returns a polyline of {x, y}
  const P = NAV.pts, n = P.length;
  const near = q => P.map((p, i) => [i, dist(p, q)]).sort((u, v) => u[1] - v[1]).slice(0, 3);
  const A = near(a), B = near(b);
  const D = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), done = new Uint8Array(n);
  for (const [i, d] of A) D[i] = d;
  const goal = new Map(B.map(([i, d]) => [i, d]));
  let best = Infinity, bestEnd = -1;
  for (;;) {
    let u = -1, du = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && D[i] < du) { du = D[i]; u = i; }
    if (u < 0 || du >= best) break;
    done[u] = 1;
    if (goal.has(u) && du + goal.get(u) < best) { best = du + goal.get(u); bestEnd = u; }
    for (const [v, w] of NAV.adj[u]) if (du + w < D[v]) { D[v] = du + w; prev[v] = u; }
  }
  if (bestEnd < 0) return [a, b];
  const path = []; for (let u = bestEnd; u >= 0; u = prev[u]) path.push(P[u]);
  path.reverse();
  return [a, ...path, b];
}
function chaikin(pts, iter = 2) {
  for (let k = 0; k < iter; k++) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i + 1];
      out.push({ x: 0.75 * p.x + 0.25 * q.x, y: 0.75 * p.y + 0.25 * q.y }, { x: 0.25 * p.x + 0.75 * q.x, y: 0.25 * p.y + 0.75 * q.y });
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}
function buildSegments(p) {
  // a smoothed route for every walk between two keyframes (holds and teleports stay as they are)
  p.seg = [];
  for (let i = 0; i + 1 < p.kf.length; i++) {
    const a = p.kf[i], b = p.kf[i + 1];
    if (b.k === 2 || a.k === 3) { p.seg.push(null); continue; }
    const direct = dist(a, b), dt = Math.max(1, b.t - a.t);
    let pts = [a, b];
    if (direct > 1500) {
      const r = routeBetween(a, b);
      let len = 0; for (let j = 1; j < r.length; j++) len += dist(r[j - 1], r[j]);
      if (len < direct * 2.2 && len / dt < 650) pts = chaikin(r, 2);  // only if the route is walkable in the time available
    }
    const cum = [0]; for (let j = 1; j < pts.length; j++) cum.push(cum[j - 1] + dist(pts[j - 1], pts[j]));
    p.seg.push({ pts, cum, len: cum[cum.length - 1] });
  }
}

function posAt(p, t) {
  const k = p.kf; const n = k.length;
  if (!n) return FOUNTAIN[p.team];
  if (t <= k[0].t) return k[0];
  if (t >= k[n - 1].t) return k[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (k[m].t <= t) lo = m; else hi = m; }
  const a = k[lo], b = k[hi];
  if (b.k === 2 || a.k === 3) return a; // holding position until a recall / during death
  const f = (t - a.t) / (b.t - a.t || 1);
  const sg = p.seg && p.seg[lo];
  if (!sg || sg.pts.length <= 2) return { x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f) };
  // constant speed along the smoothed route
  const d = f * sg.len, c = sg.cum; let j = 1;
  while (j < c.length - 1 && c[j] < d) j++;
  const u = (d - c[j - 1]) / ((c[j] - c[j - 1]) || 1);
  return { x: lerp(sg.pts[j - 1].x, sg.pts[j].x, u), y: lerp(sg.pts[j - 1].y, sg.pts[j].y, u) };
}
// how "exact" the position is at t (seconds to nearest known keyframe)
function posConfidence(p, t) {
  let best = 1e9;
  for (const f of p.kf) { const d = Math.abs(f.t - t); if (d < best) best = d; if (f.t > t + best) break; }
  return best;
}

// ---------------------------------------------------------------- structures
function buildStructures(game) {
  game.structures = STRUCTURES.map(([team, kind, lane, tier, x, y]) => ({ team, kind, lane, tier, x, y, downs: [] }));
  game.structureEvents = [];
  for (const e of game.events) {
    if (e.type !== 'BUILDING_KILL') continue;
    const kind = e.buildingType === 'INHIBITOR_BUILDING' ? 'inhib' : 'tower';
    const alive = s => !s.downs.some(([a, b]) => e.t >= a && e.t < b);
    let cands = game.structures.filter(s => s.team === e.teamId && s.kind === kind && alive(s));
    let s = cands.find(s => s.lane === e.laneType && (kind === 'inhib' || s.tier === e.towerType));
    if (!s && e.position && cands.length) s = cands.reduce((a, b) => (dist(a, e.position) < dist(b, e.position) ? a : b));
    if (!s) continue;
    // inhibitors respawn after 5 minutes and nexus turrets after 3; other turrets stay down
    s.downs.push([e.t, kind === 'inhib' ? e.t + INHIB_RESPAWN : s.tier === 'NEXUS_TURRET' ? e.t + NEXUS_TURRET_RESPAWN : Infinity]);
    const label = kind === 'inhib' ? `${TEAM_NAME[s.team]} ${LANE_NAME[s.lane]} inhibitor` : `${TEAM_NAME[s.team]} ${LANE_NAME[s.lane] || ''} ${TIER_NAME[s.tier] || ''} tower`.replace(/\s+/g, ' ');
    game.structureEvents.push({ t: e.t, team: ENEMY[s.team], lost: s.team, kind, tier: s.tier, lane: s.lane, x: s.x, y: s.y, label, killer: e.killerId });
  }
  game.plates = game.events.filter(e => e.type === 'TURRET_PLATE_DESTROYED' && ENEMY[e.teamId]).map(e => ({ t: e.t, team: ENEMY[e.teamId], lane: e.laneType, killer: e.killerId }));
}
function structureAlive(s, t) { return !s.downs.some(([a, b]) => t >= a && t < b); }

// ---------------------------------------------------------------- objectives
function buildObjectives(game) {
  const list = [];
  for (const e of game.events) {
    if (e.type !== 'ELITE_MONSTER_KILL') continue;
    const team = e.killerTeamId || (game.byId[e.killerId] && game.byId[e.killerId].team);
    if (team !== 100 && team !== 200) continue;
    if (e.monsterType === 'ATAKHAN' && parseInt(String(game.info.gameVersion || '').split('.')[0], 10) >= 16) continue; // 2025-only objective
    const key = e.monsterType === 'DRAGON' ? (e.monsterSubType === 'ELDER_DRAGON' ? 'ELDER' : 'DRAGON') : e.monsterType;
    const name = MONSTER_NAME[e.monsterSubType] || MONSTER_NAME[e.monsterType] || e.monsterType;
    const pos = e.position || (key === 'DRAGON' || key === 'ELDER' ? { x: 9866, y: 4414 } : { x: 5007, y: 10471 });
    list.push({ t: e.t, team, key, name, x: pos.x, y: pos.y, killer: e.killerId, assists: e.assistingParticipantIds || [] });
  }
  // group voidgrubs taken together
  game.objectives = [];
  for (const o of list) {
    const last = game.objectives[game.objectives.length - 1];
    if (o.key === 'HORDE' && last && last.key === 'HORDE' && last.team === o.team && o.t - last.t < GRUB_GROUP_WINDOW) { last.count++; last.name = `${last.count} Voidgrubs`; continue; }
    game.objectives.push(Object.assign({ count: 1 }, o, o.key === 'HORDE' ? { name: '1 Voidgrub' } : {}));
  }
  game.souls = game.events.filter(e => e.type === 'DRAGON_SOUL_GIVEN' && (e.teamId === 100 || e.teamId === 200)).map(e => ({ t: e.t, team: e.teamId, name: e.name }));
  // League-client timelines have no soul event: the first team to its fourth drake gets the soul
  if (!game.events.some(e => e.type === 'DRAGON_SOUL_GIVEN')) {
    const n = { 100: 0, 200: 0 };
    for (const o of game.objectives) if (o.key === 'DRAGON' && ++n[o.team] === 4 && !game.souls.length) game.souls.push({ t: o.t, team: o.team, name: null });
  }
}

function objectiveScore(game, t) {
  const sc = { 100: 0, 200: 0 };
  const det = { 100: { towers: 0, inhibs: 0, dragons: 0, barons: 0, heralds: 0, grubs: 0, atakhan: 0, plates: 0, baronBuff: false, elderBuff: false, soul: false },
    200: { towers: 0, inhibs: 0, dragons: 0, barons: 0, heralds: 0, grubs: 0, atakhan: 0, plates: 0, baronBuff: false, elderBuff: false, soul: false } };
  const tierW = { OUTER_TURRET: 1, INNER_TURRET: 1.3, BASE_TURRET: 1.6, NEXUS_TURRET: 2 };
  for (const s of game.structureEvents) {
    if (s.t > t) break;
    if (s.kind === 'tower') { sc[s.team] += tierW[s.tier] || 1; det[s.team].towers++; }
    else if (t < s.t + INHIB_RESPAWN) { sc[s.team] += 3; det[s.team].inhibs++; }
  }
  for (const p of game.plates) if (p.t <= t) { sc[p.team] += 0.15; det[p.team].plates++; }
  for (const o of game.objectives) {
    if (o.t > t) break;
    const d = det[o.team];
    if (o.key === 'DRAGON') { sc[o.team] += 1; d.dragons++; }
    else if (o.key === 'ELDER') { if (t < o.t + ELDER_BUFF) { sc[o.team] += 7; d.elderBuff = true; } }
    else if (o.key === 'BARON_NASHOR') { d.barons++; if (t < o.t + BARON_BUFF) { sc[o.team] += 7; d.baronBuff = true; } else sc[o.team] += 0.5; }
    else if (o.key === 'RIFTHERALD') { d.heralds++; sc[o.team] += t < o.t + HERALD_EFFECT ? 1 : 0.3; }
    else if (o.key === 'HORDE') { d.grubs += o.count; sc[o.team] += 0.35 * o.count; }
    else if (o.key === 'ATAKHAN') { d.atakhan++; sc[o.team] += 1.5; }
  }
  for (const s of game.souls) if (s.t <= t) { sc[s.team] += 2.5; det[s.team].soul = s.name || true; }
  return { score: Math.tanh((sc[100] - sc[200]) / 4), det, raw: sc };
}

// ---------------------------------------------------------------- wards (estimated from place / kill events)
function buildWards(game) {
  const { byId, events, duration } = game;
  const life = (type, lvl) => type === 'YELLOW_TRINKET' ? 90 + 30 * (lvl - 1) / 17 : type === 'SIGHT_WARD' ? 150
    : type === 'BLUE_TRINKET' ? 240 : type === 'CONTROL_WARD' ? 1e9 : 0;
  const wards = []; let active = [];
  game.wardKills = [];
  for (const e of events) {
    if (e.type === 'WARD_PLACED') {
      const c = byId[e.creatorId]; if (!c) continue;
      const L = life(e.wardType, levelAt(c, e.t)); if (!L) continue;
      active = active.filter(w => w.end > e.t);
      if (e.wardType === 'CONTROL_WARD') active.filter(w => w.creator === c.id && w.type === 'CONTROL_WARD').forEach(w => (w.end = e.t));
      if (e.wardType === 'YELLOW_TRINKET' || e.wardType === 'SIGHT_WARD') {
        const mine = active.filter(w => w.creator === c.id && (w.type === 'YELLOW_TRINKET' || w.type === 'SIGHT_WARD') && w.end > e.t);
        if (mine.length >= 3) mine[0].end = e.t;
      }
      const w = { team: c.team, creator: c.id, type: e.wardType, start: e.t, end: Math.min(e.t + L, duration) };
      wards.push(w); active.push(w);
    } else if (e.type === 'WARD_KILL') {
      const k = byId[e.killerId]; if (!k) continue;
      game.wardKills.push({ t: e.t, team: k.team, killer: k.id, type: e.wardType });
      active = active.filter(w => w.end > e.t);
      let c = active.filter(w => w.team !== k.team && w.type === e.wardType);
      if (!c.length) c = active.filter(w => w.team !== k.team);
      if (c.length) c[0].end = e.t;
    }
  }
  game.wards = wards;
}
function wardCount(game, team, t) {
  let n = 0;
  for (const w of game.wards) if (w.team === team && w.start <= t && t < w.end) n += w.type === 'CONTROL_WARD' ? 1.2 : w.type === 'BLUE_TRINKET' ? 0.7 : 1;
  return n;
}

// ---------------------------------------------------------------- influence / territory
function influence(game, t, N, wantGrid, bd = SR) {
  const { ps } = game;
  const src = [];
  let goldSum = 0; const golds = {};
  for (const p of ps) { golds[p.id] = interpSeries(game.ft, p.series.gold, t); goldSum += golds[p.id]; }
  const avgGold = goldSum / ps.length || 1;
  const alive = { 100: 0, 200: 0 }; const fwd = { 100: 0, 200: 0 };
  for (const p of ps) {
    if (isDead(p, t)) continue;
    const pos = posAt(p, t);
    alive[p.team]++;
    const prog = (pos.x + pos.y) / 29600;
    fwd[p.team] += p.team === 100 ? prog : 1 - prog;
    src.push([pos.x, pos.y, p.team === 100 ? 1 : -1, 0.65 + 0.35 * clamp(golds[p.id] / avgGold, 0.3, 2), 2300]);
  }
  for (const s of game.structures) {
    if (!structureAlive(s, t)) continue;
    const w = s.kind === 'tower' ? 0.9 : s.kind === 'inhib' ? 0.6 : 1;
    src.push([s.x, s.y, s.team === 100 ? 1 : -1, w, s.kind === 'tower' ? 1600 : 1500]);
  }
  src.push([FOUNTAIN[100].x, FOUNTAIN[100].y, 1, 1.2, 2600]);
  src.push([FOUNTAIN[200].x, FOUNTAIN[200].y, -1, 1.2, 2600]);

  const cw = (bd.maxX - bd.minX) / N, ch = (bd.maxY - bd.minY) / N;
  const grid = wantGrid ? new Float32Array(N * N) : null;
  let sum = 0, cb = 0, cr = 0;
  for (let j = 0; j < N; j++) {
    const y = bd.minY + (j + 0.5) * ch;
    for (let i = 0; i < N; i++) {
      const x = bd.minX + (i + 0.5) * cw;
      let B = 0, R = 0;
      for (let k = 0; k < src.length; k++) {
        const s = src[k]; const dx = x - s[0], dy = y - s[1]; const d2 = dx * dx + dy * dy; const s2 = s[4] * s[4];
        if (d2 > 9 * s2) continue;
        const v = s[3] * Math.exp(-d2 / (2 * s2));
        if (s[2] > 0) B += v; else R += v;
      }
      const c = (B - R) / (B + R + 0.12);
      if (grid) grid[j * N + i] = c;
      sum += c; if (c > 0.2) cb++; else if (c < -0.2) cr++;
    }
  }
  const territory = sum / (N * N);
  const pressure = (alive[100] ? fwd[100] / alive[100] : 0) - (alive[200] ? fwd[200] / alive[200] : 0);
  return { grid, N, territory, share: cb + cr ? cb / (cb + cr) : 0.5, alive, pressure, cellsB: cb, cellsR: cr };
}
function influenceAtPoint(game, t, x, y) {
  return influence(game, t, 1, true, { minX: x - 1, minY: y - 1, maxX: x + 1, maxY: y + 1 }).grid[0];
}

// ---------------------------------------------------------------- win probability (trained on high-elo games, see train/)
// A logistic regression on the game state whose coefficients change smoothly with game time (piecewise-linear between
// knots, e.g. every 10 minutes). Coefficients come from wp_model.js (window.WP_MODEL), written by train/train.html after
// fitting on Master+ ranked games. Without that file the app falls back to the hand-weighted control score.
const WP_FEATS = ['gold', 'xp', 'towerOuter', 'towerInner', 'towerBase', 'towerNexus', 'inhib', 'dragon', 'soul', 'elder', 'baron',
  'grubs', 'herald', 'alive', 'deadTime', 'territory', 'pressure', 'vision'];
const WP_GROUP = { gold: 'gold', xp: 'xp', vision: 'vision', territory: 'map', pressure: 'map', alive: 'numbers', deadTime: 'numbers' }; // the rest: obj
const FACTORS = ['gold', 'xp', 'vision', 'map', 'obj', 'numbers'];
const TOWER_FEAT = { OUTER_TURRET: 'towerOuter', INNER_TURRET: 'towerInner', BASE_TURRET: 'towerBase', NEXUS_TURRET: 'towerNexus' };

function wpModelFor(game) {
  const M = typeof window !== 'undefined' ? window.WP_MODEL : null;
  if (!M || !M.full) return null;
  return game.hasWards ? M.full : (M.noVision || M.full);
}
function knotWeights(knots, t) {
  const w = new Array(knots.length).fill(0), n = knots.length - 1;
  if (t <= knots[0]) { w[0] = 1; return w; }
  if (t >= knots[n]) { w[n] = 1; return w; }
  for (let i = 0; i < n; i++) if (t < knots[i + 1]) { const f = (t - knots[i]) / (knots[i + 1] - knots[i]); w[i] = 1 - f; w[i + 1] = f; break; }
  return w;
}
function lastIdx(arr, t, key) { // index of the last element with arr[i] (or arr[i][key]) <= t, -1 if none
  let lo = 0, hi = arr.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if ((key == null ? arr[m] : arr[m][key]) <= t) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}
// The timeline records gold once a minute. Kill bounties are known to the second, so they're placed at the kill and only
// the remaining (farming) gold is interpolated across the minute. This keeps the win chance from moving before a kill happens.
function buildWpSeries(game) {
  const { ft, ps } = game;
  game.teamGoldF = { 100: ft.map(() => 0), 200: ft.map(() => 0) };
  game.teamXpF = { 100: ft.map(() => 0), 200: ft.map(() => 0) };
  for (const p of ps) ft.forEach((_, i) => { game.teamGoldF[p.team][i] += p.series.gold[i]; game.teamXpF[p.team][i] += p.series.xp[i]; });
  game.goldEv = { 100: [], 200: [] };
  const cum = { 100: 0, 200: 0 };
  // League-client timelines don't record kill bounties: assume the standard 300g
  const hasBounty = game.events.some(e => e.type === 'CHAMPION_KILL' && 'bounty' in e);
  for (const k of game.kills) {
    k.wpBounty = hasBounty ? k.bounty : KILL_BOUNTY_DEFAULT;
    if (!game.goldEv[k.team] || !k.wpBounty) continue;
    cum[k.team] += k.wpBounty * (k.assists.length ? ASSIST_GOLD_FACTOR : 1);
    game.goldEv[k.team].push({ t: k.t, c: cum[k.team] });
  }
}
function goldEvBefore(game, team, t) { const a = game.goldEv[team]; const i = lastIdx(a, t, 't'); return i < 0 ? 0 : a[i].c; }
function teamGoldAt(game, team, t) {
  const ft = game.ft, G = game.teamGoldF[team]; const n = ft.length;
  if (!n) return 0;
  const i = lastIdx(ft, t);
  if (i < 0) return G[0];
  if (i >= n - 1) return G[n - 1] + goldEvBefore(game, team, t) - goldEvBefore(game, team, ft[n - 1]);
  const a = ft[i], b = ft[i + 1], Ba = goldEvBefore(game, team, a);
  const farm = (G[i + 1] - G[i]) - (goldEvBefore(game, team, b) - Ba);
  return G[i] + (goldEvBefore(game, team, t) - Ba) + farm * (t - a) / (b - a || 1);
}
// state features at time t, blue minus red (positive = good for Blue). inf: influence() at t.
function wpFeatures(game, t, inf) {
  const f = {}; for (const k of WP_FEATS) f[k] = 0;
  f.gold = (teamGoldAt(game, 100, t) - teamGoldAt(game, 200, t)) / 1000;
  f.xp = (interpSeries(game.ft, game.teamXpF[100], t) - interpSeries(game.ft, game.teamXpF[200], t)) / 1000;
  for (const s of game.structureEvents) {
    if (s.t > t) break;
    const sg = s.team === 100 ? 1 : -1;
    if (s.kind === 'tower') { const k = TOWER_FEAT[s.tier]; if (k && (s.tier !== 'NEXUS_TURRET' || t < s.t + NEXUS_TURRET_RESPAWN)) f[k] += sg; } // nexus turrets grow back
    else if (t < s.t + INHIB_RESPAWN) f.inhib += sg;
  }
  for (const o of game.objectives) {
    if (o.t > t) break;
    const sg = o.team === 100 ? 1 : -1;
    if (o.key === 'DRAGON') f.dragon += sg;
    else if (o.key === 'ELDER') { if (t < o.t + ELDER_BUFF) f.elder += sg; }
    else if (o.key === 'BARON_NASHOR') { if (t < o.t + BARON_BUFF) f.baron += sg; }
    else if (o.key === 'HORDE') f.grubs += sg * o.count;
    else if (o.key === 'RIFTHERALD') f.herald += sg;
  }
  for (const s of game.souls) if (s.t <= t) f.soul = s.team === 100 ? 1 : -1;
  let aB = 0, aR = 0, dB = 0, dR = 0;
  for (const p of game.ps) {
    const d = isDead(p, t);
    if (d) { if (p.team === 100) dB += (d.respawn - t) / 60; else dR += (d.respawn - t) / 60; }
    else if (p.team === 100) aB++; else aR++;
  }
  f.alive = aB - aR; f.deadTime = dR - dB;
  f.territory = inf.territory; f.pressure = inf.pressure;
  f.vision = game.hasWards ? (wardCount(game, 100, t) - wardCount(game, 200, t)) / 5 : 0;
  return f;
}
// win probability for Blue, plus each factor group's push in log-odds (positive = towards Blue)
function wpPredict(m, f, t) {
  const w = knotWeights(m.knots, t); let L = 0; const parts = {}; for (const k of FACTORS) parts[k] = 0;
  for (const k of m.feats) {
    const c = m.coef[k]; let b = 0; for (let i = 0; i < w.length; i++) b += c[i] * w[i];
    const v = b * (f[k] || 0); L += v; parts[WP_GROUP[k] || 'obj'] += v;
  }
  return { wp: 1 / (1 + Math.exp(-clamp(L, -30, 30))), L, parts };
}
// the same state with one death undone: the victim alive and the killers without the bounty
function wpWithoutDeath(game, t, st, victim, d) {
  if (!game.wpm) return null;
  const f = Object.assign({}, st.f), sg = victim.team === 100 ? 1 : -1;
  if (isDead(victim, t) === d) { f.alive += sg; f.deadTime += sg * (d.respawn - t) / 60; }
  if (d.kill && d.kill.wpBounty && t >= d.t) f.gold += sg * d.kill.wpBounty * (d.kill.assists.length ? ASSIST_GOLD_FACTOR : 1) / 1000;
  return wpPredict(game.wpm, f, t).wp;
}
function wpAt(game, t) { const s = stateAt(game, t); return s.wp; }
function wpFor(game, team, t) { const w = wpAt(game, clamp(t, 0, game.duration)); return 100 * (team === 100 ? w : 1 - w); }

// ---------------------------------------------------------------- control sampling
function evalState(game, t) {
  const { ps, ft } = game;
  let gB = 0, gR = 0, xB = 0, xR = 0;
  for (const p of ps) {
    const g = interpSeries(ft, p.series.gold, t), x = interpSeries(ft, p.series.xp, t);
    if (p.team === 100) { gB += g; xB += x; } else { gR += g; xR += x; }
  }
  const avgG = (gB + gR) / 2, avgX = (xB + xR) / 2;
  const gold = Math.tanh((gB - gR) / (1500 + 0.1 * avgG));
  const xp = Math.tanh((xB - xR) / (1500 + 0.1 * avgX));
  let wB, wR, vision;
  if (game.hasWards) {
    wB = wardCount(game, 100, t); wR = wardCount(game, 200, t);
    vision = clamp((wB - wR) / (wB + wR + 4), -1, 1);
  } else if (game.live) {
    // live recording: vision score each team gained over the last 3 minutes
    const L = game.live, a = Math.max(0, t - 180);
    wB = interpSeries(L.t, L.vision[100], t) - interpSeries(L.t, L.vision[100], a);
    wR = interpSeries(L.t, L.vision[200], t) - interpSeries(L.t, L.vision[200], a);
    vision = clamp((wB - wR) / (wB + wR + 3), -1, 1);
  } else {
    // no ward events: use each team's end-of-game vision score, phased in over the first 10 minutes
    wB = game.visionScore[100]; wR = game.visionScore[200];
    vision = clamp(1.6 * (wB - wR) / (wB + wR + 20), -1, 1) * Math.min(1, t / 600);
  }
  const inf = influence(game, t, 24, false);
  const map = clamp(0.7 * clamp(inf.territory * 2.2, -1, 1) + 0.3 * clamp(inf.pressure * 1.5, -1, 1), -1, 1);
  const numbers = (inf.alive[100] - inf.alive[200]) / 5;
  const ob = objectiveScore(game, t);
  const comp = { gold, xp, vision, map, obj: ob.score, numbers };
  let control = 0; for (const k in WEIGHTS) control += WEIGHTS[k] * comp[k];
  control = clamp(control, -1, 1);
  const f = wpFeatures(game, t, inf);
  // fc: each factor's push towards Blue on the control scale (−1…+1); with the trained model, half its log-odds
  const fc = {}; let wp;
  if (game.wpm) {
    const r = wpPredict(game.wpm, f, t);
    wp = r.wp; for (const k of FACTORS) fc[k] = r.parts[k] / 2;
  } else { wp = (control + 1) / 2; for (const k of FACTORS) fc[k] = WEIGHTS[k] * comp[k]; }
  return { t, comp, fc, f, wp, legacy: control, control: game.wpm ? 2 * wp - 1 : control,
    raw: { goldB: gB, goldR: gR, xpB: xB, xpR: xR, wardsB: wB, wardsR: wR, aliveB: inf.alive[100], aliveR: inf.alive[200],
      share: inf.share, objDet: ob.det } };
}

function sampleControl(game) {
  const samples = [];
  for (let t = 0; t <= game.duration + 0.001; t += SAMPLE_STEP) samples.push(evalState(game, t));
  game.samples = samples;
  game.smooth = { s10: smoothSeries(samples, 10), s30: smoothSeries(samples, 30), s45: smoothSeries(samples, 45) };
}
function smoothSeries(samples, half) {
  const w = Math.max(1, Math.round(half / SAMPLE_STEP)); const n = samples.length; const out = new Float32Array(n);
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + samples[i].control;
  for (let i = 0; i < n; i++) { const a = Math.max(0, i - w), b = Math.min(n - 1, i + w); out[i] = (pre[b + 1] - pre[a]) / (b - a + 1); }
  return out;
}
function sampleIndex(game, t) { return clamp(Math.round(t / SAMPLE_STEP), 0, game.samples.length - 1); }
function stateAt(game, t) { return game.samples[sampleIndex(game, t)]; }
function smoothAt(game, key, t) { return game.smooth[key][sampleIndex(game, t)]; }

// ---------------------------------------------------------------- fights
function findFights(game) {
  const fights = [];
  for (const k of game.kills) {
    const f = fights[fights.length - 1];
    if (f && k.t - f.end <= FIGHT_GAP && Math.hypot(k.x - f.x, k.y - f.y) < FIGHT_RADIUS) {
      f.kills.push(k); f.end = k.t;
      f.x = f.kills.reduce((a, b) => a + b.x, 0) / f.kills.length; f.y = f.kills.reduce((a, b) => a + b.y, 0) / f.kills.length;
    } else fights.push({ start: k.t, end: k.t, x: k.x, y: k.y, kills: [k] });
  }
  for (const f of fights) {
    f.by = { 100: f.kills.filter(k => k.team === 100).length, 200: f.kills.filter(k => k.team === 200).length };
    f.winner = f.by[100] > f.by[200] ? 100 : f.by[200] > f.by[100] ? 200 : 0;
    f.zone = zoneOf(f.x, f.y).name;
    f.size = f.kills.length;
    const involved = new Set(); f.kills.forEach(k => { involved.add(k.victim); if (k.killer) involved.add(k.killer); k.assists.forEach(a => involved.add(a)); });
    f.involved = involved.size;
    f.label = f.size === 1 ? 'Pick' : f.involved >= 6 ? 'Teamfight' : 'Skirmish';
  }
  return fights;
}
function describeFight(f) {
  const res = f.winner ? `${TEAM_NAME[f.winner]} won ${f.by[f.winner]}–${f.by[ENEMY[f.winner]]}` : `traded ${f.by[100]}–${f.by[200]}`;
  return `${f.label} in ${f.zone}: ${res}`;
}

// all notable things that happened in a window, as text bits per team
function eventsBetween(game, a, b) {
  const out = [];
  for (const f of game.fights) if (f.end >= a && f.start <= b) out.push({ t: f.start, team: f.winner, text: describeFight(f), kind: 'fight' });
  for (const o of game.objectives) if (o.t >= a && o.t <= b) out.push({ t: o.t, team: o.team, text: `${TEAM_NAME[o.team]} took ${o.name}`, kind: 'obj' });
  for (const s of game.structureEvents) if (s.t >= a && s.t <= b) out.push({ t: s.t, team: s.team, text: `${TEAM_NAME[s.team]} destroyed ${s.label}`, kind: 'struct' });
  return out.sort((x, y) => x.t - y.t);
}

// ---------------------------------------------------------------- phases
function findPhases(game) {
  const sm = game.smooth.s30; const S = game.samples;
  let segs = [];
  for (let i = 0; i < sm.length; i++) {
    const st = sm[i] > PHASE_LEAD ? 100 : sm[i] < -PHASE_LEAD ? 200 : 0;
    const last = segs[segs.length - 1];
    if (last && last.state === st) last.b = i; else segs.push({ state: st, a: i, b: i });
  }
  const minLen = Math.round(MIN_PHASE_SECONDS / SAMPLE_STEP);
  for (let guard = 0; guard < 500 && segs.length > 1; guard++) {
    let idx = -1, len = 1e9;
    segs.forEach((s, i) => { const l = s.b - s.a + 1; if (l < minLen && l < len) { len = l; idx = i; } });
    if (idx < 0) break;
    const nb = idx === 0 ? segs[1] : idx === segs.length - 1 ? segs[idx - 1] : ((segs[idx - 1].b - segs[idx - 1].a) >= (segs[idx + 1].b - segs[idx + 1].a) ? segs[idx - 1] : segs[idx + 1]);
    segs[idx].state = nb.state;
    const merged = [];
    for (const s of segs) { const l = merged[merged.length - 1]; if (l && l.state === s.state) l.b = s.b; else merged.push({ ...s }); }
    segs = merged;
  }
  return segs.map((s, i) => {
    const start = S[s.a].t, end = S[s.b].t;
    const contrib = {}; for (const k of FACTORS) contrib[k] = 0;
    let mean = 0, peak = 0;
    for (let j = s.a; j <= s.b; j++) {
      for (const k of FACTORS) contrib[k] += S[j].fc[k];
      mean += sm[j]; if (Math.abs(sm[j]) > Math.abs(peak)) peak = sm[j];
    }
    const n = s.b - s.a + 1; for (const k in contrib) contrib[k] /= n; mean /= n;
    const sign = s.state === 100 ? 1 : s.state === 200 ? -1 : 0;
    const reasons = Object.entries(contrib).filter(([, v]) => sign ? v * sign > 0.01 : false).sort((a, b) => b[1] * sign - a[1] * sign).slice(0, 3).map(([k]) => k);
    const evs = eventsBetween(game, start, end);
    const endEvents = i < segs.length - 1 ? eventsBetween(game, end - 40, end + 25) : [];
    const sA = S[s.a].raw, sB = S[s.b].raw;
    return { leader: s.state, start, end, mean, peak, contrib, reasons, events: evs, endEvents,
      goldStart: sA.goldB - sA.goldR, goldEnd: sB.goldB - sB.goldR };
  });
}

// ---------------------------------------------------------------- key moments (biggest swings)
function findMoments(game) {
  const sm = game.smooth.s10; const W = Math.round(MOMENT_HALF_WINDOW / SAMPLE_STEP); const S = game.samples;
  const cands = [];
  for (let i = W; i < sm.length - W; i++) cands.push({ i, d: sm[i + W] - sm[i - W] });
  cands.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  const picked = [];
  for (const c of cands) {
    if (Math.abs(c.d) < MOMENT_MIN_SWING || picked.length >= MAX_MOMENTS) break;
    if (picked.some(p => Math.abs(p.i - c.i) < MOMENT_MIN_GAP / SAMPLE_STEP)) continue;
    picked.push(c);
  }
  return picked.sort((a, b) => a.i - b.i).map(c => {
    const t = S[c.i].t, team = c.d > 0 ? 100 : 200;
    const a = S[Math.max(0, c.i - W)], b = S[Math.min(S.length - 1, c.i + W)];
    const dComp = {}; for (const k of FACTORS) dComp[k] = b.fc[k] - a.fc[k];
    const driver = Object.entries(dComp).sort((x, y) => (y[1] - x[1]) * (team === 100 ? 1 : -1))[0][0];
    return { t, team, delta: c.d, from: a.t, to: b.t, events: eventsBetween(game, t - 40, t + 40), driver, dComp };
  });
}

// ---------------------------------------------------------------- objective review
function nearbyCounts(game, t, x, y, r) {
  const c = { 100: 0, 200: 0 };
  for (const p of game.ps) if (!isDead(p, t) && dist(posAt(p, t), { x, y }) < r) c[p.team]++;
  return c;
}
function reviewObjectives(game) {
  return game.objectives.map(o => {
    const taker = o.team, other = ENEMY[o.team], sign = taker === 100 ? 1 : -1;
    const before = smoothAt(game, 's30', Math.max(0, o.t - 45)) * sign;
    const st = stateAt(game, Math.max(0, o.t - 30));
    const visionTaker = taker === 100 ? st.raw.wardsB : st.raw.wardsR, visionOther = taker === 100 ? st.raw.wardsR : st.raw.wardsB;
    const near = nearbyCounts(game, o.t - 3, o.x, o.y, 4500);
    const at = stateAt(game, o.t).raw;
    const aliveOther = other === 100 ? at.aliveB : at.aliveR, aliveTaker = taker === 100 ? at.aliveB : at.aliveR;
    const fightBefore = game.fights.filter(f => f.end <= o.t && f.end >= o.t - 75 && f.winner === taker).pop();
    const trades = eventsBetween(game, o.t - 60, o.t + 60).filter(e => e.team === other && e.kind !== 'fight');
    let verdict, tone;
    if (fightBefore) { verdict = `Converted a won fight (${fightBefore.by[taker]}–${fightBefore.by[other]}) into the objective.`; tone = 'good'; }
    else if (before >= 0.1) { verdict = `Set up from a position of control — ${TEAM_NAME[taker]} held more of the map/resources before it.`; tone = 'good'; }
    else if (before <= -0.1) { verdict = `Taken against the run of play: ${TEAM_NAME[taker]} was behind on control. ${TEAM_NAME[other]} failed to contest.`; tone = 'warn'; }
    else { verdict = 'Taken from an even state.'; tone = 'neutral'; }
    return { ...o, before, visionTaker, visionOther, near, aliveOther, aliveTaker, fightBefore, trades, verdict, tone };
  });
}

// ---------------------------------------------------------------- player report
function playerReport(game, pid) {
  const p = game.byId[pid]; if (!p) return null;
  const team = p.team, sign = team === 100 ? 1 : -1;
  const deaths = p.deaths.map(d => {
    const t = d.t;
    const pre = Math.max(0, t - 4);
    const terr = influenceAtPoint(game, pre, d.x, d.y) * sign;
    const zone = zoneOf(d.x, d.y);
    const near = nearbyCounts(game, t - 2, d.x, d.y, 2500);
    const allies = near[team], enemies = near[ENEMY[team]];
    const st = stateAt(game, pre);
    const myW = team === 100 ? st.raw.wardsB : st.raw.wardsR, theirW = team === 100 ? st.raw.wardsR : st.raw.wardsB;
    const ctrl = smoothAt(game, 's30', pre) * sign;
    const after = eventsBetween(game, t + 1, t + 75).filter(e => e.team === ENEMY[team] && e.kind !== 'fight');
    const fight = game.fights.find(f => f.kills.includes(d.kill));
    const tags = []; const tips = [];
    if (terr < -0.2) tags.push({ t: 'Enemy territory', c: 'bad' });
    if (allies <= 1 && enemies >= 1) tags.push({ t: 'Isolated', c: 'bad' });
    if (enemies > allies) tags.push({ t: `Outnumbered ${allies}v${enemies}`, c: 'bad' });
    if (game.hasWards && theirW - myW >= 2) tags.push({ t: 'Vision deficit', c: 'warn' });
    if (ctrl > 0.15) tags.push({ t: 'Team was ahead', c: 'warn' });
    if (ctrl < -0.15) tags.push({ t: 'Team was behind', c: 'neutral' });
    if (after.length) tags.push({ t: 'Enemy converted', c: 'bad' });
    if (fight && fight.winner === team) tags.push({ t: 'Fight was won', c: 'good' });

    if (terr < -0.2 && allies <= 1) tips.push('You were alone in enemy-controlled territory. Before walking in, count the enemies missing from the map and ward ahead (or wait for your team).');
    else if (terr < -0.2) tips.push('This area was controlled by the enemy. Entering it without a vision or numbers edge is a coin flip at best.');
    if (enemies > allies && !(allies <= 1 && terr < -0.2)) tips.push(`You fought ${allies}v${enemies}. Look for where your team was — fight when they can join, or back off.`);
    if (game.hasWards && theirW - myW >= 2) tips.push(`Your team had less vision (≈${myW.toFixed(0)} vs ${theirW.toFixed(0)} wards). Less vision means you can't see the threat coming.`);
    if (ctrl > 0.15) tips.push('Your team was in control here — this death gave tempo back. When ahead, play around vision and objectives rather than risky plays.');
    if (after.length) tips.push(`The enemy converted your death: ${after.map(e => e.text.replace(/^(Blue|Red) /, '')).join(', ')}.`);
    if (!tips.length) tips.push(terr > 0.2 ? 'You died on your own side with help nearby — likely a fight/mechanics issue rather than a macro mistake.' : 'Even territory, even numbers — check the replay at this moment to see what decided the fight.');
    return { t, x: d.x, y: d.y, zone: zone.name, terr, allies, enemies, myW, theirW, ctrl, after, tags, tips, killer: d.kill.killer, fight };
  });

  // presence at objectives
  const objPresence = game.objectives.map(o => {
    const dead = isDead(p, o.t - 2);
    const d = dead ? null : dist(posAt(p, o.t - 2), o);
    return { ...o, dead: !!dead, distance: d, present: !dead && d < 4500, ours: o.team === team };
  });

  // zone / territory time
  const zones = {}; let aliveT = 0, enemyHalf = 0, alone = 0;
  for (let t = 60; t < game.duration; t += 5) {
    if (isDead(p, t)) continue;
    const pos = posAt(p, t); aliveT += 5;
    const z = zoneOf(pos.x, pos.y);
    const key = z.name.replace(/ \((Blue|Red) side\)| \(river\)/, '');
    zones[key] = (zones[key] || 0) + 5;
    if (z.side === ENEMY[team]) enemyHalf += 5;
    let nearest = 1e9;
    for (const q of game.ps) if (q.team === team && q.id !== p.id && !isDead(q, t)) nearest = Math.min(nearest, dist(pos, posAt(q, t)));
    if (nearest > 5000) alone += 5;
  }
  const deadTime = p.deaths.reduce((a, d) => a + (d.respawn - d.t), 0);
  return { p, deaths, objPresence, zones, aliveT, enemyHalf, alone, deadTime };
}

// exports (browser globals)
Object.assign(window, {
  enrichWithLive, validateGameData, analysisNotes, CHAMP_NAMES, champName, SR, FOUNTAIN, TEAM_NAME, ENEMY, WEIGHTS, FACTOR_LABEL, ROLE_SHORT, MONSTER_NAME,
  fmtTime, fmtGold, clamp, lerp, dist, interpSeries, zoneOf, buildGame, posAt, posConfidence, isDead, levelAt, countBefore,
  structureAlive, influence, influenceAtPoint, nearbyCounts, stateAt, smoothAt, sampleIndex, wardCount, playerReport, describeFight, eventsBetween, SAMPLE_STEP,
  WP_FEATS, WP_GROUP, FACTORS, evalState, wpFeatures, wpPredict, wpWithoutDeath, wpAt, wpFor, wpModelFor, knotWeights, teamGoldAt,
});
