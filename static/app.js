'use strict';
/* global SR, FOUNTAIN, TEAM_NAME, ENEMY, WEIGHTS, FACTOR_LABEL, FACTORS, WP_GROUP, knotWeights, ROLE_SHORT, fmtTime, fmtGold, clamp, interpSeries, zoneOf,
   buildGame, posAt, posConfidence, isDead, levelAt, countBefore, structureAlive, influence, stateAt, smoothAt, playerReport,
   describeFight, SAMPLE_STEP */

const $ = id => document.getElementById(id);
const S = {
  replays: [], meta: null, game: null, t: 0, playing: false, speed: 10, you: null, focus: null,
  tab: 'review', heat: null, heatT: -1, lastUi: 0, mePid: null,
  review: null, revPid: null, revSel: null, revFilter: 'key', sideTab: 'moves', stopAt: null, savedSpeed: null,
};
const store = {
  get(k, d) { try { const v = localStorage.getItem('lra.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('lra.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
// Players are identified by PUUID, which never changes (Riot IDs can be renamed).
// Replay files and the League client use the same PUUID; Riot API data uses an encrypted one,
// so game participants are linked to the replay's players by team + champion (rawPuuid).
const pkey = p => p.rawPuuid || p.puuid;
// which player is "you": accounts you marked, else the account logged into the League client, else the most frequent player
function meIn(players) {
  for (const id of S.myIds) { const m = players.find(p => pkey(p) === id); if (m) return m; }
  if (S.clientPuuid) { const m = players.find(p => pkey(p) === S.clientPuuid); if (m) return m; }
  if (!S.myIds.length && S.topId) { const m = players.find(p => pkey(p) === S.topId); if (m) return m; }
  return null;
}
function markMe(g, pid) {
  const others = new Set(g.ps.map(pkey));
  const p = g.byId[pid]; if (!p || !pkey(p)) return;
  S.myIds = S.myIds.filter(k => !others.has(k)); S.myIds.unshift(pkey(p));
  store.set('myPuuids', S.myIds.slice(0, 20));
  S.mePid = pid;
}
function linkReplayPlayers(g, meta) {
  const mp = (meta && meta.players) || [];
  for (const p of g.ps) {
    const m = mp.find(x => x.team === p.team && String(x.champion).toLowerCase() === String(p.champ).toLowerCase())
      || (g.source === 'lcu' ? mp.find(x => x.puuid === p.puuid) : null);
    p.rawPuuid = m ? m.puuid : (g.source === 'lcu' ? p.puuid : null);
  }
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const teamCls = t => (t === 100 ? 'b' : t === 200 ? 'r' : '');
const COLORS = { 100: '#3d8bff', 200: '#ef4b5c' };

async function api(path, opts) {
  const r = await fetch(path, opts);
  return r.json();
}
function banner(msg, err) {
  const b = $('banner');
  if (!msg) { b.classList.add('hidden'); return; }
  b.innerHTML = msg; b.classList.toggle('err', !!err); b.classList.remove('hidden');
}

// ================================================================ images
const imgCache = {};
function champImg(name) {
  if (!name) return null;
  if (!imgCache[name]) { const im = new Image(); im.src = `/asset/champ/${encodeURIComponent(name)}.png`; imgCache[name] = im; }
  return imgCache[name];
}
const mapImg = new Image(); mapImg.src = '/asset/map/map11.png';

// ================================================================ setup
async function init() {
  S.myIds = store.get('myPuuids', []);
  wireUi();
  try { const me = await api('/api/me'); if (me.puuid) S.clientPuuid = me.puuid; } catch { /* client not running */ }
  try { Object.assign(CHAMP_NAMES, await api('/api/champions')); } catch { /* offline: fall back to internal ids */ }
  await refreshConfig();
  await loadReplayList();
  requestAnimationFrame(loop);
  // keep-alive for the packaged app (it quits shortly after its window is closed)
  const ping = () => api('/api/ping').catch(() => {});
  setInterval(ping, 20000);
  window.addEventListener('pagehide', () => { try { navigator.sendBeacon('/api/bye', ''); } catch { /* ignore */ } });
  // a .rofl passed to the exe (drag & drop onto the icon / "Open with")
  const openPath = new URLSearchParams(location.search).get('open');
  if (openPath) {
    history.replaceState(null, '', location.pathname);
    const meta = await api('/api/replay-file?path=' + encodeURIComponent(openPath));
    if (meta.error) banner(esc(meta.error), true); else openReplay(meta);
  }
}

async function refreshConfig() {
  const c = await api('/api/config');
  const ks = $('keyStatus');
  ks.textContent = (c.hasKey ? (c.keyRejected ? 'API key expired — paste a new one' : `Key saved (${c.keyHint})`) : 'No API key') + (c.lcu ? ' · client connected' : '');
  ks.classList.toggle('ok', c.hasKey && !c.keyRejected);
  ks.classList.toggle('bad', !!c.keyRejected);
  S.hasKey = c.hasKey;
}

async function loadReplayList() {
  const r = await api('/api/replays');
  S.replays = (r.replays || []).filter(x => !x.error);
  // the user is the person who appears in the most replays
  const freq = {};
  for (const rp of S.replays) for (const p of rp.players || []) if (p.puuid) freq[p.puuid] = (freq[p.puuid] || 0) + 1;
  const top = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
  S.topId = top && top[1] >= 2 ? top[0] : null;
  const sel = $('replaySelect');
  if (!r.exists) { sel.innerHTML = `<option>No replay folder found (${esc(r.dir)})</option>`; return; }
  if (!S.replays.length) { sel.innerHTML = `<option>No .rofl files in ${esc(r.dir)}</option>`; return; }
  sel.innerHTML = '<option value="">Select a replay…</option>' + S.replays.map((rp, i) => {
    const me = meIn(rp.players);
    const d = new Date(rp.mtime * 1000);
    const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const len = rp.gameLength ? fmtTime(rp.gameLength / 1000) : '?';
    const who = me ? `${champName(me.champion)} ${me.kills}/${me.deaths}/${me.assists} · ${me.win ? 'Win' : 'Loss'}` : rp.players.length ? 'not your game: ' + rp.players.map(p => champName(p.champion)).slice(0, 3).join(', ') + '…' : 'no player data';
    const open = S.meta && S.meta.file === rp.file;
    return `<option value="${i}" ${open ? 'selected' : ''}>${esc(date)} · ${esc(who)} · ${len}${rp.cached ? ' ✓' : ''}</option>`;
  }).join('');
}

function wireUi() {
  $('replaySelect').onchange = e => { const i = e.target.value; if (i !== '') openReplay(S.replays[+i]); };
  $('fileInput').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { openReplay(await parseRoflFile(f)); } catch (err) { banner(esc(err.message), true); }
    e.target.value = '';
  };
  $('reloadBtn').onclick = () => S.meta && openReplay(S.meta, true);
  window.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dropping'); });
  window.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
  window.addEventListener('drop', async e => {
    e.preventDefault(); document.body.classList.remove('dropping');
    const f = [...(e.dataTransfer.files || [])].find(x => /\.rofl$/i.test(x.name));
    if (!f) { banner('Drop a .rofl replay file to analyse it.', true); return; }
    try { openReplay(await parseRoflFile(f)); } catch (err) { banner(esc(err.message), true); }
  });
  $('saveKey').onclick = async () => {
    const k = $('apiKey').value.trim(); if (!k) return;
    await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: k }) });
    $('apiKey').value = ''; await refreshConfig();
    banner('API key saved.'); setTimeout(() => banner(''), 2500);
    if (S.meta && !S.game) openReplay(S.meta, true);
  };
  $('playBtn').onclick = togglePlay;
  $('speed').onchange = e => { if (typeof rsControl === 'function' && rsControl()) rsSetSpeed(+e.target.value); else S.speed = +e.target.value; };
  $('scrub').oninput = e => seek(+e.target.value);
  for (const id of ['tHeat', 'tTrails', 'tNames', 'tEvents', 'tDirector']) {
    const el = $(id); el.checked = store.get(id, el.checked); el.onchange = () => store.set(id, el.checked);
  }
  $('tabs').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.tab = b.dataset.tab; renderTabs(); };
  $('sideTabs').onclick = e => {
    const b = e.target.closest('button'); if (!b) return; S.sideTab = b.dataset.st;
    for (const x of $('sideTabs').querySelectorAll('button')) x.classList.toggle('active', x === b);
    $('moves').classList.toggle('hidden', S.sideTab !== 'moves'); $('scoreboard').classList.toggle('hidden', S.sideTab !== 'score');
    S.lastUi = 0;
  };
  document.addEventListener('keydown', e => {
    if (!S.game || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && document.activeElement.type !== 'range') return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.code === 'ArrowRight') { e.preventDefault(); seek(S.t + (e.shiftKey ? 60 : 10)); }
    if (e.code === 'ArrowLeft') { e.preventDefault(); seek(S.t - (e.shiftKey ? 60 : 10)); }
    if (e.key === '.' || e.key === 'n') stepMove(1);
    if (e.key === ',' || e.key === 'p') stepMove(-1);
  });
  const mc = $('map');
  mc.onmousemove = e => mapHover(e);
  mc.onmouseleave = () => $('mapTip').classList.add('hidden');
  mc.onclick = e => { const p = playerAtMouse(e); S.focus = p && S.focus !== p.id ? p.id : null; };
  const cc = $('chart');
  let drag = false;
  cc.onmousedown = e => { drag = true; chartSeek(e); };
  window.addEventListener('mouseup', () => (drag = false));
  cc.onmousemove = e => { if (drag) chartSeek(e); chartHover(e); };
  cc.onmouseleave = () => { $('chartTip').classList.add('hidden'); S.chartHoverT = null; drawChart(); };
  window.addEventListener('resize', () => { sizeCanvases(); drawChart(); });
}

