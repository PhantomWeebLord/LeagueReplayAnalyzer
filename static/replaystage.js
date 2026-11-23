'use strict';
/* =====================================================================
   v2 — the real replay instead of a recreation.
   League plays the replay in its own replay player. This window shows that player live (a capture of
   League's window only), drives it through Riot's Replay API (seek, pause, speed, fog of war, selection)
   and keeps the review, eval bar, chart and coach notes in sync with it.
   League can only play replays from its current patch; older replays fall back to the recreated map.
   ===================================================================== */
/* global S, $, api, esc, banner, clamp, fmtTime, updatePlayBtn, LV, TEAM_NAME, sizeCanvases, drawChart, mapImg */

const RS = {
  view: 'replay',        // what the stage shows: 'replay' (League's player) | 'map' (recreated map)
  userView: null,        // view the user picked for this game (overrides the automatic choice)
  st: null,              // last /api/replay/status
  phase: 'none',
  pb: null, pbAt: 0,     // League's playback state and when it arrived
  pending: null,         // { t, at }: a seek we asked for that League hasn't reached yet
  stream: null,          // capture of League's window
  opening: 0,            // when we asked League to open the replay
  broughtBack: false,    // already brought this window back to the front after League opened
  names: null,           // pid -> player name inside the replay (League selects players by name)
  camPid: null,          // whose stats panel League is showing (the selected player)
  stopAt: null, restoreSpeed: null,
  fog: true, replayBar: false,
  timer: null, lastSend: 0, sendTimer: null, busy: false, sig: '', restoreAt: 0,
  gen: 0,                // poll generation: a newer poll supersedes one still waiting for the server
  pbMiss: 0,             // consecutive polls without an answer from the Replay API
  noPbSince: 0,          // when League started playing this replay without answering the Replay API
  want: null,            // { speed?, paused?, until }: what we asked League for (it drops speed changes while seeking)
};
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const REPLAY_SPEEDS = [0.5, 1, 2, 4, 8];
const MAP_SPEEDS = [1, 4, 10, 20, 40, 80];
const RS_POLL_ACTIVE_MS = 450, RS_POLL_IDLE_MS = 1500;
const OPENING_WINDOW_MS = 120000;   // how long a replay counts as "being opened"
const REPLAY_API_GRACE_MS = 20000;  // the Replay API answers a few seconds after the replay appears
const SEEK_THROTTLE_MS = 300;

// ---------------------------------------------------------------- state
const rsMatchId = () => (S.game && (S.game.matchId || (S.meta && S.meta.matchId))) || null;
const rsSpect = st => !!(st && st.spectating && (st.window || st.playback));
const rsOurs = st => rsSpect(st) && !!st.playingMatch && st.playingMatch === rsMatchId();
/** League is playing this game's replay and answers the Replay API: the app drives it. */
function rsControl() { return !!(S.game && rsOurs(RS.st) && RS.pb); }
/** The review clock follows League's replay clock (same condition). */
const rsSynced = rsControl;
/** League's replay time extrapolated from the last poll (ignores seeks still in flight). */
function pbNow() {
  const pb = RS.pb; if (!pb) return null;
  return pb.time + (pb.paused || pb.seeking ? 0 : (performance.now() - RS.pbAt) / 1000 * (pb.speed || 1));
}
/** League's current replay time: the target of a seek in flight, else the extrapolated clock. */
function rsTime() {
  if (RS.pending && performance.now() - RS.pending.at < 4000) return RS.pending.t;
  return pbNow();
}

function rsPhase(st) {
  if (!S.game) return 'none';
  if (!st) return 'offline';
  if (st.inGame) return 'ingame';
  const opening = RS.opening && Date.now() - RS.opening < OPENING_WINDOW_MS;
  if (rsOurs(st)) {
    // the Replay API answers a few seconds after the replay appears: only call it "no control" if that lasts
    if (!st.playback) return st.apiEnabled && RS.noPbSince && Date.now() - RS.noPbSince < REPLAY_API_GRACE_MS ? 'loading' : 'nocontrol';
    return RS.stream ? 'live' : 'capture';
  }
  if (st.compatible === false) return 'old';
  if (rsSpect(st)) return opening && !st.playingMatch ? 'loading' : 'other';
  if (!st.lcu) return 'noclient';
  if (st.clientPatching) return 'patching';
  if (st.clientPlayingReplay) return opening ? 'loading' : 'other';
  if (!st.apiEnabled) return 'setup';
  if (opening) return 'loading';
  return 'ready';
}

