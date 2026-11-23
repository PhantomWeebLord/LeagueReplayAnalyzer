'use strict';
/* =====================================================================
   Game Review: grades every action in the game, chess-review style.
   Each action gets a grade, an explanation, and what would have been better.
   Grades roll up into accuracy per player, per team and per game phase.
   ===================================================================== */
/* global ENEMY, TEAM_NAME, clamp, dist, fmtTime, fmtGold, zoneOf, interpSeries, isDead, posAt, stateAt, smoothAt,
   influenceAtPoint, nearbyCounts, ROLE_SHORT, wpFor, wpWithoutDeath, wpPredict, knotWeights */

// Colours form a diverging ordinal scale (validated for the dark surface): one cool hue rising
// good → great → brilliant, a neutral gray for OK, one warm hue deepening inaccuracy → blunder.
// The symbol always travels with the colour, so the grade never relies on colour alone.
const GRADES = {
  brilliant: { sym: '!!', label: 'Brilliant', score: 100, color: '#4ae0ff', ink: '#0b0f17' },
  great: { sym: '!', label: 'Great', score: 100, color: '#14c2e1', ink: '#0b0f17' },
  good: { sym: '✓', label: 'Good', score: 92, color: '#00a4c0', ink: '#0b0f17' },
  ok: { sym: '•', label: 'OK', score: 80, color: '#7f8793', ink: '#0b0f17' },
  inaccuracy: { sym: '?!', label: 'Inaccuracy', score: 58, color: '#ffb6a2', ink: '#0b0f17' },
  miss: { sym: '✗', label: 'Miss', score: 45, color: '#ff8d74', ink: '#0b0f17' },
  mistake: { sym: '?', label: 'Mistake', score: 30, color: '#f26549', ink: '#0b0f17' },
  blunder: { sym: '??', label: 'Blunder', score: 5, color: '#da3c1c', ink: '#ffffff' },
};
const GRADE_ORDER = ['brilliant', 'great', 'good', 'ok', 'inaccuracy', 'miss', 'mistake', 'blunder'];
const BAD_GRADES = new Set(['inaccuracy', 'miss', 'mistake', 'blunder']);
const LANING_END = 840, MID_GAME_END = 1500; // 14:00 and 25:00
const PHASES = [{ key: 'early', label: 'Early game', from: 0, to: LANING_END }, { key: 'mid', label: 'Mid game', from: LANING_END, to: MID_GAME_END }, { key: 'late', label: 'Late game', from: MID_GAME_END, to: 1e9 }];
const LOSS_GRADES = ['ok', 'inaccuracy', 'mistake', 'blunder']; // by cost band
const UNSPENT_GOLD = 1500, FAR_FROM_FIGHT = 5000;

// ---------------------------------------------------------------- helpers
const evalFor = (g, team, t) => { const c = smoothAt(g, 's10', clamp(t, 0, g.duration)); return 50 + 50 * (team === 100 ? c : -c); };

