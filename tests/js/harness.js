'use strict';
/* Minimal test harness (no dependencies). Suites register with test(); run() reports to the Python runner. */
const TT = { tests: [], pageErrors: [], games: {}, cfg: null };
window.addEventListener('error', e => TT.pageErrors.push(String(e.message)));
window.addEventListener('unhandledrejection', e => { if (!TT.allowRejections) TT.pageErrors.push('unhandled: ' + String(e.reason && e.reason.message || e.reason)); });

const test = (name, fn) => TT.tests.push({ name, fn });
function fail(msg) { throw new Error(msg); }
const show = v => { try { return JSON.stringify(v); } catch { return String(v); } };
const eq = (a, b, msg = '') => { if (show(a) !== show(b)) fail(`${msg} expected ${show(b)}, got ${show(a)}`); };
const ok = (v, msg = 'expected truthy') => { if (!v) fail(msg); };
const near = (a, b, tol = 1e-6, msg = '') => { if (!(Math.abs(a - b) <= tol)) fail(`${msg} expected ${b} ±${tol}, got ${a}`); };
const throws = (fn, re) => { try { fn(); } catch (e) { if (re && !re.test(String(e.message))) fail(`wrong error: ${e.message}`); return e; } fail('expected a throw'); };
const clone = o => JSON.parse(JSON.stringify(o));
const G = id => clone(TT.games[id]);
const built = {};
const gameOf = id => (built[id] = built[id] || buildGame(G(id)));
const reviewed = {};
const reviewOf = id => (reviewed[id] = reviewed[id] || reviewGame(gameOf(id)));
const frames = d => d.timeline.info.frames;
const parts = d => d.match.info.participants;
const tickUi = () => new Promise(r => setTimeout(r, 0));
async function until(fn, ms = 4000) { const t = performance.now(); while (performance.now() - t < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 15)); } return false; }

// Fingerprint of everything a player sees from the analysis. Any change in a grade, number or sentence changes it.
const round = (v, d = 4) => (typeof v === 'number' && isFinite(v) ? +v.toFixed(d) : v == null ? null : v);
function canonical(g, R) {
  return {
    duration: round(g.duration), winner: g.winner, wards: g.hasWards, items: g.hasItems,
    players: g.ps.map(p => [p.id, p.team, p.champ, p.role, p.deaths.map(d => [round(d.t, 2), round(d.respawn, 2)]), p.recalls.length, p.kf.length]),
    kills: g.kills.length, objectives: g.objectives.map(o => [round(o.t, 2), o.team, o.key, o.name, o.count]), souls: g.souls.map(s => [round(s.t, 2), s.team]),
    structures: g.structureEvents.map(s => [round(s.t, 2), s.team, s.kind, s.tier, s.lane]), fights: g.fights.map(f => [round(f.start, 2), round(f.end, 2), f.size, f.involved, f.winner, f.label, f.zone]),
    phases: g.phases.map(p => [p.leader, round(p.start, 2), round(p.end, 2), round(p.mean), p.reasons]), moments: g.moments.map(m => [round(m.t, 2), m.team, round(m.delta), m.driver]),
    samples: g.samples.filter((_, i) => i % 15 === 0).map(s => [round(s.t, 1), round(s.wp, 5), round(s.control, 5)]),
    actions: R.actions.map(a => [a.id, round(a.t, 2), a.team, a.actor, a.pids, a.kind, a.grade, round(a.weight), round(a.dwp, 3), round(a.before, 2), round(a.after, 2), a.title, a.detail, a.better, a.tags]),
    accuracy: g.ps.map(p => [p.id, round(R.players[p.id].accuracy), R.players[p.id].counts, R.players[p.id].notes.map(n => n.text), R.players[p.id].phases.map(x => [x.key, round(x.accuracy), x.n])]),
    teams: [100, 200].map(t => [round(R.teams[t].accuracy), R.teams[t].n]), story: gameStory(g, 100).map(x => [round(x.t, 2), x.text]),
  };
}
async function digest(g, R) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(g, R)));
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(h), b => b.toString(16).padStart(2, '0')).join('');
}

async function runAll() {
  const t0 = performance.now();
  await until(() => S.replays.length > 0, 15000);
  TT.cfg = await (await fetch('/__t/config')).json();
  for (const id of TT.cfg.games) TT.games[id] = await (await fetch('/__t/game?id=' + id)).json();
  const out = [], golden = {}, real = {};
  // deterministic display names from the fixture table
  for (const t of TT.tests) {
    try { await t.fn(); out.push({ name: t.name, ok: true }); }
    catch (e) { out.push({ name: t.name, ok: false, error: String(e && e.stack || e) }); }
  }
  for (const id of TT.cfg.games) {
    if (id === 'aram') continue;
    const name = `golden: synthetic game ${id}`;
    try {
      const g = buildGame(G(id)); const R = reviewGame(g); const d = await digest(g, R); golden[id] = d;
      if (!TT.cfg.update) { if (!TT.cfg.golden[id]) fail('no baseline recorded'); eq(d, TT.cfg.golden[id], 'analysis output changed:'); }
      out.push({ name, ok: true });
    } catch (e) { out.push({ name, ok: false, error: String(e && e.message || e) }); }
    await tickUi();
  }
  for (const id of TT.cfg.realIds) {
    const name = `golden: local replay ${id}`;
    try {
      const data = await (await fetch('/__t/real?id=' + encodeURIComponent(id))).json();
      let v;
      try { const g = buildGame(data); v = await digest(g, reviewGame(g)); }
      catch (e) { v = 'throws: ' + e.message; }
      real[id] = v;
      if (!TT.cfg.update) { if (!(id in TT.cfg.local)) { out.push({ name: name + ' (no baseline yet)', ok: true }); continue; } eq(v, TT.cfg.local[id], 'analysis output changed:'); }
      out.push({ name, ok: true });
    } catch (e) { out.push({ name, ok: false, error: String(e && e.message || e) }); }
    await tickUi();
  }
  await fetch('/__t/results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tests: out, golden, real, pageErrors: TT.pageErrors, ms: performance.now() - t0 }) });
}
window.addEventListener('load', () => setTimeout(runAll, 50));
