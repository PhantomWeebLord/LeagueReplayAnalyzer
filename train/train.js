'use strict';
/* =====================================================================
   Training page. Uses the app's own model.js / review.js so the features the model is fitted on are exactly the ones
   the app computes.
   1. Extract: game-state features every 30 s from each downloaded Master+ game, labelled with the winner.
   2. Fit: logistic regression with time-varying coefficients (IRLS / Newton, L2), validated on held-out games.
   3. Calibrate: run the review on high-elo games and record how much win chance each kind of action usually moves,
      so grades are percentiles of real high-elo outcomes.
   4. Validate: held-out high-elo games and your own games.
   ===================================================================== */
/* global buildGame, evalState, WP_FEATS, reviewGame, GRADE_ORDER, GRADES, smoothAt, stateAt */

const TR = (window.TR = { status: 'idle', progress: 0, log: [] });
const $ = id => document.getElementById(id);
function log(...a) { const s = a.join(' '); TR.log.push(s); $('log').textContent += s + '\n'; console.log(s); }
function status(s) { TR.status = s; $('status').textContent = s; }
const J = u => fetch(u).then(r => { if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.json(); });
const save = (name, text) => fetch('/api/save?name=' + encodeURIComponent(name), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text }).then(r => r.json());
// yield to the page without setTimeout (timers are throttled to once a minute in hidden tabs)
const tick = () => new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
const isHoldout = id => { let h = 2166136261; for (const c of id) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) % 5 === 0; };
const KNOTS = [0, 600, 1200, 1800, 2400];
const fmtP = x => (x * 100).toFixed(1) + '%';
const quantiles = (arr, n = 50) => { const s = Float64Array.from(arr).sort(); if (!s.length) return null; return Array.from({ length: n + 1 }, (_, i) => +s[Math.min(s.length - 1, Math.round(i / n * (s.length - 1)))].toFixed(3)); };

// ---------------------------------------------------------------- 1. extract
async function extract() {
  const ids = await J('/api/list');
  log(`Extracting features from ${ids.length} downloaded games…`);
  const D = { ids: [], rows: [], skipped: 0, patches: {}, roles: {}, hasWardsGames: 0 };
  const t0 = performance.now();
  for (let i = 0; i < ids.length; i++) {
    let g;
    try { g = buildGame(await J('/api/game?id=' + ids[i]), { light: true, noModel: true }); } catch (e) { D.skipped++; continue; }
    if (!g.winner || g.duration < 600) { D.skipped++; continue; }
    const gi = D.ids.length; D.ids.push(ids[i]);
    if (g.hasWards) D.hasWardsGames++;
    const pv = String(g.info.gameVersion || '').split('.').slice(0, 2).join('.'); D.patches[pv] = (D.patches[pv] || 0) + 1;
    const y = g.winner === 100 ? 1 : 0, hold = isHoldout(ids[i]);
    // Sample only at Riot's minute snapshots. Between them gold, XP and positions are interpolated towards the NEXT
    // snapshot, so a sample there would quietly know up to a minute of the future.
    for (const t of g.ft) {
      if (t < 60 || t > g.duration - 10) continue;
      const st = evalState(g, t);
      D.rows.push({ g: gi, t, y, hold, f: Float32Array.from(WP_FEATS, k => st.f[k]), legacy: st.legacy });
    }
    const mins = g.duration / 60;
    if (g.duration >= 900) for (const p of g.ps) {
      if (!p.role) continue;
      const R = (D.roles[p.role] = D.roles[p.role] || { cpm: [], vpm: [], cw: [] });
      R.cpm.push(((p.final.totalMinionsKilled || 0) + (p.final.neutralMinionsKilled || 0)) / mins);
      R.vpm.push((p.final.visionScore || 0) / mins);
      R.cw.push(p.final.visionWardsBoughtInGame || 0);
    }
    if (i % 10 === 0) { status(`extract ${i + 1}/${ids.length} · ${D.rows.length} samples · ${((performance.now() - t0) / 1000).toFixed(0)}s`); TR.progress = i / ids.length; await tick(); }
  }
  log(`  ${D.ids.length} games used (${D.skipped} skipped), ${D.rows.length} samples, ${((performance.now() - t0) / 1000).toFixed(0)} s. Patches: ${Object.entries(D.patches).sort().map(([k, v]) => `${k}×${v}`).join(', ')}`);
  return D;
}

