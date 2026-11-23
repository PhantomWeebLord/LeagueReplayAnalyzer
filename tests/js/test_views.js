'use strict';
/* Characterization tests for the map, Trends, Live and replay-stage modules. */

test('self-test output escapes replay data', () => { const html = selfTestLine({ status: 'ISSUES', file: '<img src=x>.rofl', source: '<b>', dur: 60, actions: 1, me: '<i>x', ms: 1, msg: '<s>', bad: ['<u>bad'] }); for (const t of ['<img', '<b>', '<i>', '<s>', '<u>']) ok(!html.includes(t), t); ok(html.includes('&lt;u&gt;bad')); });
test('fxDur scales with playback speed', () => { const s = S.speed; S.speed = 10; eq(fxDur(1), 10); S.speed = 1; eq(fxDur(1), 1.6); S.speed = s; });
test('director targets a fight', () => { const g = gameOf('riot-16.23'); const f = g.fights.find(x => x.size > 1); const t = directorTarget(g, f.start + 0.5); eq(t.mode, 'action'); ok(t.z >= 1.35 && t.z <= 2.5); });
test('director returns to the full map', () => { const g = gameOf('riot-16.23'); const saved = S.focus; S.focus = null; const t = directorTarget(g, 100); eq([t.mode, t.z], ['map', 1]); S.focus = saved; });
test('director follows the selected player when quiet', () => { const g = gameOf('riot-16.23'); const saved = S.focus; S.focus = g.ps[0].id; eq(directorTarget(g, 100).mode, 'follow'); S.focus = saved; });
test('captions', () => { const g = buildGame(G('riot-16.23')); const c = captionsFor(g); ok(c[0].text.startsWith('FIRST BLOOD')); ok(c.some(x => x.text.includes('TAKES'))); ok(c.some(x => x.text.includes('INHIBITOR'))); for (let i = 1; i < c.length; i++) ok(c[i].t >= c[i - 1].t); eq(captionsFor(g), c); });
test('multikill captions', () => {
  const d = G('short'); const f = frames(d)[4]; for (const [i, v] of [6, 7, 8].entries()) f.events.push({ type: 'CHAMPION_KILL', timestamp: 200000 + i * 1000, victimId: v, killerId: 1, assistingParticipantIds: [], position: { x: 7000, y: 7000 }, bounty: 300, shutdownBounty: 0 });
  f.events.sort((a, b) => a.timestamp - b.timestamp); const c = captionsFor(buildGame(d)).map(x => x.text); ok(c.some(x => x.startsWith('DOUBLE KILL'))); ok(c.some(x => x.startsWith('TRIPLE KILL')));
});
test('first blood caption without a champion killer', () => { const d = G('short'); frames(d).find(x => x.events.some(e => e.type === 'CHAMPION_KILL')).events.find(e => e.type === 'CHAMPION_KILL').killerId = 0; eq(captionsFor(buildGame(d))[0].text, 'FIRST BLOOD'); });
test('champLabel', () => { const g = gameOf('short'); eq(champLabel(g, 1), 'WUKONG'); eq(champLabel(g, 99), ''); });

test('avg ignores missing values', () => { eq(avg([1, null, 3, NaN]), 2); eq(avg([]), null); eq(avgOf([2, 4, undefined]), 3); eq(avgOf([]), null); });
test('trend cache key', () => { eq(trendKey('NA1_1'), `trend.v${TREND_VERSION}.NA1_1`); eq(TREND_VERSION, 8); });
test('mistake categories', () => { eq(MISTAKE_CATS.length, 10); ok(MISTAKE_CATS.every(c => c.key && c.label && c.tip)); });
test('summarizeGame', () => {
  const g = gameOf('riot-16.23'), R = reviewOf('riot-16.23'), p = g.ps[0];
  const row = summarizeGame(g, R, { file: 'x.rofl', matchId: 'NA1_1', mtime: 1 }, p.id);
  eq([row.v, row.champ, row.role, row.team, row.win, row.k, row.d, row.a], [8, 'MonkeyKing', 'TOP', 100, g.winner === 100, p.kills.length, p.deaths.length, p.assistsAt.length]);
  near(row.acc, R.players[p.id].accuracy); ok(row.ctrlShare >= 0 && row.ctrlShare <= 1); eq(Object.keys(row.cats).length, 10); ok(row.cspm > 0 && row.vspm > 0);
});
test('summarizeGame in a short game has no 15:00 control', () => { const d = G('short'); d.timeline.info.frames = frames(d).slice(0, 12); for (const f of frames(d)) f.events = f.events.filter(e => e.type !== 'GAME_END'); d.match.info.gameDuration = 660; const g = buildGame(d); const R = reviewGame(g); eq(summarizeGame(g, R, { file: 'f', matchId: 'm', mtime: 1 }, g.ps[0].id).ctrl15, null); });