// ---------------------------------------------------------------- win-chance valuation (trained model, see train/)
// Each action is valued by how much it moved its team's win chance (in percentage points), using the model fitted on
// Master+ games. Grades are then percentiles of the same measurement over thousands of Master+ actions of the same kind,
// so "Mistake" means "costlier than ~85% of deaths in high-elo games", not a hand-set rule.
const wpT = (g, team, t) => wpFor(g, team, clamp(t, 0, g.duration));
const swing = (g, team, a, b) => wpT(g, team, b) - wpT(g, team, a);
// "structural" win chance: everything except champions alive / death timers. Used where respawns would otherwise mask
// what a team built (gold, towers, objectives, map) — e.g. the 90 s after a Baron taken off a won fight.
function wpS(g, team, t) {
  if (!g.wpm) return wpT(g, team, t);
  const st = stateAt(g, clamp(t, 0, g.duration));
  const w = wpPredict(g.wpm, Object.assign({}, st.f, { alive: 0, deadTime: 0 }), st.t).wp;
  return 100 * (team === 100 ? w : 1 - w);
}
const swingS = (g, team, a, b) => wpS(g, team, b) - wpS(g, team, a);
const NORMS = () => (window.WP_MODEL && window.WP_MODEL.norms) || null;
function pctOf(key, v) { // percentile (0–100) of v among high-elo values of this kind
  const N = NORMS(); const q = N && N[key]; if (!q || v == null) return null;
  const n = q.length - 1;
  if (v <= q[0]) return 0;
  if (v >= q[n]) return 100;
  for (let i = 1; i <= n; i++) if (v <= q[i]) { const f = q[i] > q[i - 1] ? (v - q[i - 1]) / (q[i] - q[i - 1]) : 0.5; return (i - 1 + f) * 100 / n; }
  return 100;
}
// percentile cut-offs between bands, plus absolute fallbacks (win-chance points) for when no calibration is loaded
const BANDS = {
  deathCost: { p: [60, 85, 96], abs: [2.5, 5, 10] },   // OK | Inaccuracy | Mistake | Blunder
  fightLoss: { p: [50, 80, 95], abs: [3, 7, 14] },     // OK | Inaccuracy | Mistake | Blunder
  objLoss: { p: [45, 78, 94], abs: [3, 7, 14] },       // OK | Inaccuracy | Mistake | Blunder
  fightGain: { p: [65, 92], abs: [5, 12] },            // Good | Great | (top band, Brilliant if also against the odds)
  pickGain: { p: [65, 92], abs: [3, 8] },              // single kills are compared with other single kills, not with teamfights
  objGain: { p: [75], abs: [8] },                      // Good | Great
  convGain: { p: [25], abs: [0] },                     // below the cut: the fight was not converted (Miss)
};
function bandOf(key, v) {
  const B = BANDS[key], pct = pctOf(key, v); let i = 0;
  if (pct != null) while (i < B.p.length && pct >= B.p[i]) i++;
  else while (i < B.abs.length && v >= B.abs[i]) i++;
  return { band: i, pct };
}
const COLLECT = v => { if (window.REVIEW_COLLECT) window.REVIEW_COLLECT.push(v); };
const fmtWp = v => (Math.abs(v) < 0.05 ? '0.0%' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`);
// "costlier than 87% of deaths in Master+ games" / "cheaper than 70% of …"
const pctTxt = (pct, more, less, what) => (pct == null ? '' : pct >= 50 ? `: ${more} ${Math.min(99, Math.round(pct))}% of ${what} in Master+ games` : `: ${less} ${Math.min(99, Math.round(100 - pct))}% of ${what} in Master+ games`);
// Epic monsters are valued by their total effect: how much the taking team's win chance rose on average over the 90 s
// after taking that monster at that game time, in high-elo games (most of a Baron's value arrives as towers fall
// afterwards, not at the moment it dies). Towers and inhibitors are valued by the jump when they fall.
const OBJ_WINDOW = 90;
function objKey(g, o) { return o.key === 'DRAGON' && g.souls.some(s => s.team === o.team && Math.abs(s.t - o.t) < 5) ? 'DRAGON_SOUL' : o.key; }
function objValueOf(g, o) {
  const T = NORMS() && NORMS().objValue && NORMS().objValue[objKey(g, o)];
  if (!T || !T.length) return Math.max(0, swingS(g, o.team, o.t - 3, Math.min(g.duration, o.t + OBJ_WINDOW)));
  if (o.t <= T[0][0]) return Math.max(0, T[0][1]);
  for (let i = 1; i < T.length; i++) if (o.t <= T[i][0]) return Math.max(0, lerpV(T[i - 1][1], T[i][1], (o.t - T[i - 1][0]) / (T[i][0] - T[i - 1][0])));
  return Math.max(0, T[T.length - 1][1]);
}
const lerpV = (a, b, f) => a + (b - a) * f;
function gainValue(g, team, x) { return x.kind === 'obj' && x.o ? objValueOf(g, x.o) : Math.max(0, swing(g, team, x.t - 3, x.t + 3)); }
function gainsValue(g, team, list) { let v = 0; for (const x of list) v += gainValue(g, team, x); return v; }
const objValue = o => ({ BARON_NASHOR: 3, ELDER: 3.5, ATAKHAN: 2, DRAGON: 1.5, RIFTHERALD: 1, HORDE: 0.35 * (o.count || 1) })[o.key] || 1;
const sumV = arr => arr.reduce((a, b) => a + b.v, 0);
const names = (arr, max = 3) => arr.slice(0, max).map(x => x.name).join(', ') + (arr.length > max ? ` and ${arr.length - max} more` : '');
const champOf = (g, id) => (g.byId[id] ? g.byId[id].cname : null);
const frameIdx = (g, t) => { let i = 0; while (i + 1 < g.ft.length && g.ft[i + 1] <= t) i++; return i; };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// objectives + structures a team gained in [a, b]
function gains(g, team, a, b) {
  const out = [];
  for (const o of g.objectives) if (o.team === team && o.t >= a && o.t <= b) out.push({ t: o.t, name: o.name, v: objValue(o), x: o.x, y: o.y, kind: 'obj', killer: o.killer, assists: o.assists, o });
  for (const s of g.structureEvents) if (s.team === team && s.t >= a && s.t <= b)
    out.push({ t: s.t, name: s.label, v: s.kind === 'inhib' ? 1.5 : s.tier === 'NEXUS_TURRET' ? 1.2 : 0.8, x: s.x, y: s.y, kind: 'struct', killer: s.killer });
  return out.sort((x, y) => x.t - y.t);
}
function wardsPlaced(g, team, a, b) {
  let n = 0;
  for (const e of g.events) { if (e.t > b) break; if (e.t >= a && e.type === 'WARD_PLACED' && g.byId[e.creatorId] && g.byId[e.creatorId].team === team) n++; }
  return n;
}
function upgrade(grade) { const i = GRADE_ORDER.indexOf(grade); return i > 1 && i <= 3 ? GRADE_ORDER[i - 1] : grade; }
function downgrade(grade) { const map = { brilliant: 'great', great: 'good', good: 'ok', ok: 'inaccuracy', inaccuracy: 'mistake', miss: 'mistake', mistake: 'blunder' }; return map[grade] || grade; }
function act(o) { return Object.assign({ pids: [], weight: 1, tags: [], better: '', detail: '' }, o); }

// ---------------------------------------------------------------- deaths
function reviewDeath(g, p, d) {
  const team = p.team, en = ENEMY[team], sg = team === 100 ? 1 : -1, t = d.t;
  const pre = Math.max(0, t - 4);
  const terr = influenceAtPoint(g, pre, d.x, d.y) * sg;
  const zone = zoneOf(d.x, d.y);
  const near = nearbyCounts(g, Math.max(0, t - 2), d.x, d.y, 2500);
  const allies = Math.max(1, near[team]), enemies = near[en];
  const laning = t < LANING_END && !!zone.lane && p.role !== 'JUNGLE';
  const k = d.kill;
  const killers = [k.killer, ...k.assists].map(id => g.byId[id]).filter(q => q && q.team === en);
  const gankedBy = killers.find(q => q.role === 'JUNGLE');
  const fight = g.fights.find(f => f.kills.includes(k));
  const fT = fight ? fight.by[team] : 0, fE = fight ? fight.by[en] : 1;
  const before = evalFor(g, team, t - 15), after = evalFor(g, team, t + 45);
  const conv = gains(g, en, t + 1, t + 75);
  const own = gains(g, team, t - 30, t + 40).filter(x => dist(x, d) < 6000);
  const unspent = p.series.cur[frameIdx(g, t)] || 0;
  const bounty = k.bounty || 0;
  const ctrl = (before - 50) / 50;
  const traded = !!fight && fight.size > 1 && fT >= fE;
  let sev = 0.22; const why = [], tips = [], tags = [];

  if (terr < -0.25) { sev += 0.2; why.push(`in ${TEAM_NAME[en]}-controlled territory`); tags.push('Enemy territory'); }
  if (!laning && allies <= 1 && enemies >= 1) { sev += 0.18; why.push('with no allies nearby'); tags.push('Isolated'); }
  if (enemies > allies) { sev += 0.1 + 0.05 * Math.min(3, enemies - allies - 1); why.push(`outnumbered ${allies}v${enemies}`); tags.push(`Outnumbered ${allies}v${enemies}`); }
  if (g.hasWards) {
    const st = stateAt(g, pre); const mw = team === 100 ? st.raw.wardsB : st.raw.wardsR, tw = team === 100 ? st.raw.wardsR : st.raw.wardsB;
    if (tw - mw >= 2) { sev += 0.08; why.push(`with less vision (≈${mw.toFixed(0)} vs ${tw.toFixed(0)} wards)`); tags.push('Vision deficit'); }
  }
  if (ctrl > 0.15) { sev += 0.08; why.push('while your team was ahead'); tags.push('Team was ahead'); }
  if (conv.length) { sev += 0.12 + 0.08 * Math.min(3, sumV(conv)); tags.push('Enemy converted'); }
  if (bounty >= 450) { sev += 0.08; why.push(`giving up a ${bounty}g bounty`); tags.push('Shutdown given'); }
  if (unspent >= UNSPENT_GOLD) { sev += 0.06; why.push(`holding ${fmtGold(unspent, false)} unspent gold`); tags.push('Unspent gold'); }
  if (laning && gankedBy) tags.push(`Ganked by ${gankedBy.cname}`);
  if (traded) { sev -= 0.35; tags.push(fT > fE ? 'Fight won' : 'Even trade'); }
  if (own.length) { sev -= 0.22; tags.push('Team got value'); }
  if (terr > 0.25 && allies >= enemies) sev -= 0.1;
  if (laning) sev -= 0.06;
  sev += clamp(before - after, 0, 30) / 30 * 0.25;
  sev = clamp(sev, 0, 1.5);
  let grade = sev >= 1.0 ? 'blunder' : sev >= 0.7 ? 'mistake' : sev >= 0.45 ? 'inaccuracy' : 'ok';

  // trained model: what the death cost in win chance. The death itself (the same moment with you alive and no bounty
  // paid), plus your share of what the enemy took while you were dead, minus what your team got for it.
  let cost = null, costTxt = '', dwp = null;
  if (g.wpm) {
    const st = stateAt(g, Math.min(g.duration, t + 2));
    const cf = wpWithoutDeath(g, st.t, st, p, d);
    const direct = cf == null ? 0 : Math.max(0, 100 * (team === 100 ? cf - st.wp : st.wp - cf));
    let convCost = 0;
    for (const x of gains(g, en, t + 1, Math.min(d.respawn + 15, t + 90))) {
      const j = gainValue(g, en, x); if (j <= 0) continue;
      const deadMates = g.ps.filter(q => q.team === team && isDead(q, x.t - 1)).length;
      convCost += isDead(p, x.t - 1) ? j / Math.max(1, deadMates) : 0.5 * j / Math.max(1, deadMates + 1);
    }
    const ownV = gainsValue(g, team, own) * 0.5;
    const fightV = fight && fight.size > 1 ? Math.max(0, swing(g, team, fight.start - 6, fight.end + 3)) / Math.max(1, fight.by[en]) : 0;
    cost = Math.max(0, direct + convCost - ownV - fightV);
    dwp = -(direct + convCost);
    COLLECT({ key: 'deathCost', v: cost, t });
    const b = bandOf('deathCost', cost);
    grade = LOSS_GRADES[b.band];
    sev = 0.2 + b.band * 0.3;
    const back = ownV + fightV;
    costTxt = ` It cost your team about ${(direct + convCost).toFixed(1)}% win chance` +
      (convCost >= 0.5 ? ` (${direct.toFixed(1)}% from the death, ${convCost.toFixed(1)}% from what ${TEAM_NAME[en]} took meanwhile)` : '') +
      (back >= 0.5 ? `; your team won ${Math.min(back, direct + convCost).toFixed(1)}% back around it, so the net cost was ${cost.toFixed(1)}%` : '') +
      pctTxt(b.pct, 'costlier than', 'cheaper than', 'deaths') + '.';
  }

  if (tags.includes('Enemy territory') && tags.includes('Isolated')) tips.push(`Walking alone into ${TEAM_NAME[en]}-controlled space is the most common way to get picked off. Count how many enemies are missing from the map, and ward ahead or move with a teammate.`);
  else if (tags.includes('Enemy territory')) tips.push('This part of the map belonged to the enemy at that moment. Only go there with vision or a numbers advantage.');
  if (enemies > allies && !tags.includes('Isolated')) tips.push(`You fought ${allies}v${enemies}. Back off until your team can join — fights are decided by numbers first.`);
  if (laning && gankedBy) tips.push(`Ganked by ${gankedBy.cname}. Track the enemy jungler: when you can't see them, play closer to your tower and ward the river / tri-brush.`);
  if (tags.includes('Vision deficit')) tips.push('Your team had less vision here, so you could not see the threat coming. Ward before you walk in.');
  if (tags.includes('Team was ahead')) tips.push('Your team was in control. When ahead, dying is the main way to give the lead back — play around vision and objectives rather than risky plays.');
  if (conv.length) tips.push(`Your death opened ${names(conv)} for the enemy. Near objective timers, staying alive is worth more than a kill.`);
  if (tags.includes('Shutdown given')) tips.push('You carried a bounty — the enemy gained a lot from this. Play safer while you are worth a shutdown.');
  if (tags.includes('Unspent gold')) tips.push(`You died with ${fmtGold(unspent, false)} unspent. Recall to buy before taking risky fights.`);
  if (!tips.length) tips.push(traded ? "This death was part of a fight your team didn't lose — acceptable." : own.length ? `Your team got ${names(own)} around this death — an acceptable trade.` : 'Fair fight in neutral or friendly territory — watch the replay here to check the trade and mechanics.');

  const killer = champOf(g, k.killer);
  return act({ t, team, actor: p.id, pids: [p.id], kind: 'death', grade, weight: cost != null ? 1 + Math.min(1.2, cost / 8) : 1 + sev, sev, dwp, cost,
    title: `Died in ${zone.name}${killer ? ` to ${killer}` : ' (minions / tower)'}`,
    detail: (why.length ? `You died ${why.join(', ')}.` : 'You died in an even situation.') + (conv.length ? ` ${TEAM_NAME[en]} then took ${names(conv)}.` : '') + costTxt,
    better: tips.join(' '), tags, before, after, x: d.x, y: d.y });
}