// ---------------------------------------------------------------- 2. fit
// design: feature f at knot k contributes w_k(t)·x_f; at most two knots are non-zero for any t
function rowX(r, featIdx) {
  const n = KNOTS.length, idx = [], val = [];
  let k0 = 0, f = 0;
  if (r.t >= KNOTS[n - 1]) { k0 = n - 1; f = 0; } else { while (k0 + 1 < n && r.t >= KNOTS[k0 + 1]) k0++; f = (r.t - KNOTS[k0]) / (KNOTS[k0 + 1] - KNOTS[k0]); }
  featIdx.forEach((fi, j) => {
    const x = fi < 0 ? r.legacy : r.f[fi];
    if (!x) return;
    idx.push(j * n + k0); val.push(x * (1 - f));
    if (f > 0) { idx.push(j * n + k0 + 1); val.push(x * f); }
  });
  return [idx, val];
}
function cholSolve(H, g, P) { // H (P×P, row-major, SPD) · x = g
  const L = new Float64Array(P * P);
  for (let i = 0; i < P; i++) for (let j = 0; j <= i; j++) {
    let s = H[i * P + j]; for (let k = 0; k < j; k++) s -= L[i * P + k] * L[j * P + k];
    L[i * P + j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j * P + j];
  }
  const y = new Float64Array(P);
  for (let i = 0; i < P; i++) { let s = g[i]; for (let k = 0; k < i; k++) s -= L[i * P + k] * y[k]; y[i] = s / L[i * P + i]; }
  const x = new Float64Array(P);
  for (let i = P - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < P; k++) s -= L[k * P + i] * x[k]; x[i] = s / L[i * P + i]; }
  return x;
}
// Penalised logistic regression (Newton / IRLS):
//  - L2 ridge (lambda) and a smoothness penalty between neighbouring time knots of the same feature (smooth)
//  - every coefficient >= 0: all features point towards Blue, so more gold / towers / drakes can never lower Blue's
//    chance. Enforced with an active set (coefficients that want to go negative are pinned at 0).
// rare events get one weight for all game times (a very stiff smoothness penalty) instead of one per knot
const RARE = new Set(['towerBase', 'towerNexus', 'inhib', 'soul', 'elder', 'baron', 'herald', 'grubs']);
const smoothMulFor = featIdx => featIdx.map(fi => (fi >= 0 && RARE.has(WP_FEATS[fi]) ? 200 : 1));
function fitLogit(rows, featIdx, lambda = 2, smooth = 40, iters = 30, nonneg = true) {
  const sMul = smoothMulFor(featIdx);
  const nK = KNOTS.length, P = featIdx.length * nK;
  const X = rows.map(r => rowX(r, featIdx));
  const b = new Float64Array(P), fixed = new Uint8Array(P);
  const gradAndHess = withH => {
    const H = withH ? new Float64Array(P * P) : null, g = new Float64Array(P);
    for (let i = 0; i < P; i++) { if (H) H[i * P + i] = lambda; g[i] = -lambda * b[i]; }
    for (let j = 0; j < featIdx.length; j++) for (let k = 0; k + 1 < nK; k++) {
      const a = j * nK + k, c = a + 1, diff = b[c] - b[a], sm = smooth * sMul[j];
      g[a] += sm * diff; g[c] -= sm * diff;
      if (H) { H[a * P + a] += sm; H[c * P + c] += sm; H[a * P + c] -= sm; H[c * P + a] -= sm; }
    }
    for (let r = 0; r < rows.length; r++) {
      const [idx, val] = X[r]; let z = 0;
      for (let a = 0; a < idx.length; a++) z += b[idx[a]] * val[a];
      const p = 1 / (1 + Math.exp(-z)), w = Math.max(p * (1 - p), 1e-6), e = rows[r].y - p;
      for (let a = 0; a < idx.length; a++) {
        g[idx[a]] += e * val[a];
        if (!H) continue;
        const ia = idx[a] * P, va = w * val[a];
        for (let c = 0; c < idx.length; c++) H[ia + idx[c]] += va * val[c];
      }
    }
    return { H, g };
  };
  for (let outer = 0; outer < 20; outer++) {
    for (let it = 0; it < iters; it++) {
      const { H, g } = gradAndHess(true);
      for (let i = 0; i < P; i++) if (fixed[i]) { for (let c = 0; c < P; c++) { H[i * P + c] = 0; H[c * P + i] = 0; } H[i * P + i] = 1; g[i] = 0; }
      const d = cholSolve(H, g, P);
      let mx = 0; for (let i = 0; i < P; i++) { b[i] += d[i]; mx = Math.max(mx, Math.abs(d[i])); }
      if (mx < 1e-6) break;
    }
    let changed = false;
    if (nonneg) for (let i = 0; i < P; i++) if (!fixed[i] && b[i] < 0) { fixed[i] = 1; b[i] = 0; changed = true; }
    if (!changed) { // release pinned coefficients whose gradient now points upwards
      const { g } = gradAndHess(false);
      for (let i = 0; i < P; i++) if (fixed[i] && g[i] > 1e-4) { fixed[i] = 0; changed = true; }
    }
    if (!changed) break;
  }
  return b;
}
function predictRows(rows, featIdx, b) { return rows.map(r => { const [idx, val] = rowX(r, featIdx); let z = 0; for (let a = 0; a < idx.length; a++) z += b[idx[a]] * val[a]; return 1 / (1 + Math.exp(-z)); }); }
function metrics(rows, p) {
  let ll = 0, br = 0, acc = 0, n = rows.length;
  const buckets = [[60, 600], [600, 900], [900, 1200], [1200, 1500], [1500, 1800], [1800, 2400], [2400, 1e9]].map(([a, b]) => ({ a, b, n: 0, acc: 0, ll: 0 }));
  const cal = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
  rows.forEach((r, i) => {
    const q = Math.min(1 - 1e-9, Math.max(1e-9, p[i]));
    const l = -(r.y * Math.log(q) + (1 - r.y) * Math.log(1 - q)); ll += l; br += (q - r.y) ** 2;
    const ok = (q > 0.5) === (r.y === 1) || q === 0.5 ? 1 : 0; acc += ok;
    const bk = buckets.find(x => r.t >= x.a && r.t < x.b); if (bk) { bk.n++; bk.acc += ok; bk.ll += l; }
    const c = cal[Math.min(9, Math.floor(q * 10))]; c.n++; c.p += q; c.y += r.y;
  });
  return { n, logloss: ll / n, brier: br / n, accuracy: acc / n,
    byTime: buckets.filter(x => x.n).map(x => ({ from: x.a, to: x.b, n: x.n, accuracy: x.acc / x.n, logloss: x.ll / x.n })),
    calibration: cal.filter(c => c.n).map(c => ({ n: c.n, predicted: c.p / c.n, actual: c.y / c.n })) };
}
// choose the ridge / smoothness strength by cross-validation over games (samples from one game share a label, so
// the number of independent outcomes is the number of games, not samples)
async function cvSelect(rows, featIdx, grid, folds = 3) {
  let best = null; const res = [];
  for (const [lam, sm] of grid) {
    let ll = 0, n = 0;
    for (let k = 0; k < folds; k++) {
      const tr = rows.filter(r => r.g % folds !== k), te = rows.filter(r => r.g % folds === k);
      const b = fitLogit(tr, featIdx, lam, sm);
      const p = predictRows(te, featIdx, b);
      te.forEach((r, i) => { const q = Math.min(1 - 1e-9, Math.max(1e-9, p[i])); ll -= r.y * Math.log(q) + (1 - r.y) * Math.log(1 - q); n++; });
      await tick();
    }
    ll /= n; res.push({ lam, sm, ll: +ll.toFixed(5) });
    status(`cross-validating ridge ${lam}, smooth ${sm}: ${ll.toFixed(4)}`);
    if (!best || ll < best.ll) best = { lam, sm, ll };
  }
  return { best, res };
}
function coefObj(feats, b) { const o = {}; feats.forEach((k, j) => (o[k] = Array.from(b.slice(j * KNOTS.length, (j + 1) * KNOTS.length), v => +v.toFixed(5)))); return o; }

