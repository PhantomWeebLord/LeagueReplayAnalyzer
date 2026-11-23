'use strict';
/* =====================================================================
   Cinematic map renderer
   - Director camera: eases onto fights and objectives (a few seconds early), follows the selected player when
     it's quiet, returns to the full map otherwise; fights play in slow motion.
   - Glowing comet trails along the routed paths, kill bursts, tower shockwaves, epic-monster pulses,
     recall swirls and respawn beams, broadcast-style captions and a kill feed.
   ===================================================================== */
/* global S, $, SR, FOUNTAIN, TEAM_NAME, COLORS, posAt, isDead, structureAlive, toPx, updateHeat, heatCanvas, mapImg, champImg,
   hexA, clamp, dist, GRADES, zoneOf */

const CAM = { x: 7375, y: 7430, z: 1, last: performance.now(), slow: false, mode: 'map' };
const rand = i => { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };
// how many game-seconds an effect lasts, so it stays visible for about `real` seconds at the current playback speed
const fxSpeed = () => (typeof rsSynced === 'function' && rsSynced() ? RS.pb.speed || 1 : S.follow ? 1 : (S.speed || 1));
const fxDur = real => Math.max(real * 1.6, real * fxSpeed());

function directorTarget(g, t) {
  const lead = Math.max(5, fxDur(0.7));
  let best = null;
  for (const f of g.fights) {
    if (t < f.start - lead || t > f.end + fxDur(1.6)) continue;
    const w = f.size * 2 + (f.label === 'Teamfight' ? 6 : 0);
    if (!best || w > best.w) best = { w, x: f.x, y: f.y, fight: f.start - 1 <= t && t <= f.end + 2 };
  }
  for (const o of g.objectives) {
    if (t < o.t - lead - 5 || t > o.t + fxDur(1.6)) continue;
    const w = o.key === 'BARON_NASHOR' || o.key === 'ELDER' ? 14 : 8;
    if (!best || w > best.w) best = { w, x: o.x, y: o.y, fight: false };
  }
  if (best) {
    // zoom to fit the alive champions around the action
    let spread = 1800;
    for (const p of g.ps) if (!isDead(p, t)) { const q = posAt(p, t); const d = dist(q, best); if (d < 4200) spread = Math.max(spread, d); }
    return { x: best.x, y: best.y, z: clamp(14800 / (2.6 * spread + 2600), 1.35, 2.5), fight: best.fight, mode: 'action' };
  }
  if (S.focus && g.byId[S.focus]) { const q = isDead(g.byId[S.focus], t) || posAt(g.byId[S.focus], t); return { x: q.x, y: q.y, z: 1.8, fight: false, mode: 'follow' }; }
  return { x: 7375, y: 7430, z: 1, fight: false, mode: 'map' };
}

function updateCamera(g, t) {
  const now = performance.now(); const dt = Math.min(0.1, (now - CAM.last) / 1000); CAM.last = now;
  const on = $('tDirector') && $('tDirector').checked;
  const tg = on ? directorTarget(g, t) : { x: 7375, y: 7430, z: 1, fight: false, mode: 'map' };
  const kp = 1 - Math.exp(-dt * 2.4), kz = 1 - Math.exp(-dt * 1.7);
  CAM.x += (tg.x - CAM.x) * kp; CAM.y += (tg.y - CAM.y) * kp; CAM.z += (tg.z - CAM.z) * kz;
  // keep the view inside the map
  const half = (SR.maxX - SR.minX) / (2 * CAM.z);
  CAM.x = clamp(CAM.x, SR.minX + half, SR.maxX - half); CAM.y = clamp(CAM.y, SR.minY + half, SR.maxY - half);
  CAM.slow = on && tg.fight && S.playing; CAM.mode = tg.mode;
}

