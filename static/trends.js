'use strict';
/* =====================================================================
   Trends: analyses every replay you're in and shows how you play across games —
   accuracy over time, recurring mistakes, weakest phase, champions and roles.
   Per-game summaries are cached in the browser (recomputed when the grading changes).
   ===================================================================== */
/* global S, $, api, esc, store, buildGame, linkReplayPlayers, reviewGame, meIn, champName, fmtTime, openReplay, smoothAt,
   BAD_GRADES, GRADES, ROLE_SHORT, accColor, fmtAcc, clamp, banner */

const TREND_VERSION = 8; // bump when model/review logic changes so cached summaries are rebuilt
const T = { running: false, rows: [], hover: null, stop: false };

const MISTAKE_CATS = [
  { key: 'enemyTerr', label: 'Deaths in enemy-controlled territory', tip: 'Before walking into fog on the enemy side, count how many enemies are missing and ward ahead.' },
  { key: 'isolated', label: 'Deaths with no ally nearby', tip: 'Mid/late game, move with your team or only side-lane when you know where the enemies are.' },
  { key: 'outnumbered', label: 'Deaths while outnumbered', tip: 'Count bodies before committing — fight when your team can join.' },
  { key: 'converted', label: 'Deaths the enemy turned into objectives', tip: 'Around dragon/Baron timers, staying alive is worth more than a kill.' },
  { key: 'aheadDeaths', label: 'Deaths while your team was ahead', tip: 'When ahead, deaths are the only way to give the lead back. Play around vision and let them come to you.' },
  { key: 'absent', label: 'Missed teamfights (alive, far away)', tip: 'Watch the map around objective timers and group before the fight starts.' },
  { key: 'unconverted', label: 'Won fights but took nothing', tip: 'After winning a fight, immediately take the nearest tower/objective.' },
  { key: 'objLost', label: 'Objectives given up for free (team)', tip: 'Be grouped with vision ~60s before objectives spawn, or trade on the other side.' },
  { key: 'badRecall', label: 'Badly timed recalls', tip: 'Recall right after a wave crashes or an objective is taken, not in the minute before a spawn.' },
  { key: 'gold', label: 'Sat on unspent gold', tip: 'Recall when you can complete an item — gold in your pocket does nothing.' },
];

function trendKey(matchId) { return `trend.v${TREND_VERSION}.${matchId}`; }

function summarizeGame(g, review, rp, pid) {
  const p = g.byId[pid]; const s = review.players[pid];
  const acts = review.actions.filter(a => a.pids.includes(pid));
  const deaths = acts.filter(a => a.kind === 'death');
  const tag = (t) => deaths.filter(a => a.tags.some(x => x.startsWith(t))).length;
  const cats = {
    enemyTerr: tag('Enemy territory'), isolated: tag('Isolated'), outnumbered: tag('Outnumbered'), converted: tag('Enemy converted'),
    aheadDeaths: tag('Team was ahead'),
    absent: acts.filter(a => a.kind === 'absent' && a.grade === 'miss').length,
    unconverted: acts.filter(a => a.kind === 'conversion').length,
    objLost: acts.filter(a => a.kind === 'objective-lost' && BAD_GRADES.has(a.grade)).length,
    badRecall: acts.filter(a => a.kind === 'recall' && BAD_GRADES.has(a.grade)).length,
    gold: acts.filter(a => a.kind === 'gold').length,
  };
  const mins = g.duration / 60;
  const cs = (p.final.totalMinionsKilled || 0) + (p.final.neutralMinionsKilled || 0);
  const sign = p.team === 100 ? 1 : -1;
  let inCtrl = 0; const sm = g.smooth.s30; for (let i = 0; i < sm.length; i++) if (sm[i] * sign > 0.08) inCtrl++;
  const lane = acts.find(a => a.kind === 'laning');
  const worst = acts.filter(a => BAD_GRADES.has(a.grade)).sort((a, b) => b.weight * (100 - GRADES[b.grade].score) - a.weight * (100 - GRADES[a.grade].score))[0];
  return {
    v: TREND_VERSION, matchId: g.matchId || rp.matchId, file: rp.file, date: g.info.gameCreation || rp.mtime * 1000,
    champ: p.champ, role: p.role, team: p.team, win: g.winner === p.team, dur: g.duration, source: g.source,
    k: p.kills.length, d: p.deaths.length, a: p.assistsAt.length,
    acc: s.accuracy, phases: Object.fromEntries(s.phases.map(ph => [ph.key, ph.n ? ph.accuracy : null])),
    counts: s.counts, cats, cspm: cs / Math.max(1, mins), vspm: (p.final.visionScore || 0) / Math.max(1, mins),
    ctrlShare: inCtrl / sm.length, laneGrade: lane ? lane.grade : null,
    ctrl15: g.duration > 960 ? smoothAt(g, 's30', 900) * sign : null,
    worst: worst ? { t: worst.t, grade: worst.grade, title: worst.title } : null,
  };
}