// ---------------------------------------------------------------- polling
async function rsPoll() {
  clearTimeout(RS.timer);
  const gen = ++RS.gen;
  if (S.game) {
    const ver = (S.meta && S.meta.version) || '';
    let st = null;
    try { st = await api(`/api/replay/status?matchId=${encodeURIComponent(rsMatchId() || '')}&version=${encodeURIComponent(ver)}`); }
    catch { st = null; }
    if (gen !== RS.gen) return; // a newer poll started while this one waited
    RS.st = st;
    const pb = st && st.playback;
    if (pb && rsOurs(st)) {
      RS.pb = pb; RS.pbAt = performance.now(); RS.pbMiss = 0; RS.noPbSince = 0;
      reconcile(pb);
      if (RS.pending && !pb.seeking) {
        // League reached the seek target (allowing for how far it has played since at its speed)
        const ahead = pb.time - RS.pending.t, ran = (performance.now() - RS.pending.at) / 1000 * (pb.speed || 1);
        if (ahead > -1.5 && ahead < ran + 1.5) RS.pending = null;
      }
    } else if (RS.pb && st && rsOurs({ ...st, playback: RS.pb }) && ++RS.pbMiss < 4) {
      st.playback = RS.pb; // the Replay API is slow while League seeks: keep the last known state for a moment
    } else {
      RS.pb = null; RS.pbMiss = 0;
      RS.noPbSince = st && rsOurs(st) && !st.playback ? RS.noPbSince || Date.now() : 0;
    }
    rsOnPhase(rsPhase(RS.st));
  }
  RS.timer = setTimeout(rsPoll, rsOurs(RS.st) ? RS_POLL_ACTIVE_MS : RS_POLL_IDLE_MS);
}

function rsOnPhase(ph) {
  const prev = RS.phase; RS.phase = ph;
  if (ph !== prev) {
    if (ph === 'old' && !RS.userView) setView('map', false);
    if ((ph === 'capture' || ph === 'nocontrol') && RS.opening && !RS.broughtBack) {
      // League opened on top of everything: bring this window back so the replay can be shown here
      RS.broughtBack = true; post('/api/replay/window', { action: 'app' });
    }
    if (ph === 'live' || ph === 'capture') { RS.opening = 0; loadNames(); applyRender(); }
    if (prev === 'live' && ph !== 'live') RS.camPid = null;
  }
  updateSpeedOptions();
  // a minimised League window can't be captured: un-minimise it (it stays behind the other windows)
  const w = RS.st && RS.st.window;
  if (ph === 'live' && w && w.minimized && Date.now() - RS.restoreAt > 4000) { RS.restoreAt = Date.now(); post('/api/replay/window', { action: 'behind' }); }
  if (rsControl()) {
    const t = rsTime();
    if (RS.stopAt != null && t >= RS.stopAt) {
      RS.stopAt = null; rsPlayback({ paused: true, ...(RS.restoreSpeed ? { speed: RS.restoreSpeed } : {}) }); RS.restoreSpeed = null;
    }
    if (S.focus !== RS.camPid) lockCamera(S.focus);
  }
  renderStage();
}