const trendRow = (over = {}) => ({ champ: 'Ahri', role: 'MIDDLE', win: true, d: 3, acc: 80, cspm: 7, vspm: 1, cats: Object.fromEntries(MISTAKE_CATS.map((c, i) => [c.key, i === 0 ? 2 : 0])), ...over });
const withRows = (rows, fn) => { const saved = T.rows; T.rows = rows; try { return fn(); } finally { T.rows = saved; } };
test('focusPlan needs games', () => { withRows([], () => eq(focusPlan('Ahri', 'MIDDLE'), null)); });
test('focusPlan builds goals', () => {
  withRows([trendRow(), trendRow({ d: 5, win: false, cspm: 8 })], () => {
    const p = focusPlan('Ahri', 'MIDDLE'); eq(p.n, 2); eq(p.cats[0].key, MISTAKE_CATS[0].key); eq(p.goals.map(g => g.key), ['deaths', 'cspm', 'vspm']); eq(p.goals[0].target, 3); near(p.goals[1].target, 7.8, 1e-9); eq([p.champ.n, p.champ.wr], [2, 0.5]);
  });
});
test('focusPlan support has no CS goal', () => { withRows([trendRow({ role: 'UTILITY' })], () => eq(focusPlan('Ahri', 'UTILITY').goals.map(g => g.key), ['deaths', 'vspm'])); });
test('focusPlan unknown champion', () => { withRows([trendRow()], () => eq(focusPlan('Jinx', 'BOTTOM').champ, { id: 'Jinx', n: 0 })); });
test('goal helpers', () => {
  const row = [1, 2, 3, 4, 70, 12]; eq(goalValue({ key: 'deaths' }, row, 10), 3); eq(goalValue({ key: 'cspm' }, row, 10), 7); eq(goalValue({ key: 'vspm' }, row, 10), 1.2); eq(goalValue({ key: 'cspm' }, row, 2), null); eq(goalValue({ key: 'x' }, row, 10), null); eq(goalValue({ key: 'deaths' }, null, 10), null);
  eq(goalMet({ better: 'low', target: 3 }, 2), true); eq(goalMet({ better: 'high', target: 3 }, 2), false); eq(goalMet({}, null), null);
  eq(fmtGoal({ key: 'deaths' }, 3), '3'); eq(fmtGoal({ key: 'vspm' }, 1.234), '1.23'); eq(fmtGoal({ key: 'cspm' }, 7.26), '7.3'); eq(fmtGoal({ key: 'x' }, null), '—');
  eq(goalTxt({ label: 'Deaths', better: 'low', key: 'deaths', target: 3 }), 'Deaths ≤ 3'); eq(goalTxt({ label: 'CS', better: 'high', key: 'cspm', target: 7 }), 'CS ≥ 7.0');
});
test('live status text', () => {
  const c = [[null, 'App offline'], [{ status: 'disabled' }, 'Live recording is turned off'], [{ status: 'play', session: {} }, 'In game — recording'], [{ status: 'play', session: { ended: true } }, 'Game over'], [{ status: 'spectate' }, 'Watching a replay'],
    [{ status: 'idle', phase: 'ChampSelect' }, 'Champion select'], [{ status: 'idle', phase: 'Lobby' }, 'In lobby'], [{ status: 'idle', phase: 'Odd' }, 'Waiting for your next game'], [{ status: 'idle' }, 'League client closed — waiting']];
  for (const [st, want] of c) eq(liveStatusText(st), want);
});
test('champ card', () => { ok(champCard(null, null).includes('Lock in')); ok(champCard({ champ: { n: 0 } }, 'Ahri').includes('No past games')); withRows([trendRow()], () => { const p = focusPlan('Ahri', 'MIDDLE'); ok(champCard(p, 'Ahri').includes('1 game')); }); });
test('renderFocus', () => { ok(renderFocus(null, '').includes('Open a few of your replays')); withRows([trendRow()], () => ok(renderFocus(focusPlan('Ahri', 'MIDDLE'), 'CARD').includes('CARD'))); });
test('live session lookup', async () => {
  const saved = [LV.sessions, LV.sessionCache]; LV.sessions = [{ id: 'x', matchId: 'NA1_1', snaps: 5 }, { id: 'y', matchId: 'NA1_2', snaps: 50 }]; LV.sessionCache = { y: { id: 'y' } };
  try { eq(await liveSessionFor(null), null); eq(await liveSessionFor('NA1_1'), null); eq(await liveSessionFor('NA1_2'), { id: 'y' }); eq(await liveSessionFor('NA1_3'), null); } finally { [LV.sessions, LV.sessionCache] = saved; }
});