async function analyzeAllForTrends(force) {
  if (T.running) return;
  T.running = true; T.stop = false; T.rows = [];
  try { // summaries from older versions of the grading are never read again
    for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (/^lra\.trend\.v\d+\./.test(k) && !k.startsWith('lra.' + trendKey(''))) localStorage.removeItem(k); }
  } catch { /* storage unavailable */ }
  const mine = S.replays.filter(rp => rp.players.length >= 10 && (rp.gameLength || 0) > 10 * 60000 && meIn(rp.players));
  const prog = $('trProgress');
  for (let i = 0; i < mine.length && !T.stop; i++) {
    const rp = mine[i];
    prog.innerHTML = `Analysing game ${i + 1} of ${mine.length}… <span class="muted">${esc(rp.file)}</span>`;
    let row = force ? null : store.get(trendKey(rp.matchId), null);
    if (!row || row.v !== TREND_VERSION) {
      try {
        let data = await api(`/api/match?id=${encodeURIComponent(rp.matchId)}`);
        if (data.error) { row = { error: data.error, matchId: rp.matchId, file: rp.file }; }
        else {
          // same input as the review page, so a game's accuracy here always matches its review
          const live = typeof liveSessionFor === 'function' ? await liveSessionFor(rp.matchId) : null;
          if (live) data = enrichWithLive(data, live);
          const g = buildGame(data); linkReplayPlayers(g, rp);
          const me = meIn(g.ps);
          if (me) { const review = reviewGame(g); row = summarizeGame(g, review, rp, me.id); store.set(trendKey(rp.matchId), row); }
        }
      } catch (e) { row = { error: String(e.message || e), matchId: rp.matchId, file: rp.file }; }
      await new Promise(r => setTimeout(r, 0)); // keep the page responsive
    }
    if (row) T.rows.push(row);
    if (i % 4 === 3) renderTrends();
  }
  T.running = false;
  prog.innerHTML = '';
  renderTrends();
}

