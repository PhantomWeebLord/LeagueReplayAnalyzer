'use strict';
/* Characterization tests for model.js. Tests named "known ..." pin down defects from the audit. */

test('fmtTime', () => { for (const [v, s] of [[0, '0:00'], [59.9, '0:59'], [60, '1:00'], [3725, '62:05'], [-5, '0:00']]) eq(fmtTime(v), s); });
test('fmtGold', () => { eq(fmtGold(1500), '+1.5k'); eq(fmtGold(-250), '−250'); eq(fmtGold(1500, false), '1.5k'); eq(fmtGold(0), '+0'); });
test('clamp, lerp, dist', () => { eq(clamp(5, 0, 3), 3); eq(clamp(-1, 0, 3), 0); eq(clamp(2, 0, 3), 2); eq(lerp(10, 20, 0.25), 12.5); eq(dist({ x: 0, y: 0 }, { x: 3, y: 4 }), 5); });
test('interpSeries', () => {
  eq(interpSeries([], [], 5), 0); eq(interpSeries([0, 10], [0, 100], -1), 0); eq(interpSeries([0, 10], [0, 100], 11), 100);
  eq(interpSeries([0, 10, 20], [0, 100, 300], 15), 200); eq(interpSeries([5], [7], 5), 7);
});
test('zoneOf map regions', () => {
  const c = (x, y) => zoneOf(x, y).name;
  eq(c(500, 500), 'Blue base'); eq(c(14300, 14300), 'Red base'); eq(c(1000, 8000), 'Top lane (Blue side)'); eq(c(8000, 1000), 'Bot lane (Blue side)');
  eq(c(7400, 7400), 'Mid lane (river)'); eq(c(5000, 10000), 'Top river (Baron side)'); eq(c(10000, 5000), 'Bot river (Dragon side)');
  eq(c(3800, 7200), 'Blue jungle (top side)'); eq(c(11000, 7600), 'Red jungle (bot side)');
});
test('zoneOf team sides', () => { eq(zoneOf(500, 500).side, 100); eq(zoneOf(14300, 14300).side, 200); eq(zoneOf(7400, 7400).side, 0); eq(zoneOf(7400, 7400).lane, 'mid'); });
test('deathTimer by level and game time', () => {
  near(deathTimer(1, 0), 6); near(deathTimer(18, 0), 52.5); near(deathTimer(6, 1200), 12 * (1 + 0.0085 * 5));
  near(deathTimer(18, 2700), 52.5 * 1.2175); near(deathTimer(18, 5000), 52.5 * 1.5); eq(deathTimer(0, 0), 6); eq(deathTimer(30, 0), 52.5);
});
test('champName uses internal id', () => { eq(champName('MonkeyKing'), 'Wukong'); eq(champName('Kaisa'), "Kai'Sa"); eq(champName('NotAChamp'), 'NotAChamp'); });
test('knotWeights', () => {
  const k = [0, 600, 1200]; eq(knotWeights(k, -5), [1, 0, 0]); eq(knotWeights(k, 0), [1, 0, 0]); eq(knotWeights(k, 300), [0.5, 0.5, 0]); eq(knotWeights(k, 600), [0, 1, 0]); eq(knotWeights(k, 2000), [0, 0, 1]);
});