async function fit(D) {
  const train = D.rows.filter(r => !r.hold), test = D.rows.filter(r => r.hold);
  log(`Fitting on ${train.length} samples from ${new Set(train.map(r => r.g)).size} games; ${test.length} held-out samples from ${new Set(test.map(r => r.g)).size} games.`);
  const fi = ks => ks.map(k => (k === 'legacy' ? -1 : WP_FEATS.indexOf(k)));
  const specs = {
    full: WP_FEATS,
    noVision: WP_FEATS.filter(k => k !== 'vision'),
    goldOnly: ['gold'],
    legacyControl: ['legacy'],
  };
  const grid = [[1, 30], [3, 100], [10, 300], [30, 1000], [100, 3000], [300, 10000], [1000, 30000]];
  const cv = await cvSelect(train, fi(specs.full), grid);
  log('  cross-validation (log loss): ' + cv.res.map(r => `ridge ${r.lam}/smooth ${r.sm}: ${r.ll}`).join(' · ') + ` → using ridge ${cv.best.lam}, smooth ${cv.best.sm}`);
  const REG = { full: cv.best, noVision: cv.best, goldOnly: { lam: 2, sm: 40 }, legacyControl: { lam: 2, sm: 40 } };
  const out = {}; const res = {};
  for (const [name, feats] of Object.entries(specs)) {
    status(`fitting ${name}…`); await tick();
    const t0 = performance.now();
    const b = fitLogit(train, fi(feats), REG[name].lam, REG[name].sm);
    const m = metrics(test, predictRows(test, fi(feats), b));
    out[name] = { feats, b }; res[name] = m;
    log(`  ${name.padEnd(14)} held-out accuracy ${fmtP(m.accuracy)} · log loss ${m.logloss.toFixed(4)} · Brier ${m.brier.toFixed(4)} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  }
  log('  by game time (full model): ' + res.full.byTime.map(x => `${Math.round(x.from / 60)}–${x.to > 1e8 ? '' : Math.round(x.to / 60)}m ${fmtP(x.accuracy)}`).join(' · '));
  log('  by game time (old hand-set score): ' + res.legacyControl.byTime.map(x => `${Math.round(x.from / 60)}–${x.to > 1e8 ? '' : Math.round(x.to / 60)}m ${fmtP(x.accuracy)}`).join(' · '));
  log('  calibration (predicted → actual): ' + res.full.calibration.map(c => `${fmtP(c.predicted)}→${fmtP(c.actual)}`).join(', '));
  // The shipped model is the one fitted on the training split, so every "games it never saw" number below is true of it.
  const final = {};
  for (const name of ['full', 'noVision']) final[name] = { knots: KNOTS, feats: specs[name], coef: coefObj(specs[name], out[name].b) };
  const benchmarks = {};
  for (const [r, v] of Object.entries(D.roles)) benchmarks[r] = { n: v.cpm.length, cpm: quantiles(v.cpm, 20), vpm: quantiles(v.vpm, 20), cw: quantiles(v.cw, 20) };
  const model = {
    version: 1, trainedAt: new Date().toISOString().slice(0, 10), games: new Set(train.map(r => r.g)).size, gamesDownloaded: D.ids.length, samples: train.length, regularization: { ridge: cv.best.lam, smooth: cv.best.sm },
    source: 'Ranked solo/duo games of Challenger, Grandmaster and Master players (NA), Riot Match-V5 API',
    patches: Object.keys(D.patches).sort(), full: final.full, noVision: final.noVision,
    metrics: { heldOutGames: new Set(test.map(r => r.g)).size, full: res.full, noVision: res.noVision, goldOnly: res.goldOnly, legacyControl: res.legacyControl },
    benchmarks, norms: (window.WP_MODEL && window.WP_MODEL.norms) || null,
  };
  return model;
}
async function writeModel(model) {
  const txt = '// Generated by train/train.html — win-probability model fitted on high-elo games. Do not edit by hand.\nwindow.WP_MODEL = ' + JSON.stringify(model) + ';\n';
  const r = await save('wp_model.js', txt);
  log(`Saved ${r.saved} (${(r.bytes / 1024).toFixed(0)} KB).`);
  window.WP_MODEL = model;
}

async function runFit() {
  try {
    const D = await extract();
    TR.D = D;
    const model = await fit(D);
    await writeModel(model);
    TR.model = model;
    status('fit done');
  } catch (e) { log('ERROR ' + e.stack); status('error'); }
}

// ---------------------------------------------------------------- 3. calibrate grades
async function ensureModel() {
  if (window.WP_MODEL) return window.WP_MODEL;
  await new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/static/wp_model.js?' + Date.now(); s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  if (!window.WP_MODEL) throw new Error('no wp_model.js — run the fit first');
  return window.WP_MODEL;
}
const trimmedMean = xs => { const s = xs.slice().sort((a, b) => a - b), k = Math.floor(s.length * 0.1), m = s.slice(k, s.length - k); return m.reduce((a, b) => a + b, 0) / (m.length || 1); };
// average win-chance gain over the 90 s after each kind of epic monster, in 5-minute bins of game time
function buildObjTable(list) {
  const byKey = {}; for (const x of list) (byKey[x.obj] = byKey[x.obj] || []).push(x);
  const out = {};
  for (const [k, arr] of Object.entries(byKey)) {
    const bins = [];
    for (let a = 0; a < 2700; a += 300) {
      const xs = arr.filter(x => x.t >= a && (a + 300 >= 2700 ? true : x.t < a + 300));
      if (xs.length >= 12) bins.push([Math.round(xs.reduce((s, x) => s + x.t, 0) / xs.length), +trimmedMean(xs.map(x => x.v)).toFixed(2), xs.length]);
    }
    if (!bins.length && arr.length >= 8) bins.push([Math.round(arr.reduce((s, x) => s + x.t, 0) / arr.length), +trimmedMean(arr.map(x => x.v)).toFixed(2), arr.length]);
    if (bins.length) out[k] = bins;
  }
  return out;
}
async function reviewPass(ids, label) {
  const vals = {}; let n = 0; const t0 = performance.now();
  for (let i = 0; i < ids.length; i++) {
    let g; try { g = buildGame(await J('/api/game?id=' + ids[i])); } catch (e) { continue; }
    window.REVIEW_COLLECT = [];
    try { reviewGame(g); } catch (e) { log('review error ' + ids[i] + ': ' + e.message); continue; }
    for (const c of window.REVIEW_COLLECT) (vals[c.key] = vals[c.key] || []).push(c);
    n++;
    if (i % 5 === 0) { status(`${label} ${i + 1}/${ids.length} · ${((performance.now() - t0) / 1000).toFixed(0)}s`); await tick(); }
  }
  window.REVIEW_COLLECT = null;
  return { vals, n };
}
async function runNorms(maxGames = 6000) {
  try {
    const model = await ensureModel();
    const ids = (await J('/api/list')).filter(id => !isHoldout(id));
    const pick = ids.length > maxGames ? ids.filter((_, i) => i % Math.ceil(ids.length / maxGames) === 0) : ids;
    // pass 1: what each epic monster is worth over the following 90 s
    const sub = pick.filter((_, i) => i % 2 === 1).slice(0, 3000);
    log(`Valuing epic monsters on ${sub.length} high-elo games…`);
    model.norms = null;
    const p1 = await reviewPass(sub, 'objective values');
    const objValue = buildObjTable(p1.vals.objTotal || []);
    for (const [k, bins] of Object.entries(objValue)) log(`  ${k.padEnd(13)} ` + bins.map(b => `${Math.round(b[0] / 60)}m ${b[1] >= 0 ? '+' : ''}${b[1]}% (n=${b[2]})`).join(' · '));
    model.norms = { objValue };
    // pass 2: distributions of every graded measurement
    log(`Calibrating grades on ${pick.length} high-elo games (training split)…`);
    const p2 = await reviewPass(pick, 'calibrate');
    const norms = { objValue }; const summary = {};
    for (const [k, list] of Object.entries(p2.vals)) {
      if (k === 'objTotal') continue;
      const v = list.map(c => c.v);
      norms[k] = quantiles(v, 50);
      const q = norms[k]; summary[k] = { n: v.length, p25: q[12], median: q[25], p60: q[30], p85: q[42], p95: q[47] };
      log(`  ${k.padEnd(10)} n=${v.length}  median ${q[25]}  p60 ${q[30]}  p85 ${q[42]}  p95 ${q[47]}  max ${q[50]}`);
    }
    model.norms = norms; model.normsGames = p2.n;
    await writeModel(model);
    await save('norms_summary.json', JSON.stringify({ summary, objValue }, null, 1));
    log(`Calibrated on ${p2.n} games.`);
    status('calibration done');
  } catch (e) { log('ERROR ' + e.stack); status('error'); }
}

// ---------------------------------------------------------------- 4. validate
function teamAccStats(rows) { // rows: {win, acc}
  const w = rows.filter(r => r.win).map(r => r.acc), l = rows.filter(r => !r.win).map(r => r.acc);
  const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  return { winners: +mean(w).toFixed(1), losers: +mean(l).toFixed(1), n: rows.length };
}
async function runValidate(maxGames = 2000) {
  try {
    await ensureModel();
    const report = { highElo: {}, user: {} };
    // held-out high-elo games: does the side that played more accurately win?
    const ids = (await J('/api/list')).filter(isHoldout).slice(0, maxGames);
    log(`Validating on ${ids.length} held-out high-elo games…`);
    const teamRows = [], gradeCount = {}; let higherWins = 0, games = 0;
    for (let i = 0; i < ids.length; i++) {
      let g, R; try { g = buildGame(await J('/api/game?id=' + ids[i])); R = reviewGame(g); } catch (e) { continue; }
      if (!g.winner) continue;
      games++;
      for (const team of [100, 200]) teamRows.push({ win: g.winner === team, acc: R.teams[team].accuracy });
      if ((R.teams[g.winner].accuracy || 0) > (R.teams[g.winner === 100 ? 200 : 100].accuracy || 0)) higherWins++;
      for (const a of R.actions) { const k = a.kind; gradeCount[k] = gradeCount[k] || {}; gradeCount[k][a.grade] = (gradeCount[k][a.grade] || 0) + 1; }
      if (i % 5 === 0) { status(`validate ${i + 1}/${ids.length}`); await tick(); }
    }
    report.highElo = { games, teamAccuracy: teamAccStats(teamRows), moreAccurateTeamWon: higherWins / games, grades: gradeCount };
    log(`  team accuracy: winners ${report.highElo.teamAccuracy.winners}, losers ${report.highElo.teamAccuracy.losers}; the more accurate team won ${fmtP(report.highElo.moreAccurateTeamWon)} of games`);
    for (const k of ['death', 'fight', 'objective-lost', 'conversion', 'laning']) if (gradeCount[k]) {
      const c = gradeCount[k], tot = Object.values(c).reduce((a, b) => a + b, 0);
      log(`  ${k.padEnd(15)} ` + GRADE_ORDER.filter(x => c[x]).map(x => `${x} ${Math.round(c[x] / tot * 100)}%`).join(' · '));
    }

    // your games
    const uids = await J('/api/user-list');
    const cfg = await J('/api/config').catch(() => ({})); // optional "myNames": ["name"] in config.json
    const myNames = new Set((cfg.myNames || []).map(n => String(n).toLowerCase()));
    log(`Your ${uids.length} cached games…`);
    let corr = 0, corrLegacy = 0, samples = 0; const meRows = [], uTeam = [], uGrades = {};
    for (const id of uids) {
      let g, R; try { g = buildGame(await J('/api/user-game?id=' + id)); R = reviewGame(g); } catch (e) { log('  skip ' + id + ': ' + e.message); continue; }
      if (!g.winner) continue;
      for (let t = 60; t < g.duration; t += 60) {
        const st = stateAt(g, t); samples++;
        if ((st.wp > 0.5) === (g.winner === 100)) corr++;
        if ((st.legacy > 0) === (g.winner === 100)) corrLegacy++;
      }
      for (const team of [100, 200]) uTeam.push({ win: g.winner === team, acc: R.teams[team].accuracy });
      const me = g.ps.find(p => myNames.has(String(p.name).toLowerCase()));
      if (me && R.players[me.id].accuracy != null) meRows.push({ win: g.winner === me.team, acc: R.players[me.id].accuracy });
      for (const a of R.actions) if (me && a.pids.includes(me.id)) uGrades[a.grade] = (uGrades[a.grade] || 0) + 1;
      await tick();
    }
    report.user = { games: uTeam.length / 2, winnerCalledMinuteByMinute: corr / samples, legacyWinnerCalled: corrLegacy / samples,
      teamAccuracy: teamAccStats(uTeam), you: teamAccStats(meRows), yourGrades: uGrades };
    log(`  win chance called the winner ${fmtP(corr / samples)} of minutes (old score: ${fmtP(corrLegacy / samples)})`);
    log(`  team accuracy: winners ${report.user.teamAccuracy.winners}, losers ${report.user.teamAccuracy.losers}`);
    log(`  your accuracy: wins ${report.user.you.winners}, losses ${report.user.you.losers} (${meRows.length} games)`);
    log('  your grades: ' + GRADE_ORDER.filter(x => uGrades[x]).map(x => `${x} ${uGrades[x]}`).join(' · '));
    await save('validation.json', JSON.stringify(report, null, 1));
    const model = window.WP_MODEL; model.validation = { highElo: { games, teamAccuracy: report.highElo.teamAccuracy, moreAccurateTeamWon: report.highElo.moreAccurateTeamWon },
      user: { games: report.user.games, winnerCalled: report.user.winnerCalledMinuteByMinute, legacyWinnerCalled: report.user.legacyWinnerCalled } };
    await writeModel(model);
    status('validation done');
  } catch (e) { log('ERROR ' + e.stack); status('error'); }
}
Object.assign(window, { runFit, runNorms, runValidate, fitLogit, predictRows, metrics, coefObj, KNOTS });

$('bFit').onclick = runFit;
$('bNorms').onclick = () => runNorms();
$('bVal').onclick = () => runValidate();
$('bAll').onclick = async () => { await runFit(); await runNorms(); await runValidate(); };
if (location.hash === '#all') $('bAll').onclick();
