'use strict';
/* =====================================================================
   Live coach
   - Before a game: your personal focus card (from your past games) + your history on the champion you lock in.
   - During a game: a calm panel with only your own stats vs. the goals you set before the game.
     No real-time advice: Riot does not allow apps to dictate player decisions mid-game.
   - When the game ends: the full debrief opens automatically, enriched with the live recording.
   - While watching a replay in League: the review follows the replay and coaches each graded moment.
   ===================================================================== */
/* global S, $, api, esc, store, banner, openReplay, renderMoves, drawChart, seek, updatePlayBtn, champName, fmtTime, clamp,
   T, analyzeAllForTrends, MISTAKE_CATS, ROLE_SHORT, GRADES, BAD_GRADES, fmtAcc, chip, showTrends */

const LV = {
  state: null, timer: null, gt: null, gtAt: 0, prevGt: null, speed: 1, paused: false,
  sessions: [], sessionCache: {}, debrief: null, debriefTries: 0, playbackOk: false, playbackAt: 0,
  sig: '', followMatch: null,
};

const liveVisible = () => !$('live').classList.contains('hidden');
const avgOf = avg;
const LIVE_POLL_FAST_MS = 1000, LIVE_POLL_SLOW_MS = 4000;
const DEBRIEF_RETRY_MS = 10000, DEBRIEF_MAX_TRIES = 90; // Riot can take a few minutes to publish a match

async function loadLiveSessions() {
  try { const s = await api('/api/live/sessions'); LV.sessions = Array.isArray(s) ? s : []; } catch { LV.sessions = []; }
  return LV.sessions;
}
async function liveSessionFor(matchId) {
  if (!matchId) return null;
  const s = LV.sessions.find(x => x.matchId === matchId && x.snaps > 10);
  if (!s) return null;
  if (!LV.sessionCache[s.id]) {
    try { const full = await api('/api/live/session?id=' + encodeURIComponent(s.id)); if (full && !full.error) LV.sessionCache[s.id] = full; } catch { /* ignore */ }
  }
  return LV.sessionCache[s.id] || null;
}

// ---------------------------------------------------------------- focus plan (from your past games only)
function focusPlan(champId, role) {
  const rows = (T.rows || []).filter(r => !r.error);
  if (!rows.length) return null;
  const cats = MISTAKE_CATS.map(c => ({ ...c, rate: avgOf(rows.map(r => r.cats[c.key])) }))
    .filter(c => c.rate >= 0.3).sort((a, b) => b.rate - a.rate).slice(0, 3);
  const deaths = avgOf(rows.map(r => r.d)), vspm = avgOf(rows.map(r => r.vspm));
  const sup = role === 'UTILITY';
  const cspm = sup ? null : avgOf(rows.filter(r => r.role === (role || r.role) && r.role !== 'UTILITY').map(r => r.cspm));
  const goals = [
    { key: 'deaths', label: 'Deaths', target: Math.max(2, Math.round(deaths - 1)), better: 'low', unit: '' },
    cspm ? { key: 'cspm', label: 'CS per minute', target: Math.round((cspm + 0.3) * 10) / 10, better: 'high' } : null,
    vspm ? { key: 'vspm', label: 'Vision score per minute', target: Math.round((vspm + 0.1) * 100) / 100, better: 'high' } : null,
  ].filter(Boolean);
  let champ = null;
  if (champId) {
    const cr = rows.filter(r => String(r.champ).toLowerCase() === String(champId).toLowerCase());
    if (cr.length) {
      const top = MISTAKE_CATS.map(c => ({ ...c, rate: avgOf(cr.map(r => r.cats[c.key])) })).sort((a, b) => b.rate - a.rate)[0];
      champ = { id: champId, n: cr.length, wr: cr.filter(r => r.win).length / cr.length, acc: avgOf(cr.map(r => r.acc)), deaths: avgOf(cr.map(r => r.d)), top };
    } else champ = { id: champId, n: 0 };
  }
  return { cats, goals, champ, n: rows.length };
}
function goalValue(goal, row, minutes) {
  if (!row) return null;
  if (goal.key === 'deaths') return row[2];
  if (goal.key === 'cspm') return minutes >= 3 ? row[4] / minutes : null;
  if (goal.key === 'vspm') return minutes >= 3 ? row[5] / minutes : null;
  return null;
}
const goalMet = (g, v) => v == null ? null : g.better === 'low' ? v <= g.target : v >= g.target;
const fmtGoal = (g, v) => v == null ? '—' : g.key === 'deaths' ? String(v) : v.toFixed(g.key === 'vspm' ? 2 : 1);
const goalTxt = g => `${g.label} ${g.better === 'low' ? '≤' : '≥'} ${g.key === 'deaths' ? g.target : g.target.toFixed(g.key === 'vspm' ? 2 : 1)}`;