// ================================================================ rofl parsing (for files opened from disk)
async function parseRoflFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (String.fromCharCode(...buf.slice(0, 4)) !== 'RIOT') throw new Error('That is not a .rofl replay file.');
  const pat = new TextEncoder().encode('{"gameLength"');
  let idx = -1;
  outer: for (let i = buf.length - pat.length; i >= 0; i--) {
    for (let j = 0; j < pat.length; j++) if (buf[i + j] !== pat[j]) continue outer;
    idx = i; break;
  }
  if (idx < 0) throw new Error('Could not find the metadata block in this replay.');
  const text = new TextDecoder('utf-8').decode(buf.slice(idx));
  let depth = 0, inStr = false, end = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}') { depth--; if (!depth) { end = i + 1; break; } }
  }
  const meta = JSON.parse(text.slice(0, end));
  const stats = JSON.parse(meta.statsJson || '[]');
  let m = file.name.match(/([A-Za-z]+\d*)-(\d+)/);
  let matchId = m ? `${m[1].toUpperCase()}_${m[2]}` : null;
  if (!matchId) {
    const v = prompt('Could not read the game ID from the file name. Enter the match ID (e.g. NA1_1234567890):');
    if (!v) throw new Error('No match ID given.');
    matchId = v.trim().toUpperCase().replace('-', '_');
  }
  const players = stats.map(p => ({
    puuid: p.PUUID, name: p.RIOT_ID_GAME_NAME || p.NAME, tag: p.RIOT_ID_TAG_LINE, champion: p.SKIN, team: +p.TEAM,
    position: p.TEAM_POSITION || p.INDIVIDUAL_POSITION, win: p.WIN === 'Win', kills: +p.CHAMPIONS_KILLED || 0,
    deaths: +p.NUM_DEATHS || 0, assists: +p.ASSISTS || 0, gold: +p.GOLD_EARNED || 0, visionScore: +p.VISION_SCORE || 0,
  }));
  const vm = String.fromCharCode(...buf.slice(0, 400)).match(/\d+\.\d+\.\d+\.\d+/);
  return { file: file.name, matchId, gameId: matchId.split('_')[1], version: vm ? vm[0] : null, gameLength: meta.gameLength, players };
}

// ================================================================ open a replay
async function openReplay(meta, refresh) {
  const token = (S.openToken = (S.openToken || 0) + 1); // a replay opened while this one loads must win
  S.meta = meta; S.game = null; S.playing = false; updatePlayBtn();
  $('trends').classList.add('hidden'); $('trendsBtn').classList.remove('on');
  if ($('live')) { $('live').classList.add('hidden'); $('liveBtn').classList.remove('on'); }
  S.follow = false; if (typeof updateFollowChip === 'function') updateFollowChip();
  banner(`Loading ${esc(meta.matchId || meta.file)}…`);
  if (!meta.matchId) { banner('Could not determine the match ID for this replay.', true); return; }
  let data;
  try { data = await api(`/api/match?id=${encodeURIComponent(meta.matchId)}${refresh ? '&refresh=1' : ''}`); }
  catch (e) { data = { error: 'Could not reach the local server.' }; }
  if (token !== S.openToken) return;
  if (data.error) { showMetaOnly(meta, data.error); refreshConfig(); return; }
  try {
    const t0 = performance.now();
    const live = typeof liveSessionFor === 'function' ? await liveSessionFor(meta.matchId) : null;
    if (token !== S.openToken) return;
    if (live) data = enrichWithLive(data, live);
    S.game = buildGame(data);
    S.game.meta = meta;
    linkReplayPlayers(S.game, meta);
    S.review = reviewGame(S.game);
    console.log(`Game model built in ${(performance.now() - t0).toFixed(0)} ms`, S.game);
  } catch (e) { S.game = null; S.review = null; console.error(e); showMetaOnly(meta, 'Could not analyse this match: ' + e.message); return; }
  banner('');
  S.focus = null;
  S.mePid = (meIn(S.game.ps) || {}).id || null;
  S.revPid = S.mePid || S.game.ps[0].id; S.revSel = null; S.stopAt = null;
  $('welcome').classList.add('hidden'); $('app').classList.remove('hidden');
  $('scrub').max = S.game.duration;
  const g = S.game;
  const winTxt = g.winner ? `<span class="${teamCls(g.winner)}">${TEAM_NAME[g.winner]} win</span>` : '';
  const me = g.ps.find(p => p.id === S.mePid);
  const src = g.source === 'lcu' ? '<span class="muted" title="Loaded from your League client: positions, kills, towers and objectives are exact; wards and item purchases are estimated.">· client data</span>' : '';
  $('matchTitle').innerHTML = `${esc(g.matchId || meta.matchId)} · ${fmtTime(g.duration)} · ${winTxt} ${src}` +
    (me ? ` <span class="muted">· you: ${esc(me.cname)} (${TEAM_NAME[me.team]})</span>` : '');
  S.heatT = -1;
  $('watchLeague').classList.add('hidden'); // v2: the replay view opens League itself
  if (typeof rsOnGameOpened === 'function') rsOnGameOpened();
  sizeCanvases();
  S.t = 0; S.lastUi = 0;
  drawChart();
  renderTabs();
  renderMoves();
  loadReplayList();
}

function showMetaOnly(meta, err) {
  const needsKey = /key/i.test(err);
  banner(esc(err) + (needsKey ? ' — paste a key in the box at the top right.' : ''), true);
  $('app').classList.add('hidden'); $('welcome').classList.remove('hidden');
  const teams = [100, 200].map(t => {
    const ps = meta.players.filter(p => p.team === t);
    return `<div class="card" style="margin-top:12px"><div class="card-head"><h3 class="${teamCls(t)}">${TEAM_NAME[t]} ${ps[0] && ps[0].win ? '(Win)' : '(Loss)'}</h3></div>` +
      ps.map(p => `<div class="sb-row ${meIn(meta.players) === p ? 'you' : ''}" style="grid-template-columns:28px 1fr 80px 70px 60px">
        <img src="/asset/champ/${encodeURIComponent(p.champion)}.png" alt=""><span class="nm">${esc(p.name)} <small>${esc(champName(p.champion))}</small></span>
        <span class="r">${p.kills}/${p.deaths}/${p.assists}</span><span class="r">${fmtGold(p.gold, false)}</span><span class="r">👁 ${p.visionScore}</span></div>`).join('') + '</div>';
  }).join('');
  const w = $('welcome');
  w.querySelector('.meta-only')?.remove();
  w.insertAdjacentHTML('beforeend', `<div class="meta-only"><h4 class="sec">From the replay file (${esc(meta.file || meta.matchId)})</h4>${teams}</div>`);
}

// ================================================================ playback
function togglePlay() {
  if (!S.game) return;
  if (typeof rsControl === 'function' && rsControl()) { rsTogglePause(); return; }
  if (S.stopAt != null) { S.stopAt = null; S.speed = S.savedSpeed || +$('speed').value; }
  if (S.t >= S.game.duration) S.t = 0;
  S.playing = !S.playing; updatePlayBtn();
}
function updatePlayBtn() { $('playBtn').textContent = (typeof rsControl === 'function' && rsControl() ? !RS.pb.paused : S.playing) ? '❚❚' : '▶'; }
function endWatch() { if (S.stopAt != null) { S.stopAt = null; S.speed = S.savedSpeed || +$('speed').value; } }
function seek(t) {
  if (!S.game) return;
  endWatch(); // moving the playhead cancels "watch this moment" and restores the chosen speed
  S.t = clamp(t, 0, S.game.duration);
  S.lastUi = 0;
  if (typeof rsSeek === 'function') rsSeek(S.t); // the real replay jumps too
}
let lastFrame = performance.now();
function loop(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000); lastFrame = now;
  try { // one bad frame must not stop the whole app from drawing
  if (S.game) {
    const rt = typeof rsSynced === 'function' && rsSynced() ? rsTime() : null;
    if (rt != null) { S.t = clamp(rt, 0, S.game.duration); S.playing = false; }
    else if (S.follow && LV.gt != null) {
      const tt = LV.gt + (LV.paused ? 0 : (performance.now() - LV.gtAt) / 1000 * (LV.speed || 1));
      S.t = clamp(tt, 0, S.game.duration);
    }
    if (S.playing) {
      S.t += dt * (CAM.slow ? Math.max(1, S.speed * 0.35) : S.speed);
      if (S.t >= S.game.duration) { S.t = S.game.duration; S.playing = false; updatePlayBtn(); }
      if (S.stopAt != null && S.t >= S.stopAt) { S.playing = false; S.stopAt = null; S.speed = S.savedSpeed || +$('speed').value; updatePlayBtn(); }
    }
    if (typeof RS === 'undefined' || RS.view !== 'replay') drawMap();
    if (now - S.lastUi > 120) { S.lastUi = now; updateSide(); drawChart(); updateCoachBar(); if (typeof RS !== 'undefined' && RS.pb) updatePlayBtn(); }
  }
  } catch (e) { if (S.loopError !== String(e)) console.error('draw loop:', e); S.loopError = String(e); }
  requestAnimationFrame(loop);
}

// ================================================================ map
function sizeCanvases() {
  const dpr = window.devicePixelRatio || 1;
  for (const id of ['map', 'chart']) {
    const c = $(id); const r = c.getBoundingClientRect();
    c.width = Math.max(10, Math.round(r.width * dpr)); c.height = Math.max(10, Math.round(r.height * dpr));
  }
}
function toPx(x, y, W, H) { return [(x - SR.minX) / (SR.maxX - SR.minX) * W, H - (y - SR.minY) / (SR.maxY - SR.minY) * H]; }