function drawMap() {
  const c = $('map'); const ctx = c.getContext('2d'); const W = c.width, H = c.height; const g = S.game; const t = S.t;
  const u = W / 600; const now = performance.now();
  updateCamera(g, t);
  const z = CAM.z, [cxp, cyp] = toPx(CAM.x, CAM.y, W, H);
  const scr = (px, py) => [(px - cxp) * z + W / 2, (py - cyp) * z + H / 2];
  const iz = 1 / Math.pow(z, 0.55);   // icons grow a little when zoomed, not z-fold
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#05070b'; ctx.fillRect(0, 0, W, H);
  ctx.setTransform(z, 0, 0, z, W / 2 - cxp * z, H / 2 - cyp * z);

  // terrain, colour-graded
  if (mapImg.complete && mapImg.naturalWidth) { ctx.filter = 'brightness(0.62) saturate(0.8) contrast(1.12)'; ctx.drawImage(mapImg, 0, 0, W, H); ctx.filter = 'none'; }
  // territory, softly breathing
  if ($('tHeat').checked) {
    updateHeat(t);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.globalAlpha = 0.85 + 0.12 * Math.sin(now / 1400);
    ctx.drawImage(heatCanvas, 0, 0, W, H);
    ctx.globalAlpha = 1;
  }
  const showFx = $('tEvents').checked;

  // structures
  for (const s of g.structures) {
    const [x, y] = toPx(s.x, s.y, W, H); const alive = structureAlive(s, t);
    const r = (s.kind === 'nexus' ? 7 : s.kind === 'inhib' ? 5 : 4.2) * u * iz;
    ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4);
    if (alive) { ctx.shadowColor = COLORS[s.team]; ctx.shadowBlur = 10 * u; ctx.fillStyle = COLORS[s.team]; ctx.fillRect(-r, -r, 2 * r, 2 * r); ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1.1 * u * iz; ctx.strokeRect(-r, -r, 2 * r, 2 * r); }
    else { ctx.fillStyle = 'rgba(20,22,28,.9)'; ctx.fillRect(-r, -r, 2 * r, 2 * r); ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 1 * u * iz;
      ctx.beginPath(); ctx.moveTo(-r, 0); ctx.lineTo(r, 0); ctx.moveTo(0, -r); ctx.lineTo(0, r); ctx.stroke(); }
    ctx.restore();
  }
  // tower / inhibitor destruction shockwaves
  if (showFx) for (const [i, s] of g.structureEvents.entries()) {
    const d = fxDur(1.4); if (t < s.t || t > s.t + d) continue;
    const pr = (t - s.t) / d; const [x, y] = toPx(s.x, s.y, W, H);
    ctx.strokeStyle = hexA(COLORS[s.team], 1 - pr); ctx.lineWidth = 3 * u * iz * (1 - pr) + 0.5;
    ctx.beginPath(); ctx.arc(x, y, (6 + 40 * pr) * u * iz, 0, 7); ctx.stroke();
    for (let k = 0; k < 8; k++) { const a = rand(i * 31 + k) * 6.283, sp = 10 + 30 * rand(i * 17 + k);
      ctx.fillStyle = `rgba(255,220,160,${(1 - pr) * 0.9})`; ctx.fillRect(x + Math.cos(a) * sp * pr * u * iz, y + Math.sin(a) * sp * pr * u * iz, 2 * u * iz, 2 * u * iz); }
  }

  // epic monster pulses
  if (showFx) for (const o of g.objectives) {
    const d = fxDur(2.2); if (t < o.t - 1 || t > o.t + d) continue;
    const pr = clamp((t - o.t) / d, 0, 1); const [x, y] = toPx(o.x, o.y, W, H);
    for (let k = 0; k < 2; k++) { const q = (pr + k * 0.35) % 1;
      ctx.strokeStyle = hexA(COLORS[o.team], (1 - q) * 0.9); ctx.lineWidth = 2.5 * u * iz;
      ctx.beginPath(); ctx.arc(x, y, (14 + 46 * q) * u * iz, 0, 7); ctx.stroke(); }
    const grd = ctx.createRadialGradient(x, y, 0, x, y, 30 * u * iz);
    grd.addColorStop(0, hexA(COLORS[o.team], 0.45 * (1 - pr))); grd.addColorStop(1, hexA(COLORS[o.team], 0));
    ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(x, y, 30 * u * iz, 0, 7); ctx.fill();
  }

  // comet trails
  if ($('tTrails').checked) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
    const span = 14, step = 0.5;
    for (const p of g.ps) {
      if (isDead(p, t)) continue;
      let prev = null;
      for (let k = span; k >= 0; k -= step) {
        const tt = t - k; if (tt < 0 || isDead(p, tt)) { prev = null; continue; }
        const q = posAt(p, tt); const cur = toPx(q.x, q.y, W, H);
        if (prev && Math.hypot(cur[0] - prev[0], cur[1] - prev[1]) < 70 * u) {
          const f = 1 - k / span;
          ctx.strokeStyle = hexA(COLORS[p.team], 0.05 + 0.5 * f * f);
          ctx.lineWidth = (0.8 + 4.2 * f) * u * iz;
          ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(cur[0], cur[1]); ctx.stroke();
        }
        prev = cur;
      }
    }
    ctx.restore();
  }

  // recall channels (swirl before the teleport) and fountain arrival / respawn beams
  if (showFx) for (const p of g.ps) {
    for (let i = 1; i < p.kf.length; i++) {
      const f = p.kf[i]; if (f.k !== 2) continue;
      const respawn = p.kf[i - 1].k === 3;
      if (!respawn && t >= f.t - 8 && t < f.t) {           // channelling a recall
        const q = p.kf[i - 1]; const [x, y] = toPx(q.x, q.y, W, H); const pr = 1 - (f.t - t) / 8;
        ctx.strokeStyle = `rgba(150,200,255,${0.35 + 0.5 * pr})`; ctx.lineWidth = 2 * u * iz;
        for (let k = 0; k < 3; k++) { const a0 = now / 300 + k * 2.09; ctx.beginPath(); ctx.arc(x, y, (16 + 4 * k) * u * iz, a0, a0 + 1.2 + pr * 2); ctx.stroke(); }
      }
      const d = fxDur(1.2);
      if (t >= f.t && t < f.t + d) {                         // arrival beam at the fountain
        const [x, y] = toPx(f.x, f.y, W, H); const pr = (t - f.t) / d;
        const gr = ctx.createLinearGradient(x, y - 60 * u * iz, x, y);
        gr.addColorStop(0, hexA(COLORS[p.team], 0)); gr.addColorStop(1, hexA(COLORS[p.team], 0.7 * (1 - pr)));
        ctx.fillStyle = gr; ctx.fillRect(x - 6 * u * iz, y - 60 * u * iz, 12 * u * iz, 60 * u * iz);
      }
    }
  }

  // kills: shockwave, sparks, killer->victim streak, skull
  if (showFx) for (const [i, k] of g.kills.entries()) {
    const d = fxDur(1.6); if (t < k.t || t > k.t + d) continue;
    const pr = (t - k.t) / d; const [x, y] = toPx(k.x, k.y, W, H); const col = COLORS[k.team];
    ctx.strokeStyle = hexA(col, 1 - pr); ctx.lineWidth = 3 * u * iz * (1 - pr) + 0.5;
    ctx.beginPath(); ctx.arc(x, y, (8 + 26 * pr) * u * iz, 0, 7); ctx.stroke();
    for (let s = 0; s < 10; s++) { const a = rand(i * 13 + s) * 6.283, sp = 12 + 26 * rand(i * 7 + s);
      ctx.fillStyle = hexA(col, (1 - pr)); ctx.beginPath(); ctx.arc(x + Math.cos(a) * sp * pr * u * iz, y + Math.sin(a) * sp * pr * u * iz, 1.6 * u * iz, 0, 7); ctx.fill(); }
    const killer = g.byId[k.killer];
    if (killer && pr < 0.45) {
      const q = posAt(killer, k.t); const [kx, ky] = toPx(q.x, q.y, W, H);
      if (Math.hypot(kx - x, ky - y) > 4 * u) { ctx.strokeStyle = hexA(col, 0.8 * (1 - pr / 0.45)); ctx.lineWidth = 2 * u * iz; ctx.beginPath(); ctx.moveTo(kx, ky); ctx.lineTo(x, y); ctx.stroke(); }
    }
    ctx.fillStyle = `rgba(255,255,255,${0.9 * (1 - pr)})`; ctx.font = `${14 * u * iz}px Segoe UI Symbol, Segoe UI, sans-serif`; ctx.textAlign = 'center';
    ctx.fillText('☠', x, y - 14 * u * iz);
  }

  // selected review action
  const sel = S.review && S.revSel != null ? S.review.actions[S.revSel] : null;
  if (sel && sel.x != null && Math.abs(t - sel.t) < 25) {
    const [x, y] = toPx(sel.x, sel.y, W, H); const pulse = 1 + 0.15 * Math.sin(now / 180);
    ctx.strokeStyle = GRADES[sel.grade].color; ctx.lineWidth = 3 * u * iz;
    ctx.beginPath(); ctx.arc(x, y, 30 * u * iz * pulse, 0, 7); ctx.stroke();
    ctx.fillStyle = GRADES[sel.grade].color; ctx.font = `800 ${14 * u * iz}px Segoe UI, sans-serif`; ctx.textAlign = 'center';
    ctx.fillText(GRADES[sel.grade].sym, x + 30 * u * iz, y - 26 * u * iz);
  }

  // champions
  const R = 12.5 * u * iz;
  const order = g.ps.slice().sort((a, b) => (isDead(a, t) ? 0 : 1) - (isDead(b, t) ? 0 : 1));
  for (const p of order) {
    const dead = isDead(p, t);
    const pos = dead ? { x: dead.x, y: dead.y } : posAt(p, t);
    const [x, y] = toPx(pos.x, pos.y, W, H);
    p._px = scr(x, y);
    const isYou = p.id === S.mePid, isFocus = p.id === S.focus;
    ctx.save();
    if (!dead) { ctx.shadowColor = COLORS[p.team]; ctx.shadowBlur = 14 * u; }
    ctx.globalAlpha = dead ? 0.75 : 1;
    ctx.beginPath(); ctx.arc(x, y, R, 0, 7); ctx.fillStyle = '#0b0f17'; ctx.fill();
    ctx.shadowBlur = 0;
    const im = champImg(p.champ);
    ctx.save(); ctx.beginPath(); ctx.arc(x, y, R, 0, 7); ctx.clip();
    if (dead) ctx.filter = 'grayscale(1) brightness(0.9)';
    if (im && im.complete && im.naturalWidth) ctx.drawImage(im, x - R, y - R, 2 * R, 2 * R);
    else { ctx.fillStyle = COLORS[p.team]; ctx.fillRect(x - R, y - R, 2 * R, 2 * R); }
    ctx.restore();
    ctx.strokeStyle = dead ? 'rgba(150,150,150,.8)' : COLORS[p.team]; ctx.lineWidth = 2.4 * u * iz;
    ctx.beginPath(); ctx.arc(x, y, R, 0, 7); ctx.stroke();
    if (dead) {   // respawn countdown ring
      const total = dead.respawn - dead.t, left = dead.respawn - t;
      ctx.globalAlpha = 1; ctx.strokeStyle = '#e6ebf5'; ctx.lineWidth = 2.2 * u * iz;
      ctx.beginPath(); ctx.arc(x, y, R + 3.5 * u * iz, -Math.PI / 2, -Math.PI / 2 + 6.283 * clamp(left / total, 0, 1)); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = `700 ${10.5 * u * iz}px Segoe UI, sans-serif`; ctx.textAlign = 'center';
      ctx.fillText(Math.ceil(left) + 's', x, y + 4 * u * iz);
    }
    if (isYou || isFocus) { ctx.globalAlpha = 1; ctx.strokeStyle = isFocus ? '#fff' : '#ffd84d'; ctx.lineWidth = 2.6 * u * iz; ctx.beginPath(); ctx.arc(x, y, R + 6 * u * iz, 0, 7); ctx.stroke(); }
    if ($('tNames').checked || isFocus) {
      ctx.globalAlpha = 1; ctx.font = `600 ${10 * u * iz}px Segoe UI, sans-serif`; ctx.textAlign = 'center';
      ctx.lineWidth = 3 * u * iz; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.strokeText(p.name, x, y + R + 12 * u * iz);
      ctx.fillStyle = '#fff'; ctx.fillText(p.name, x, y + R + 12 * u * iz);
    }
    ctx.restore();
  }

  // ---- screen-space overlays
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const vg = ctx.createRadialGradient(W / 2, H / 2, W * 0.32, W / 2, H / 2, W * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
  if (showFx) { drawKillFeed(ctx, g, t, W, u); drawCaptions(ctx, g, t, W, u); }
  if (CAM.mode !== 'map' && $('tDirector').checked) {
    ctx.font = `600 ${10.5 * u}px Segoe UI, sans-serif`; ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(232,182,76,.9)';
    ctx.fillText(CAM.mode === 'follow' ? '● FOLLOWING' : CAM.slow ? '● DIRECTOR · SLOW-MO' : '● DIRECTOR', 12 * u, 20 * u);
  }
}