// ---------------------------------------------------------------- fights
function reviewFights(g, A) {
  for (const f of g.fights) {
    const t0 = f.start, t1 = f.end;
    for (const team of [100, 200]) {
      const en = ENEMY[team], sg = team === 100 ? 1 : -1, net = f.by[team] - f.by[en];
      const pre = Math.max(0, t0 - 5);
      const st = stateAt(g, pre);
      const nearC = nearbyCounts(g, pre, f.x, f.y, 3500); const nT = nearC[team], nE = nearC[en];
      const goldDiff = (st.raw.goldB - st.raw.goldR) * sg;
      const terr = influenceAtPoint(g, pre, f.x, f.y) * sg;
      const adv = (nT - nE) * 0.5 + clamp(goldDiff / 2500, -1.5, 1.5) * 0.5 + terr * 0.6;
      const before = evalFor(g, team, t0 - 15), after = evalFor(g, team, t1 + 30);
      const disadv = [], advs = [];
      if (nT < nE) disadv.push(`${nT}v${nE} near the fight`); else if (nT > nE) advs.push(`${nT}v${nE} near the fight`);
      if (goldDiff < -1500) disadv.push(`${fmtGold(-goldDiff, false)} gold behind`); else if (goldDiff > 1500) advs.push(`${fmtGold(goldDiff, false)} gold ahead`);
      if (terr < -0.25) disadv.push('in enemy territory'); else if (terr > 0.25) advs.push('in your territory');
      const conv = gains(g, team, t1, t1 + 100);
      const res = `${f.by[team]}–${f.by[en]}`;
      let grade, detail, better = '';
      // trained model: the fight's swing in win chance, and how much of it the team kept over the next 90 s
      const fv = g.wpm ? swing(g, team, t0 - 6, t1 + 3) : null;
      const gainKey = f.size > 1 ? 'fightGain' : 'pickGain';
      const fb = fv == null ? null : fv >= 0 ? bandOf(gainKey, fv) : bandOf('fightLoss', -fv);
      if (fv != null && (f.size > 1 || fv >= 0)) COLLECT({ key: fv >= 0 ? gainKey : 'fightLoss', v: Math.abs(fv), t: t0 });
      const fvTxt = fv == null ? '' : ` Win chance ${fmtWp(fv)}` + (fv >= 0 ? pctTxt(fb.pct, 'a bigger swing than', 'a smaller swing than', f.size > 1 ? 'won fights' : 'single kills') : pctTxt(fb.pct, 'a bigger loss than', 'a smaller loss than', 'lost fights')) + '.';
      if (net > 0) {
        if (fb && fv > 0) {
          grade = fb.band >= 2 && adv < -0.8 && f.size >= 4 && net >= 2 && nT < nE ? 'brilliant' : fb.band >= 1 || (adv < -0.4 && (f.size >= 3 || nT < nE)) ? 'great' : 'good';
        } else if (fb) grade = 'ok';
        else if (adv < -0.8 && f.size >= 4 && net >= 2 && nT < nE) grade = 'brilliant';
        else if (adv < -0.4 && (f.size >= 3 || nT < nE)) grade = 'great';
        else if (net >= 2 && conv.length) grade = 'great';
        else grade = 'good';
        detail = `Won ${res} in ${f.zone}` + (adv < -0.4 && disadv.length ? ` despite being at a disadvantage (${disadv.join(', ')})` : '') + (conv.length ? `, then converted into ${names(conv)}.` : '.') + fvTxt;
        if (net >= 2 && f.size >= 3) {
          const cv = g.wpm ? swingS(g, team, t1 + 3, t1 + 90) : null;
          if (cv != null) COLLECT({ key: 'convGain', v: cv, t: t1 });
          const cb = cv == null ? null : bandOf('convGain', cv);
          const unconverted = cb ? cb.band === 0 && !conv.length : !conv.length;
          if (unconverted) {
            const alive = g.ps.filter(q => q.team === team && !isDead(q, t1 + 5)).map(q => q.id);
            A.push(act({ t: t1 + 10, team, actor: null, pids: alive, kind: 'conversion', grade: 'miss', weight: 0.8, dwp: cv,
              title: `Won a ${res} fight but took nothing`,
              detail: `After winning in ${f.zone} at ${fmtTime(t1)}, your team didn't take a tower or objective in the next 100 seconds.` +
                (cv != null ? ` What it built over the next 90 s (gold, towers, objectives, map): ${fmtWp(cv)} win chance${cb.pct != null ? `, less than ${Math.round(100 - cb.pct)}% of Master+ teams after a won fight` : ''}.` : ''),
              better: 'Right after winning a fight, look for the nearest thing to take: a tower, dragon/Baron if it is up, or the enemy jungle. Kills only win games when they are converted.',
              before: evalFor(g, team, t1), after: evalFor(g, team, t1 + 100), tags: ['Unconverted'] }));
          }
        }
      } else if (net < 0) {
        const lossGrade = fb && fv < 0 ? LOSS_GRADES[fb.band] : fb ? 'ok' : null;
        if (adv > 0.4) { grade = lossGrade || (net <= -2 ? 'mistake' : 'inaccuracy'); detail = `Lost ${res} in ${f.zone} despite having the advantage${advs.length ? ` (${advs.join(', ')})` : ''}.`; better = 'This fight was winnable. Look at the engage and target selection — fight together and focus the closest threat.'; }
        else if (adv < -0.4) { grade = lossGrade || (net <= -2 ? 'mistake' : 'inaccuracy'); detail = `Fought at a disadvantage${disadv.length ? ` (${disadv.join(', ')})` : ''} and lost ${res} in ${f.zone}.`; better = 'You were not favoured here. Avoid fights you are behind in — give up the area and look for a trade on the other side of the map.'; }
        else { grade = lossGrade || (net <= -3 ? 'mistake' : net <= -2 ? 'inaccuracy' : 'ok'); detail = `Lost an even fight ${res} in ${f.zone}.`; better = BAD_GRADES.has(grade) ? 'Even fights come down to engage timing and focus — watch the replay of this one.' : ''; }
        detail += fvTxt;
      } else {
        grade = fb && fv < 0 && fb.band >= 2 ? 'inaccuracy' : 'ok'; detail = `Traded ${res} in ${f.zone}.` + fvTxt;
      }

      // actors: everyone on this team who scored a kill/assist; on a lost fight also survivors who were close by
      const scorers = new Map();
      for (const k of f.kills) if (k.team === team) {
        if (g.byId[k.killer]) scorers.set(k.killer, (scorers.get(k.killer) || { k: 0, a: 0 })), scorers.get(k.killer).k++;
        for (const a of k.assists) if (g.byId[a] && g.byId[a].team === team) scorers.set(a, scorers.get(a) || { k: 0, a: 0 }), scorers.get(a).a++;
      }
      const victims = new Set(f.kills.filter(k => g.byId[k.victim] && g.byId[k.victim].team === team).map(k => k.victim));
      if (net < 0) for (const q of g.ps) if (q.team === team && !victims.has(q.id) && !scorers.has(q.id) && !isDead(q, pre) && dist(posAt(q, pre), f) < 2500) scorers.set(q.id, { k: 0, a: 0, near: true });
      if (f.size === 1 && net < 0) continue; // a single pick is reviewed as the victim's death
      for (const [pid, c] of scorers) {
        let pg = grade;
        if (c.k >= 2 && net > 0) pg = upgrade(pg);
        const you = c.near ? ' — you were nearby' : ` — you: ${plural(c.k, 'kill')}, ${plural(c.a, 'assist')}`;
        const stake = fv == null ? 1 : 0.6 + Math.min(1, Math.abs(fv) / 10);
        A.push(act({ t: t0, team, actor: pid, pids: [pid], kind: 'fight', grade: pg, weight: (c.near ? 0.4 : 0.8) * stake, dwp: fv,
          title: `${f.label} in ${f.zone}: ${net > 0 ? 'won' : net < 0 ? 'lost' : 'traded'} ${res}${you}`,
          detail, better, before, after, x: f.x, y: f.y, tags: [f.label] }));
      }

      // absent from a teamfight the team lost
      if (f.involved >= 6 && f.size >= 2 && net <= -2 && t0 >= LANING_END) {
        for (const q of g.ps) {
          if (q.team !== team || isDead(q, t0) || scorers.has(q.id) || victims.has(q.id)) continue;
          const qp = posAt(q, t0); const dd = dist(qp, f);
          if (dd < FAR_FROM_FIGHT) continue;
          const side = gains(g, team, t0 - 40, t1 + 40).filter(x => x.killer === q.id || dist(x, qp) < 3000);
          if (side.length) A.push(act({ t: t0, team, actor: q.id, pids: [q.id], kind: 'absent', grade: 'good', weight: 0.6,
            title: `Cross-map: took ${names(side)} while your team fought`, detail: `Your team lost ${res} in ${f.zone}, but you took ${names(side)} at the same time.`,
            better: '', before, after, tags: ['Cross-map'] }));
          else A.push(act({ t: t0, team, actor: q.id, pids: [q.id], kind: 'absent', grade: 'miss', weight: 1,
            title: `Missed the teamfight in ${f.zone}`,
            detail: `You were in ${zoneOf(qp.x, qp.y).name}, about ${Math.round(dd / 100) * 100} units away, while your team lost ${res}.`,
            better: 'Group up when a fight is likely (objective about to spawn, enemies grouping). If you split push, the enemy must have to answer you — and back off when they collapse on your team instead.',
            before, after, tags: ['Absent'] }));
        }
      }
    }
  }
}