const heatCanvas = document.createElement('canvas');
function updateHeat(t) {
  if (S.heat && Math.abs(t - S.heatT) < 0.4) return;
  const N = 56; const inf = influence(S.game, t, N, true);
  heatCanvas.width = N; heatCanvas.height = N;
  const ctx = heatCanvas.getContext('2d'); const img = ctx.createImageData(N, N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const c = inf.grid[j * N + i]; const o = ((N - 1 - j) * N + i) * 4; const a = Math.min(1, Math.abs(c) * 1.15);
    if (c > 0) { img.data[o] = 61; img.data[o + 1] = 139; img.data[o + 2] = 255; } else { img.data[o] = 239; img.data[o + 1] = 75; img.data[o + 2] = 92; }
    img.data[o + 3] = Math.round(a * a * 120);
  }
  ctx.putImageData(img, 0, 0);
  S.heat = inf; S.heatT = t;
}

// drawMap() lives in mapview.js (cinematic renderer)
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${clamp(a, 0, 1)})`;
}
function playerAtMouse(e) {
  if (!S.game) return null;
  const c = $('map'); const r = c.getBoundingClientRect(); const dpr = c.width / r.width;
  const mx = (e.clientX - r.left) * dpr, my = (e.clientY - r.top) * dpr; const R = 16 * c.width / 600;
  let best = null, bd = R;
  for (const p of S.game.ps) if (p._px) { const d = Math.hypot(p._px[0] - mx, p._px[1] - my); if (d < bd) { bd = d; best = p; } }
  return best;
}
function mapHover(e) {
  const tip = $('mapTip'); const p = playerAtMouse(e);
  if (!p) { tip.classList.add('hidden'); return; }
  const g = S.game, t = S.t; const pos = posAt(p, t); const conf = posConfidence(p, t);
  const gold = interpSeries(g.ft, p.series.gold, t);
  tip.innerHTML = `<b class="${teamCls(p.team)}">${esc(p.name)}</b> · ${esc(p.cname)} (${esc(ROLE_SHORT[p.role] || p.role)})<br>
    Lv ${levelAt(p, t)} · ${fmtGold(gold, false)} gold · ${esc(zoneOf(pos.x, pos.y).name)}<br>
    <span class="muted">${isDead(p, t) ? 'dead' : conf < 3 ? 'exact position' : `estimated (±${Math.round(conf)}s from a known point)`}</span>`;
  const wrap = $('mapWrap').getBoundingClientRect();
  tip.style.left = Math.min(e.clientX - wrap.left + 14, wrap.width - 240) + 'px'; tip.style.top = (e.clientY - wrap.top + 14) + 'px';
  tip.classList.remove('hidden');
}

// ================================================================ side panel
function teamAvgLevel(g, team, t) { const ps = g.ps.filter(p => p.team === team); return ps.reduce((a, p) => a + levelAt(p, t), 0) / ps.length; }

function updateSide() {
  const g = S.game, t = S.t; const st = stateAt(g, t); const ctrl = smoothAt(g, 's10', t);
  $('clock').textContent = `${fmtTime(t)} / ${fmtTime(g.duration)}`;
  if (document.activeElement !== $('scrub')) $('scrub').value = t;
  const blue = Math.round(50 + 50 * ctrl);
  $('meterFill').style.width = blue + '%';
  $('ctrlPct').innerHTML = `<span class="blue">${blue}%</span> · <span class="red">${100 - blue}%</span>`;

  // explanation
  const trained = !!g.wpm;
  const leader = ctrl > 0.08 ? 100 : ctrl < -0.08 ? 200 : 0;
  const contrib = FACTORS.map(k => [k, st.fc[k]]);
  const thPro = trained ? 0.04 : 0.015, thCon = trained ? 0.05 : 0.02;
  const R = st.raw;
  const why = {
    gold: tm => `${fmtGold(Math.abs(R.goldB - R.goldR), false)} gold ahead`,
    xp: () => 'a level advantage', vision: () => 'more wards on the map',
    map: () => 'more of the map under control', obj: () => 'an objective lead', numbers: tm => `a numbers advantage (${R.aliveB}v${R.aliveR})`,
  };
  let txt;
  if (!leader) txt = '<b>Even</b>: neither team has a clear edge right now.';
  else {
    const sg = leader === 100 ? 1 : -1;
    const pro = contrib.filter(([, v]) => v * sg > thPro).sort((a, b) => b[1] * sg - a[1] * sg).slice(0, 2).map(([k]) => why[k](leader));
    const con = contrib.filter(([, v]) => v * sg < -thCon).sort((a, b) => a[1] * sg - b[1] * sg)[0];
    const strength = trained ? (Math.abs(ctrl) > 0.6 ? 'heavily favoured' : Math.abs(ctrl) > 0.3 ? 'favoured' : 'slightly favoured')
      : Math.abs(ctrl) > 0.45 ? 'firmly in control' : Math.abs(ctrl) > 0.22 ? 'in control' : 'slightly ahead';
    txt = `<b class="${teamCls(leader)}">${TEAM_NAME[leader]}</b> is ${strength}` + (pro.length ? ` with ${pro.join(' and ')}.` : '.');
    const conTxt = { gold: () => `a ${fmtGold(Math.abs(R.goldB - R.goldR), false)} gold lead`, xp: () => 'a level lead', vision: () => 'more wards on the map',
      map: () => 'more of the map', obj: () => 'an objective lead', numbers: () => 'more players alive' };
    if (con) txt += ` ${TEAM_NAME[ENEMY[leader]]} still has ${conTxt[con[0]]()}.`;
  }
  $('ctrlText').innerHTML = txt;

  const od = R.objDet;
  const val = {
    gold: () => R.goldB === R.goldR ? 'even' : `${R.goldB > R.goldR ? 'Blue' : 'Red'} ${fmtGold(Math.abs(R.goldB - R.goldR), false)}`,
    xp: () => `Lv ${teamAvgLevel(g, 100, t).toFixed(1)} vs ${teamAvgLevel(g, 200, t).toFixed(1)}`,
    vision: () => g.hasWards ? `≈${R.wardsB.toFixed(0)} vs ${R.wardsR.toFixed(0)} wards` : g.live ? `+${R.wardsB.toFixed(0)} vs +${R.wardsR.toFixed(0)} (3 min)` : `score ${R.wardsB} vs ${R.wardsR} (game)`,
    map: () => `${Math.round(R.share * 100)}% vs ${100 - Math.round(R.share * 100)}%`,
    obj: () => `T${od[100].towers} D${od[100].dragons}${od[100].baronBuff ? ' B' : ''} vs T${od[200].towers} D${od[200].dragons}${od[200].baronBuff ? ' B' : ''}`,
    numbers: () => `${R.aliveB} v ${R.aliveR} alive`,
  };
  const L = Math.log(Math.max(1e-6, st.wp) / Math.max(1e-6, 1 - st.wp));
  $('factors').innerHTML = FACTORS.map(k => {
    const v = trained ? Math.tanh(st.fc[k] * 1.5) : st.comp[k]; const w = Math.abs(v) * 50;
    const style = v >= 0 ? `left:50%;width:${w}%;background:var(--blue)` : `left:${50 - w}%;width:${w}%;background:var(--red)`;
    // trained: how many points of Blue's win chance this factor accounts for right now
    const pts = trained ? 100 * (st.wp - 1 / (1 + Math.exp(-(L - 2 * st.fc[k])))) : 0;
    const tip = trained ? `${FACTOR_LABEL[k]}: worth ${Math.abs(pts).toFixed(1)} points of win chance to ${pts >= 0 ? 'Blue' : 'Red'} right now (trained on Master+ games)`
      : `${FACTOR_LABEL[k]}: weight ${Math.round(WEIGHTS[k] * 100)}% of the control score`;
    return `<div class="factor" title="${tip}">
      <span class="lbl">${FACTOR_LABEL[k]}</span><div class="fbar"><i style="${style}"></i></div><span class="val">${val[k]()}</span></div>`;
  }).join('');

  // scoreboard
  if (S.sideTab !== 'score') return;
  $('scoreboard').innerHTML = [100, 200].map(team => {
    const ps = g.ps.filter(p => p.team === team);
    const kills = g.kills.filter(k => k.team === team && k.t <= t).length;
    const gold = team === 100 ? R.goldB : R.goldR;
    return `<div class="sb-team"><div class="sb-team-head"><b class="${teamCls(team)}">${TEAM_NAME[team]}${g.winner === team ? ' · Victory' : ''}</b>
      <span class="muted">${kills} kills · ${fmtGold(gold, false)} gold</span></div>` +
      ps.map(p => {
        const dead = isDead(p, t);
        const k = countBefore(p.kills, t), d = p.deaths.filter(x => x.t <= t).length, a = countBefore(p.assistsAt, t);
        const cs = Math.round(interpSeries(g.ft, p.series.cs, t)), pg = interpSeries(g.ft, p.series.gold, t);
        return `<div class="sb-row ${p.id === S.mePid ? 'you' : ''} ${dead ? 'dead' : ''}" data-pid="${p.id}" title="Click to highlight on the map">
          <img src="/asset/champ/${encodeURIComponent(p.champ)}.png" alt="">
          <span class="nm">${esc(p.name)} <small>${esc(ROLE_SHORT[p.role] || '')}${dead ? ` · ${Math.ceil(dead.respawn - t)}s` : ''}</small></span>
          <span class="r">${levelAt(p, t)}</span><span class="r">${k}/${d}/${a}</span><span class="r">${cs}</span><span class="r">${fmtGold(pg, false)}</span></div>`;
      }).join('') + '</div>';
  }).join('');
  for (const row of $('scoreboard').querySelectorAll('.sb-row')) row.onclick = () => { const id = +row.dataset.pid; S.focus = S.focus === id ? null : id; };
}

// ================================================================ chart
// Two panels on one shared time axis (never two y-scales on one plot):
//   1. control (diverging: Blue above the midline, Red below)   2. gold difference (same encoding)
const CH = { l: 58, r: 16, top: 30, gap: 22, axis: 22 };
function chartGeom() {
  const c = $('chart'); const dpr = window.devicePixelRatio || 1;
  const W = c.width, H = c.height; const l = CH.l * dpr, r = CH.r * dpr;
  const top = CH.top * dpr, gap = CH.gap * dpr, axis = CH.axis * dpr;
  const avail = H - top - gap - axis;
  const h1 = avail * 0.64, h2 = avail - h1;
  const p1 = { y: top, h: h1, mid: top + h1 / 2 };
  const p2 = { y: top + h1 + gap, h: h2, mid: top + h1 + gap + h2 / 2 };
  return { c, W, H, dpr, l, r, pw: W - l - r, p1, p2, tp: top, ph: h1, mid: p1.mid };
}
const INK = { muted: '#8b96ad', grid: '#1c2438', base: '#3a4766', text: '#e6ebf5' };
function drawChart() {
  const g = S.game; if (!g) return;
  const G = chartGeom(); const { c, W, H, dpr, l, pw, p1, p2 } = G; const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const X = t => l + t / g.duration * pw;
  const font = (px, w = 400) => `${w} ${px * dpr}px Segoe UI, system-ui, sans-serif`;

  // phase bands behind the control panel
  for (const p of g.phases) {
    if (!p.leader) continue;
    ctx.fillStyle = hexA(COLORS[p.leader], 0.06);
    ctx.fillRect(X(p.start), p1.y, X(p.end) - X(p.start), p1.h);
  }
  // vertical time grid (both panels) + shared x-axis labels
  ctx.strokeStyle = INK.grid; ctx.lineWidth = 1; ctx.fillStyle = INK.muted; ctx.font = font(11); ctx.textAlign = 'center';
  for (let m = 0; m * 60 <= g.duration; m += 5) {
    const x = Math.round(X(m * 60)) + 0.5;
    for (const P of [p1, p2]) { ctx.beginPath(); ctx.moveTo(x, P.y); ctx.lineTo(x, P.y + P.h); ctx.stroke(); }
    ctx.fillText(m + ':00', x, H - 6 * dpr);
  }

  // --- panel 1: control
  const Y1 = v => p1.mid - v * p1.h / 2;
  ctx.textAlign = 'right'; ctx.font = font(11);
  for (const v of [-1, -0.5, 0, 0.5, 1]) {
    ctx.strokeStyle = v === 0 ? INK.base : INK.grid; ctx.beginPath(); ctx.moveTo(l, Math.round(Y1(v)) + 0.5); ctx.lineTo(l + pw, Math.round(Y1(v)) + 0.5); ctx.stroke();
    ctx.fillStyle = INK.muted; ctx.fillText(v === 0 ? 'even' : `${Math.round(50 + Math.abs(v) * 50)}%`, l - 8 * dpr, Y1(v) + 4 * dpr);
  }
  const area = (series, Y, mid, sgn, col) => {
    ctx.beginPath(); ctx.moveTo(X(0), mid);
    series.forEach((v, i) => ctx.lineTo(X(i * SAMPLE_STEP), Y(sgn > 0 ? Math.max(0, v) : Math.min(0, v))));
    ctx.lineTo(X((series.length - 1) * SAMPLE_STEP), mid); ctx.closePath();
    ctx.fillStyle = hexA(col, 0.55); ctx.fill();
  };
  const sm = Array.from(g.smooth.s10);
  area(sm, Y1, p1.mid, 1, COLORS[100]); area(sm, Y1, p1.mid, -1, COLORS[200]);
  // panel labels (identity: swatch + muted text)
  const label = (txt, x, y, col) => { ctx.fillStyle = col; ctx.fillRect(x, y - 8 * dpr, 8 * dpr, 8 * dpr); ctx.fillStyle = INK.muted; ctx.textAlign = 'left'; ctx.font = font(11); ctx.fillText(txt, x + 12 * dpr, y); };
  label(g.wpm ? 'Blue win chance' : 'Blue in control', l + 6 * dpr, p1.y + 13 * dpr, COLORS[100]);
  label(g.wpm ? 'Red win chance' : 'Red in control', l + 6 * dpr, p1.y + p1.h - 6 * dpr, COLORS[200]);
  // objectives (diamonds) & towers (squares) along the control panel's floor, 2px surface ring
  for (const s of g.structureEvents) {
    const x = X(s.t), y = p1.y + p1.h - 22 * dpr, r = 3.5 * dpr;
    ctx.fillStyle = '#121826'; ctx.fillRect(x - r - 2 * dpr, y - r - 2 * dpr, 2 * r + 4 * dpr, 2 * r + 4 * dpr);
    ctx.fillStyle = COLORS[s.team]; ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  for (const o of g.objectives) {
    const x = X(o.t), y = p1.y + p1.h - 9 * dpr, r = (o.key === 'BARON_NASHOR' || o.key === 'ELDER' ? 6.5 : 5) * dpr;
    const dia = rr => { ctx.beginPath(); ctx.moveTo(x, y - rr); ctx.lineTo(x + rr, y); ctx.lineTo(x, y + rr); ctx.lineTo(x - rr, y); ctx.closePath(); };
    ctx.fillStyle = '#121826'; dia(r + 2 * dpr); ctx.fill();
    ctx.fillStyle = COLORS[o.team]; dia(r); ctx.fill();
  }

  // --- panel 2: gold difference (its own axis)
  let gmax = 1000; for (const s of g.samples) gmax = Math.max(gmax, Math.abs(s.raw.goldB - s.raw.goldR));
  gmax = Math.ceil(gmax / 2000) * 2000;
  const Y2 = v => p2.mid - (v / gmax) * p2.h / 2;
  ctx.textAlign = 'right'; ctx.font = font(11);
  for (const v of [-gmax, 0, gmax]) {
    ctx.strokeStyle = v === 0 ? INK.base : INK.grid; ctx.beginPath(); ctx.moveTo(l, Math.round(Y2(v)) + 0.5); ctx.lineTo(l + pw, Math.round(Y2(v)) + 0.5); ctx.stroke();
    ctx.fillStyle = INK.muted; ctx.fillText(v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v) / 1000}k`, l - 8 * dpr, Y2(v) + 4 * dpr);
  }
  const gd = g.samples.map(s => s.raw.goldB - s.raw.goldR);
  area(gd, Y2, p2.mid, 1, COLORS[100]); area(gd, Y2, p2.mid, -1, COLORS[200]);
  ctx.fillStyle = INK.muted; ctx.textAlign = 'left'; ctx.font = font(11, 600);
  ctx.fillText('Gold difference', l + 6 * dpr, p2.y + 12 * dpr);

  // --- marker rows above the control panel: review grades (top) and kills
  ctx.font = font(10); ctx.fillStyle = INK.muted; ctx.textAlign = 'right';
  ctx.fillText('kills', l - 8 * dpr, p1.y - 6 * dpr);
  for (const k of g.kills) {
    ctx.fillStyle = '#121826'; ctx.beginPath(); ctx.arc(X(k.t), p1.y - 9 * dpr, 5 * dpr, 0, 7); ctx.fill();
    ctx.fillStyle = COLORS[k.team]; ctx.beginPath(); ctx.arc(X(k.t), p1.y - 9 * dpr, 3 * dpr, 0, 7); ctx.fill();
  }
  if (S.review) {
    ctx.fillStyle = INK.muted; ctx.textAlign = 'right'; ctx.fillText('review', l - 8 * dpr, p1.y - 19 * dpr);
    for (const a of S.review.actions) {
      if (!a.pids.includes(S.revPid) || a.grade === 'ok' || a.kind === 'farm' || a.kind === 'vision') continue;
      const x = X(a.t), y = p1.y - 23 * dpr, r = (a.id === S.revSel ? 5.5 : 4) * dpr;
      ctx.fillStyle = GRADES[a.grade].color; ctx.beginPath(); ctx.moveTo(x, y + r); ctx.lineTo(x + r, y - r); ctx.lineTo(x - r, y - r); ctx.closePath(); ctx.fill();
    }
  }
  // hover crosshair
  if (S.chartHoverT != null) {
    const x = Math.round(X(S.chartHoverT)) + 0.5;
    ctx.strokeStyle = 'rgba(230,235,245,.35)'; ctx.lineWidth = 1;
    for (const P of [p1, p2]) { ctx.beginPath(); ctx.moveTo(x, P.y); ctx.lineTo(x, P.y + P.h); ctx.stroke(); }
  }
  // playhead
  ctx.strokeStyle = INK.text; ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath(); ctx.moveTo(X(S.t), p1.y - 28 * dpr); ctx.lineTo(X(S.t), p2.y + p2.h); ctx.stroke();
}
function chartTime(e) {
  const G = chartGeom(); const r = G.c.getBoundingClientRect(); const x = (e.clientX - r.left) * G.dpr;
  return clamp((x - G.l) / G.pw, 0, 1) * S.game.duration;
}
function chartSeek(e) { if (S.game) { seek(chartTime(e)); drawChart(); } }
function chartHover(e) {
  if (!S.game) return;
  const g = S.game; const t = chartTime(e); const st = stateAt(g, t); const c = smoothAt(g, 's10', t);
  S.chartHoverT = t; drawChart();
  const evs = g.kills.filter(k => Math.abs(k.t - t) < 8).length;
  const near = [...g.objectives.filter(o => Math.abs(o.t - t) < 10).map(o => `${TEAM_NAME[o.team]}: ${o.name}`),
    ...g.structureEvents.filter(s => Math.abs(s.t - t) < 10).map(s => `${TEAM_NAME[s.team]}: ${s.label}`)];
  const rv = S.review ? S.review.actions.filter(a => a.pids.includes(S.revPid) && a.grade !== 'ok' && a.kind !== 'farm' && a.kind !== 'vision' && Math.abs(a.t - t) < 12) : [];
  const gdv = st.raw.goldB - st.raw.goldR;
  const tip = $('chartTip');
  tip.innerHTML = `<b>${fmtTime(t)}</b> · ${g.wpm ? 'win chance' : 'control'}: Blue ${Math.round(50 + 50 * c)}% / Red ${Math.round(50 - 50 * c)}%<br>
    Gold: ${gdv === 0 ? 'even' : `${gdv > 0 ? 'Blue' : 'Red'} +${fmtGold(Math.abs(gdv), false)}`}${evs ? ` · ${evs} kill${evs > 1 ? 's' : ''} nearby` : ''}` +
    (near.length ? '<br>' + near.map(esc).join('<br>') : '') +
    (rv.length ? '<br>' + rv.map(a => `${GRADES[a.grade].sym} ${esc(a.title)}`).join('<br>') : '');
  const wrap = tip.parentElement.getBoundingClientRect();
  tip.style.left = Math.max(0, Math.min(e.clientX - wrap.left + 12, wrap.width - 300)) + 'px'; tip.style.top = '6px';
  tip.classList.remove('hidden');
}