// ---- broadcast captions (First Blood, multikills, aces, objectives, inhibitors)
function captionsFor(g) {
  if (g._captions) return g._captions;
  const out = [];
  if (g.kills.length) out.push({ t: g.kills[0].t, team: g.kills[0].team, text: `FIRST BLOOD${g.byId[g.kills[0].killer] ? ` — ${champLabel(g, g.kills[0].killer)}` : ''}` });
  const names = { 2: 'DOUBLE KILL', 3: 'TRIPLE KILL', 4: 'QUADRA KILL', 5: 'PENTAKILL' };
  const byKiller = {};
  for (const k of g.kills) {
    if (!g.byId[k.killer]) continue;
    const s = byKiller[k.killer] = byKiller[k.killer] && k.t - byKiller[k.killer].last <= 10 ? byKiller[k.killer] : { n: 0, last: 0 };
    s.n++; s.last = k.t;
    if (s.n >= 2) {
      if (s.cap) s.cap.until = k.t;
      s.cap = { t: k.t, team: k.team, text: `${names[Math.min(5, s.n)]} — ${champLabel(g, k.killer)}` };
      out.push(s.cap);
    }
  }
  for (const f of g.fights) for (const team of [100, 200]) {
    const enemy = g.ps.filter(p => p.team !== team);
    const last = f.kills.filter(k => k.team === team).pop();
    if (last && enemy.length >= 5 && enemy.every(p => isDead(p, last.t + 0.5))) out.push({ t: last.t + 0.5, team, text: `ACE — ${TEAM_NAME[team].toUpperCase()} WIPES THE ENEMY TEAM` });
  }
  for (const o of g.objectives) out.push({ t: o.t, team: o.team, text: `${TEAM_NAME[o.team].toUpperCase()} TAKES ${o.name.toUpperCase()}`, big: true });
  for (const s of g.structureEvents) if (s.kind === 'inhib') out.push({ t: s.t, team: s.team, text: `${TEAM_NAME[s.team].toUpperCase()} DESTROYS AN INHIBITOR` });
  return (g._captions = out.sort((a, b) => a.t - b.t));
}
function champLabel(g, id) { const p = g.byId[id]; return p ? p.cname.toUpperCase() : ''; }
function drawCaptions(ctx, g, t, W, u) {
  const d = fxDur(2.6);
  const live = captionsFor(g).filter(c => t >= c.t && t < (c.until != null ? Math.min(c.until, c.t + d) : c.t + d)).slice(-2);
  live.forEach((c, i) => {
    const pr = (t - c.t) / d; const a = pr < 0.12 ? pr / 0.12 : pr > 0.8 ? (1 - pr) / 0.2 : 1;
    ctx.font = `800 ${(c.big ? 15 : 13) * u}px Segoe UI, sans-serif`;
    const tw = ctx.measureText(c.text).width, h = (c.big ? 30 : 26) * u, y = (38 + i * 36) * u, x = W / 2 - tw / 2 - 16 * u;
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(8,11,18,.88)'; ctx.fillRect(x, y, tw + 32 * u, h);
    ctx.fillStyle = COLORS[c.team]; ctx.fillRect(x, y, 4 * u, h); ctx.fillRect(x + tw + 28 * u, y, 4 * u, h);
    ctx.fillStyle = '#f2f4f8'; ctx.textAlign = 'center'; ctx.fillText(c.text, W / 2, y + h / 2 + 5 * u);
    ctx.globalAlpha = 1;
  });
}
function drawKillFeed(ctx, g, t, W, u) {
  const keep = Math.max(20, fxDur(5));
  const ks = g.kills.filter(k => k.t <= t && t - k.t < keep).slice(-5);
  const s = 18 * u, pad = 6 * u;
  ks.forEach((k, i) => {
    const age = (t - k.t) / keep; ctx.globalAlpha = age > 0.75 ? (1 - age) / 0.25 : 1;
    const y = 10 * u + i * (s + 6 * u), x = W - 10 * u - (2 * s + 30 * u + 2 * pad);
    ctx.fillStyle = 'rgba(8,11,18,.85)'; ctx.fillRect(x, y, 2 * s + 30 * u + 2 * pad, s + 2 * u);
    ctx.fillStyle = COLORS[k.team]; ctx.fillRect(x, y, 3 * u, s + 2 * u);
    const kp = g.byId[k.killer], vp = g.byId[k.victim];
    const icon = (p, ix) => { const im = p && champImg(p.champ); if (im && im.complete && im.naturalWidth) ctx.drawImage(im, ix, y + 1 * u, s, s); else { ctx.fillStyle = '#333'; ctx.fillRect(ix, y + 1 * u, s, s); } };
    icon(kp, x + pad); icon(vp, x + pad + s + 30 * u);
    ctx.fillStyle = '#e6ebf5'; ctx.font = `${12 * u}px Segoe UI Symbol, Segoe UI, sans-serif`; ctx.textAlign = 'center';
    ctx.fillText('⚔', x + pad + s + 15 * u, y + s * 0.78);
    ctx.globalAlpha = 1;
  });
}