// ---------------------------------------------------------------- objectives
function reviewObjectiveActions(g, A) {
  for (const o of g.objectiveReview) {
    const V = objValue(o); const taker = o.team, other = ENEMY[taker];
    const before = evalFor(g, taker, o.t - 45), after = evalFor(g, taker, o.t + 30);
    const takers = new Set(g.ps.filter(q => q.team === taker && !isDead(q, o.t - 1) && dist(posAt(q, o.t - 1), o) < FAR_FROM_FIGHT).map(q => q.id));
    if (g.byId[o.killer] && g.byId[o.killer].team === taker) takers.add(o.killer);
    for (const a of o.assists || []) if (g.byId[a] && g.byId[a].team === taker) takers.add(a);
    let gT, dT;
    if (o.near[taker] < o.near[other] && o.near[other] >= 3) { gT = V >= 1.5 ? 'brilliant' : 'great'; dT = `Took ${o.name} while outnumbered at the pit (${o.near[taker]}v${o.near[other]}).`; }
    else if (o.fightBefore) { gT = 'great'; dT = `Won a fight ${o.fightBefore.by[taker]}–${o.fightBefore.by[other]} and converted it into ${o.name}. Textbook.`; }
    else if (o.before >= 0.1) { gT = 'good'; dT = `Set up from a position of control — your team owned the map before ${o.name}.`; }
    else if (o.before <= -0.15) { gT = 'great'; dT = `Took ${o.name} while behind on control — good opportunism.`; }
    else { gT = 'good'; dT = `Took ${o.name} from an even position.`; }
    const wT = g.hasWards ? wardsPlaced(g, taker, o.t - 90, o.t) : null, wO = g.hasWards ? wardsPlaced(g, other, o.t - 90, o.t) : null;
    const wardTxt = g.hasWards ? ` Wards placed in the 90s before: ${TEAM_NAME[taker]} ${wT}, ${TEAM_NAME[other]} ${wO}.` : '';
    // trained model: what the objective was worth in win chance at that moment
    const ov = g.wpm ? objValueOf(g, o) : null;
    if (ov != null) {
      COLLECT({ key: 'objTotal', obj: objKey(g, o), t: o.t, v: swingS(g, taker, o.t - 3, Math.min(g.duration, o.t + OBJ_WINDOW)) });
      COLLECT({ key: 'objGain', v: ov, t: o.t, obj: o.key });
      if (gT === 'good' && bandOf('objGain', ov).band >= 1) gT = 'great';
      dT += NORMS() && NORMS().objValue ? ` Taking it at this point is worth about ${fmtWp(ov)} win chance in Master+ games.` : ` Worth ${fmtWp(ov)} win chance.`;
    }
    dT += wardTxt;
    A.push(act({ t: o.t, team: taker, actor: o.killer, pids: [...takers], kind: 'objective', grade: gT, weight: ov != null ? 0.3 + Math.min(1.2, ov / 8) : 0.4 * V, dwp: ov,
      title: `Took ${o.name}`, detail: dT, better: '', before, after, x: o.x, y: o.y, tags: ['Objective'] }));

    const losers = g.ps.filter(q => q.team === other && !isDead(q, o.t - 1)).map(q => q.id);
    if (!losers.length) continue;
    const trade = gains(g, other, o.t - 60, o.t + 60); const tradeV = sumV(trade);
    const lb = -o.before;
    const far = losers.filter(id => dist(posAt(g.byId[id], o.t - 1), o) > FAR_FROM_FIGHT).map(id => champOf(g, id));
    let gL, dL, bL = '';
    // trained model: net loss = the objective's value to them minus what you took at the same time
    const tradeWp = ov != null ? gainsValue(g, other, trade) : null;
    const netLoss = ov != null ? Math.max(0, ov - tradeWp) : null;
    const lossB = netLoss != null ? bandOf('objLoss', netLoss) : null;
    if (netLoss != null && o.aliveOther > 3) COLLECT({ key: 'objLoss', v: netLoss, t: o.t, obj: o.key });
    const lossGrade = lossB ? LOSS_GRADES[lossB.band] : null;
    if (lossB ? trade.length && (tradeWp >= ov * 0.8 || lossB.band === 0) : tradeV >= V * 0.6) { gL = 'ok'; dL = `Gave up ${o.name} but traded for ${names(trade)}.`; }
    else if (lossB ? trade.length && BAD_GRADES.has(lossGrade) : tradeV >= V * 0.3 && lb > -0.2) { gL = lossB ? lossGrade : 'inaccuracy'; dL = `Gave up ${o.name} and only partly traded for it (${names(trade)}).`; bL = 'The trade was uneven. Either contest with your whole team, or take something of equal value at the same time.'; }
    else if (o.aliveOther <= 3) { gL = 'ok'; dL = `Lost ${o.name} with only ${o.aliveOther} alive — the deaths before it caused this, not the call.`; }
    else if (lb <= -0.2) { gL = lossB && lossB.band >= 3 ? 'inaccuracy' : 'ok'; dL = `Conceded ${o.name} while behind — reasonable, but a trade on the other side of the map would have been better.`; bL = 'When you cannot contest, take something at the same time: a tower, plates, or the enemy jungle camps.'; }
    else if (o.near[other] >= 3 && o.near[other] >= o.near[taker]) { gL = lossB ? (lossB.band >= 2 ? 'inaccuracy' : 'ok') : 'inaccuracy'; dL = `Contested ${o.name} with ${o.near[other]} nearby but still lost it.`; bL = 'You had the bodies there — look at vision around the pit and who started the objective first.'; }
    else {
      gL = lossB ? (lossB.band === 0 ? 'inaccuracy' : lossGrade) : V >= 3 ? 'blunder' : V >= 1.5 ? 'mistake' : 'inaccuracy';
      const state = lb > 0.1 ? 'in your favour' : 'even';
      dL = o.near[other] >= 2
        ? `Lost ${o.name} while the game was ${state}: ${o.near[other]} of you were nearby${o.near[other] < o.near[taker] ? ' but outnumbered' : ''} (${o.near[other]}v${o.near[taker]})${far.length ? `; far away: ${far.join(', ')}` : ''}.`
        : `Gave up ${o.name} for free while the game was ${state} (${o.near[other]} of you nearby${far.length ? `; far away: ${far.join(', ')}` : ''}).`;
      bL = 'Track objective timers. Be grouped with vision around the pit about 60s before it spawns. If you cannot contest, trade: take a tower or camps on the opposite side.';
    }
    if (o.key === 'HORDE' && BAD_GRADES.has(gL)) gL = 'inaccuracy';
    if (netLoss != null) dL += ` Net cost: ${netLoss.toFixed(1)}% win chance${trade.length ? ' after your trade' : ''}${BAD_GRADES.has(gL) ? pctTxt(lossB.pct, 'more than', 'less than', 'objectives lost') : ''}.`;
    dL += wardTxt;
    if (g.hasWards && BAD_GRADES.has(gL) && wO < wT) bL = `Your team placed fewer wards (${wO} vs ${wT}) in the 90s before it. ` + bL;
    A.push(act({ t: o.t, team: other, actor: null, pids: losers, kind: 'objective-lost', grade: gL, weight: netLoss != null ? 0.25 + Math.min(1.1, netLoss / 8) : 0.35 * V, dwp: netLoss != null ? -netLoss : null,
      title: `Lost ${o.name}`, detail: dL, better: bL, before: 100 - before, after: 100 - after, x: o.x, y: o.y, tags: ['Objective'] }));
  }
  // structures destroyed by a player
  for (const s of g.structureEvents) {
    if (!g.byId[s.killer]) continue;
    const sv = g.wpm ? Math.max(0, swing(g, s.team, s.t - 3, s.t + 3)) : null;
    A.push(act({ t: s.t, team: s.team, actor: s.killer, pids: [s.killer], kind: 'structure', grade: s.kind === 'inhib' ? 'great' : 'good', weight: s.kind === 'inhib' ? 0.6 : 0.3, dwp: sv,
      title: `Destroyed ${s.label}`, detail: `Last-hit ${s.label}.` + (sv != null ? ` Worth ${fmtWp(sv)} win chance.` : ''), before: evalFor(g, s.team, s.t - 15), after: evalFor(g, s.team, s.t + 30), x: s.x, y: s.y, tags: ['Structure'] }));
  }
}