// ================================================================ tabs
function renderTabs() {
  for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === S.tab);
  const g = S.game; if (!g) return;
  const body = $('tabBody');
  body.innerHTML = ({ review: tabReview, phases: tabPhases, moments: tabMoments, objectives: tabObjectives, me: tabMe, how: tabHow })[S.tab](g);
  for (const el of body.querySelectorAll('[data-seek]')) el.onclick = ev => {
    if (ev.target.closest('select')) return;
    ev.preventDefault();
    seek(+el.dataset.seek); S.playing = false; updatePlayBtn(); drawChart();
    $('mapWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  for (const el of body.querySelectorAll('[data-pick]')) el.onclick = () => { S.revPid = +el.dataset.pick; S.revSel = null; renderTabs(); renderMoves(); drawChart(); };
  const sel = body.querySelector('#meSel');
  if (sel) sel.onchange = () => {
    markMe(g, +sel.value); S.revPid = S.mePid;
    renderTabs(); renderMoves();
  };
}
const chip = (txt, cls = '') => `<span class="chip ${cls}">${esc(txt)}</span>`;
const evChips = evs => evs.length ? `<div class="chips">${evs.map(e => chip(`${fmtTime(e.t)} ${e.text}`, teamCls(e.team))).join('')}</div>` : '';

function tabPhases(g) {
  const reasonTxt = { gold: 'gold lead', xp: 'level lead', vision: 'vision', map: 'map territory & forward positioning', obj: 'objectives (towers/drakes/buffs)', numbers: 'numbers after fights' };
  const total = { 100: 0, 200: 0, 0: 0 }; g.phases.forEach(p => (total[p.leader] += p.end - p.start));
  const head = `<div class="stat-row">
    <div class="stat"><b class="blue">${fmtTime(total[100])}</b><span>Blue in control</span></div>
    <div class="stat"><b class="red">${fmtTime(total[200])}</b><span>Red in control</span></div>
    <div class="stat"><b>${fmtTime(total[0])}</b><span>Contested / even</span></div>
    <div class="stat"><b>${g.phases.length}</b><span>Control phases</span></div></div>`;
  return head + '<div class="list">' + g.phases.map(p => {
    const title = p.leader ? `<span class="${teamCls(p.leader)}">${TEAM_NAME[p.leader]}</span> in control · avg ${Math.round(50 + Math.abs(p.mean) * 50)}%${g.wpm ? ' win chance' : ''}` : 'Contested — no clear control';
    const why = p.reasons.length ? `Driven by ${p.reasons.map(r => reasonTxt[r]).join(', ')}.` : 'Resources and map were roughly even.';
    const gold = `Gold went from ${fmtGold(p.goldStart)} to ${fmtGold(p.goldEnd)} (Blue perspective).`;
    const killsB = g.kills.filter(k => k.t >= p.start && k.t <= p.end && k.team === 100).length;
    const killsR = g.kills.filter(k => k.t >= p.start && k.t <= p.end && k.team === 200).length;
    const ending = p.endEvents.length ? `<p><b>What changed it:</b> ${p.endEvents.map(e => `${fmtTime(e.t)} ${esc(e.text)}`).join(' → ')}</p>` :
      (p !== g.phases[g.phases.length - 1] ? '<p><b>What changed it:</b> no single fight — a gradual shift in positioning, vision or farm.</p>' : '');
    const notable = p.events.filter(e => e.kind !== 'fight' || e.text.startsWith('Teamfight'));
    return `<div class="item ${teamCls(p.leader)}" data-seek="${p.start}">
      <div class="when"><b>${fmtTime(p.start)}–${fmtTime(p.end)}</b>${fmtTime(p.end - p.start)}</div>
      <div><h4>${title}</h4><p>${why} ${gold} Kills ${killsB}–${killsR}.</p>${evChips(notable)}${ending}</div></div>`;
  }).join('') + '</div>';
}

function tabMoments(g) {
  const driverTxt = { gold: 'a gold swing (farm, plates or bounties)', xp: 'an experience swing', vision: 'a vision swing (wards placed / cleared)',
    map: 'a positioning shift — they moved forward and took territory', obj: 'objectives', numbers: 'a numbers advantage' };
  const unit = g.wpm ? 'win chance' : 'control';
  if (!g.moments.length) return `<p class="muted">No large ${unit} swings in this game — it was decided gradually.</p>`;
  return `<p class="muted small">The biggest swings in ${unit} (measured over ~80 seconds). Click to jump there and watch what happened.</p><div class="list">` +
    g.moments.map(m => {
      const fights = m.events.filter(e => e.kind === 'fight');
      const head = `<span class="${teamCls(m.team)}">${TEAM_NAME[m.team]}</span> gained ${Math.round(Math.abs(m.delta) * 50)} ${g.wpm ? 'points of win chance' : 'points of control'}`;
      const desc = m.events.length ? '' : `<p>No fight or objective — caused by ${driverTxt[m.driver]}.</p>`;
      const lesson = fights.length && m.events.some(e => e.kind !== 'fight' && e.team === m.team)
        ? `<p class="muted">${TEAM_NAME[m.team]} converted the fight into map objectives — this is the core macro pattern: win fight → take what's nearby.</p>`
        : fights.length && !m.events.some(e => e.kind !== 'fight') ? `<p class="muted">The fight wasn't converted into an objective — check if anything was available nearby.</p>` : '';
      return `<div class="item ${teamCls(m.team)}" data-seek="${Math.max(0, m.from)}">
        <div class="when"><b>${fmtTime(m.t)}</b>${fmtTime(m.from)}–${fmtTime(m.to)}</div>
        <div><h4>${head}</h4>${desc}${evChips(m.events)}${lesson}</div></div>`;
    }).join('') + '</div>';
}

function tabObjectives(g) {
  if (!g.objectiveReview.length) return '<p class="muted">No epic monsters were taken.</p>';
  const towers = g.structureEvents.filter(s => s.kind === 'tower');
  const first = towers[0];
  const head = `<div class="stat-row">${[100, 200].map(t => {
    const d = g.objectives.filter(o => o.team === t && o.key === 'DRAGON').length;
    const b = g.objectives.filter(o => o.team === t && o.key === 'BARON_NASHOR').length;
    const tw = towers.filter(s => s.team === t).length;
    return `<div class="stat"><b class="${teamCls(t)}">${tw} / ${d} / ${b}</b><span>${TEAM_NAME[t]} towers / drakes / barons</span></div>`;
  }).join('')}${first ? `<div class="stat"><b class="${teamCls(first.team)}">${fmtTime(first.t)}</b><span>First tower (${TEAM_NAME[first.team]})</span></div>` : ''}</div>`;
  return head + '<div class="list">' + g.objectiveReview.map(o => {
    const other = ENEMY[o.team];
    const chips = [
      chip(`${g.wpm ? 'Win chance' : 'Control'} before: ${Math.round(50 + o.before * 50)}% ${TEAM_NAME[o.team]}`, o.before > 0.1 ? 'good' : o.before < -0.1 ? 'warn' : ''),
      chip(`Vision ≈${o.visionTaker.toFixed(0)} vs ${o.visionOther.toFixed(0)}`, o.visionTaker > o.visionOther ? 'good' : ''),
      chip(`Nearby ${o.near[o.team]}v${o.near[other]}`),
      chip(`Alive ${o.aliveTaker}v${o.aliveOther}`, o.aliveOther < 5 ? 'warn' : ''),
    ].join('');
    const trades = o.trades.length ? `<p class="muted">${TEAM_NAME[other]} traded: ${o.trades.map(e => esc(e.text.replace(/^(Blue|Red) /, ''))).join(', ')}</p>`
      : o.near[other] <= 1 ? `<p class="muted">${TEAM_NAME[other]} had ${o.near[other]} player${o.near[other] === 1 ? '' : 's'} nearby and got nothing in return — a free objective.</p>` : '';
    return `<div class="item ${teamCls(o.team)}" data-seek="${Math.max(0, o.t - 40)}">
      <div class="when"><b>${fmtTime(o.t)}</b>${esc(o.name)}</div>
      <div><h4><span class="${teamCls(o.team)}">${TEAM_NAME[o.team]}</span> took ${esc(o.name)}</h4><p>${esc(o.verdict)}</p><div class="chips">${chips}</div>${trades}</div></div>`;
  }).join('') + '</div>';
}

function tabMe(g) {
  const opts = g.ps.map(p => `<option value="${p.id}" ${p.id === S.mePid ? 'selected' : ''}>${TEAM_NAME[p.team]} · ${esc(p.cname)} — ${esc(p.name)}</option>`).join('');
  const sel = `<div class="me-head"><span>Player:</span><select id="meSel">${S.mePid ? '' : '<option>Choose yourself…</option>'}${opts}</select>
    <span class="muted small">Auto-detected as the person who appears in most of your replays.</span></div>`;
  if (!S.mePid) return sel;
  const R = playerReport(g, S.mePid); const p = R.p;
  const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '–';
  const ours = R.objPresence; const present = ours.filter(o => o.present).length;
  const stats = `<div class="stat-row">
    <div class="stat"><b>${p.deaths.length}</b><span>Deaths · ${fmtTime(R.deadTime)} spent dead</span></div>
    <div class="stat"><b>${pct(R.enemyHalf, R.aliveT)}</b><span>Time on the enemy half (alive)</span></div>
    <div class="stat"><b>${pct(R.alone, R.aliveT)}</b><span>Time far (5000+) from every ally</span></div>
    <div class="stat"><b>${present}/${ours.length}</b><span>Epic objectives you were near</span></div>
    <div class="stat"><b>${R.deaths.filter(d => d.terr < -0.2).length}</b><span>Deaths in enemy territory</span></div></div>`;
  const zTot = Object.values(R.zones).reduce((a, b) => a + b, 0) || 1;
  const zones = Object.entries(R.zones).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([z, v]) =>
    `<div class="zone-bar"><span>${esc(z)}</span><div><i style="width:${v / zTot * 100}%"></i></div><span class="r">${Math.round(v / zTot * 100)}%</span></div>`).join('');
  const deaths = R.deaths.map((d, i) => `<div class="item ${teamCls(ENEMY[p.team])}" data-seek="${Math.max(0, d.t - 20)}">
      <div class="when"><b>${fmtTime(d.t)}</b>Death ${i + 1}</div>
      <div><h4>${esc(d.zone)}${d.killer && g.byId[d.killer] ? ` — killed by ${esc(g.byId[d.killer].cname)}` : ''}</h4>
      <div class="chips">${d.tags.map(x => chip(x.t, x.c)).join('')}</div>
      <ul>${d.tips.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div></div>`).join('');
  const objs = ours.map(o => `<div class="item ${teamCls(o.team)}" data-seek="${Math.max(0, o.t - 40)}">
      <div class="when"><b>${fmtTime(o.t)}</b>${o.ours ? 'Your team' : 'Enemy'}</div>
      <div><h4>${esc(o.name)} — ${o.dead ? 'you were dead' : o.present ? 'you were there' : `you were ${Math.round(o.distance / 100) * 100} units away`}</h4>
      ${!o.ours && !o.dead && !o.present ? '<p class="muted">Enemy took it while you were elsewhere. Were you getting something equal (tower, plates, a pick) in return?</p>' : ''}
      ${!o.ours && o.dead ? '<p class="muted">You were dead when it was taken — your death likely opened this window.</p>' : ''}</div></div>`).join('');
  return sel + stats + `<h4 class="sec">Where you spent your time</h4><div class="zone-bars">${zones}</div>` +
    `<h4 class="sec">Your deaths, in context</h4>${deaths ? `<div class="list">${deaths}</div>` : '<p class="muted">No deaths — nice.</p>'}` +
    `<h4 class="sec">Objective presence</h4><div class="list">${objs || '<p class="muted">No epic objectives this game.</p>'}</div>`;
}