for (const id of ['riot-15.12', 'riot-16.10', 'riot-16.23', 'red-win', 'short', 'long', 'lcu']) {
  test(`buildGame ${id}: shape`, () => {
    const g = gameOf(id);
    eq(g.ps.length, 10); ok(g.duration > 600); ok([100, 200].includes(g.winner)); eq(g.ft.length, frames(TT.games[id]).length);
    eq(g.ps.filter(p => p.team === 100).length, 5); ok(g.samples.length >= g.duration / SAMPLE_STEP);
    ok(g.samples.every(s => isFinite(s.control) && s.wp >= 0 && s.wp <= 1), 'win chance in range');
    for (const p of g.ps) { ok(p.kf.length > 0); for (let i = 1; i < p.kf.length; i++) ok(p.kf[i].t > p.kf[i - 1].t, 'keyframes ordered'); }
  });
  test(`buildGame ${id}: positions stay on the map`, () => {
    const g = gameOf(id);
    for (const p of g.ps) for (let t = 0; t <= g.duration; t += 13) { const q = posAt(p, t); ok(isFinite(q.x) && isFinite(q.y) && q.x > -600 && q.x < 15600 && q.y > -600 && q.y < 15600, `${p.champ}@${t}`); }
  });
  test(`buildGame ${id}: deaths never overlap`, () => { for (const p of gameOf(id).ps) p.deaths.forEach((d, i) => { ok(d.respawn > d.t); if (p.deaths[i + 1]) ok(d.respawn <= p.deaths[i + 1].t); }); });
}
test('players sorted by team then role', () => { eq(gameOf('riot-16.23').ps.map(p => p.role).slice(0, 5), ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']); eq(gameOf('riot-16.23').ps[5].team, 200); });
test('player identity fields', () => { const p = gameOf('riot-16.23').ps[0]; eq([p.champ, p.cname, p.name, p.tag], ['MonkeyKing', 'Wukong', 'Fixture1', 'TEST']); });
test('winner from teams then GAME_END', () => {
  eq(gameOf('red-win').winner, 200);
  const d = G('riot-16.23'); d.match.info.teams.forEach(t => (t.win = false)); eq(buildGame(d, { light: true }).winner, 100);
});
test('no winner anywhere is null', () => { const d = G('riot-16.23'); d.match.info.teams.forEach(t => (t.win = false)); for (const f of frames(d)) f.events = f.events.filter(e => e.type !== 'GAME_END'); eq(buildGame(d).winner, null); });
test('duration from GAME_END, else frames', () => {
  const d = G('riot-16.23'); for (const f of frames(d)) f.events = f.events.filter(e => e.type !== 'GAME_END');
  near(buildGame(d, { light: true }).duration, frames(d).at(-1).timestamp / 1000);
});
test('millisecond gameDuration is converted', () => { const d = G('short'); for (const f of frames(d)) f.events = f.events.filter(e => e.type !== 'GAME_END'); d.timeline.info.frames = frames(d).slice(0, 2); d.match.info.gameDuration = 1000000; eq(buildGame(d, { light: true }).duration, 1000); });
test('ARAM is rejected', () => throws(() => buildGame(G('aram')), /Only Summoner's Rift games are supported \(this game was on map 12\)/));
test('Arena map is rejected', () => { const d = G('riot-16.23'); d.match.info.mapId = 30; throws(() => buildGame(d), /map 30/); });
test('missing mapId is accepted', () => { const d = G('short'); delete d.match.info.mapId; ok(buildGame(d).samples.length); });
test('special modes are flagged', () => { for (const mode of ['URF', 'ONEFORALL', 'SWIFTPLAY']) { const d = G('short'); d.match.info.gameMode = mode; const n = analysisNotes(buildGame(d)); ok(n.some(x => x.includes(mode) && x.includes('rough')), mode); } });
test('normal modes are not flagged', () => { const d = G('short'); eq(analysisNotes(buildGame(d)), []); delete d.match.info.gameMode; eq(analysisNotes(buildGame(d)), []); });
test('patches outside the model are flagged', () => { for (const v of ['99.1.1.1', '15.12.1.1', '16.17.1.1', '16.24.1.1']) { const d = G('short'); d.match.info.gameVersion = v; const n = analysisNotes(buildGame(d)); ok(n.some(x => x.includes(v.split('.').slice(0, 2).join('.')) && x.includes('approximate')), v); } });
test('patches inside the model are not flagged', () => { for (const v of ['16.18.1.1', '16.20.1.1', '16.23.1.1']) { const d = G('short'); d.match.info.gameVersion = v; eq(analysisNotes(buildGame(d)), [], v); } });
test('unreadable patch is not flagged', () => { const d = G('short'); d.match.info.gameVersion = 'unknown'; eq(analysisNotes(buildGame(d)), []); });
test('a special mode still gets a review', () => { const d = G('short'); d.match.info.gameMode = 'URF'; ok(reviewGame(buildGame(d)).actions.length > 0); });

const MALFORMED = {
  'match missing': [d => { delete d.match; }, /incomplete/], 'timeline missing': [d => { delete d.timeline; }, /incomplete/], 'participants missing': [d => { delete d.match.info.participants; }, /no players/],
  'no participants': [d => { d.match.info.participants = []; }, /no players/], 'team id invalid': [d => { parts(d)[0].teamId = 300; }, /invalid players/], 'teamId missing': [d => { delete parts(d)[0].teamId; }, /invalid players/],
  'participant id missing': [d => { delete parts(d)[0].participantId; }, /invalid players/], 'no frames': [d => { d.timeline.info.frames = []; }, /timeline is empty/], 'frames undefined': [d => { delete d.timeline.info.frames; }, /timeline is empty/],
  'frames without timestamps': [d => { for (const f of frames(d)) delete f.timestamp; }, /timeline is empty/],
};
for (const [name, [mut, re]] of Object.entries(MALFORMED)) test(`malformed data gives a clear error: ${name}`, () => { const d = G('short'); mut(d); throws(() => buildGame(d), re); });
test('null data gives a clear error', () => { for (const v of [null, undefined, {}, { match: {} }]) throws(() => buildGame(v), /incomplete/); });
test('event without timestamp is dropped and noted', () => {
  const d = G('short'); const n = gameOf('short').kills.length; frames(d).find(f => f.events.some(e => e.type === 'CHAMPION_KILL')).events.find(e => e.type === 'CHAMPION_KILL').timestamp = undefined;
  const g = buildGame(d); eq(g.kills.length, n - 1); ok(g.dataNotes.some(x => /1 timeline event/.test(x))); ok(reviewGame(g).actions.length > 0);
});
test('non-numeric frame values become zero', () => { const d = G('short'); frames(d)[5].participantFrames['1'].totalGold = 'x'; frames(d)[5].participantFrames['1'].xp = null; const g = buildGame(d); eq(g.byId[1].series.gold[5], 0); eq(g.byId[1].series.xp[5], 0); ok(g.samples.every(s => isFinite(s.control))); });
test('positions off the map are clamped', () => { const d = G('short'); frames(d)[5].participantFrames['1'].position = { x: 999999, y: -999999 }; const g = buildGame(d); eq([g.byId[1].series.x[5], g.byId[1].series.y[5]], [15600, -600]); });
test('non-numeric position uses the fountain', () => { const d = G('short'); frames(d)[5].participantFrames['1'].position = { x: 'a', y: null }; const g = buildGame(d); eq(g.byId[1].series.x[5], 420); });
test('kill with a bad position uses the victim track', () => { const d = G('short'); const k = frames(d).find(f => f.events.some(e => e.type === 'CHAMPION_KILL')).events.find(e => e.type === 'CHAMPION_KILL'); k.position = { x: 'a' }; ok(buildGame(d).kills.every(x => isFinite(x.x) && isFinite(x.y))); });
test('incomplete lobby still builds and is noted', () => { const d = G('short'); parts(d).pop(); const g = buildGame(d); eq(g.ps.length, 9); ok(g.dataNotes.some(x => /9 players/.test(x))); ok(reviewGame(g).actions.length > 0); });
test('complete game has no data notes', () => { eq(gameOf('riot-16.23').dataNotes, []); });
test('missing champion name falls back to its ID', () => { const d = G('short'); parts(d)[0].championName = null; const p = buildGame(d).byId[1]; eq(p.champ, '62'); });
test('frame without participantFrames holds last values', () => { const d = G('short'); delete frames(d)[5].participantFrames; const g = buildGame(d); eq(g.ps[0].series.gold[5], g.ps[0].series.gold[4]); });
test('player missing from a frame holds last values', () => { const d = G('short'); delete frames(d)[5].participantFrames['1']; const g = buildGame(d); const p = g.byId[1]; eq(p.series.xp[5], p.series.xp[4]); });
test('first frame without data uses fountain', () => { const d = G('short'); delete frames(d)[0].participantFrames; const g = buildGame(d); eq([g.byId[1].series.x[0], g.byId[6].series.x[0]], [420, 14300]); });
test('timeline gap still builds', () => { const d = G('riot-16.23'); frames(d).splice(8, 5); ok(buildGame(d).samples.every(s => isFinite(s.control))); });
test('kill without position uses victim track', () => { const d = G('short'); for (const f of frames(d)) for (const e of f.events) if (e.type === 'CHAMPION_KILL') delete e.position; const g = buildGame(d); ok(g.kills.length > 0 && g.kills.every(k => isFinite(k.x))); });
test('unknown monster type is kept', () => { const d = G('short'); for (const f of frames(d)) for (const e of f.events) if (e.type === 'ELITE_MONSTER_KILL') e.monsterType = 'NEW_MONSTER'; const g = buildGame(d); ok(g.objectives.some(o => o.key === 'NEW_MONSTER' && o.name === 'NEW_MONSTER')); });
test('unknown event type is ignored', () => { const d = G('short'); frames(d)[3].events.push({ type: 'FUTURE_EVENT', timestamp: 180000 }); ok(buildGame(d).events.some(e => e.type === 'FUTURE_EVENT')); });
test('kill with unknown victim is ignored', () => { const d = G('short'); const n = gameOf('short').kills.length; frames(d)[3].events.push({ type: 'CHAMPION_KILL', timestamp: 170000, victimId: 99, killerId: 1 }); eq(buildGame(d).kills.length, n); });
test('execute kill (no killer) is kept', () => { const d = G('short'); frames(d).find(f => f.events.some(e => e.type === 'CHAMPION_KILL')).events.find(e => e.type === 'CHAMPION_KILL').killerId = 0; ok(buildGame(d).kills.some(k => k.killer === 0)); });
test('very short game', () => { const d = G('short'); d.timeline.info.frames = frames(d).slice(0, 4); for (const f of frames(d)) f.events = f.events.filter(e => e.type !== 'GAME_END'); d.match.info.gameDuration = 180; eq(Math.round(buildGame(d).duration), 180); });
test('zero duration game is refused', () => { const d = G('short'); d.match.info.gameDuration = 0; d.timeline.info.frames = frames(d).slice(0, 1); frames(d)[0].events = []; throws(() => buildGame(d), /no game time/); });

test('light mode skips sampling', () => { const g = buildGame(G('short'), { light: true, noModel: true }); eq(g.samples, undefined); eq(g.wpm, null); });
test('hand-weighted score without model', () => { const g = buildGame(G('short'), { noModel: true }); eq(g.wpm, null); ok(g.samples.every(s => s.control >= -1 && s.control <= 1)); });
test('wpModelFor: wards pick the full model', () => { eq(gameOf('riot-16.23').wpm, WP_MODEL.full); eq(gameOf('lcu').wpm, WP_MODEL.noVision); });
test('feature flags', () => { const a = gameOf('riot-16.23'), b = gameOf('lcu'); eq([a.hasWards, a.hasItems, a.hasLevels], [true, true, true]); eq([b.hasWards, b.hasItems, b.hasLevels], [false, false, false]); });

test('levelAt from events', () => { const p = gameOf('riot-16.23').ps[0]; eq(levelAt(p, 0), 1); eq(levelAt(p, 300), 3); ok(levelAt(p, 1e6) <= 18); });
test('levelAt from frames without events', () => { const p = gameOf('lcu').ps[0]; eq(p.levelUps.length, 0); eq(levelAt(p, 0), 1); eq(levelAt(p, 300), p.series.level[5] - (p._ft[5] > 300 ? 0 : 0) > 0 ? levelAt(p, 300) : 0); ok(levelAt(p, 1e6) >= 10); });
test('isDead window', () => { const p = gameOf('riot-16.23').ps.find(x => x.deaths.length); const d = p.deaths[0]; eq(isDead(p, d.t), d); eq(isDead(p, d.respawn), null); eq(isDead(p, d.t - 1), null); });
test('countBefore', () => { eq(countBefore([1, 2, 3], 2), 2); eq(countBefore([], 2), 0); });
test('posAt holds during death and returns to fountain', () => {
  const g = gameOf('riot-16.23'); const p = g.ps.find(x => x.deaths.length); const d = p.deaths[0];
  const q = posAt(p, (d.t + d.respawn) / 2); near(q.x, d.x, 1); near(q.y, d.y, 1);
  const r = posAt(p, d.respawn); near(r.x, FOUNTAIN[p.team].x, 1);
});
test('posAt before and after the track', () => { const p = gameOf('short').ps[0]; eq(posAt(p, -5), p.kf[0]); eq(posAt(p, 1e7), p.kf.at(-1)); eq(posAt({ kf: [], team: 200 }, 5), FOUNTAIN[200]); });
test('posConfidence', () => { const p = gameOf('short').ps[0]; eq(posConfidence(p, p.kf[3].t), 0); ok(posConfidence(p, p.kf[3].t + 1) <= 1); });
test('routeBetween follows the graph', () => { const r = routeBetween({ x: 1000, y: 7000 }, { x: 7400, y: 7400 }); ok(r.length > 2); eq(r[0], { x: 1000, y: 7000 }); eq(r.at(-1), { x: 7400, y: 7400 }); });
test('chaikin smooths and keeps endpoints', () => { const a = { x: 0, y: 0 }, b = { x: 10, y: 0 }, c = { x: 10, y: 10 }; const s = chaikin([a, b, c], 1); eq(s[0], a); eq(s.at(-1), c); eq(s.length, 6); eq(chaikin([a, b], 2), [a, b]); });
test('recalls from purchases', () => { const p = gameOf('riot-16.23').ps[0]; ok(p.recalls.length > 0 && p.recalls.every(r => r.inferred === false)); });
test('recalls inferred without purchases', () => { ok(gameOf('lcu').ps.some(p => p.recalls.some(r => r.inferred))); });

test('structures table', () => { eq(STRUCTURES.length, 30); eq(STRUCTURES.filter(s => s[0] === 100 && s[1] === 'tower').length, 11); eq(gameOf('short').structures.length, 30); });
test('tower events resolve to structures', () => { const g = gameOf('riot-16.23'); ok(g.structureEvents.some(s => s.tier === 'OUTER_TURRET')); ok(g.structureEvents.every(s => s.team !== s.lost)); });
test('inhibitor respawns after 5 minutes', () => { const g = gameOf('riot-16.23'); const e = g.structureEvents.find(s => s.kind === 'inhib'); const s = g.structures.find(x => x.kind === 'inhib' && x.downs.length); eq(structureAlive(s, e.t + 1), false); eq(structureAlive(s, e.t + 301), true); });
test('outer tower stays down', () => { const g = gameOf('riot-16.23'); const s = g.structures.find(x => x.tier === 'OUTER_TURRET' && x.downs.length); eq(structureAlive(s, 1e7), false); });
test('nexus turret respawns after 3 minutes', () => {
  const d = G('short'); frames(d)[5].events.push({ type: 'BUILDING_KILL', timestamp: 250000, teamId: 200, killerId: 1, buildingType: 'TOWER_BUILDING', laneType: 'MID_LANE', towerType: 'NEXUS_TURRET', position: { x: 12611, y: 13084 } });
  frames(d)[5].events.sort((a, b) => a.timestamp - b.timestamp); const g = buildGame(d); const s = g.structures.find(x => x.tier === 'NEXUS_TURRET' && x.downs.length); eq(structureAlive(s, 260), false); eq(structureAlive(s, 431), true);
});
test('unmatched building falls back to nearest', () => { const d = G('short'); frames(d)[5].events.push({ type: 'BUILDING_KILL', timestamp: 250000, teamId: 200, killerId: 1, buildingType: 'TOWER_BUILDING', laneType: 'NEW_LANE', towerType: 'NEW', position: { x: 4318, y: 13875 } }); frames(d)[5].events.sort((a, b) => a.timestamp - b.timestamp); ok(buildGame(d).structureEvents.some(s => s.t === 250 && s.lane === 'TOP_LANE')); });
test('plates', () => { const g = gameOf('riot-16.23'); eq(g.plates.length, 1); eq(g.plates[0].lane, 'TOP_LANE'); });

test('objective names and keys', () => { const g = gameOf('riot-16.23'); ok(g.objectives.some(o => o.key === 'DRAGON' && o.name === 'Infernal Drake')); ok(g.objectives.some(o => o.key === 'BARON_NASHOR')); ok(g.objectives.some(o => o.key === 'RIFTHERALD')); });
test('voidgrubs group', () => { const o = gameOf('riot-16.23').objectives.find(x => x.key === 'HORDE'); eq([o.count, o.name], [3, '3 Voidgrubs']); });
test('Atakhan counted on 15.x only', () => { ok(gameOf('riot-15.12').objectives.some(o => o.key === 'ATAKHAN')); const d = G('riot-15.12'); d.match.info.gameVersion = '16.1.1.1'; ok(!buildGame(d).objectives.some(o => o.key === 'ATAKHAN')); });
test('soul from event', () => { eq(gameOf('riot-16.23').souls.length, 1); });
test('soul inferred from fourth drake', () => { const g = gameOf('lcu'); const n = { 100: 0, 200: 0 }; for (const o of g.objectives) if (o.key === 'DRAGON') n[o.team]++; if (n[100] >= 4 || n[200] >= 4) eq(g.souls.length, 1); });
test('monster without position uses pit', () => { const d = G('short'); for (const f of frames(d)) for (const e of f.events) if (e.type === 'ELITE_MONSTER_KILL') delete e.position; const o = buildGame(d).objectives.find(x => x.key === 'DRAGON'); eq([o.x, o.y], [9866, 4414]); });
test('monster with unknown team is skipped', () => { const d = G('short'); const n = gameOf('short').objectives.length; frames(d)[4].events.push({ type: 'ELITE_MONSTER_KILL', timestamp: 200000, killerId: 0, monsterType: 'DRAGON' }); frames(d)[4].events.sort((a, b) => a.timestamp - b.timestamp); eq(buildGame(d).objectives.length, n); });
test('objectiveScore in range', () => { const g = gameOf('riot-16.23'); for (const t of [0, 600, 1200, g.duration]) { const r = objectiveScore(g, t); ok(r.score >= -1 && r.score <= 1); } });
test('objectiveScore buff windows', () => { const g = gameOf('riot-16.23'); const b = g.objectives.find(o => o.key === 'BARON_NASHOR'); ok(objectiveScore(g, b.t + 10).det[b.team].baronBuff); ok(!objectiveScore(g, b.t + 181).det[b.team].baronBuff); });

test('wards are counted', () => { const g = gameOf('riot-16.23'); ok(g.wards.length > 0); ok(wardCount(g, 100, 600) > 0); eq(wardCount(g, 100, 0), 0); });
test('control ward replaced by the next one', () => { const g = gameOf('long'); const cw = g.wards.filter(w => w.type === 'CONTROL_WARD' && w.creator === g.wards[0].creator); ok(cw.length >= 2); eq(cw[0].end, cw[1].start); });
test('ward kill ends a ward', () => { const g = gameOf('riot-16.23'); ok(g.wardKills.length > 0); });

test('influence grid and ranges', () => { const r = influence(gameOf('short'), 500, 8, true); eq(r.grid.length, 64); ok(r.territory >= -1 && r.territory <= 1); ok(r.share >= 0 && r.share <= 1); eq(r.alive[100] + r.alive[200] <= 10, true); });
test('influenceAtPoint favours the near fountain', () => { const g = gameOf('short'); ok(influenceAtPoint(g, 30, 500, 500) > 0); ok(influenceAtPoint(g, 30, 14300, 14300) < 0); });
test('nearbyCounts', () => { const g = gameOf('short'); const c = nearbyCounts(g, 0, 420, 420, 2000); eq(c[100], 5); eq(c[200], 0); });

test('wpPredict moves with gold', () => { const m = WP_MODEL.full; const f = k => { const o = {}; for (const x of m.feats) o[x] = 0; o.gold = k; return wpPredict(m, o, 900).wp; }; near(f(0), 0.5, 1e-9); ok(f(5) > 0.5); ok(f(-5) < 0.5); near(f(5) + f(-5), 1, 1e-9); });
test('wpPredict clamps extreme values', () => { const m = WP_MODEL.full; const o = {}; for (const x of m.feats) o[x] = 1e9; const r = wpPredict(m, o, 900).wp; ok(r < 1 && r > 0.99); });
test('teamGoldAt places bounties at the kill', () => { const g = gameOf('riot-16.23'); const k = g.kills[0]; ok(teamGoldAt(g, k.team, k.t + 0.1) - teamGoldAt(g, k.team, k.t - 0.1) > 100); });
test('teamGoldAt edges', () => { const g = gameOf('short'); eq(teamGoldAt(g, 100, -5), g.teamGoldF[100][0]); ok(teamGoldAt(g, 100, 1e6) >= g.teamGoldF[100].at(-1)); });
test('client data assumes 300g bounties', () => { eq(gameOf('lcu').kills[0].wpBounty, 300); });
test('wpFeatures blue minus red', () => { const g = gameOf('riot-16.23'); const f = wpFeatures(g, 1000, influence(g, 1000, 24, false)); for (const k of WP_FEATS) ok(k in f && isFinite(f[k]), k); });
test('wpFeatures buff windows', () => { const g = gameOf('riot-16.23'); const b = g.objectives.find(o => o.key === 'BARON_NASHOR'), sg = b.team === 100 ? 1 : -1; eq(stateAt(g, b.t + 10).f.baron, sg); eq(stateAt(g, Math.min(g.duration, b.t + 200)).f.baron, 0); });
test('wpWithoutDeath improves the victim', () => { const g = gameOf('riot-16.23'); const p = g.ps.find(x => x.deaths.length); const d = p.deaths[0]; const st = stateAt(g, d.t + 2); const w = wpWithoutDeath(g, st.t, st, p, d); ok(p.team === 100 ? w >= st.wp : w <= st.wp); });
test('wpWithoutDeath without model', () => { const g = buildGame(G('short'), { noModel: true }); const p = g.ps.find(x => x.deaths.length); eq(wpWithoutDeath(g, 1, stateAt(g, 1), p, p.deaths[0]), null); });
test('wpFor is complementary', () => { const g = gameOf('short'); near(wpFor(g, 100, 500) + wpFor(g, 200, 500), 100, 1e-9); near(wpFor(g, 100, -5), wpFor(g, 100, 0), 1e-9); });
test('sampling helpers', () => { const g = gameOf('short'); eq(sampleIndex(g, -5), 0); eq(sampleIndex(g, 1e9), g.samples.length - 1); eq(stateAt(g, 10), g.samples[5]); ok(isFinite(smoothAt(g, 's30', 100))); });
test('smoothSeries averages neighbours', () => { const s = [0, 2, 4, 6, 8].map(control => ({ control })); const o = smoothSeries(s, 2); near(o[2], 4, 1e-6); near(o[0], 1, 1e-6); });

test('fights group nearby kills', () => { const g = gameOf('riot-16.23'); eq(g.fights.reduce((n, f) => n + f.size, 0), g.kills.length); ok(g.fights.some(f => f.label === 'Teamfight' || f.label === 'Skirmish')); ok(g.fights.some(f => f.label === 'Pick')); });
test('describeFight', () => { eq(describeFight({ winner: 100, by: { 100: 3, 200: 1 }, label: 'Teamfight', zone: 'Mid lane' }), 'Teamfight in Mid lane: Blue won 3–1'); eq(describeFight({ winner: 0, by: { 100: 1, 200: 1 }, label: 'Skirmish', zone: 'X' }), 'Skirmish in X: traded 1–1'); });
test('eventsBetween sorted', () => { const e = eventsBetween(gameOf('riot-16.23'), 0, 1e6); ok(e.length > 0); for (let i = 1; i < e.length; i++) ok(e[i].t >= e[i - 1].t); });
test('phases cover the game', () => { const g = gameOf('riot-16.23'); eq(g.phases[0].start, 0); near(g.phases.at(-1).end, Math.floor(g.duration / 2) * 2, 2); for (let i = 1; i < g.phases.length; i++) ok(g.phases[i].leader !== g.phases[i - 1].leader); });
test('moments are spaced and limited', () => { const m = gameOf('riot-16.23').moments; ok(m.length <= 10); for (let i = 1; i < m.length; i++) ok(m[i].t - m[i - 1].t >= 100); });
test('objective review fields', () => { const o = gameOf('riot-16.23').objectiveReview[0]; for (const k of ['before', 'near', 'aliveOther', 'aliveTaker', 'verdict', 'tone']) ok(k in o, k); });
test('playerReport', () => { const g = gameOf('riot-16.23'); const p = g.ps.find(x => x.deaths.length); const r = playerReport(g, p.id); eq(r.deaths.length, p.deaths.length); ok(r.aliveT > 0); ok(r.objPresence.length === g.objectives.length); ok(r.deaths[0].tips.length > 0); eq(playerReport(g, 99), null); });

const liveFor = (id, n = 8, over = {}) => {
  const d = TT.games[id]; const P = parts(d);
  return Object.assign({ me: 0, players: P.map(p => ({ team: p.teamId, championId: p.championName, name: p.riotIdGameName })),
    snaps: Array.from({ length: n }, (_, k) => ({ t: 60 + k * 2, g: 1000 + k, hp: 0.5, p: P.map((_p, i) => [2 + (k > 4 ? 1 : 0), 0, 0, 0, k, k * 0.5 + i, i === 1 && k >= 3 && k < 6 ? 1 : 0, 0, k > 4 ? [[3031, 1]] : []]) })) }, over);
};
test('enrichWithLive ignores too-short recordings', () => { const d = G('lcu'); eq(enrichWithLive(d, null), d); eq(enrichWithLive(d, liveFor('lcu', 3)), d); });
test('enrichWithLive adds item and level events to client data', () => { const out = enrichWithLive(G('lcu'), liveFor('lcu')); ok(out.live.synthetic > 0); const ev = frames(out).flatMap(f => f.events); ok(ev.some(e => e.type === 'ITEM_PURCHASED' && e.synthetic)); ok(ev.some(e => e.type === 'LEVEL_UP' && e.synthetic)); });
test('enrichWithLive does not add to Riot data with items', () => { const out = enrichWithLive(G('riot-16.23'), liveFor('riot-16.23')); eq(out.live.synthetic, 0); });
test('enrichWithLive skips transform items', () => { const l = liveFor('lcu'); for (const s of l.snaps.slice(5)) for (const r of s.p) r[8] = [[3042, 1]]; const out = enrichWithLive(G('lcu'), l); ok(!frames(out).flatMap(f => f.events).some(e => e.itemId === 3042)); });
test('enrichWithLive vision, death windows and me', () => { const out = enrichWithLive(G('lcu'), liveFor('lcu')); eq(out.live.me, 1); eq(out.live.vision[100].length, 8); eq(out.live.dead[2], [[66, 72]]); });
test('live respawn times override estimates', () => {
  const l = liveFor('lcu'); const base = buildGame(G('lcu')); const p = base.ps.find(x => x.deaths.length), d = p.deaths[0]; const i = l.players.findIndex(x => x.championId === p.champ);
  l.snaps = [...Array(8).keys()].map(k => ({ t: d.t - 2 + k * 2, g: 1, hp: 1, p: l.players.map((_x, j) => [1, 0, 0, 0, 0, 0, j === i && k >= 1 && k < 4 ? 1 : 0, 0, []]) }));
  const g = buildGame(enrichWithLive(G('lcu'), l)); near(g.byId[p.id].deaths[0].respawn, d.t + 6, 0.01);
});
test('a damaged live recording is ignored', () => {
  const good = liveFor('lcu');
  const bad = [{ snaps: Array(6).fill({ t: 1 }), players: [{ team: 100, championId: 'MonkeyKing' }] }, { ...good, players: null }, { ...good, players: 'x' }, { ...good, snaps: 'x' },
    { ...good, snaps: good.snaps.map((s, i) => (i === 2 ? null : s)) }, { ...good, snaps: good.snaps.map((s, i) => (i === 2 ? { ...s, p: s.p.slice(0, 3) } : s)) },
    { ...good, snaps: good.snaps.map((s, i) => (i === 2 ? { ...s, t: 'x' } : s)) }, { ...good, snaps: good.snaps.map((s, i) => (i === 2 ? { ...s, p: s.p.map(() => null) } : s)) }];
  for (const l of bad) { const d = G('lcu'); eq(enrichWithLive(d, l), d); }
});

const MODE_MATRIX = [
  ['Ranked Solo', 420, 11, 'CLASSIC', 'graded'], ['Ranked Flex', 440, 11, 'CLASSIC', 'graded'], ['Normal Draft', 400, 11, 'CLASSIC', 'graded'], ['Clash', 700, 11, 'CLASSIC', 'graded'],
  ['Custom', 0, 11, 'CLASSIC', 'graded'], ['Tournament custom', 3130, 11, 'CLASSIC', 'graded'], ['Swiftplay', 480, 11, 'SWIFTPLAY', 'flagged'], ['URF', 900, 11, 'URF', 'flagged'],
  ['One for All', 1020, 11, 'ONEFORALL', 'flagged'], ['Ultimate Spellbook', 1400, 11, 'ULTBOOK', 'flagged'], ['ARAM', 450, 12, 'ARAM', 'refused'], ['ARAM Mayhem', 2400, 12, 'KIWI', 'refused'],
  ['Arena', 1700, 30, 'CHERRY', 'refused'], ['Swarm', 1830, 33, 'STRAWBERRY', 'refused'],
];
for (const [name, queue, map, mode, want] of MODE_MATRIX) test(`game mode: ${name} is ${want}`, () => {
  const d = G('short'); Object.assign(d.match.info, { queueId: queue, mapId: map, gameMode: mode });
  if (want === 'refused') { throws(() => buildGame(d), new RegExp(`map ${map}`)); return; }
  const g = buildGame(d); ok(reviewGame(g).actions.length > 0); eq(analysisNotes(g).some(x => x.includes(mode)), want === 'flagged');
});
for (const patch of ['15.12', '16.10', '16.23']) test(`gaps and missing frames on patch ${patch}`, () => {
  const d = G(`riot-${patch}`); frames(d).splice(9, 4); delete frames(d)[3].participantFrames; delete frames(d)[5].participantFrames['2']; frames(d)[6].events = null;
  const g = buildGame(d); ok(g.samples.every(s => isFinite(s.control) && s.wp >= 0 && s.wp <= 1)); const R = reviewGame(g); ok(R.actions.every(a => !/undefined|NaN/.test(a.title + a.detail)));
});
