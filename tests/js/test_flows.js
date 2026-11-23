'use strict';
/* End-to-end user flows through the real app, its real server and the sandboxed data folder. */

const replayFor = re => S.replays.find(r => re.test(r.matchId));
const visible = id => !$(id).classList.contains('hidden');
const stubbedApi = async (routes, fn) => {
  const real = window.fetch;
  window.fetch = (url, opts) => { const hit = Object.keys(routes).find(k => String(url).startsWith(k)); if (hit) return Promise.resolve(new Response(typeof routes[hit] === 'string' ? routes[hit] : JSON.stringify(routes[hit]), { status: 200, headers: { 'Content-Type': 'application/json' } })); return real(url, opts); };
  try { return await fn(); } finally { window.fetch = real; }
};

test('flow: replay list is populated', () => { ok(S.replays.length >= 7); ok(S.replays.every(r => r.matchId && r.players.length === 10)); ok($('replaySelect').options.length >= 8); });
test('flow: player is auto-detected', () => { ok(S.topId && S.topId.startsWith('fixture-puuid-')); });
test('flow: config status shows no key', async () => { await refreshConfig(); ok($('keyStatus').textContent.startsWith('No API key')); });

for (const [label, re] of [['15.12', /5000000201/], ['16.10', /5000000202/], ['16.23', /5000000203/]]) {
  test(`flow: open and review a ${label} replay`, async () => {
    await openReplay(replayFor(re));
    ok(S.game && S.review); ok(visible('app') && !visible('welcome')); ok(!visible('banner'), $('banner').textContent);
    ok($('matchTitle').textContent.includes(S.game.matchId)); ok($('tabBody').textContent.includes('Game story')); ok($('moves').querySelectorAll('.rv-move').length > 0);
  });
}
test('flow: every tab renders', async () => {
  await openReplay(replayFor(/5000000203/));
  for (const tab of ['review', 'phases', 'moments', 'objectives', 'me', 'how']) { S.tab = tab; renderTabs(); ok($('tabBody').innerText.length > 40, tab); ok(!/undefined|NaN|\[object/.test($('tabBody').innerText), `text glitch in ${tab}`); }
  S.tab = 'review'; renderTabs();
});
test('flow: tab buttons switch tabs', async () => { await openReplay(replayFor(/5000000203/)); $('tabs').querySelector('[data-tab=phases]').click(); eq(S.tab, 'phases'); ok($('tabBody').textContent.includes('Control phases')); $('tabs').querySelector('[data-tab=review]').click(); });
test('flow: How tab shows Riot notice and rotation result', async () => { await openReplay(replayFor(/5000000203/)); S.tab = 'how'; renderTabs(); ok($('tabBody').textContent.includes("isn't endorsed by Riot Games")); ok($('tabBody').textContent.includes('72.1%')); S.tab = 'review'; renderTabs(); });
test('flow: side tabs', async () => { await openReplay(replayFor(/5000000203/)); const t = $('sideTabs'); eq([...t.querySelectorAll('button')].map(b => b.textContent), ['Moves', 'Scoreboard']); t.querySelector('[data-st=score]').click(); S.t = 600; updateSide(); ok(visible('scoreboard') && !visible('moves')); ok($('scoreboard').querySelectorAll('.sb-row').length === 10); t.querySelector('[data-st=moves]').click(); ok(visible('moves')); });
test('flow: side panel at key times', async () => { await openReplay(replayFor(/5000000203/)); for (const v of [0, 300, 900, S.game.duration]) { S.t = v; updateSide(); ok(!/undefined|NaN/.test($('ctrlText').innerText + $('factors').innerText), `t=${v}`); ok($('clock').textContent.includes(fmtTime(v))); } });
test('flow: map and chart draw at every stage', async () => { await openReplay(replayFor(/5000000203/)); setView('map', true); sizeCanvases(); for (const v of [0, 260, 930, 1400, S.game.duration]) { S.t = v; drawMap(); drawChart(); } eq(S.loopError || null, null); });
test('flow: seek, play and pause', async () => { await openReplay(replayFor(/5000000203/)); seek(100); eq(S.t, 100); seek(-5); eq(S.t, 0); seek(1e9); eq(S.t, S.game.duration); togglePlay(); eq(S.t, 0); ok(S.playing); togglePlay(); ok(!S.playing); });
test('flow: step through moves', async () => { await openReplay(replayFor(/5000000203/)); const a = movesFor(S.revPid); ok(a.length > 1); stepMove(1); eq(S.revSel, a.find(x => x.t >= -1).id); stepMove(1); ok($('moves').querySelector('.rv-detail')); stepMove(-1); selectAction(S.revSel, false); eq(S.revSel, null); });
test('flow: watch a moment restores speed', async () => { await openReplay(replayFor(/5000000203/)); const a = S.review.actions.find(x => x.kind === 'death'); const sp = S.speed; watchAction(a.id); ok(S.playing); eq(S.speed, 3); eq(S.stopAt, a.t + 8); seek(10); eq(S.stopAt, null); eq(S.speed, +$('speed').value); S.playing = false; S.speed = sp; });
test('flow: filters and player picker', async () => { await openReplay(replayFor(/5000000203/)); for (const f of ['bad', 'good', 'all', 'key']) { $('moves').querySelector(`[data-f=${f}]`).click(); eq(S.revFilter, f); } const sel = $('mvSel'); sel.value = String(S.game.ps[6].id); sel.onchange({ target: sel }); eq(S.revPid, S.game.ps[6].id); });
test('flow: mark yourself', async () => { await openReplay(replayFor(/5000000203/)); const saved = [S.myIds.slice(), store.get('myPuuids', [])]; const pid = S.game.ps[3].id; S.revPid = pid; renderMoves(); $('mvMe').click(); eq(S.mePid, pid); S.myIds = saved[0]; store.set('myPuuids', saved[1]); });
test('flow: keyboard shortcuts', async () => { await openReplay(replayFor(/5000000203/)); seek(100); document.activeElement.blur(); document.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight' })); eq(S.t, 110); document.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft', shiftKey: true })); eq(S.t, 50); document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' })); ok(S.playing); document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' })); ok(!S.playing); });
test('flow: client data is labelled', async () => { await openReplay({ file: 'x', matchId: 'NA1_5000000106', players: [] }); ok(S.game); eq(S.game.source, 'lcu'); ok($('matchTitle').textContent.includes('client data')); });
test('flow: ARAM shows a clear error', async () => { await openReplay(replayFor(/5000000105/)); eq(S.game, null); ok(visible('banner')); ok($('banner').textContent.includes("Only Summoner's Rift")); ok(visible('welcome') && !visible('app')); ok($('welcome').querySelector('.meta-only')); });
test('flow: missing match shows the replay stats', async () => { await openReplay({ file: 'gone.rofl', matchId: 'NA1_4000000000', players: [{ team: 100, name: '<b>x', champion: 'Ahri', win: true, kills: 1, deaths: 2, assists: 3, gold: 1000, visionScore: 5 }] }); eq(S.game, null); ok($('banner').textContent.includes('No Riot API key')); ok($('welcome').querySelector('.meta-only').innerHTML.includes('&lt;b&gt;x')); });
test('flow: replay without an ID', async () => { await openReplay({ file: 'x.rofl', players: [] }); ok($('banner').textContent.includes('Could not determine')); banner(''); });
test('flow: latest replay wins a race', async () => { const a = replayFor(/5000000201/), b = replayFor(/5000000203/); await Promise.all([openReplay(a), openReplay(b)]); eq(S.game.matchId, b.matchId); });
test('flow: server unreachable message', async () => { const real = window.fetch; window.fetch = (u, o) => (String(u).startsWith('/api/match') ? Promise.reject(new TypeError('down')) : real(u, o)); try { await openReplay({ file: 'f', matchId: 'NA1_5000000203', players: [] }); ok($('banner').textContent.includes('Could not reach')); } finally { window.fetch = real; } });
test('known H11: zero-player game leaves the page on Loading', async () => {
  const d = G('short'); d.match.info.participants = []; TT.allowRejections = true; let msg = '';
  try { await stubbedApi({ '/api/match': d }, async () => { try { await openReplay({ file: 'f', matchId: 'NA1_1', players: [] }); } catch (e) { msg = e.message; } }); } finally { TT.allowRejections = false; }
  ok(/reading 'id'/.test(msg), msg); ok($('banner').textContent.includes('Loading')); banner('');
});
test('flow: save an API key from the UI', async () => { $('apiKey').value = ' RGAPI-test '; $('saveKey').click(); ok(await until(() => $('keyStatus').textContent.includes('Key saved'))); eq($('apiKey').value, ''); await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"apiKey":""}' }); await refreshConfig(); banner(''); });
test('flow: Trends analyses every replay', async () => {
  showTrends(true); ok(await until(() => !T.running && T.rows.length >= 6, 20000), 'trends finished'); ok(visible('trends')); ok($('trBody').textContent.includes('games analysed')); ok($('trBody').textContent.includes('Recurring mistakes'));
  ok(!/undefined|NaN/.test($('trBody').innerText)); ok(T.rows.some(r => r.error) || T.rows.length >= 6);
});
test('flow: Trends reuses cached rows', async () => { const n = T.rows.filter(r => !r.error).length; ok(n > 0); await analyzeAllForTrends(false); eq(T.rows.filter(r => !r.error).length, n); });
test('flow: open a game from Trends', async () => { const row = T.rows.find(r => !r.error); await openFromTrends(row.file); ok(!visible('trends') && visible('app')); eq(S.game.matchId, row.matchId); });
test('flow: Live panel renders', async () => { showLive(true); ok(await until(() => $('lvBody').textContent.includes('What the live coach does'))); eq($('lvStatus').textContent, 'Live recording is turned off'); showLive(false); ok(!visible('live')); });
test('flow: Live in-game panel shows only your own stats', async () => {
  const st = { status: 'play', phase: 'InProgress', last: { p: [[3, 1, 2, 3, 40, 5, 0, 0, []]] }, session: { id: 's', mode: 'play', me: 0, gameTime: 600, ended: false, snaps: 3, players: [{ championId: 'Ahri', position: 'MIDDLE' }] } };
  const saved = LV.state; LV.state = st; LV.sig = ''; $('live').classList.remove('hidden'); renderLive(); const t = $('lvBody').textContent; ok(t.includes('10:00')); ok(t.includes('Recording for your debrief')); ok(!/go dragon|back now/i.test(t.split('What the live coach')[0])); $('live').classList.add('hidden'); LV.state = saved; LV.sig = '';
});
test('flow: self-test passes on all Rift replays', async () => {
  const savedRe = S.replays; S.replays = savedRe.filter(r => !/5000000105/.test(r.matchId)); const expected = S.replays.length; // opening a game reloads the list
  try { const r = await runSelfTest(); eq(r.filter(x => x.status !== 'ok').map(x => [x.file, x.status, x.msg, x.bad]), []); eq(r.length, expected); } finally { S.replays = savedRe; [...document.body.children].filter(x => x.style.zIndex === '50').forEach(x => x.remove()); S.sideTab = 'moves'; }
});
