'use strict';
/* Characterization tests for review.js (grading). */

test('grade table', () => { eq(GRADE_ORDER.length, 8); for (const k of GRADE_ORDER) ok(GRADES[k].label && GRADES[k].sym && GRADES[k].color && GRADES[k].ink); eq(GRADE_ORDER.map(k => GRADES[k].score), [100, 100, 92, 80, 58, 45, 30, 5]); });
test('bad grades', () => { eq([...BAD_GRADES].sort(), ['blunder', 'inaccuracy', 'miss', 'mistake']); });
test('bands', () => { eq(BANDS.deathCost.p, [60, 85, 96]); eq(BANDS.fightLoss.p, [50, 80, 95]); eq(BANDS.objLoss.p, [45, 78, 94]); eq(BANDS.fightGain.p, [65, 92]); eq(BANDS.pickGain.p, [65, 92]); eq(BANDS.objGain.p, [75]); eq(BANDS.convGain.p, [25]); });
test('pctOf', () => { const q = WP_MODEL.norms.deathCost; eq(pctOf('deathCost', q[0] - 1), 0); eq(pctOf('deathCost', q.at(-1) + 1), 100); near(pctOf('deathCost', q[25]), 50, 2.1); eq(pctOf('nope', 1), null); eq(pctOf('deathCost', null), null); });
test('bandOf uses percentiles', () => { const q = WP_MODEL.norms.deathCost; eq(bandOf('deathCost', q[10]).band, 0); eq(bandOf('deathCost', q[35]).band, 1); eq(bandOf('deathCost', q[45]).band, 2); eq(bandOf('deathCost', q[50]).band, 3); });
test('bandOf falls back to absolute cut-offs', () => { const saved = WP_MODEL.norms; WP_MODEL.norms = null; try { eq(bandOf('deathCost', 1).band, 0); eq(bandOf('deathCost', 3).band, 1); eq(bandOf('deathCost', 6).band, 2); eq(bandOf('deathCost', 11).band, 3); eq(bandOf('deathCost', 1).pct, null); } finally { WP_MODEL.norms = saved; } });
test('fmtWp', () => { eq(fmtWp(0.01), '0.0%'); eq(fmtWp(2.34), '+2.3%'); eq(fmtWp(-2.34), '−2.3%'); });
test('pctTxt', () => { eq(pctTxt(null, 'a', 'b', 'c'), ''); eq(pctTxt(80, 'more than', 'less than', 'deaths'), ': more than 80% of deaths in Master+ games'); eq(pctTxt(20, 'more than', 'less than', 'deaths'), ': less than 80% of deaths in Master+ games'); eq(pctTxt(100, 'm', 'l', 'x'), ': m 99% of x in Master+ games'); });
test('names list', () => { const a = [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }]; eq(names(a), 'A, B, C and 1 more'); eq(names(a, 4), 'A, B, C, D'); eq(names([]), ''); });
test('plural', () => { eq(plural(1, 'kill'), '1 kill'); eq(plural(2, 'kill'), '2 kills'); });
test('upgrade and downgrade', () => { eq(upgrade('good'), 'great'); eq(upgrade('ok'), 'good'); eq(upgrade('great'), 'great'); eq(upgrade('mistake'), 'mistake'); eq(downgrade('great'), 'good'); eq(downgrade('ok'), 'inaccuracy'); eq(downgrade('mistake'), 'blunder'); eq(downgrade('blunder'), 'blunder'); });
test('act defaults', () => { const a = act({ kind: 'x' }); eq([a.pids, a.weight, a.tags, a.better, a.detail], [[], 1, [], '', '']); });
test('static objective weights', () => { eq(objValue({ key: 'BARON_NASHOR' }), 3); eq(objValue({ key: 'ELDER' }), 3.5); eq(objValue({ key: 'HORDE', count: 2 }), 0.7); eq(objValue({ key: 'UNKNOWN' }), 1); });
test('objective value from table', () => { const g = gameOf('riot-16.23'); const o = g.objectives.find(x => x.key === 'BARON_NASHOR'); ok(objValueOf(g, o) > 0); });
test('soul drake has its own key', () => { const g = gameOf('riot-16.23'); const s = g.souls[0]; const o = g.objectives.find(x => x.key === 'DRAGON' && Math.abs(x.t - s.t) < 5); eq(objKey(g, o), 'DRAGON_SOUL'); });
test('objective value without calibration falls back to swing', () => { const saved = WP_MODEL.norms; WP_MODEL.norms = null; try { const g = gameOf('riot-16.23'); ok(objValueOf(g, g.objectives[0]) >= 0); } finally { WP_MODEL.norms = saved; } });
test('gains', () => { const g = gameOf('riot-16.23'); const out = gains(g, g.winner, 0, g.duration); ok(out.some(x => x.kind === 'obj') && out.some(x => x.kind === 'struct')); for (let i = 1; i < out.length; i++) ok(out[i].t >= out[i - 1].t); eq(gains(g, 100, -5, -1), []); });
test('wardsPlaced', () => { const g = gameOf('riot-16.23'); ok(wardsPlaced(g, 100, 0, 600) > 0); eq(wardsPlaced(g, 100, -2, -1), 0); });
test('summarise', () => { const r = summarise([{ grade: 'great', weight: 1 }, { grade: 'blunder', weight: 1 }]); eq(r.accuracy, 52.5); eq([r.counts.great, r.counts.blunder, r.n], [1, 1, 2]); eq(summarise([]).accuracy, null); });
test('phaseLabel', () => { for (const [v, l] of [[95, 'Excellent'], [85, 'Good'], [70, 'Inaccurate'], [55, 'Mistakes'], [10, 'Blunders']]) eq(phaseLabel(v).label, l); eq(phaseLabel(null).label, '—'); });