// ---------------------------------------------------------------- polling & transitions
async function livePoll() {
  clearTimeout(LV.timer);
  const gen = (LV.pollGen = (LV.pollGen || 0) + 1); // a newer poll replaces this one, or each Live click adds another loop
  let fresh = null;
  try { fresh = await api('/api/live/state'); } catch { fresh = null; }
  if (gen !== LV.pollGen) return;
  LV.state = fresh;
  const st = LV.state;
  const s = st && st.session;
  const now = performance.now();
  if (s && st.status === 'spectate') {
    if (LV.gt != null && Math.abs(s.gameTime - LV.prevGt) < 0.05 && now - LV.gtAt > 1500) LV.paused = true;
    else if (LV.prevGt == null || s.gameTime !== LV.prevGt) LV.paused = false;
    LV.prevGt = s.gameTime; LV.gt = s.gameTime; LV.gtAt = now;
    if (now - LV.playbackAt > 4000) {
      LV.playbackAt = now;
      api('/api/replay/playback').then(p => { LV.playbackOk = !!(p && !p.error); if (LV.playbackOk) { LV.speed = p.speed || 1; LV.paused = !!p.paused; } }).catch(() => (LV.playbackOk = false));
    }
    if (s.matchId) followReplay(s.matchId);
  } else if (S.follow) {
    S.follow = false; updateFollowChip();
  }
  if (s && s.mode === 'play' && s.ended) maybeDebrief(s);
  if (liveVisible()) renderLive();
  const fast = liveVisible() || S.follow || (st && st.status === 'spectate');
  LV.timer = setTimeout(livePoll, fast ? LIVE_POLL_FAST_MS : LIVE_POLL_SLOW_MS);
}

async function followReplay(matchId) {
  if (S.game && S.game.matchId === matchId) {
    if (LV.followMatch !== matchId) { LV.followMatch = matchId; LV.followStopped = false; }
    if (!S.follow && !LV.followStopped) { S.follow = true; S.playing = false; updatePlayBtn(); updateFollowChip(); }
    return;
  }
  if (LV.followMatch === matchId) return; // loading
  LV.followMatch = matchId; LV.followStopped = false;
  // the replay list may not have loaded yet (app just opened): without it the players can't be linked to you
  if (!S.replays.some(r => r.matchId === matchId)) await loadReplayList().catch(() => {});
  const meta = S.replays.find(r => r.matchId === matchId) || { matchId, file: 'Replay', players: [] };
  banner('Replay detected in League — following along.');
  setTimeout(() => banner(''), 3000);
  await openReplay(meta);
  if (S.game) { S.follow = true; S.playing = false; updatePlayBtn(); updateFollowChip(); }
}
function updateFollowChip() {
  const c = $('followChip'); if (!c) return;
  c.classList.toggle('hidden', !S.follow || (typeof RS !== 'undefined' && RS.view === 'replay'));
}

// reads the list when writing: two games can be waiting for their match data at the same time
function markDebriefed(id) {
  const done = store.get('debriefed', []);
  if (!done.includes(id)) store.set('debriefed', [...done, id].slice(-50));
}