// ---------------------------------------------------------------- recalls
function reviewRecalls(g, A) {
  for (const p of g.ps) {
    const team = p.team, en = ENEMY[team], s = p.series;
    for (const r of p.recalls) {
      const t = r.t; if (t < 90 || t > g.duration - 30) continue;
      let i = 1; while (i < g.ft.length - 1 && g.ft[i] < t) i++;
      const spent = i > 0 ? Math.max(0, s.cur[i - 1] + (s.gold[i] - s.gold[i - 1]) - s.cur[i]) : 0;
      const enemyObj = gains(g, en, t, t + 75).filter(x => x.kind === 'obj' && x.v >= 1.5)
        .filter(x => isDead(p, x.t - 1) || dist(posAt(p, x.t - 1), x) > FAR_FROM_FIGHT);
      const ownTrade = gains(g, team, t - 20, t + 75).length > 0;
      const lostFight = g.fights.find(f => f.start > t && f.start < t + 45 && f.by[en] - f.by[team] >= 2 && f.involved >= 4
        && !f.kills.some(k => k.killer === p.id || k.victim === p.id || k.assists.includes(p.id)));
      const tempo = gains(g, team, t - 45, t).length > 0 || g.fights.some(f => f.end <= t && f.end > t - 45 && f.winner === team) || p.kills.some(k => k <= t && k > t - 40);
      const est = r.inferred ? ' (time estimated)' : '';
      let grade = 'ok', detail = `Recalled${spent > 50 ? ` and spent about ${fmtGold(spent, false)}` : ''}.`, better = '';
      // live recording: your health and gold just before you went back
      let hpBefore = null, goldBefore = null;
      if (g.live && g.live.me === p.id) {
        const L = g.live; let k = 0; while (k + 1 < L.t.length && L.t[k + 1] <= t - 12) k++;
        hpBefore = L.hp[k]; let k2 = 0; while (k2 + 1 < L.t.length && L.t[k2 + 1] <= t - 1) k2++; goldBefore = L.gold[k2];
      }
      if (enemyObj.length && !ownTrade) {
        const ov = g.wpm ? gainValue(g, en, enemyObj[0]) : null;
        grade = ov != null ? (ov >= 6 ? 'mistake' : 'inaccuracy') : enemyObj[0].v >= 3 ? 'mistake' : 'inaccuracy';
        detail = r.inferred ? `Recalled shortly before ${TEAM_NAME[en]} took ${enemyObj[0].name} (within about a minute).`
          : `Recalled ${Math.max(5, Math.round(enemyObj[0].t - t))}s before ${TEAM_NAME[en]} took ${enemyObj[0].name}.`;
        better = 'Time your recall around objectives: back right after a wave crashes or after your team takes something — not in the minute before a dragon/Baron spawns.';
      } else if (lostFight) {
        grade = 'inaccuracy'; detail = `Your team lost a fight ${lostFight.by[team]}–${lostFight.by[en]} shortly after you recalled.`;
        better = 'Before recalling, check whether the enemy is grouping. Coordinate recalls so your team is not left a player down.';
      } else if (hpBefore != null && hpBefore >= 0.75 && goldBefore < 600 && !tempo && t > 240) {
        grade = 'inaccuracy'; detail = `Low-value recall: you went back at ${Math.round(hpBefore * 100)}% health with only ${fmtGold(goldBefore, false)} gold to spend.`;
        better = 'A recall costs 30–45 seconds of map time. Go back when you can buy something meaningful or when you are low — otherwise keep farming or pressuring.';
      } else if (tempo && spent >= 900) { grade = 'good'; detail = `Recalled on tempo (right after your team gained something) and spent about ${fmtGold(spent, false)}.`; }
      else if (spent >= 1300) { detail = `Recalled with a big item spike — spent about ${fmtGold(spent, false)}.`; }
      if (hpBefore != null && !/Low-value/.test(detail)) detail = detail.replace(/\.$/, '') + ` (you had ${Math.round(hpBefore * 100)}% health and ${fmtGold(goldBefore, false)} gold before going back).`;
      A.push(act({ t, team, actor: p.id, pids: [p.id], kind: 'recall', grade, weight: grade === 'ok' ? 0.2 : 0.7, routine: grade === 'ok',
        title: `Recall${est}`, detail, better, before: evalFor(g, team, t - 10), after: evalFor(g, team, t + 60), tags: ['Recall'] }));
    }
  }
}

