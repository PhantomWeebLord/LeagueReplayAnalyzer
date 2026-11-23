'use strict';
/* Characterization tests for app.js helpers. */

test('esc escapes HTML', () => { eq(esc(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;'); eq(esc(null), ''); eq(esc(undefined), ''); eq(esc(0), '0'); });
test('teamCls', () => { eq([teamCls(100), teamCls(200), teamCls(0)], ['b', 'r', '']); });
test('store round trip', () => { store.set('t.k', { a: 1 }); eq(store.get('t.k', null), { a: 1 }); eq(store.get('t.none', 7), 7); localStorage.setItem('lra.t.bad', '{'); eq(store.get('t.bad', 9), 9); localStorage.removeItem('lra.t.k'); localStorage.removeItem('lra.t.bad'); });
test('toPx maps game units to the canvas', () => { eq(toPx(SR.minX, SR.minY, 100, 100), [0, 100]); eq(toPx(SR.maxX, SR.maxY, 100, 100), [100, 0]); });
test('hexA', () => { eq(hexA('#3d8bff', 0.5), 'rgba(61,139,255,0.5)'); eq(hexA('#000000', 2), 'rgba(0,0,0,1)'); });
test('banner shows, hides and marks errors', () => { banner('hello', true); const b = $('banner'); ok(!b.classList.contains('hidden') && b.classList.contains('err')); eq(b.textContent, 'hello'); banner(''); ok(b.classList.contains('hidden')); });
test('api parses JSON', async () => { eq((await api('/api/ping')).app, 'lra2'); });

const withMe = (state, fn) => { const saved = { myIds: S.myIds, clientPuuid: S.clientPuuid, topId: S.topId }; Object.assign(S, state); try { return fn(); } finally { Object.assign(S, saved); } };
test('meIn: marked account first', () => { const pl = [{ id: 1, puuid: 'a' }, { id: 2, puuid: 'b' }]; eq(withMe({ myIds: ['b'], clientPuuid: 'a', topId: 'a' }, () => meIn(pl).id), 2); });
test('meIn: then logged-in account', () => { const pl = [{ id: 1, puuid: 'a' }, { id: 2, puuid: 'b' }]; eq(withMe({ myIds: [], clientPuuid: 'a', topId: 'b' }, () => meIn(pl).id), 1); });
test('meIn: then most frequent player', () => { const pl = [{ id: 1, puuid: 'a' }, { id: 2, puuid: 'b' }]; eq(withMe({ myIds: [], clientPuuid: null, topId: 'b' }, () => meIn(pl).id), 2); });
test('meIn: frequent player ignored once you marked yourself', () => { const pl = [{ id: 2, puuid: 'b' }]; eq(withMe({ myIds: ['z'], clientPuuid: null, topId: 'b' }, () => meIn(pl)), null); });
test('meIn prefers the replay PUUID', () => { const pl = [{ id: 1, puuid: 'enc', rawPuuid: 'raw' }]; eq(withMe({ myIds: ['raw'], clientPuuid: null, topId: null }, () => meIn(pl).id), 1); });
test('markMe replaces accounts from the same game', () => {
  const g = { ps: [{ id: 1, puuid: 'a' }, { id: 2, puuid: 'b' }], byId: { 1: { id: 1, puuid: 'a' }, 2: { id: 2, puuid: 'b' } } };
  const saved = [S.myIds, S.mePid, store.get('myPuuids', [])];
  S.myIds = ['a', 'other']; markMe(g, 2); eq(S.myIds, ['b', 'other']); eq(S.mePid, 2); markMe(g, 99); eq(S.mePid, 2);
  S.myIds = saved[0]; S.mePid = saved[1]; store.set('myPuuids', saved[2]);
});
test('linkReplayPlayers by team and champion (Riot data)', () => {
  const g = { source: 'riot-api', ps: [{ team: 100, champ: 'Ahri', puuid: 'encrypted' }, { team: 200, champ: 'Ahri', puuid: 'enc2' }] };
  linkReplayPlayers(g, { players: [{ team: 200, champion: 'ahri', puuid: 'raw2' }] }); eq(g.ps[0].rawPuuid, null); eq(g.ps[1].rawPuuid, 'raw2');
});
test('linkReplayPlayers for client data keeps PUUID', () => { const g = { source: 'lcu', ps: [{ team: 100, champ: 'Ahri', puuid: 'p' }] }; linkReplayPlayers(g, { players: [] }); eq(g.ps[0].rawPuuid, 'p'); });
test('linkReplayPlayers without metadata', () => { const g = { source: 'riot-api', ps: [{ team: 100, champ: 'Ahri', puuid: 'p' }] }; linkReplayPlayers(g, null); eq(g.ps[0].rawPuuid, null); });

const roflFile = (name, parts_) => new File(parts_, name);
const roflBytes = (ver, stats) => [new TextEncoder().encode('RIOT\x00\x02' + ver + '\0'.repeat(60)), new Uint8Array(300), new TextEncoder().encode(JSON.stringify({ gameLength: 1234000, statsJson: JSON.stringify(stats) }))];
const STATS = [{ PUUID: 'p1', RIOT_ID_GAME_NAME: 'Name', RIOT_ID_TAG_LINE: 'TAG', SKIN: 'Ahri', TEAM: '100', TEAM_POSITION: 'MIDDLE', WIN: 'Win', CHAMPIONS_KILLED: '3', NUM_DEATHS: '1', ASSISTS: '7', GOLD_EARNED: '9000', VISION_SCORE: '20' }];
for (const ver of ['15.12.700.1234', '16.10.700.1234', '16.23.840.6595']) test(`parseRoflFile patch ${ver}`, async () => { const r = await parseRoflFile(roflFile('NA1-55.rofl', roflBytes(ver, STATS))); eq([r.version, r.matchId, r.gameId, r.gameLength], [ver, 'NA1_55', '55', 1234000]); eq(r.players[0].champion, 'Ahri'); eq([r.players[0].team, r.players[0].kills, r.players[0].win], [100, 3, true]); });
test('parseRoflFile defaults for missing numbers', async () => { const r = await parseRoflFile(roflFile('NA1-55.rofl', roflBytes('16.23.1.1', [{ SKIN: 'Ahri', TEAM: '200' }]))); eq([r.players[0].kills, r.players[0].gold, r.players[0].win], [0, 0, false]); });
test('parseRoflFile rejects wrong files', async () => { let m = ''; try { await parseRoflFile(roflFile('x.rofl', ['NOPE'])); } catch (e) { m = e.message; } ok(/not a \.rofl/.test(m)); });
test('parseRoflFile without metadata', async () => { let m = ''; try { await parseRoflFile(roflFile('x.rofl', ['RIOT' + '\0'.repeat(100)])); } catch (e) { m = e.message; } ok(/metadata/.test(m)); });
test('parseRoflFile truncated metadata throws', async () => { const b = roflBytes('16.23.1.1', STATS); b[2] = b[2].slice(0, 20); let threw = false; try { await parseRoflFile(roflFile('NA1-1.rofl', b)); } catch { threw = true; } ok(threw); });
test('parseRoflFile asks for an ID when the name has none', async () => {
  const saved = window.prompt; window.prompt = () => ' na1-77 ';
  try { eq((await parseRoflFile(roflFile('renamed.rofl', roflBytes('16.23.1.1', [])))).matchId, 'NA1_77'); window.prompt = () => null; let m = ''; try { await parseRoflFile(roflFile('renamed.rofl', roflBytes('16.23.1.1', []))); } catch (e) { m = e.message; } ok(/No match ID/.test(m)); }
  finally { window.prompt = saved; }
});
test('team average level', () => { const g = gameOf('short'); ok(teamAvgLevel(g, 100, 600) > 1); });
test('move filters', () => { const a = { grade: 'ok', routine: true, kind: 'recall' }; eq(MOVE_FILTERS.key.fn(a), false); eq(MOVE_FILTERS.key.fn({ grade: 'ok', kind: 'death' }), true); eq(MOVE_FILTERS.bad.fn({ grade: 'miss' }), true); eq(MOVE_FILTERS.good.fn({ grade: 'great' }), true); eq(MOVE_FILTERS.all.fn(a), true); });
test('accuracy formatting and colour', () => { eq(fmtAcc(null), '–'); eq(fmtAcc(81.234), '81.2'); eq(accColor(null), 'var(--muted)'); eq(accColor(95), GRADES.great.color); eq(accColor(82), GRADES.good.color); eq(accColor(70), GRADES.inaccuracy.color); eq(accColor(55), GRADES.mistake.color); eq(accColor(20), GRADES.blunder.color); });
test('evalTxt', () => { eq(evalTxt({ kind: 'farm', before: 1 }), ''); eq(evalTxt({ kind: 'x' }), ''); ok(evalTxt({ kind: 'death', before: 50, after: 40, dwp: -5 }).includes('−5.0%')); ok(evalTxt({ kind: 'recall', before: 50, after: 40 }).includes('50→40%')); });
test('win-chance unit table covers every feature', () => { for (const k of WP_FEATS) ok(WP_UNIT[k], k); });
test('wpUnitValue', () => { const m = WP_MODEL.full; ok(wpUnitValue(m, 'gold', 900) > 0); near(wpUnitValue({ knots: m.knots, coef: {} }, 'gold', 900), 0, 1e-9); });