async function maybeDebrief(s) {
  const done = store.get('debriefed', []);
  if (done.includes(s.id) || LV.debrief === s.id || (LV.gaveUp || []).includes(s.id)) return;
  LV.debrief = s.id; LV.debriefTries = 0;
  banner('Game over — preparing your debrief…');
  const attempt = async () => {
    LV.debriefTries++;
    const cur = LV.state && LV.state.session && LV.state.session.id === s.id ? LV.state.session : s;
    if (!cur.ended) { LV.debrief = null; banner(''); return; } // the game came back after a freeze or reconnect
    if (cur.matchId) {
      const data = await api('/api/match?id=' + encodeURIComponent(cur.matchId)).catch(() => ({ error: 'offline' }));
      if (!data.error) {
        await loadLiveSessions();
        markDebriefed(s.id);
        LV.debrief = null;
        await openDebrief(cur);
        return;
      }
    }
    if (LV.debriefTries < DEBRIEF_MAX_TRIES) setTimeout(attempt, DEBRIEF_RETRY_MS);
    else { LV.debrief = null; LV.gaveUp = [...(LV.gaveUp || []), s.id]; banner('Match data for your last game is not available yet — open it later from Live → Recorded games.', true); }
    if (liveVisible()) renderLive();
  };
  attempt();
}