// ---------------------------------------------------------------- gold efficiency
function reviewGoldLive(g, A, p) {
  // 2-second gold samples from the live recording: carrying 1500+ gold while alive for 75 s or more
  const L = g.live; let i = 0;
  while (i < L.t.length) {
    if (L.t[i] >= 300 && L.gold[i] >= UNSPENT_GOLD && !isDead(p, L.t[i]) && L.t[i] < g.duration - 90) {
      let j = i, peak = L.gold[i];
      while (j + 1 < L.t.length && L.gold[j + 1] >= 1300 && L.gold[j + 1] >= L.gold[j] - 250) { j++; peak = Math.max(peak, L.gold[j]); }
      const dur = L.t[j] - L.t[i];
      if (dur >= 75) {
        const grade = (dur >= 180 || peak >= 2800) && L.t[i] < 1800 ? 'mistake' : 'inaccuracy';
        A.push(act({ t: L.t[i], team: p.team, actor: p.id, pids: [p.id], kind: 'gold', grade, weight: 0.6,
          title: `Unspent gold: up to ${fmtGold(peak, false)} for ${fmtTime(dur)}`,
          detail: `From ${fmtTime(L.t[i])} to ${fmtTime(L.t[j])} you held at least ${fmtGold(Math.min(L.gold[i], UNSPENT_GOLD), false)} without spending it (live recording).`,
          better: 'Unspent gold is wasted power. Find a safe moment to recall (after shoving a wave) as soon as you can complete an item or a big component.',
          before: evalFor(g, p.team, L.t[i]), after: evalFor(g, p.team, L.t[j]), tags: ['Gold'] }));
      }
      i = j + 1;
    } else i++;
  }
}
function reviewGold(g, A) {
  for (const p of g.ps) {
    if (g.live && g.live.me === p.id) { reviewGoldLive(g, A, p); continue; }
    const s = p.series, ft = g.ft, n = ft.length;
    let i = 0;
    while (i < n) {
      if (ft[i] >= 300 && s.cur[i] >= UNSPENT_GOLD && ft[i] < g.duration - 90) {
        let j = i;
        while (j + 1 < n && s.cur[j + 1] >= 1300 && (s.cur[j] + s.gold[j + 1] - s.gold[j] - s.cur[j + 1]) < 300) j++;
        if (j > i) {
          let peak = 0; for (let k = i; k <= j; k++) peak = Math.max(peak, s.cur[k]);
          const mins = Math.round((ft[j] - ft[i]) / 60) + 1;
          let grade = (j - i >= 3 || peak >= 2800) ? 'mistake' : 'inaccuracy';
          if (ft[i] > 1800) grade = 'inaccuracy';
          A.push(act({ t: ft[i], team: p.team, actor: p.id, pids: [p.id], kind: 'gold', grade, weight: 0.6,
            title: `Unspent gold: up to ${fmtGold(peak, false)} for ~${mins} min`,
            detail: `From ${fmtTime(ft[i])} to ${fmtTime(ft[j])} you carried more than ${fmtGold(Math.min(s.cur[i], UNSPENT_GOLD), false)} without buying.`,
            better: 'Unspent gold is wasted power. Find a safe moment to recall (after shoving a wave) as soon as you can complete an item or a big component.',
            before: evalFor(g, p.team, ft[i]), after: evalFor(g, p.team, ft[j]), tags: ['Gold'] }));
        }
        i = j + 1;
      } else i++;
    }
  }
}