// ---------------------------------------------------------------- driving League
function reconcile(pb) {
  const w = RS.want;
  if (!w) return;
  if (performance.now() > w.until) { RS.want = null; return; }
  if (pb.seeking) return;
  const fix = {};
  if (w.speed != null && Math.abs(pb.speed - w.speed) > 1e-3) fix.speed = w.speed;
  if (w.paused != null && pb.paused !== w.paused) fix.paused = w.paused;
  if (Object.keys(fix).length) post('/api/replay/playback', fix).catch(() => {});
  else RS.want = null;
}
async function rsPlayback(body) {
  if (body.speed != null || body.paused != null) {
    RS.want = { ...(RS.want && performance.now() < RS.want.until ? RS.want : {}), until: performance.now() + 6000 };
    if (body.speed != null) RS.want.speed = body.speed;
    if (body.paused != null) RS.want.paused = body.paused;
  }
  if (RS.pb) {
    RS.pb.time = pbNow(); RS.pbAt = performance.now();
    if (body.paused != null) RS.pb.paused = body.paused;
    if (body.speed != null) RS.pb.speed = body.speed;
    if (body.time != null) RS.pb.time = body.time;
  }
  if (body.time != null) RS.pending = { t: body.time, at: performance.now() };
  const r = await post('/api/replay/playback', body).catch(() => null);
  if (r && r.error) banner(esc(r.error), true);
  updatePlayBtn();
}
/** Called by seek(): jump League's replay too (throttled while you drag the scrubber). */
function rsSeek(t) {
  if (!rsControl()) return;
  RS.stopAt = null;
  RS.pending = { t, at: performance.now() };
  clearTimeout(RS.sendTimer);
  const send = () => { RS.lastSend = performance.now(); rsPlayback({ time: Math.max(0, t) }); };
  if (performance.now() - RS.lastSend > SEEK_THROTTLE_MS) send(); else RS.sendTimer = setTimeout(send, SEEK_THROTTLE_MS);
}
function rsTogglePause() { if (RS.pb) rsPlayback({ paused: !RS.pb.paused }); }
function rsSetSpeed(v) { rsPlayback({ speed: v }); }
/** "Watch this moment": play [from, to] at normal speed, then pause. */
function rsWatch(from, to) {
  clearTimeout(RS.sendTimer); // a scrubber seek still waiting must not override this
  RS.restoreSpeed = RS.pb && RS.pb.speed !== 1 ? RS.pb.speed : null;
  rsPlayback({ time: Math.max(0, from), paused: false, speed: 1 });
  RS.stopAt = to;
}

async function loadNames() {
  const pl = await api('/api/replay/players').catch(() => null);
  if (!Array.isArray(pl) || !S.game) return;
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  RS.names = {};
  for (const p of S.game.ps) {
    const m = pl.find(x => x.team === p.team && (norm(x.champ) === norm(p.champ) || norm(x.champName) === norm(p.cname)))
      || pl.find(x => norm(x.name) === norm(p.name));
    RS.names[p.id] = m ? m.name : p.name;
  }
  renderStage(true);
}
/* Selects a player in League's replay: League shows their stats panel (items, health, stats).
   Moving League's camera from outside doesn't work on current patches (League ignores camera position/attach
   from the Replay API in its normal camera, and its other camera modes crashed in testing), so the camera stays
   in your hands: click a portrait in League's own window to lock it, and it stays locked here. */
function lockCamera(pid) {
  RS.camPid = pid;
  const name = pid == null ? '' : (RS.names && RS.names[pid]) || (S.game.byId[pid] || {}).name;
  post('/api/replay/render', { selectionName: name || '' });
  renderStage(true);
}
function applyRender() {
  // outlineHover off: League still sees the mouse moving over this window and would outline whatever is under it
  post('/api/replay/render', { fogOfWar: RS.fog, interfaceReplay: RS.replayBar, interfaceTimeline: RS.replayBar, outlineHover: false });
}

// ---------------------------------------------------------------- the video (League's window, captured)
async function rsCapture() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { banner('This window cannot capture other windows.', true); return; }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'window', frameRate: { ideal: 60 }, width: { ideal: 1920 }, height: { ideal: 1080 }, cursor: 'never' },
      audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude',
    });
    const tr = stream.getVideoTracks()[0];
    if (RS.stream && RS.stream !== stream) for (const t of RS.stream.getTracks()) t.stop();
    if (tr) {
      tr.contentHint = 'motion'; tr.addEventListener('ended', rsDropStream);
      const s = tr.getSettings ? tr.getSettings() : {}, w = RS.st && RS.st.window;
      if (w && w.w && w.h && s.width && s.height && Math.abs(s.width / s.height - w.w / w.h) > 0.05)
        banner('That doesn\'t look like League\'s window. If the picture is wrong, close the replay view and pick the <b>League of Legends (TM) Client</b> window.', true);
    }
    RS.stream = stream;
    const v = $('rsVideo'); v.srcObject = stream; v.play().catch(() => {});
    post('/api/replay/window', { action: 'behind' });  // League keeps playing behind this window
    rsOnPhase(rsPhase(RS.st));
  } catch (e) {
    if (e && e.name !== 'NotAllowedError' && e.name !== 'AbortError') banner('Could not show League\'s window here: ' + esc(e.message || e.name), true);
  }
}
function rsDropStream() {
  if (RS.stream) for (const t of RS.stream.getTracks()) t.stop();
  RS.stream = null; $('rsVideo').srcObject = null;
  rsOnPhase(rsPhase(RS.st));
}

