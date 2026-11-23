'use strict';
/* Self-test: open http://127.0.0.1:8765/?selftest to run every replay in your folder through the full
   pipeline (fetch → model → review → every UI view) and check the output for errors / NaNs / bad positions. */
/* global S, openReplay, posAt, GRADES, renderTabs, updateSide, drawMap, drawChart, renderMoves, stepMove, fmtTime */

async function runSelfTest() {
  const out = document.createElement('div');
  out.style.cssText = 'position:fixed;inset:auto 12px 12px auto;width:560px;max-height:60vh;overflow:auto;z-index:50;background:#0b0f17;border:1px solid #253049;border-radius:10px;padding:12px;font:12px/1.4 Consolas,monospace;color:#e6ebf5';
  document.body.appendChild(out);
  const log = html => { out.insertAdjacentHTML('beforeend', html + '<br>'); out.scrollTop = out.scrollHeight; };
  while (!S.replays.length) await new Promise(r => setTimeout(r, 300));
  log(`<b>Self-test: ${S.replays.length} replays</b>`);
  const results = [];
  for (const rp of S.replays) {
    const r = { file: rp.file }; const t0 = performance.now(); const errs = [];
    const onErr = e => errs.push(String(e.message || e));
    window.addEventListener('error', onErr);
    try {
      await openReplay(rp);
      const g = S.game;
      if (!g) { r.status = 'FAIL'; r.msg = document.getElementById('banner').textContent; }
      else {
        const bad = [];
        r.source = g.source; r.dur = g.duration; r.actions = S.review.actions.length;
        if (g.samples.some(s => !isFinite(s.control))) bad.push('NaN in control score');
        if (g.samples.some(s => !(s.wp >= 0 && s.wp <= 1))) bad.push('win chance out of range');
        if (window.WP_MODEL && !g.wpm) bad.push('trained model not applied');
        for (const p of g.ps) for (let t = 0; t < g.duration; t += 20) {
          const q = posAt(p, t);
          if (!isFinite(q.x) || !isFinite(q.y) || q.x < -600 || q.x > 15600 || q.y < -600 || q.y > 15600) { bad.push(`bad position ${p.champ} @${fmtTime(t)}`); break; }
        }
        for (const p of g.ps) { const a = S.review.players[p.id].accuracy; if (a != null && !(a >= 0 && a <= 100)) bad.push('bad accuracy ' + p.champ); }
        for (const a of S.review.actions) {
          const txt = `${a.title} ${a.detail} ${a.better}`;
          if (!GRADES[a.grade] || /undefined|NaN|null|\[object/.test(txt)) { bad.push(`bad action text: ${txt.slice(0, 120)}`); break; }
        }
        if (typeof chatContext === 'function') { // what the chat sends Claude, at a few moments and for a selected move
          for (const t of [0, g.duration / 2, g.duration]) {
            S.t = t; S.revSel = S.review.actions.findIndex(a => Math.abs(a.t - t) < 40); if (S.revSel < 0) S.revSel = null;
            const c = JSON.stringify(chatContext());
            if (!c || /NaN|\[object|"undefined"|Infinity/.test(c)) { bad.push('chat context glitch @' + fmtTime(t)); break; }
          }
          S.revSel = null; S.t = 0;
        }
        for (const tab of ['review', 'phases', 'moments', 'objectives', 'me', 'how']) {
          S.tab = tab; renderTabs();
          if (/undefined|NaN|\[object/.test(document.getElementById('tabBody').innerText)) bad.push('text glitch in tab ' + tab);
        }
        S.sideTab = 'score'; S.t = g.duration / 2; updateSide(); drawMap(); drawChart();
        if (/undefined|NaN/.test(document.getElementById('scoreboard').innerText + document.getElementById('factors').innerText + document.getElementById('ctrlText').innerText)) bad.push('text glitch in side panel');
        for (const p of g.ps) for (let i = 1; i < p.deaths.length; i++) if (p.deaths[i - 1].respawn > p.deaths[i].t) { bad.push('overlapping deaths ' + p.champ); break; }
        const drakes = t => g.objectives.filter(o => o.key === 'DRAGON' && o.team === t).length;
        if ((drakes(100) >= 4 || drakes(200) >= 4) && !g.souls.length) bad.push('4 drakes but no soul');
        if (S.loopError) { bad.push('draw loop: ' + S.loopError); S.loopError = null; }
        S.sideTab = 'moves'; renderMoves(); stepMove(1); stepMove(1);
        if (/undefined|NaN/.test(document.getElementById('moves').innerText)) bad.push('text glitch in moves list');
        const me = g.byId[S.mePid];
        r.me = me ? `${me.name} (${me.champ}) ${S.review.players[me.id].accuracy.toFixed(1)}%` : '—';
        r.status = bad.length || errs.length ? 'ISSUES' : 'ok'; r.bad = bad.concat(errs);
      }
    } catch (e) { r.status = 'FAIL'; r.msg = String(e.stack || e).slice(0, 300); }
    window.removeEventListener('error', onErr);
    r.ms = Math.round(performance.now() - t0);
    results.push(r);
    const col = r.status === 'ok' ? '#3ecf8e' : r.status === 'ISSUES' ? '#f2b84b' : '#ff6b6b';
    log(`<span style="color:${col}">${r.status.padEnd(6)}</span> ${r.file} ${r.source || ''} ${r.dur ? fmtTime(r.dur) : ''} · ${r.actions || 0} actions · you: ${r.me || '—'} · ${r.ms}ms${r.msg ? ' · ' + r.msg : ''}${r.bad && r.bad.length ? '<br>&nbsp;&nbsp;' + r.bad.join('<br>&nbsp;&nbsp;') : ''}`);
  }
  const n = s => results.filter(r => r.status === s).length;
  log(`<b>Done: ${n('ok')} ok, ${n('ISSUES')} with issues, ${n('FAIL')} failed.</b>`);
  window.__selftest = results;
  return results;
}
if (/[?&]selftest/.test(location.search)) setTimeout(runSelfTest, 500);