// ---------------------------------------------------------------- laning, farming, vision summaries
function reviewSummaries(g, A) {
  const T = LANING_END, ft = g.ft, mins = g.duration / 60;
  const at = (p, key, t) => interpSeries(ft, p.series[key], t);
  for (const p of g.ps) {
    const team = p.team, en = ENEMY[team];
    const opp = p.role && g.ps.find(q => q.team === en && q.role === p.role);
    if (opp && g.duration > 900) {
      const csD = at(p, 'cs', T) - at(opp, 'cs', T), gD = at(p, 'gold', T) - at(opp, 'gold', T), xD = at(p, 'xp', T) - at(opp, 'xp', T);
      const laneKey = { TOP: 'TOP_LANE', MIDDLE: 'MID_LANE', BOTTOM: 'BOT_LANE', UTILITY: 'BOT_LANE' }[p.role];
      const platesFor = laneKey ? g.plates.filter(x => x.t < T && x.lane === laneKey && x.team === team).length : 0;
      const platesAgainst = laneKey ? g.plates.filter(x => x.t < T && x.lane === laneKey && x.team === en).length : 0;
      const plateTxt = laneKey && g.plates.length ? `, turret plates ${platesFor}–${platesAgainst}` : '';
      const score = (p.role === 'UTILITY' ? gD / 700 + xD / 900 : gD / 1000 + csD / 15 + xD / 1500) + (laneKey ? (platesFor - platesAgainst) * 0.2 : 0);
      let grade = score >= 2.2 ? 'great' : score >= 0.8 ? 'good' : score <= -2.2 ? 'mistake' : score <= -0.8 ? 'inaccuracy' : 'ok';
      // trained model: what your gold + XP lead over your lane opponent at 14:00 was worth in win chance
      let laneTxt = '', laneWp = null;
      if (g.wpm) {
        const m = g.wpm, w = knotWeights(m.knots, T), coef = k => (m.coef[k] || []).reduce((a, c, i) => a + c * w[i], 0);
        const L = coef('gold') * gD / 1000 + coef('xp') * xD / 1000;
        laneWp = 100 * (1 / (1 + Math.exp(-L)) - 0.5);
        COLLECT({ key: 'laneWp', v: laneWp, role: p.role });
        const pc = pctOf('laneWp', laneWp);
        if (pc != null) grade = pc >= 85 ? 'great' : pc >= 62 ? 'good' : pc >= 38 ? 'ok' : pc >= 15 ? 'inaccuracy' : 'mistake';
        laneTxt = ` Your lane lead was worth ${fmtWp(laneWp)} win chance${pc != null ? ` (better than ${Math.round(pc)}% of Master+ laners)` : ''}.`;
      }
      const kd = `${p.kills.filter(k => k < T).length}/${p.deaths.filter(d => d.t < T).length}`;
      const tips = { TOP: 'Focus on last-hitting under pressure, avoid trading when your wave is in a bad spot, and respect the enemy jungler. A lane death costs ~300g plus XP plus the wave.',
        MIDDLE: 'Prioritise last hits and wave control; when you roam, shove the wave first so you do not lose farm and plates.',
        BOTTOM: 'CS is your main income. Trade only when the enemy uses key spells, and play safe when the enemy jungler is unseen.',
        JUNGLE: 'Look at your pathing: full-clear efficiently and gank lanes the enemy jungler is not near. Track their start and mirror them.',
        UTILITY: 'Ward to protect your laner from ganks, and look for trades when the enemy support uses key spells.' };
      A.push(act({ t: T, team, actor: p.id, pids: [p.id], kind: 'laning', grade, weight: 1.5,
        title: `Laning phase vs ${opp.cname}`,
        detail: `At 14:00: ${csD >= 0 ? '+' : ''}${Math.round(csD)} CS, ${fmtGold(gD)} gold, ${fmtGold(xD)} XP vs your lane opponent${plateTxt} (K/D before 14:00: ${kd}).${laneTxt}`,
        better: BAD_GRADES.has(grade) ? (tips[p.role] || '') : '', before: evalFor(g, team, 0), after: evalFor(g, team, T), tags: ['Laning'], dwp: laneWp }));
    }
    const cs = (p.final.totalMinionsKilled || 0) + (p.final.neutralMinionsKilled || 0) || at(p, 'cs', g.duration);
    const cpm = cs / Math.max(1, mins);
    // benchmarks: Master+ players of the same role (60th / 35th / 15th / 5th percentile), else fixed values
    const BM = window.WP_MODEL && window.WP_MODEL.benchmarks && window.WP_MODEL.benchmarks[p.role];
    const fromBM = q => (q && q.length === 21 ? [q[12], q[7], q[3], q[1]].map(v => +v.toFixed(2)) : null);
    if (p.role && p.role !== 'UTILITY' && mins > 12) {
      const jg = p.role === 'JUNGLE';
      const b = fromBM(BM && BM.cpm) || (jg ? [6.5, 5.5, 4.5, 3.5] : [8, 7, 5.5, 4.5]);
      const grade = cpm >= b[0] ? 'great' : cpm >= b[1] ? 'good' : cpm >= b[2] ? 'ok' : cpm >= b[3] ? 'inaccuracy' : 'mistake';
      const bmTxt = BM && BM.cpm ? ` Master+ ${ROLE_SHORT[p.role] || p.role} players: ${BM.cpm[10].toFixed(1)} median; ${b[1].toFixed(1)}+ is good, ${b[0].toFixed(1)}+ excellent.` : ` Benchmarks for ${ROLE_SHORT[p.role] || p.role}: ${b[1]}+ good, ${b[0]}+ excellent.`;
      A.push(act({ t: g.duration, team, actor: p.id, pids: [p.id], kind: 'farm', grade, weight: 1,
        title: `Farming: ${cpm.toFixed(1)} CS/min`, detail: `${Math.round(cs)} CS over ${Math.round(mins)} minutes.${bmTxt}`,
        better: BAD_GRADES.has(grade) ? 'Farm is the most reliable income in the game. Between fights, keep catching side waves and clearing camps instead of standing around mid.' : '',
        before: 50, after: 50, tags: ['Farming'] }));
    }
    if (mins > 12) {
      const vs = p.final.visionScore || 0, vpm = vs / mins, cw = p.final.visionWardsBoughtInGame;
      const b = fromBM(BM && BM.vpm) || (p.role === 'UTILITY' ? [2.4, 1.8, 1.3, 0.9] : p.role === 'JUNGLE' ? [1.3, 1.0, 0.7, 0.5] : [1.0, 0.75, 0.5, 0.35]);
      let grade = vpm >= b[0] ? 'great' : vpm >= b[1] ? 'good' : vpm >= b[2] ? 'ok' : vpm >= b[3] ? 'inaccuracy' : 'mistake';
      if (cw === 0 && mins > 18) grade = downgrade(grade);
      const bmTxt = BM && BM.vpm && p.role ? ` Master+ ${ROLE_SHORT[p.role] || p.role} players: ${BM.vpm[10].toFixed(2)}/min median${BM.cw ? `, ${Math.round(BM.cw[10])} control wards` : ''}.` : '';
      A.push(act({ t: g.duration, team, actor: p.id, pids: [p.id], kind: 'vision', grade, weight: p.role === 'UTILITY' ? 1.5 : 0.8,
        title: `Vision: ${vpm.toFixed(2)} vision score/min`,
        detail: `Vision score ${vs}${p.final.wardsPlaced != null ? `, ${p.final.wardsPlaced} wards placed, ${p.final.wardsKilled || 0} destroyed` : ''}${cw != null ? `, ${cw} control wards bought` : ''}.${bmTxt}`,
        better: BAD_GRADES.has(grade) ? `Use your trinket on cooldown${cw === 0 ? ', buy a control ward every recall' : ''}, and sweep or ward before objectives. Vision is how your team knows where it is safe to walk.` : '',
        before: 50, after: 50, tags: ['Vision'] }));
    }
  }
}

// ---------------------------------------------------------------- roll-up
function summarise(acts) {
  let w = 0, s = 0; const counts = {}; GRADE_ORDER.forEach(k => (counts[k] = 0));
  for (const a of acts) { w += a.weight; s += a.weight * GRADES[a.grade].score; counts[a.grade]++; }
  return { accuracy: w ? s / w : null, counts, n: acts.length };
}
function phaseLabel(acc) {
  if (acc == null) return { label: '—', grade: 'ok' };
  return acc >= 90 ? { label: 'Excellent', grade: 'great' } : acc >= 80 ? { label: 'Good', grade: 'good' } : acc >= 68 ? { label: 'Inaccurate', grade: 'inaccuracy' }
    : acc >= 50 ? { label: 'Mistakes', grade: 'mistake' } : { label: 'Blunders', grade: 'blunder' };
}