// what one unit of each feature is worth, in points of win chance from an even game, at a given time
const WP_UNIT = {
  gold: ['+1,000 team gold', 1], xp: ['+1,000 team XP', 1], towerOuter: ['an outer tower', 1], towerInner: ['an inner tower', 1],
  towerBase: ['an inhibitor tower', 1], towerNexus: ['a nexus tower', 1], inhib: ['an enemy inhibitor down', 1],
  dragon: ['a drake', 1], soul: ['dragon soul', 1], elder: ['Elder buff (active)', 1], baron: ['Baron buff (active)', 1],
  grubs: ['a Voidgrub', 1], herald: ['Rift Herald', 1], alive: ['one more champion alive', 1],
  deadTime: ['one more minute of enemy death timers', 1], territory: ['+10% of the map', 0.1], pressure: ['standing 10% further forward', 0.1],
  vision: ['+5 wards alive', 1],
};
function wpUnitValue(m, k, t) {
  const w = knotWeights(m.knots, t); const b = (m.coef[k] || []).reduce((a, c, i) => a + c * w[i], 0) * WP_UNIT[k][1];
  return 100 * (1 / (1 + Math.exp(-b)) - 0.5);
}
function tabHowTrained() {
  const M = window.WP_MODEL, m = M.full, met = M.metrics || {}, val = M.validation || {};
  const pc = x => (x == null ? '–' : `${(x * 100).toFixed(1)}%`);
  const rows = m.feats.map(k => `<tr><td>${WP_UNIT[k][0]}</td><td>${FACTOR_LABEL[WP_GROUP[k] || 'obj']}</td><td>${fmtWp1(wpUnitValue(m, k, 900))}</td><td>${fmtWp1(wpUnitValue(m, k, 1800))}</td></tr>`).join('');
  const n = M.norms || {}; const q = (k, p) => (n[k] ? n[k][Math.round(p / 2)] : null);
  const OV = n.objValue || {};
  const ovAt = (k, t) => { const T = OV[k]; if (!T || t < T[0][0] - 300 || t > T[T.length - 1][0] + 600) return null;
    if (t <= T[0][0]) return T[0][1]; for (let i = 1; i < T.length; i++) if (t <= T[i][0]) return T[i - 1][1] + (T[i][1] - T[i - 1][1]) * (t - T[i - 1][0]) / (T[i][0] - T[i - 1][0]);
    return T[T.length - 1][1]; };
  const OBJ_LABEL = { HORDE: 'Voidgrubs (a group)', RIFTHERALD: 'Rift Herald', DRAGON: 'a drake', DRAGON_SOUL: 'the soul drake', BARON_NASHOR: 'Baron Nashor', ELDER: 'Elder Dragon' };
  const cell = v => (v == null ? '–' : fmtWp1(v));
  const objRows = Object.keys(OBJ_LABEL).filter(k => OV[k]).map(k => `<tr><td>${OBJ_LABEL[k]}</td><td></td><td>${cell(ovAt(k, 900))}</td><td>${cell(ovAt(k, 1800))}</td></tr>`).join('');
  const band = (k, bands) => n[k] ? bands.map(p => `${q(k, p).toFixed(1)}%`).join(' / ') : 'not calibrated';
  return `<div class="how">
    <p>The <b>win chance</b> is a model trained on <b>${M.games.toLocaleString()} ranked games of Challenger, Grandmaster and Master players</b> (patches ${M.patches[0]}–${M.patches[M.patches.length - 1]}, trained ${M.trainedAt}). It's a logistic regression on the game state whose weights change with game time (a gold lead is worth more later). Every weight is constrained to be ≥ 0, so having more of something can never lower your chances.</p>
    <p><b>How well it predicts</b> ${met.rotation ? `(${met.rotation.games.toLocaleString()} high-elo games, each judged by a version of the model that never trained on it): it names the eventual winner in <b>${pc(met.rotation.full.acc)}</b> of moments (gold lead alone: ${pc(met.rotation.goldOnly.acc)}; the old hand-set control score: ${pc(met.rotation.legacyControl.acc)}).` : `(on ${met.heldOutGames || '–'} high-elo games it never saw): it names the eventual winner in <b>${pc(met.full && met.full.accuracy)}</b> of moments (gold lead alone: ${pc(met.goldOnly && met.goldOnly.accuracy)}; the old hand-set control score: ${pc(met.legacyControl && met.legacyControl.accuracy)}).`}${val.user ? ` On a separate set of ${val.user.games} ordinary ranked and custom games: <b>${pc(val.user.winnerCalled)}</b> minute by minute (old score ${pc(val.user.legacyWinnerCalled)}).` : ''}</p>
    <h4 class="sec">What each thing is worth</h4>
    <p class="muted small">Win-chance points from an even game, holding everything else equal, as learned from high-elo games.</p>
    <table><tr><th>One extra…</th><th>Factor</th><th>at 15:00</th><th>at 30:00</th></tr>${rows}</table>
    ${objRows ? `<p class="muted small">Epic monsters are graded by their <b>total</b> effect: how much the taking team's win chance rose on average over the next 90 seconds in Master+ games, which includes the towers and fights they usually lead to. (Holding everything else equal, as above, a buff adds little on its own: most of its value arrives as towers fall.)</p>
    <table><tr><th>Taking…</th><th></th><th>at 15:00</th><th>at 30:00</th></tr>${objRows}</table>` : ''}
    <h4 class="sec">How actions are graded</h4>
    <p>Every action is valued by how much it moved your team's win chance, and the grade comes from comparing that with the same kind of action in ${(M.normsGames || 0).toLocaleString()} Master+ games:</p>
    <ul>
      <li><b>Deaths</b>: the cost of the death itself (the same moment with you alive and no bounty paid), plus your share of whatever the enemy took while you were dead, minus what your team got for it. <i>Inaccuracy</i> = costlier than 60% of high-elo deaths, <i>Mistake</i> 85%, <i>Blunder</i> 96% (currently ${band('deathCost', [60, 85, 96])}).</li>
      <li><b>Fights</b>: the swing in win chance from just before to just after the fight. A lost fight is an <i>Inaccuracy</i> when it cost more than half of high-elo lost fights, a <i>Mistake</i> above 80%, a <i>Blunder</i> above 95%. A won fight is <i>Great</i> when its swing beats 65% of won fights, and <i>Brilliant</i> when it's in the top 8% and was won while outnumbered and behind.</li>
      <li><b>After a won fight</b>: if your team took nothing and what it built over the next 90 s (gold, towers, objectives, map) fell short of 75% of high-elo teams after a won fight, it's a <i>Miss</i>.</li>
      <li><b>Objectives</b>: what the objective was worth at that moment, minus anything you traded for it. Giving one up cheaply is OK; giving up an expensive one for free is a <i>Mistake/Blunder</i>.</li>
      <li><b>Laning</b>: your 14:00 gold + XP lead over your lane opponent converted into win chance, compared with Master+ laners. <b>Farming / vision</b>: your per-minute rates against Master+ players in your role.</li>
      <li><b>Recalls, unspent gold, missed teamfights</b>: rule-based (backing just before an enemy objective, 1,500+ gold carried for minutes, far from a lost teamfight), with severity from the win chance at stake.</li>
    </ul>
    <p>Accuracy = weighted average of action scores (Brilliant/Great 100, Good 92, OK 80, Inaccuracy 58, Miss 45, Mistake 30, Blunder 5); actions with more win chance at stake weigh more.${val.highElo ? ` In held-out high-elo games, the winning team averaged <b>${val.highElo.teamAccuracy.winners}</b> accuracy vs <b>${val.highElo.teamAccuracy.losers}</b> for the losers.` : ''}</p>
    <p><b>Limits:</b> it's a correlational model of what tends to win high-elo games. It can't see health, cooldowns, item spikes or ward positions, and it doesn't suggest the best alternative move like a chess engine does. Positions between the once-a-minute snapshots are estimated along lanes and jungle paths. Custom games have no ward data, so they use a version of the model without vision.</p>
    <p class="muted small">Replay Analyzer isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.</p></div>`;
}
const fmtWp1 = v => (Math.abs(v) < 0.05 ? '0.0%' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`);

function tabHow() {
  if (window.WP_MODEL && window.WP_MODEL.full) return tabHowTrained();
  const rows = Object.keys(WEIGHTS).map(k => `<tr><td><b>${FACTOR_LABEL[k]}</b></td><td>${Math.round(WEIGHTS[k] * 100)}%</td><td>${({
    gold: 'Team gold difference, scaled to game stage (a 2k lead at 10 min matters more than at 35 min).',
    xp: 'Team experience difference, scaled the same way.',
    vision: 'Estimated wards alive per team. Built from every ward-placed and ward-killed event, with trinket/ward lifetimes and per-player ward limits.',
    map: 'Territory: every point on the map is assigned to whichever team exerts more presence there (alive champions weighted by gold, plus alive towers). Also how far forward each team is standing.',
    obj: 'Towers, plates, inhibitors (while down), drakes, soul, Elder/Baron buffs (while active), Rift Herald and Voidgrubs. (Older 2025-season games also credit Atakhan, which only existed that season.)',
    numbers: 'How many champions are alive on each side (spikes after fights).',
  })[k]}</td></tr>`).join('');
  return `<div class="how"><p>The <b>control score</b> blends six factors into one number from 0–100% per team. Each factor is squashed to −1…+1 so no single factor can dominate.</p>
    <table><tr><th>Factor</th><th>Weight</th><th>What it measures</th></tr>${rows}</table>
    <p><b>Control phases</b> are stretches where the smoothed score stays above 56% for one team (shorter blips under a minute are merged). <b>Turning points</b> are the biggest 80-second swings.</p>
    <h4 class="sec">How actions are graded</h4>
    <p>Every action is graded by how it changed your team's position and by the situation it happened in:</p>
    <ul>
      <li><b>Deaths</b>: where you died (whose territory), how many allies vs enemies were nearby, vision, whether your team was ahead, unspent gold or bounty, and what the enemy took afterwards. A death inside a fight your team won counts as a trade.</li>
      <li><b>Fights</b>: the result compared with the odds before it (numbers nearby, gold, territory). Winning from behind is <i>Brilliant/Great</i>; losing a favourable fight is a <i>Mistake</i>. Winning a fight and taking nothing afterwards is a <i>Miss</i>.</li>
      <li><b>Objectives</b>: the setup (won fight before, map control, numbers at the pit). Giving one up with no fight and no trade while even or ahead is a <i>Mistake/Blunder</i>; conceding while behind is OK.</li>
      <li><b>Absent from teamfights</b>: alive but more than 5000 units away while your team lost a teamfight, with no cross-map trade.</li>
      <li><b>Recalls</b>: backing right before an enemy objective or a lost fight is penalised; resetting on tempo with a big item spike is <i>Good</i>.</li>
      <li><b>Gold</b>: carrying 1500+ unspent gold across several minute frames. <b>Laning</b>: CS/gold/XP against your lane opponent at 14:00. <b>Farming</b> and <b>vision</b>: per-minute rates against role benchmarks.</li>
    </ul>
    <p>Accuracy = weighted average of action scores (Brilliant/Great 100, Good 92, OK 80, Inaccuracy 58, Miss 45, Mistake 30, Blunder 5). Important actions (deaths before Baron, laning, big fights) weigh more than routine ones.</p>
    <p><b>Data limits:</b> Riot's timeline records each player's exact position once a minute and at every kill, tower and epic monster they're part of. Between those points the app draws a straight line, and infers recalls from shop purchases. Ward <i>locations</i> aren't recorded, only counts. Treat the map as a strong approximation, not a frame-perfect recording. For exact micro, open the replay in the client at the timestamps this app points you to.</p>
    <p><b>How to use it:</b> watch where the territory colour shifts before objectives spawn, check which team moved first, and use "My game" to find deaths where you walked into enemy-controlled space without vision or numbers.</p></div>`;
}

// ================================================================ game review (moves)
const badge = k => `<span class="badge" style="background:${GRADES[k].color};color:${GRADES[k].ink}" title="${GRADES[k].label}">${GRADES[k].sym}</span>`;
const fmtAcc = a => (a == null ? '–' : a.toFixed(1));
function accColor(a) { return a == null ? 'var(--muted)' : a >= 90 ? GRADES.great.color : a >= 80 ? GRADES.good.color : a >= 68 ? GRADES.inaccuracy.color : a >= 50 ? GRADES.mistake.color : GRADES.blunder.color; }
const MOVE_FILTERS = {
  key: { label: 'Key moves', fn: a => !(a.grade === 'ok' && (a.routine || a.kind === 'fight' || a.kind === 'objective-lost')) },
  bad: { label: 'Mistakes', fn: a => BAD_GRADES.has(a.grade) },
  good: { label: 'Highlights', fn: a => a.grade === 'brilliant' || a.grade === 'great' },
  all: { label: 'All', fn: () => true },
};
function movesFor(pid) { return S.review ? S.review.actions.filter(a => a.pids.includes(pid) && MOVE_FILTERS[S.revFilter].fn(a)) : []; }
function evalTxt(a) {
  if (a.kind === 'farm' || a.kind === 'vision' || a.before == null) return '';
  if (a.dwp != null) { // trained model: the action's effect on your team's win chance
    const v = a.dwp, col = v > 0.5 ? 'var(--good)' : v < -0.5 ? 'var(--bad)' : 'var(--muted)';
    return `<span class="ev" style="color:${col}" title="Change in your team's win chance from this action (model trained on Master+ games)">${fmtWp1(v)}</span>`;
  }
  const d = a.after - a.before; const col = d > 2 ? 'var(--good)' : d < -2 ? 'var(--bad)' : 'var(--muted)';
  return `<span class="ev" style="color:${col}" title="Your team's win chance before → after">${Math.round(a.before)}→${Math.round(a.after)}%</span>`;
}
function renderMoves() {
  const g = S.game; const box = $('moves'); if (!g || !S.review) { box.innerHTML = ''; return; }
  const pid = S.revPid; const sum = S.review.players[pid]; const list = movesFor(pid);
  const idx = list.findIndex(a => a.id === S.revSel);
  const opts = g.ps.map(p => `<option value="${p.id}" ${p.id === pid ? 'selected' : ''}>${p.id === S.mePid ? '★ ' : ''}${TEAM_NAME[p.team]} · ${esc(p.cname)} — ${esc(p.name)}</option>`).join('');
  const isMe = pid === S.mePid;
  box.innerHTML = `<div class="mv-head"><select id="mvSel">${opts}</select>
      <button class="btn ghost" id="mvMe" title="${isMe ? 'This is you' : 'Mark this player as you (remembered for your other replays)'}">${isMe ? '★ You' : '☆ This is me'}</button>
      <div class="mv-acc" style="color:${accColor(sum.accuracy)}">${fmtAcc(sum.accuracy)}<small>accuracy</small></div></div>
    <div class="mv-filters">${Object.entries(MOVE_FILTERS).map(([k, f]) => `<button data-f="${k}" class="${S.revFilter === k ? 'on' : ''}">${f.label}</button>`).join('')}</div>
    <div class="rv-nav"><button id="mvPrev" title="Previous move (,)">◀ Prev</button><span class="grow">${idx >= 0 ? idx + 1 : '–'} / ${list.length} moves</span><button id="mvNext" title="Next move (.)">Next ▶</button></div>
    <div class="mv-list" id="mvList">${list.map(a => {
      const sel = a.id === S.revSel;
      const detail = sel ? `<div class="rv-detail" style="border-left-color:${GRADES[a.grade].color}">
          <p><b style="color:${GRADES[a.grade].color}">${GRADES[a.grade].label}.</b> ${esc(a.detail)}</p>
          ${a.better ? `<p class="better"><b>Better:</b> ${esc(a.better)}</p>` : ''}
          ${a.tags && a.tags.length ? `<div class="chips">${a.tags.map(t => chip(t)).join('')}</div>` : ''}
          <button class="btn" data-watch="${a.id}">▶ Watch this moment</button>${LV.playbackOk && !(typeof rsControl === 'function' && rsControl()) ? ` <button class="btn ghost" data-jump="${a.t}">⏩ Jump League replay here</button>` : ''}</div>` : '';
      return `<div class="rv-move ${sel ? 'sel' : ''}" data-act="${a.id}"><span class="t">${fmtTime(a.t)}</span>${badge(a.grade)}<span class="ttl">${esc(a.title)}</span>${evalTxt(a)}</div>${detail}`;
    }).join('') || '<p class="muted small">No moves match this filter.</p>'}</div>`;
  $('mvSel').onchange = e => { S.revPid = +e.target.value; S.revSel = null; renderMoves(); drawChart(); if (S.tab === 'review') renderTabs(); };
  for (const b of box.querySelectorAll('[data-f]')) b.onclick = () => { S.revFilter = b.dataset.f; renderMoves(); };
  for (const el of box.querySelectorAll('[data-act]')) el.onclick = () => selectAction(+el.dataset.act, S.revSel !== +el.dataset.act);
  for (const el of box.querySelectorAll('[data-watch]')) el.onclick = e => { e.stopPropagation(); watchAction(+el.dataset.watch); };
  for (const el of box.querySelectorAll('[data-jump]')) el.onclick = e => { e.stopPropagation(); jumpLeagueReplay(+el.dataset.jump - 10); };
  $('mvMe').onclick = () => { if (pid !== S.mePid) { markMe(g, pid); renderMoves(); renderTabs(); drawMap(); loadReplayList(); } };
  $('mvPrev').onclick = () => stepMove(-1); $('mvNext').onclick = () => stepMove(1);
  const selEl = box.querySelector('.rv-move.sel');
  if (selEl) { const L = $('mvList'); const top = selEl.offsetTop - L.offsetTop; if (top < L.scrollTop || top > L.scrollTop + L.clientHeight - 60) L.scrollTop = top - 40; }
}
function selectAction(id, on = true) {
  const a = S.review.actions[id];
  S.revSel = on ? id : null;
  if (on && a) {
    S.playing = false; endWatch(); updatePlayBtn();
    if (a.kind !== 'farm' && a.kind !== 'vision') seek(Math.max(0, a.t - 3));
    S.focus = a.actor || null;
    if (typeof rsControl === 'function' && rsControl() && a.kind !== 'farm' && a.kind !== 'vision') rsPlayback({ paused: true });
  }
  renderMoves(); drawChart();
}
function watchAction(id) {
  const a = S.review.actions[id]; if (!a) return;
  S.revSel = id; S.focus = a.actor || null;
  if (typeof rsControl === 'function' && rsControl()) { S.t = Math.max(0, a.t - 12); rsWatch(a.t - 12, a.t + 8); renderMoves(); return; }
  seek(Math.max(0, a.t - 15)); S.savedSpeed = +$('speed').value; S.speed = 3; S.stopAt = a.t + 8; S.playing = true; updatePlayBtn();
  renderMoves();
}
function stepMove(dir) {
  const list = movesFor(S.revPid); if (!list.length) return;
  let i = list.findIndex(a => a.id === S.revSel);
  if (i < 0) { i = dir > 0 ? list.findIndex(a => a.t >= S.t - 1) : list.length - 1; if (i < 0) i = list.length - 1; }
  else i = clamp(i + dir, 0, list.length - 1);
  selectAction(list[i].id, true);
}

function tabReview(g) {
  const R = S.review; const pid = S.revPid;
  const teamBlock = team => `<div><div class="rv-team-head"><b class="${teamCls(team)}">${TEAM_NAME[team]}${g.winner === team ? ' · Victory' : ''}</b>
      <span>team accuracy <b style="color:${accColor(R.teams[team].accuracy)}">${fmtAcc(R.teams[team].accuracy)}</b></span></div>` +
    g.ps.filter(p => p.team === team).map(p => {
      const s = R.players[p.id];
      const mini = ['brilliant', 'great', 'inaccuracy', 'mistake', 'blunder'].map(k => s.counts[k] ? `<span>${badge(k)}${s.counts[k]}</span>` : '').join('');
      return `<div class="rv-prow ${p.id === pid ? 'sel' : ''} ${p.id === S.mePid ? 'you' : ''}" data-pick="${p.id}" title="Review this player">
        <img src="/asset/champ/${encodeURIComponent(p.champ)}.png" alt=""><span class="nm">${esc(p.name)} <small>${esc(p.cname)} · ${esc(ROLE_SHORT[p.role] || '')}</small></span>
        <span class="acc" style="color:${accColor(s.accuracy)}">${fmtAcc(s.accuracy)}</span><span class="mini">${mini}</span></div>`;
    }).join('') + '</div>';
  const p = g.byId[pid]; const s = R.players[pid];
  const counts = GRADE_ORDER.map(k => `<div class="rv-count">${badge(k)}<span>${GRADES[k].label}</span><b>${s.counts[k]}</b></div>`).join('');
  const phases = s.phases.map(ph => { const L = phaseLabel(ph.accuracy); return `<div class="rv-phase"><span>${ph.label}</span>${ph.n ? badge(L.grade) : '<span></span>'}<b>${ph.n ? L.label : 'No key moves'}</b><span class="muted">${fmtAcc(ph.accuracy)}</span></div>`; }).join('');
  const notes = s.notes.map(n => `<li class="${n.tone}">${esc(n.text)}</li>`).join('');
  const worst = R.actions.filter(a => a.pids.includes(pid) && BAD_GRADES.has(a.grade)).sort((a, b) => (GRADE_ORDER.indexOf(b.grade) - GRADE_ORDER.indexOf(a.grade)) || b.weight - a.weight).slice(0, 3);
  const worstHtml = worst.length ? `<h4 class="sec">Biggest mistakes</h4><div class="list">${worst.map(a => `<div class="item" data-seek="${Math.max(0, a.t - 15)}" style="border-left-color:${GRADES[a.grade].color}">
      <div class="when"><b>${fmtTime(a.t)}</b>${GRADES[a.grade].label}</div><div><h4>${badge(a.grade)} ${esc(a.title)}</h4><p>${esc(a.detail)}</p>${a.better ? `<p class="muted"><b>Better:</b> ${esc(a.better)}</p>` : ''}</div></div>`).join('')}</div>` : '';
  const myTeam = S.mePid ? g.byId[S.mePid].team : null;
  const story = gameStory(g, myTeam).map(x => `<li><a href="#" class="ts" data-seek="${Math.max(0, x.t - 10)}">${fmtTime(x.t)}</a> ${esc(x.text)}</li>`).join('');
  let debrief = '';
  if (g.live && g.live.me && g.byId[g.live.me]) {
    const mp = g.byId[g.live.me], mins = g.duration / 60;
    const plan = typeof focusPlan === 'function' ? focusPlan(mp.champ, mp.role) : null;
    const actual = { deaths: mp.deaths.length, cspm: ((mp.final.totalMinionsKilled || 0) + (mp.final.neutralMinionsKilled || 0)) / mins, vspm: (mp.final.visionScore || 0) / mins };
    const goals = plan ? plan.goals.map(gl => { const v = actual[gl.key]; const ok = gl.better === 'low' ? v <= gl.target : v >= gl.target;
      return chip(`${ok ? '✓' : '✗'} ${goalTxt(gl)} — you: ${fmtGoal(gl, v)}`, ok ? 'good' : 'bad'); }).join('') : '';
    const deadFor = mp.deaths.reduce((a, d) => a + (d.respawn - d.t), 0);
    debrief = `<div class="card-inner story"><h4 class="sec" style="margin-top:0">Your debrief <span class="muted small">recorded live</span></h4>
      ${goals ? `<div class="chips">${goals}</div>` : ''}
      <p class="small muted" style="margin:6px 0 0">Recorded during the game: exact item buys and levels for all ten players${g.live.synthetic ? ` (${g.live.synthetic} events added to the match data)` : ''}, your gold and health every 2 seconds, and exact death timers (${fmtTime(deadFor)} spent dead).</p></div>`;
  }
  return `${debrief}<div class="card-inner story"><h4 class="sec" style="margin-top:0">Game story</h4><ul class="story-list">${story}</ul></div>
    <div class="rv-grid">${teamBlock(100)}${teamBlock(200)}</div>
    <div class="rv-player">
      <div class="rv-big"><img src="/asset/champ/${encodeURIComponent(p.champ)}.png" alt=""><div class="num" style="color:${accColor(s.accuracy)}">${fmtAcc(s.accuracy)}</div>
        <div class="lbl">${esc(p.name)} · ${esc(p.cname)}<br>accuracy over ${s.n} graded actions</div></div>
      <div><div class="rv-counts">${counts}</div></div>
      <div><div class="rv-phases">${phases}</div><h4 class="sec" style="margin-top:4px">Coach's notes</h4><ul class="notes">${notes}</ul></div>
    </div>${worstHtml}
    <p class="muted small" style="margin-top:12px">Step through every graded action in the <b>Moves</b> panel next to the map (keys <code>,</code> / <code>.</code>). Accuracy is a weighted average of all of a player's graded actions.</p>`;
}

init();