const withStage = (state, fn) => { const saved = { game: S.game, meta: S.meta, st: RS.st, pb: RS.pb, opening: RS.opening, noPb: RS.noPbSince, stream: RS.stream }; S.game = gameOf('riot-16.23'); S.meta = { matchId: S.game.matchId }; Object.assign(RS, { st: null, pb: null, opening: 0, noPbSince: 0, stream: null }, state); try { return fn(); } finally { S.game = saved.game; S.meta = saved.meta; RS.st = saved.st; RS.pb = saved.pb; RS.opening = saved.opening; RS.noPbSince = saved.noPb; RS.stream = saved.stream; } };
test('rsPhase without a game or status', () => { const g = S.game; S.game = null; eq(rsPhase({}), 'none'); S.game = g; withStage({}, () => eq(rsPhase(null), 'offline')); });
test('rsPhase table', () => {
  withStage({}, () => {
    const mid = S.game.matchId;
    const c = [[{ inGame: true }, 'ingame'], [{ lcu: false }, 'noclient'], [{ lcu: true, apiEnabled: false }, 'setup'], [{ lcu: true, apiEnabled: true }, 'ready'], [{ lcu: true, clientPatching: true }, 'patching'], [{ compatible: false, lcu: true }, 'old'],
      [{ spectating: true, window: {}, playingMatch: 'NA1_9', lcu: true }, 'other'], [{ spectating: true, window: {}, playingMatch: mid, playback: { time: 1 }, lcu: true, apiEnabled: true }, 'capture'], [{ spectating: true, window: {}, playingMatch: mid, lcu: true }, 'nocontrol'], [{ lcu: true, clientPlayingReplay: true, apiEnabled: true }, 'other']];
    for (const [st, want] of c) eq(rsPhase(st), want, JSON.stringify(st));
  });
});
test('rsPhase while opening', () => { withStage({ opening: Date.now() }, () => { eq(rsPhase({ lcu: true, apiEnabled: true }), 'loading'); eq(rsPhase({ lcu: true, clientPlayingReplay: true }), 'loading'); eq(rsPhase({ spectating: true, window: {}, lcu: true }), 'loading'); }); });
test('rsPhase with stream is live', () => { withStage({ stream: {} }, () => eq(rsPhase({ spectating: true, window: {}, playingMatch: S.game.matchId, playback: { time: 1 } }), 'live')); });
test('rsPhase waits briefly for the Replay API', () => { withStage({ noPbSince: Date.now() }, () => eq(rsPhase({ spectating: true, window: {}, playingMatch: S.game.matchId, apiEnabled: true }), 'loading')); });
test('rsControl needs our replay and playback', () => { withStage({}, () => { eq(rsControl(), false); RS.st = { spectating: true, window: {}, playingMatch: S.game.matchId }; eq(rsControl(), false); RS.pb = { time: 1 }; eq(rsControl(), true); RS.st.playingMatch = 'NA1_9'; eq(rsControl(), false); }); });
test('pbNow extrapolates only while playing', () => {
  const saved = [RS.pb, RS.pbAt, RS.pending]; RS.pending = null;
  RS.pb = null; eq(pbNow(), null); RS.pb = { time: 10, paused: true, speed: 2 }; RS.pbAt = performance.now() - 1000; eq(pbNow(), 10);
  RS.pb = { time: 10, paused: false, speed: 2 }; RS.pbAt = performance.now() - 1000; near(pbNow(), 12, 0.3); RS.pb.seeking = true; eq(pbNow(), 10);
  RS.pending = { t: 99, at: performance.now() }; eq(rsTime(), 99); RS.pending = { t: 99, at: performance.now() - 5000 }; eq(rsTime(), 10);
  [RS.pb, RS.pbAt, RS.pending] = saved;
});
test('speed options include unusual speeds', () => { const sel = document.createElement('select'); sel.innerHTML = '<option value="1">1×</option>'; setSpeedValue(sel, 1.5); eq(sel.value, '1.5'); setSpeedValue(sel, 1); eq(sel.value, '1'); eq(sel.options.length, 2); });
test('panel text exists for every phase', () => { for (const k of ['noclient', 'setup', 'ready', 'loading', 'capture', 'nocontrol', 'other', 'ingame', 'patching', 'offline', 'old']) { const p = PANEL[k](); ok(p.t && p.p, k); } });
test('old-patch panel escapes patch names', () => { const saved = RS.st; RS.st = { replayPatch: '<b>x', clientPatch: '16.23' }; ok(PANEL.old().p.includes('&lt;b&gt;x')); RS.st = saved; });
test('team class for stage', () => { eq([teamClsRs(100), teamClsRs(200)], ['b', 'r']); });