// ---------------------------------------------------------------- actions from the panel
async function rsAction(kind) {
  if (RS.busy) return;
  RS.busy = true;
  try {
    if (kind === 'start') { const r = await post('/api/replay/start-client'); banner(r.error ? esc(r.error) : 'Starting League… sign in there if it asks.', !!r.error); }
    if (kind === 'enable') {
      const r = await post('/api/replay/enable-api');
      banner(r.error ? esc(r.error) : 'Replay control is on.', !!r.error); if (!r.error) setTimeout(() => banner(''), 2500);
    }
    if (kind === 'open') await openInLeague();
    if (kind === 'switch' || kind === 'restart') {
      const r = await post('/api/replay/close');
      if (r.error) { banner(esc(r.error) + ' Close the replay in League, then try again.', true); return; }
      RS.opening = Date.now(); RS.broughtBack = false; renderStage(true);
      for (let i = 0; i < 30; i++) { await new Promise(res => setTimeout(res, 700)); const st = await api('/api/replay/status').catch(() => null); if (st && !st.window && !st.clientPlayingReplay) break; }
      await openInLeague();
    }
    if (kind === 'show') await rsCapture();
    if (kind === 'league') { camTipSeen(); await post('/api/replay/window', { action: 'front' }); }
    if (kind === 'map') setView('map', true);
  } finally { RS.busy = false; rsPoll(); }
}
async function openInLeague() {
  const r = await post('/api/replay/watch', { matchId: rsMatchId(), path: S.meta && S.meta.path });
  if (r.error) { banner(esc(r.error), true); RS.opening = 0; return; }
  RS.opening = Date.now(); RS.broughtBack = false; banner('');
  renderStage(true);
}

// ---------------------------------------------------------------- view switching & rendering
function setView(v, byUser) {
  RS.view = v; if (byUser) RS.userView = v;
  $('app').classList.toggle('replay-view', v === 'replay');
  for (const b of $('viewSwitch').querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === v);
  $('mapToggles').classList.toggle('hidden', v !== 'map');
  updateSpeedOptions();
  requestAnimationFrame(() => { sizeCanvases(); drawChart(); });
  renderStage(true);
}
function updateSpeedOptions() {
  const sel = $('speed'); const ctl = rsControl();
  const want = ctl ? 'replay' : 'map';
  if (sel.dataset.mode !== want) {
    sel.dataset.mode = want;
    const list = ctl ? REPLAY_SPEEDS : MAP_SPEEDS;
    sel.innerHTML = list.map(v => `<option value="${v}">${v}×</option>`).join('');
    sel.title = ctl ? "League replay speed" : 'Playback speed';
    setSpeedValue(sel, ctl ? (RS.pb && RS.pb.speed) || 1 : S.speed);
  }
  if (ctl && RS.pb && document.activeElement !== sel) setSpeedValue(sel, RS.pb.speed);
}
// show the current speed even when it isn't one of the presets (e.g. set in League's own replay bar)
function setSpeedValue(sel, v) {
  const s = String(+(+v).toFixed(2));
  if (![...sel.options].some(o => o.value === s)) sel.insertAdjacentHTML('beforeend', `<option value="${s}">${s}×</option>`);
  sel.value = s;
}