async function openDebrief(sess) {
  const full = LV.sessionCache[sess.id] || await api('/api/live/session?id=' + encodeURIComponent(sess.id)).catch(() => null);
  if (full && !full.error) LV.sessionCache[sess.id] = full;
  const lp = (full && full.players) || sess.players || [];
  const me = full && full.me != null ? lp[full.me] : null;
  const meta = S.replays.find(r => r.matchId === sess.matchId) || {
    matchId: sess.matchId, file: 'Live game',
    players: lp.map(p => ({ name: p.name, tag: p.tag, team: p.team, champion: p.championId, puuid: me && p === me ? S.clientPuuid : null })),
  };
  banner('');
  S.tab = 'review';
  await openReplay(meta);
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- rendering
function liveStatusText(st) {
  if (!st) return 'App offline';
  if (st.status === 'disabled') return 'Live recording is turned off';
  if (st.status === 'play') return st.session && st.session.ended ? 'Game over' : 'In game — recording';
  if (st.status === 'spectate') return 'Watching a replay';
  return ({ ChampSelect: 'Champion select', Lobby: 'In lobby', Matchmaking: 'In queue', ReadyCheck: 'Match found', InProgress: 'Game starting…',
    EndOfGame: 'Post-game', WaitingForStats: 'Post-game', PreEndOfGame: 'Post-game' })[st.phase] || (st.phase ? 'Waiting for your next game' : 'League client closed — waiting');
}

function renderFocus(plan, champHtml) {
  if (!plan) return `<div class="card-inner"><h4 class="sec" style="margin-top:0">Focus for your next game</h4>
    <p class="muted">${T.running ? 'Analysing your past games…' : 'Open a few of your replays (or the Trends page) so the coach can learn your habits.'}</p></div>`;
  return `<div class="lv-grid">
    <div class="card-inner"><h4 class="sec" style="margin-top:0">Focus for this game <span class="muted small">from your last ${plan.n} games</span></h4>
      ${plan.cats.length ? `<ol class="focus">${plan.cats.map(c => `<li><b>${esc(c.label)}</b> (${c.rate.toFixed(1)} per game). ${esc(c.tip)}</li>`).join('')}</ol>` : '<p class="muted">No recurring mistakes stand out — keep it up.</p>'}
      <h4 class="sec">Goals</h4><div class="chips">${plan.goals.map(g => chip(goalTxt(g))).join('')}</div></div>
    <div class="card-inner">${champHtml}</div></div>`;
}
function champCard(plan, champId) {
  if (!champId) return `<h4 class="sec" style="margin-top:0">Your champion</h4><p class="muted">Lock in a champion to see how you usually play it.</p>`;
  const c = plan && plan.champ;
  const head = `<div class="lv-champ"><img src="/asset/champ/${encodeURIComponent(champId)}.png" alt=""><div><b>${esc(champName(champId))}</b>`;
  if (!c || !c.n) return head + `<div class="muted small">No past games on this champion in your replays.</div></div></div>`;
  return head + `<div class="muted small">${c.n} game${c.n > 1 ? 's' : ''} · ${Math.round(c.wr * 100)}% wins · accuracy ${fmtAcc(c.acc)} · ${c.deaths.toFixed(1)} deaths/game</div></div></div>
    ${c.top && c.top.rate >= 0.3 ? `<p class="small" style="margin:10px 0 0">On ${esc(champName(champId))} your most common mistake is <b>${esc(c.top.label.toLowerCase())}</b> (${c.top.rate.toFixed(1)} per game).</p>` : ''}`;
}

function renderLive() {
  const st = LV.state;
  $('lvStatus').textContent = liveStatusText(st);
  const s = st && st.session;
  let html = '';
  if (st && st.status === 'play' && s && !s.ended) {
    const me = s.me != null ? s.players[s.me] : null;
    const row = st.last && s.me != null ? st.last.p[s.me] : null;
    const minutes = (s.gameTime || 0) / 60;
    const plan = focusPlan(me && me.championId, me && me.position);
    const goals = plan ? plan.goals : [];
    html = `<div class="lv-ingame">
      <div class="lv-clock">${fmtTime(s.gameTime)}${me ? ` · ${esc(champName(me.championId))}` : ''}</div>
      ${goals.length ? `<div class="lv-goals">${goals.map(g => { const v = goalValue(g, row, minutes); const ok = goalMet(g, v);
        return `<div class="lv-goal"><span>${esc(g.label)}</span><b>${fmtGoal(g, v)}</b><span class="muted">goal ${g.better === 'low' ? '≤' : '≥'} ${fmtGoal(g, g.target)}</span><span class="lv-ok">${ok == null ? '' : ok ? '✓ on track' : 'below goal'}</span></div>`; }).join('')}</div>` : ''}
      ${plan && plan.cats.length ? `<div class="lv-remind"><span class="muted small">Your focus:</span> ${plan.cats.map(c => esc(c.label.toLowerCase())).join(' · ')}</div>` : ''}
      <p class="muted small">Recording for your debrief · ${s.snaps} snapshots. No in-game advice: Riot doesn't allow apps to tell you what to do during a match. Your full review opens automatically when the game ends.</p></div>`;
  } else if (s && s.mode === 'play' && s.ended && (LV.debrief === s.id)) {
    html = `<div class="lv-ingame"><div class="lv-clock">Game over${s.result ? ` — ${s.result === 'Win' ? 'Victory' : 'Defeat'}` : ''}</div>
      <p>Preparing your debrief… ${s.matchId ? `waiting for Riot's match data (try ${LV.debriefTries})` : 'finding the match'}. It opens here automatically.</p></div>`;
  } else if (st && st.status === 'spectate') {
    html = `<div class="lv-ingame"><div class="lv-clock">Replay · ${fmtTime(s ? s.gameTime : 0)}</div>
      <p>${s && s.matchId ? 'Following the replay in the review — coach commentary appears as each graded moment plays.' : 'Identifying which game this replay is…'}</p>
      ${s && s.matchId ? '<button class="btn" id="lvOpenFollow">Open the review</button>' : ''}
      ${LV.playbackOk ? '' : '<p class="muted small">To jump the League replay from the review, turn on replay control: <button class="btn ghost" id="lvEnableReplay">Enable replay control</button> then restart the replay.</p>'}</div>`;
  } else {
    let champId = null, role = null;
    if (st && st.champSelect) { champId = st.champSelect.champion; role = st.champSelect.position; }
    const plan = focusPlan(champId, role);
    html = renderFocus(plan, champCard(plan, champId));
  }
  const sessions = LV.sessions.filter(x => !x.error && x.snaps > 10).slice(0, 12);
  const list = sessions.length ? `<h4 class="sec">Recorded games</h4><table class="tbl games"><tr><th>When</th><th>Champion</th><th>Result</th><th>Length</th><th></th></tr>${sessions.map(x =>
    `<tr><td>${new Date(x.startedAt * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
      <td>${x.champion ? `<img src="/asset/champ/${encodeURIComponent(x.champion)}.png" alt="">${esc(champName(x.champion))}` : '—'}</td>
      <td>${x.result ? (x.result === 'Win' ? 'Win' : 'Loss') : '—'}</td><td>${x.duration ? fmtTime(x.duration) : '—'}</td>
      <td>${x.matchId ? `<button class="btn ghost" data-debrief="${esc(x.id)}">Open debrief</button>` : '<span class="muted small">match not linked yet</span>'}</td></tr>`).join('')}</table>` : '';
  const rules = `<details class="lv-rules"><summary>What the live coach does (and doesn't)</summary>
    <p>Before a game it shows your personal focus and goals, built only from your past games. During a game it records the official Live Client Data that the game serves to your PC, and shows nothing but your own stats against your goals. When the game ends, the full graded review opens with the extra precision from the recording (exact item buys, gold, health and vision over time).</p>
    <p>It deliberately does <b>not</b> give real-time advice ("go dragon", "back now"), power-spike alerts or enemy timers: Riot's developer policies don't allow apps that dictate player decisions during a match, and breaking that could put your account at risk. While you watch a <b>replay</b>, everything is fair game — the coach comments on every graded moment.</p></details>`;
  const sig = html + list;
  if (sig === LV.sig) return;
  LV.sig = sig;
  $('lvBody').innerHTML = html + list + rules;
  for (const b of $('lvBody').querySelectorAll('[data-debrief]')) b.onclick = () => { const x = LV.sessions.find(y => y.id === b.dataset.debrief); if (x) { showLive(false); openDebrief(x); } };
  const of = $('lvOpenFollow'); if (of) of.onclick = () => { showLive(false); LV.followMatch = null; followReplay(s.matchId); };
  const er = $('lvEnableReplay'); if (er) er.onclick = enableReplayControl;
}

async function enableReplayControl() {
  const r = await api('/api/replay/enable-api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  banner(r.ok ? 'Replay control enabled in League\'s game.cfg — restart the replay for it to take effect.' : esc(r.error || 'Could not enable replay control.'), !r.ok);
}

async function jumpLeagueReplay(t) {
  const r = await api('/api/replay/playback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ time: Math.max(0, t), paused: false }) });
  if (r && r.error) banner(esc(r.error), true);
}

function showLive(on) {
  $('live').classList.toggle('hidden', !on);
  $('liveBtn').classList.toggle('on', on);
  if (on) {
    $('app').classList.add('hidden'); $('welcome').classList.add('hidden'); $('trends').classList.add('hidden'); $('trendsBtn').classList.remove('on');
    LV.sig = '';
    loadLiveSessions().then(renderLive);
    if (!T.rows.length && !T.running) analyzeAllForTrends(false).then(() => { LV.sig = ''; renderLive(); });
    livePoll();
  } else if (S.game) $('app').classList.remove('hidden'); else $('welcome').classList.remove('hidden');
}

// ---------------------------------------------------------------- coach commentary while a replay plays (League replay or in-app playback)
function updateCoachBar() {
  const bar = $('coachBar'); if (!bar) return;
  if (!S.review || !(S.follow || S.playing || (typeof rsSynced === 'function' && rsSynced()))) { bar.classList.add('hidden'); return; }
  const acts = S.review.actions.filter(a => a.pids.includes(S.revPid) && a.grade !== 'ok' && a.kind !== 'farm' && a.kind !== 'vision' && a.kind !== 'laning' && a.t <= S.t && a.t > S.t - 18);
  const a = acts[acts.length - 1];
  if (!a) { bar.classList.add('hidden'); return; }
  if (bar.dataset.id !== String(a.id)) {
    bar.dataset.id = a.id;
    bar.innerHTML = `<span class="badge" style="background:${GRADES[a.grade].color};color:${GRADES[a.grade].ink}">${GRADES[a.grade].sym}</span>
      <div><b>${fmtTime(a.t)} · ${esc(GRADES[a.grade].label)}: ${esc(a.title)}</b><div>${esc(a.detail)}</div>${a.better ? `<div class="better"><b>Better:</b> ${esc(a.better)}</div>` : ''}</div>`;
  }
  bar.classList.remove('hidden');
}

function wireLive() {
  $('liveBtn').onclick = () => showLive($('live').classList.contains('hidden'));
  $('followChip').onclick = () => { S.follow = false; LV.followStopped = true; updateFollowChip(); };
  loadLiveSessions();
  livePoll();
}
wireLive();