function coachNotes(g, p, acts) {
  const notes = [];
  const deaths = acts.filter(a => a.kind === 'death');
  const tagCount = t => deaths.filter(a => a.tags.some(x => x.startsWith(t))).length;
  if (deaths.length) {
    const terr = tagCount('Enemy territory'), iso = tagCount('Isolated'), out = tagCount('Outnumbered'), conv = tagCount('Enemy converted'), ahead = tagCount('Team was ahead');
    if (terr >= 2) notes.push({ tone: 'bad', text: `${terr} of your ${deaths.length} deaths were in enemy-controlled territory. This is your biggest macro leak — before walking into fog on the enemy's side, ask "how many of them are missing?"` });
    if (iso >= 2) notes.push({ tone: 'bad', text: `${iso} deaths happened with no ally nearby. Move with your team in the mid/late game, or only side-lane when you know where the enemies are.` });
    if (out >= 2) notes.push({ tone: 'bad', text: `You were outnumbered in ${out} deaths. Count bodies before committing — even a fed champion loses 1v2.` });
    if (conv >= 2) notes.push({ tone: 'bad', text: `The enemy turned ${conv} of your deaths into objectives. Dying right before dragon/Baron timers costs far more than the kill gold.` });
    if (ahead >= 2) notes.push({ tone: 'warn', text: `${ahead} deaths came while your team was ahead. Leads are lost through deaths — when ahead, play around vision and let the enemy come to you.` });
  } else notes.push({ tone: 'good', text: 'You never died — great discipline.' });
  const absent = acts.filter(a => a.kind === 'absent' && a.grade === 'miss').length;
  if (absent) notes.push({ tone: 'bad', text: `You were far away for ${plural(absent, 'teamfight')} your team lost. Watch the map around objective timers and group up earlier.` });
  const gold = acts.filter(a => a.kind === 'gold').length;
  if (gold >= 2) notes.push({ tone: 'warn', text: `You sat on unspent gold ${gold} times. Recall when you can afford an item — gold in your pocket does nothing.` });
  const rec = acts.filter(a => a.kind === 'recall' && BAD_GRADES.has(a.grade)).length;
  if (rec) notes.push({ tone: 'warn', text: `${plural(rec, 'recall')} lined up badly with an enemy objective or fight. Plan recalls 60–90s before objective spawns.` });
  const lostObj = acts.filter(a => a.kind === 'objective-lost' && BAD_GRADES.has(a.grade)).length;
  if (lostObj) notes.push({ tone: 'bad', text: `Your team gave up ${plural(lostObj, 'objective')} without a fight or trade while the game was even or better.` });
  const lane = acts.find(a => a.kind === 'laning');
  if (lane) notes.push({ tone: BAD_GRADES.has(lane.grade) ? 'bad' : lane.grade === 'ok' ? 'neutral' : 'good', text: `Laning: ${lane.detail}` });
  const best = acts.filter(a => (a.grade === 'brilliant' || a.grade === 'great') && a.kind !== 'farm' && a.kind !== 'vision' && a.kind !== 'laning')
    .sort((a, b) => (a.grade === 'brilliant' ? 0 : 1) - (b.grade === 'brilliant' ? 0 : 1) || b.weight - a.weight)[0];
  if (best) notes.push({ tone: 'good', text: `Best moment: ${fmtTime(best.t)} — ${best.title}.` });
  return notes;
}

// ---------------------------------------------------------------- game story (a short narrative of how the game went)
function gameStory(g, myTeam) {
  const nm = t => (myTeam ? (t === myTeam ? `your team (${TEAM_NAME[t]})` : `${TEAM_NAME[t]}`) : TEAM_NAME[t]);
  const Nm = t => { const s = nm(t); return s.charAt(0).toUpperCase() + s.slice(1); };
  const why = { gold: 'a gold lead', xp: 'a level lead', vision: 'more vision', map: 'map control', obj: 'objectives', numbers: 'numbers after fights' };
  const out = [];
  const T14 = Math.min(LANING_END, g.duration);
  const c14 = smoothAt(g, 's30', T14), st14 = stateAt(g, T14), gd14 = st14.raw.goldB - st14.raw.goldR;
  const lead14 = Math.abs(c14) < 0.08 ? 0 : c14 > 0 ? 100 : 200;
  const firstTower = g.structureEvents.find(s => s.kind === 'tower');
  out.push({ t: 0, text: lead14 ? `${Nm(lead14)} came out of the laning phase ahead (${fmtGold(Math.abs(gd14), false)} gold at ${fmtTime(T14)}${firstTower ? `; first tower to ${TEAM_NAME[firstTower.team]} at ${fmtTime(firstTower.t)}` : ''}).`
    : `The laning phase was even (${fmtGold(Math.abs(gd14), false)} gold difference at ${fmtTime(T14)}).` });
  const items = [];
  for (const p of g.phases) if (p.leader && p.end - p.start >= 120 && p.end > T14) items.push({ t: p.start, kind: 'phase', text: `${Nm(p.leader)} controlled the game from ${fmtTime(p.start)} to ${fmtTime(p.end)}${p.reasons.length ? ` through ${p.reasons.slice(0, 2).map(r => why[r]).join(' and ')}` : ''}.` });
  const top = g.moments.slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 3);
  for (const m of top) {
    const ev = m.events.filter(e => e.team === m.team).slice(0, 2).map(e => e.text.replace(/^(Blue|Red) /, '').replace(/^(\w)/, c => c.toLowerCase()));
    items.push({ t: m.t, kind: 'moment', text: `At ${fmtTime(m.t)} ${nm(m.team)} swung the game${ev.length ? ': ' + ev.join(', then ') : ''}.` });
  }
  items.sort((a, b) => a.t - b.t);
  out.push(...items.slice(0, 5));
  if (g.winner) {
    const sg = g.winner === 100 ? 1 : -1; const sm = g.smooth.s30;
    let loserPeak = 0, winnerShare = 0;
    for (let i = 0; i < sm.length; i++) { loserPeak = Math.max(loserPeak, -sm[i] * sg); if (sm[i] * sg > 0.08) winnerShare++; }
    winnerShare /= sm.length;
    const flavour = loserPeak >= 0.35 ? ` — a comeback: ${nm(ENEMY[g.winner])} had been as high as ${Math.round(50 + loserPeak * 50)}% ${g.wpm ? 'win chance' : 'control'}` : winnerShare > 0.6 ? ' — controlled from start to finish' : '';
    out.push({ t: g.duration, text: `${Nm(g.winner)} won at ${fmtTime(g.duration)}${flavour}.` });
  }
  return out;
}

function reviewGame(g) {
  const A = [];
  for (const p of g.ps) for (const d of p.deaths) A.push(reviewDeath(g, p, d));
  reviewFights(g, A);
  reviewObjectiveActions(g, A);
  reviewRecalls(g, A);
  reviewGold(g, A);
  reviewSummaries(g, A);
  A.sort((a, b) => a.t - b.t);
  A.forEach((a, i) => (a.id = i));
  const players = {};
  for (const p of g.ps) {
    const acts = A.filter(a => a.pids.includes(p.id));
    const sum = summarise(acts);
    sum.phases = PHASES.map(ph => ({ ...ph, ...summarise(acts.filter(a => a.t >= ph.from && a.t < ph.to && !['farm', 'vision'].includes(a.kind))) }))
      .filter(ph => ph.from < g.duration);
    sum.notes = coachNotes(g, p, acts);
    players[p.id] = sum;
  }
  const teams = {};
  for (const team of [100, 200]) {
    const ps = g.ps.filter(p => p.team === team);
    const accs = ps.map(p => players[p.id].accuracy).filter(x => x != null);
    teams[team] = { ...summarise(A.filter(a => a.team === team)), accuracy: accs.length ? accs.reduce((a, b) => a + b, 0) / accs.length : null };
  }
  return { actions: A, players, teams };
}

Object.assign(window, { GRADES, GRADE_ORDER, BAD_GRADES, BANDS, reviewGame, phaseLabel, gameStory, pctOf });