function avg(arr) { const v = arr.filter(x => x != null && isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }

function renderTrends() {
  const box = $('trBody'); if (!box) return;
  const rows = T.rows.filter(r => !r.error).sort((a, b) => a.date - b.date);
  const failed = T.rows.filter(r => r.error);
  if (!rows.length) { box.innerHTML = T.running ? '' : '<p class="muted">No games found where you played. Mark yourself with "☆ This is me" in any game first.</p>'; return; }
  const n = rows.length, wins = rows.filter(r => r.win).length;
  const accW = avg(rows.filter(r => r.win).map(r => r.acc)), accL = avg(rows.filter(r => !r.win).map(r => r.acc));
  const ph = ['early', 'mid', 'late'].map(k => ({ k, label: { early: 'Early game', mid: 'Mid game', late: 'Late game' }[k], v: avg(rows.map(r => r.phases[k])) }));
  const weakest = ph.filter(x => x.v != null).sort((a, b) => a.v - b.v)[0];

  // recurring mistakes: per game, all games vs last 10
  const recent = rows.slice(-10), older = rows.slice(0, -10);
  const cats = MISTAKE_CATS.map(c => ({ ...c, rate: avg(rows.map(r => r.cats[c.key])), recent: avg(recent.map(r => r.cats[c.key])), older: older.length >= 5 ? avg(older.map(r => r.cats[c.key])) : null }))
    .sort((a, b) => b.rate - a.rate);
  const maxRate = Math.max(0.5, ...cats.map(c => c.rate));

  const group = keyFn => {
    const m = new Map();
    for (const r of rows) { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return [...m.entries()].map(([k, rs]) => ({ k, n: rs.length, wr: rs.filter(r => r.win).length / rs.length, acc: avg(rs.map(r => r.acc)), deaths: avg(rs.map(r => r.d)) }))
      .sort((a, b) => b.n - a.n || b.acc - a.acc);
  };
  const champs = group(r => r.champ), roles = group(r => r.role || '—');
  const pct = x => (x == null ? '–' : Math.round(x * 100) + '%');
  const focus = cats.filter(c => c.rate >= 0.3).slice(0, 3);

  box.innerHTML = `
    <div class="stat-row">
      <div class="stat"><b>${n}</b><span>games analysed</span></div>
      <div class="stat"><b>${pct(wins / n)}</b><span>win rate (${wins}W ${n - wins}L)</span></div>
      <div class="stat"><b>${fmtAcc(avg(rows.map(r => r.acc)))}</b><span>average accuracy</span></div>
      <div class="stat"><b>${fmtAcc(accW)} / ${fmtAcc(accL)}</b><span>accuracy in wins / losses</span></div>
      <div class="stat"><b>${(avg(rows.map(r => r.d)) || 0).toFixed(1)}</b><span>deaths per game</span></div>
      <div class="stat"><b>${pct(avg(rows.map(r => r.ctrlShare)))}</b><span>of game time your team was favoured to win</span></div>
      ${(() => { const ah = rows.filter(r => r.ctrl15 != null && r.ctrl15 > 0.08), bh = rows.filter(r => r.ctrl15 != null && r.ctrl15 < -0.08);
        return ah.length && bh.length ? `<div class="stat"><b>${pct(ah.filter(r => r.win).length / ah.length)} / ${pct(bh.filter(r => r.win).length / bh.length)}</b><span>win rate when your team was favoured / not favoured at 15:00 (${ah.length} / ${bh.length} games)</span></div>` : ''; })()}
    </div>
    ${focus.length ? `<div class="card-inner"><h4 class="sec" style="margin-top:0">What to work on</h4><ol class="focus">${focus.map(c =>
      `<li><b>${esc(c.label)}</b> — ${c.rate.toFixed(1)} per game. ${esc(c.tip)}</li>`).join('')}</ol></div>` : ''}
    <h4 class="sec">Accuracy by game</h4>
    <div class="tr-legend small muted"><span><i class="dot fill"></i>win</span><span><i class="dot ring"></i>loss</span><span><i class="ln2"></i>5-game average</span><span>click a point to open that game</span></div>
    <div class="tr-chart-wrap"><canvas id="trChart"></canvas><div id="trTip" class="tip hidden"></div></div>
    <div class="tr-grid">
      <div>
        <h4 class="sec">Recurring mistakes <span class="muted small">(per game · last 10 games vs earlier)</span></h4>
        <div class="tr-bars">${cats.map(c => {
          const trend = c.older == null ? '' : c.recent < c.older - 0.15 ? '<span class="tr-down" title="Improving">▼ improving</span>' : c.recent > c.older + 0.15 ? '<span class="tr-up" title="Getting worse">▲ more often</span>' : '<span class="muted">steady</span>';
          return `<div class="tr-bar" title="${esc(c.tip)}"><span>${esc(c.label)}</span><div><i style="width:${c.rate / maxRate * 100}%"></i></div><span class="r">${c.rate.toFixed(1)}</span><span class="small">${trend}</span></div>`;
        }).join('')}</div>
      </div>
      <div>
        <h4 class="sec">By game phase</h4>
        <div class="rv-phases">${ph.map(x => `<div class="tr-phase ${weakest && x.k === weakest.k ? 'weak' : ''}"><span>${x.label}</span><b>${fmtAcc(x.v)}</b>${weakest && x.k === weakest.k ? '<span class="small">weakest</span>' : '<span></span>'}</div>`).join('')}</div>
        <h4 class="sec">By role</h4>
        <table class="tbl"><tr><th>Role</th><th>Games</th><th>Win</th><th>Accuracy</th><th>Deaths</th></tr>${roles.map(r => `<tr><td>${esc(ROLE_SHORT[r.k] || r.k)}</td><td>${r.n}</td><td>${pct(r.wr)}</td><td>${fmtAcc(r.acc)}</td><td>${r.deaths.toFixed(1)}</td></tr>`).join('')}</table>
        <h4 class="sec">By champion</h4>
        <table class="tbl"><tr><th>Champion</th><th>Games</th><th>Win</th><th>Accuracy</th><th>Deaths</th></tr>${champs.slice(0, 10).map(r => `<tr><td><img src="/asset/champ/${encodeURIComponent(r.k)}.png" alt="">${esc(champName(r.k))}</td><td>${r.n}</td><td>${pct(r.wr)}</td><td>${fmtAcc(r.acc)}</td><td>${r.deaths.toFixed(1)}</td></tr>`).join('')}</table>
      </div>
    </div>
    <h4 class="sec">All games</h4>
    <table class="tbl games"><tr><th>Date</th><th>Champion</th><th>Result</th><th>Length</th><th>K/D/A</th><th>Accuracy</th><th>Mistakes</th><th>Biggest mistake</th></tr>
      ${rows.slice().reverse().map(r => `<tr data-open="${esc(r.file)}" title="Open the review for this game">
        <td>${new Date(r.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' })}</td>
        <td><img src="/asset/champ/${encodeURIComponent(r.champ)}.png" alt="">${esc(champName(r.champ))} <span class="muted">${esc(ROLE_SHORT[r.role] || '')}</span></td>
        <td>${r.win ? 'Win' : 'Loss'}</td><td>${fmtTime(r.dur)}</td><td>${r.k}/${r.d}/${r.a}</td><td><b>${fmtAcc(r.acc)}</b></td>
        <td>${(r.counts.mistake || 0) + (r.counts.blunder || 0) + (r.counts.miss || 0)}</td>
        <td class="muted">${r.worst ? `${fmtTime(r.worst.t)} ${esc(r.worst.title)}` : '—'}</td></tr>`).join('')}
    </table>
    ${failed.length ? `<p class="muted small">${failed.length} game(s) couldn't be loaded: ${failed.map(f => esc(f.file)).join(', ')}</p>` : ''}`;
  for (const tr of box.querySelectorAll('[data-open]')) tr.onclick = () => openFromTrends(tr.dataset.open);
  drawTrendChart(rows);
  const cv = $('trChart');
  cv.onmousemove = e => trendHover(e, rows);
  cv.onmouseleave = () => { T.hover = null; $('trTip').classList.add('hidden'); drawTrendChart(rows); };
  cv.onclick = () => { const plotted = rows.filter(r => r.acc != null && isFinite(r.acc)); if (T.hover != null && plotted[T.hover]) openFromTrends(plotted[T.hover].file); };
}

function trGeom() {
  const c = $('trChart'); const dpr = window.devicePixelRatio || 1; const r = c.getBoundingClientRect();
  c.width = Math.max(10, Math.round(r.width * dpr)); c.height = Math.max(10, Math.round(r.height * dpr));
  const l = 44 * dpr, rr = 16 * dpr, t = 12 * dpr, b = 24 * dpr;
  return { c, dpr, W: c.width, H: c.height, l, t, pw: c.width - l - rr, ph: c.height - t - b };
}
function drawTrendChart(allRows) {
  const rows = allRows.filter(r => r.acc != null && isFinite(r.acc));
  const G = trGeom(); const { c, dpr, W, H, l, t, pw, ph } = G; const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  if (!rows.length) return;
  const lo = Math.max(0, Math.floor((Math.min(...rows.map(r => r.acc)) - 5) / 10) * 10), hi = 100;
  const X = i => l + (rows.length === 1 ? pw / 2 : i / (rows.length - 1) * pw);
  const Y = v => t + (1 - (v - lo) / (hi - lo)) * ph;
  ctx.font = `${11 * dpr}px Segoe UI, system-ui, sans-serif`; ctx.textAlign = 'right'; ctx.fillStyle = '#8b96ad'; ctx.lineWidth = 1;
  for (let v = lo; v <= hi; v += 10) {
    ctx.strokeStyle = '#1c2438'; ctx.beginPath(); ctx.moveTo(l, Math.round(Y(v)) + 0.5); ctx.lineTo(l + pw, Math.round(Y(v)) + 0.5); ctx.stroke();
    ctx.fillText(v + '%', l - 8 * dpr, Y(v) + 4 * dpr);
  }
  ctx.textAlign = 'center';
  const step = Math.max(1, Math.ceil(rows.length / 8));
  const span = rows.length > 1 ? rows[rows.length - 1].date - rows[0].date : 0;
  const fmtD = d => new Date(d).toLocaleDateString(undefined, span > 300 * 864e5 ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' });
  let lastLbl = '';
  rows.forEach((r, i) => { if (i % step === 0 || i === rows.length - 1) { const lb = fmtD(r.date); if (lb !== lastLbl) ctx.fillText(lb, X(i), H - 6 * dpr); lastLbl = lb; } });
  // 5-game rolling average (thin line)
  ctx.strokeStyle = '#e8b64c'; ctx.lineWidth = 2 * dpr; ctx.beginPath();
  rows.forEach((r, i) => { const w = rows.slice(Math.max(0, i - 4), i + 1); const v = avg(w.map(x => x.acc)); if (i) ctx.lineTo(X(i), Y(v)); else ctx.moveTo(X(i), Y(v)); });
  ctx.stroke();
  // games: filled = win, ring = loss; 2px surface ring around every mark
  rows.forEach((r, i) => {
    const x = X(i), y = Y(r.acc), R = (T.hover === i ? 6 : 4.5) * dpr;
    ctx.fillStyle = '#121826'; ctx.beginPath(); ctx.arc(x, y, R + 2 * dpr, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, R, 0, 7);
    if (r.win) { ctx.fillStyle = '#3d8bff'; ctx.fill(); } else { ctx.strokeStyle = '#3d8bff'; ctx.lineWidth = 2 * dpr; ctx.stroke(); }
  });
  // direct label: latest rolling average
  const last = avg(rows.slice(-5).map(x => x.acc));
  if (last != null) { ctx.fillStyle = '#e6ebf5'; ctx.textAlign = 'right'; ctx.font = `600 ${11 * dpr}px Segoe UI, system-ui, sans-serif`; ctx.fillText(`recent avg ${last.toFixed(1)}%`, l + pw, Y(last) - 10 * dpr); }
}
function trendHover(e, allRows) {
  const rows = allRows.filter(r => r.acc != null && isFinite(r.acc));
  const G = trGeom(); const r = G.c.getBoundingClientRect(); const mx = (e.clientX - r.left) * G.dpr;
  let best = null, bd = 1e9;
  rows.forEach((row, i) => { const x = G.l + (rows.length === 1 ? G.pw / 2 : i / (rows.length - 1) * G.pw); const d = Math.abs(x - mx); if (d < bd) { bd = d; best = i; } });
  if (bd > 24 * G.dpr) best = null;
  T.hover = best; drawTrendChart(allRows);
  const tip = $('trTip');
  if (best == null) { tip.classList.add('hidden'); G.c.style.cursor = 'default'; return; }
  G.c.style.cursor = 'pointer';
  const row = rows[best];
  tip.innerHTML = `<b>${esc(champName(row.champ))}</b> · ${row.win ? 'Win' : 'Loss'} · ${fmtTime(row.dur)}<br>Accuracy ${fmtAcc(row.acc)} · ${row.k}/${row.d}/${row.a}<br><span class="muted">${new Date(row.date).toLocaleString()}</span>`;
  const wrap = tip.parentElement.getBoundingClientRect();
  tip.style.left = Math.max(0, Math.min(e.clientX - wrap.left + 12, wrap.width - 220)) + 'px'; tip.style.top = '8px';
  tip.classList.remove('hidden');
}

function showTrends(on) {
  $('trends').classList.toggle('hidden', !on);
  $('trendsBtn').classList.toggle('on', on);
  if (on) {
    $('app').classList.add('hidden'); $('welcome').classList.add('hidden'); banner('');
    if ($('live')) { $('live').classList.add('hidden'); $('liveBtn').classList.remove('on'); }
    if (T.running) renderTrends(); else refreshTrends();
  } else {
    T.stop = false;
    if (S.game) $('app').classList.remove('hidden'); else $('welcome').classList.remove('hidden');
  }
}
// replays added while the app is open are picked up without re-analysing the rest (those come from the cache)
async function refreshTrends() {
  await loadReplayList().catch(() => {});
  const have = new Set(T.rows.map(r => r.matchId));
  const missing = S.replays.some(rp => rp.players.length >= 10 && (rp.gameLength || 0) > 10 * 60000 && meIn(rp.players) && !have.has(rp.matchId));
  if (missing || !T.rows.length) analyzeAllForTrends(false); else renderTrends();
}
async function openFromTrends(file) {
  const rp = S.replays.find(r => r.file === file); if (!rp) return;
  showTrends(false); await openReplay(rp); window.scrollTo(0, 0);
}
function wireTrends() {
  $('trendsBtn').onclick = () => showTrends($('trends').classList.contains('hidden'));
  $('trRefresh').onclick = () => analyzeAllForTrends(true);
  window.addEventListener('resize', () => { if (!$('trends').classList.contains('hidden') && T.rows.length) drawTrendChart(T.rows.filter(r => !r.error).sort((a, b) => a.date - b.date)); });
}
wireTrends();