const PANEL = {
  noclient: () => ({ t: "League isn't running", p: 'The replay plays in League\'s own replay player and is shown right here. Start League (and sign in if it asks).', b: [['start', 'Start League']] }),
  setup: () => ({ t: 'One-time setup', p: 'Let this app control League\'s replay player (jump to moments, pause, speed). This adds <code>EnableReplayApi=1</code> to League\'s <code>game.cfg</code>; a backup is kept next to it.', b: [['enable', 'Turn on replay control']] }),
  ready: () => ({ t: 'Watch the real replay', p: `League opens this game in its replay player and it appears here, synced with the review. It takes about 20–40 seconds to load.`, b: [['open', '▶ Open the replay']] }),
  loading: () => ({ t: 'League is loading the replay…', p: 'This usually takes 20–40 seconds. League\'s window may pop up in front; this app comes back once it\'s ready.', spin: true }),
  capture: () => ({ t: 'The replay is running in League', p: 'Show it here. If a picker appears, choose the <b>League of Legends (TM) Client</b> window.<br><span class="rs-tip">League\'s camera starts at the fountain and only League can move it: in League\'s window, click your champion\'s portrait on the side of the screen to lock the camera on you. It stays locked when you come back here.</span>', b: [['show', '▶ Show the replay here'], ['league', "Go to League's window"]] }),
  nocontrol: () => ({ t: 'Replay running, but without control', p: 'League was started before replay control was turned on, so the app can follow it but not steer it. Restart the replay to control it from here.', b: [['restart', 'Restart the replay'], ['show', 'Show it anyway']] }),
  other: () => ({ t: 'League is showing a different replay', p: RS.st && RS.st.playingMatch ? `League is playing ${esc(RS.st.playingMatch)}.` : 'Close it to open this one.', b: [['switch', 'Close it and open this game']] }),
  ingame: () => ({ t: "You're in a game", p: 'The replay view is off until your game ends. Your debrief opens automatically afterwards.' }),
  patching: () => ({ t: 'League is updating', p: 'Replays can be opened once the update finishes.', spin: true }),
  offline: () => ({ t: 'App offline', p: 'The local app server is not responding.' }),
  old: () => {
    const st = RS.st || {};
    return { t: "League can't play this replay", p: `League only plays replays from its current patch. This game was played on <b>${esc(st.replayPatch || '?')}</b> and League is on <b>${esc(st.clientPatch || '?')}</b>, so you get the recreated map instead. Games you play from now on can be watched here until the next patch.`, b: [['map', 'Show the recreated map']] };
  },
};