for (const id of ['riot-15.12', 'riot-16.10', 'riot-16.23', 'red-win', 'short', 'long', 'lcu']) {
  test(`review ${id}: invariants`, () => {
    const g = gameOf(id), R = reviewOf(id);
    ok(R.actions.length > 10);
    R.actions.forEach((a, i) => { eq(a.id, i); if (i) ok(a.t >= R.actions[i - 1].t, 'sorted'); ok(GRADES[a.grade], 'grade'); ok(a.weight > 0, 'weight'); ok([100, 200].includes(a.team)); ok(a.title.length > 0); });
    for (const a of R.actions) ok(!/undefined|NaN|\[object/.test(`${a.title} ${a.detail} ${a.better}`), a.title);
    for (const p of g.ps) { const s = R.players[p.id]; ok(s.accuracy == null || (s.accuracy >= 0 && s.accuracy <= 100)); eq(Object.keys(s.counts).length, 8); ok(s.notes.length > 0); ok(s.phases.length >= 1); }
    for (const t of [100, 200]) ok(R.teams[t].accuracy >= 0 && R.teams[t].accuracy <= 100);
  });
  test(`review ${id}: one action per death`, () => { const g = gameOf(id), R = reviewOf(id); for (const p of g.ps) eq(R.actions.filter(a => a.kind === 'death' && a.actor === p.id).length, p.deaths.length); });
}
test('every action kind appears', () => { const kinds = new Set(reviewOf('long').actions.map(a => a.kind)); for (const k of ['death', 'fight', 'objective', 'objective-lost', 'structure', 'recall', 'laning', 'farm', 'vision']) ok(kinds.has(k), k); });
test('objective taken and lost are paired', () => { const R = reviewOf('riot-16.23'); ok(R.actions.filter(a => a.kind === 'objective').length >= R.actions.filter(a => a.kind === 'objective-lost').length); });
test('short games have no farm or vision grades under 12 minutes', () => { const d = G('short'); d.timeline.info.frames = frames(d).slice(0, 11); for (const f of frames(d)) f.events = f.events.filter(e => e.type !== 'GAME_END'); d.match.info.gameDuration = 600; const R = reviewGame(buildGame(d)); ok(!R.actions.some(a => a.kind === 'farm' || a.kind === 'vision')); });
test('laning needs an opponent in the role', () => { const d = G('riot-16.23'); parts(d).forEach(p => { p.teamPosition = ''; p.individualPosition = ''; }); ok(!reviewGame(buildGame(d)).actions.some(a => a.kind === 'laning')); });
test('review works without a trained model', () => { const R = reviewGame(buildGame(G('riot-16.23'), { noModel: true })); ok(R.actions.length > 10); ok(R.actions.every(a => a.dwp == null || a.kind === 'laning')); });
test('review collection hook', () => { window.REVIEW_COLLECT = []; reviewGame(buildGame(G('short'))); const keys = new Set(window.REVIEW_COLLECT.map(c => c.key)); window.REVIEW_COLLECT = null; ok(keys.has('deathCost')); ok(keys.has('objTotal')); });
test('death grade follows cost bands', () => { for (const a of reviewOf('riot-16.23').actions.filter(x => x.kind === 'death')) eq(a.grade, ['ok', 'inaccuracy', 'mistake', 'blunder'][bandOf('deathCost', a.cost).band]); });
test('death text', () => { const a = reviewOf('riot-16.23').actions.find(x => x.kind === 'death'); ok(a.title.startsWith('Died in ')); ok(/It cost your team about/.test(a.detail)); ok(a.better.length > 0); ok(a.tags.every(t => typeof t === 'string')); });
test('zero-weight free: unspent gold rule', () => { const d = G('long'); for (const f of frames(d).slice(10, 16)) f.participantFrames['1'].currentGold = 2000; const R = reviewGame(buildGame(d)); ok(R.actions.some(a => a.kind === 'gold' && a.actor === 1)); });
test('live gold rule', () => {
  const d = enrichWithLive(G('lcu'), { me: 0, players: parts(TT.games.lcu).map(p => ({ team: p.teamId, championId: p.championName, name: p.riotIdGameName })),
    snaps: Array.from({ length: 80 }, (_, k) => ({ t: 400 + k * 2, g: 2000, hp: 1, p: parts(TT.games.lcu).map(() => [5, 0, 0, 0, 0, 0, 0, 0, []]) })) });
  ok(reviewGame(buildGame(d)).actions.some(a => a.kind === 'gold' && /live recording/.test(a.detail)));
});
test('coach notes praise a deathless game', () => { const g = gameOf('short'); ok(coachNotes(g, g.ps[0], []).some(n => /never died/.test(n.text))); });
test('coach notes count patterns', () => {
  const g = gameOf('short'); const d = { kind: 'death', grade: 'mistake', weight: 1, tags: ['Enemy territory', 'Isolated', 'Outnumbered 1v2', 'Enemy converted', 'Team was ahead'], title: 'x' };
  const texts = coachNotes(g, g.ps[0], [d, d]).map(n => n.text).join(' '); for (const w of ['enemy-controlled territory', 'no ally nearby', 'outnumbered', 'objectives', 'team was ahead']) ok(texts.includes(w), w);
});
test('game story', () => { const g = gameOf('riot-16.23'); const s = gameStory(g, g.winner); ok(s.length >= 2); ok(s.at(-1).text.includes('won at')); ok(gameStory(g, null).length >= 2); });
test('game story with no winner', () => { const d = G('riot-16.23'); d.match.info.teams.forEach(t => (t.win = false)); for (const f of frames(d)) f.events = f.events.filter(e => e.type !== 'GAME_END'); const s = gameStory(buildGame(d), 100); ok(!s.at(-1).text.includes('won at')); });