function renderStage(force) {
  if (!S.game) return;
  const ph = RS.phase, replay = RS.view === 'replay';
  const live = replay && ph === 'live';
  const showVideo = replay && !!RS.stream && (ph === 'live' || ph === 'nocontrol' || (ph === 'loading' && rsOurs(RS.st)));
  $('rsVideo').classList.toggle('hidden', !showVideo);
  $('map').classList.toggle('hidden', replay);
  // panel over the stage
  const pan = replay && !showVideo && PANEL[ph] ? PANEL[ph]() : null;
  const sig = JSON.stringify([ph, RS.view, !!RS.stream, pan && pan.p, RS.camPid, RS.fog, RS.replayBar, !!RS.names, RS.st && RS.st.window && RS.st.window.foreground]);
  // view switch label / availability
  const old = ph === 'old';
  const rb = $('viewSwitch').querySelector('[data-v="replay"]');
  rb.title = old ? "League can only play replays from its current patch" : "League's replay player, shown live in this window";
  rb.classList.toggle('dim', old);
  $('rsToggles').classList.toggle('hidden', !(replay && (ph === 'live' || ph === 'nocontrol' || ph === 'capture')));
  $('rsCamTip').classList.toggle('hidden', !(live && !camTipDone()));
  $('rsPlayers').classList.toggle('hidden', !live);
  $('mapNote').innerHTML = replay
    ? (live ? `The real replay, played by League (patch ${esc((RS.st || {}).clientPatch || '')}) and driven from here: the scrubber, chart, moves and turning points jump it to that moment; play/pause and speed control it. League keeps its own camera: lock it on a champion in League's window and it stays locked.`
      : 'Replays play in League\'s own replay player and are shown here.')
    : (old ? `Recreated from Riot's match timeline: League can't play replays from patch ${esc((RS.st || {}).replayPatch || '?')} any more.` : 'Recreated from Riot\'s match timeline: positions are exact at each minute and at kills/objectives, and follow lanes and jungle paths in between.');
  if (!force && sig === RS.sig) return;
  RS.sig = sig;
  const box = $('rsPanel');
  box.classList.toggle('hidden', !pan);
  if (pan) {
    box.innerHTML = `<div class="rs-card">${pan.spin ? '<div class="rs-spin"></div>' : ''}<h3>${pan.t}</h3><p>${pan.p}</p>
      ${pan.b ? `<div class="rs-btns">${pan.b.map(([k, l], i) => `<button class="btn ${i ? 'ghost' : 'primary'}" data-rs="${k}">${l}</button>`).join('')}</div>` : ''}</div>`;
    for (const b of box.querySelectorAll('[data-rs]')) b.onclick = () => rsAction(b.dataset.rs);
  }
  // champion bar: select a player in League (shows their stats panel)
  if (live) {
    const g = S.game;
    const btn = p => `<button class="rs-champ ${teamClsRs(p.team)} ${RS.camPid === p.id ? 'on' : ''}" data-cam="${p.id}" title="Show ${esc(p.name)}'s stats panel in the replay (${esc(p.cname)})"><img src="/asset/champ/${encodeURIComponent(p.champ)}.png" alt="">${p.id === S.mePid ? '<i>★</i>' : ''}</button>`;
    $('rsPlayers').innerHTML = `<span class="lbl">Stats panel</span><div class="rs-side">${g.ps.filter(p => p.team === 100).map(btn).join('')}</div>
      <div class="rs-side">${g.ps.filter(p => p.team === 200).map(btn).join('')}</div>
      <span class="rs-hint" title="League doesn't let other apps move its camera. In League's window, click a champion portrait (or press its key) to lock the camera, or click the minimap; the view here follows.">Camera: <a href="#" id="rsCamHelp">move it in League's window</a></span>`;
    for (const b of $('rsPlayers').querySelectorAll('[data-cam]')) b.onclick = () => { const id = +b.dataset.cam; const off = RS.camPid === id; S.focus = off ? null : id; lockCamera(off ? null : id); };
    $('rsCamHelp').onclick = e => { e.preventDefault(); camTipSeen(); post('/api/replay/window', { action: 'front' }); };
  }
  $('rsFog').checked = RS.fog; $('rsBar').checked = RS.replayBar;
}
const teamClsRs = t => (t === 100 ? 'b' : 'r');
const camTipDone = () => { try { return localStorage.getItem('lra.v2.camTip') === '1'; } catch { return false; } };
function camTipSeen() { try { localStorage.setItem('lra.v2.camTip', '1'); } catch { /* ignore */ } $('rsCamTip').classList.add('hidden'); }

function rsOnGameOpened() {
  RS.userView = null; RS.camPid = null; RS.names = null; RS.stopAt = null; RS.pending = null; RS.sig = '';
  // start on the recreated map when we already know League can't play this patch (the first status poll confirms)
  const vp = String((S.meta && S.meta.version) || '').split('.').slice(0, 2).join('.');
  const cp = RS.st && RS.st.clientPatch;
  RS.phase = 'none';
  setView(vp && cp && vp !== cp ? 'map' : 'replay', false);
  rsPoll();
}

function wireStage() {
  $('viewSwitch').onclick = e => { const b = e.target.closest('button'); if (b) setView(b.dataset.v, true); };
  $('rsFog').onchange = e => { RS.fog = e.target.checked; applyRender(); };
  $('rsBar').onchange = e => { RS.replayBar = e.target.checked; applyRender(); };
  $('rsFront').onclick = () => { camTipSeen(); post('/api/replay/window', { action: 'front' }); };
  $('rsCamTipGo').onclick = () => { camTipSeen(); post('/api/replay/window', { action: 'front' }); };
  $('rsCamTipX').onclick = camTipSeen;
  $('rsFull').onclick = () => { const w = $('mapWrap'); if (document.fullscreenElement) document.exitFullscreen(); else w.requestFullscreen().catch(() => {}); };
  $('rsClose').onclick = async () => { const r = await post('/api/replay/close').catch(() => ({ error: 'The app is not responding.' })); if (r.error) banner(esc(r.error), true); else rsDropStream(); };
  $('rsVideo').ondblclick = () => $('rsFull').onclick();
  document.addEventListener('fullscreenchange', () => requestAnimationFrame(() => { sizeCanvases(); drawChart(); }));
  rsPoll();
}
wireStage();
