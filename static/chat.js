'use strict';
/* =====================================================================
   Ask Claude: a chat about the game being reviewed.
   Each question is sent with a snapshot of the game (the selected move, the state at that moment, nearby events);
   the server runs Claude with tools over a local index of Master+ games and streams the answer back.
   ===================================================================== */
/* global S, $, esc, api, banner, fmtTime, TEAM_NAME, ROLE_SHORT, GRADES, stateAt, wpFor, eventsBetween */

const CHAT = { id: null, game: null, busy: false, status: null, log: [], ctrl: null, cost: 0, draft: '' };
const CHAT_SUGGEST = {
  move: ['Was this the right call?', 'What should I have done instead?', 'What do Master+ players do in this spot?'],
  free: ['What was the biggest mistake I made this game?', 'How did Master+ junglers path on my champion?', 'Where did this game turn?'],
};

function chatNewId() { return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''); }
const r1 = v => Math.round(v * 10) / 10;

// the move the question is about: the selected one, if the replay is still near it
function chatMove() {
  if (!S.review || S.revSel == null) return null;
  const a = S.review.actions[S.revSel];
  return a && Math.abs(S.t - a.t) < 45 ? a : null;
}

function chatContext() {
  const g = S.game; if (!g || !S.review) return null;
  const me = g.byId[S.mePid] || null;
  const fp = g.byId[S.revPid] || me;
  const team = (me || fp || { team: 100 }).team, en = team === 100 ? 200 : 100, sg = team === 100 ? 1 : -1;
  const a = chatMove();
  const t = a ? a.t : S.t;
  const st = stateAt(g, t), f = st.f || {}, raw = st.raw || {};
  const pl = p => `${p.cname} (${ROLE_SHORT[p.role] || p.role || '?'}, ${p.name})${p.id === S.mePid ? ' ← you' : ''}`;
  const count = (list, tm, filt) => list.filter(x => x.t <= t && x.team === tm && (!filt || filt(x))).length;
  const objs = tm => g.objectives.filter(o => o.t <= t && o.team === tm).map(o => `${o.name} ${fmtTime(o.t)}`);
  const ctx = {
    match: { id: g.matchId, patch: String(g.info.gameVersion || '').split('.').slice(0, 2).join('.'), length: fmtTime(g.duration),
      result: g.winner ? (g.winner === team ? 'your team won' : 'your team lost') : 'unknown' },
    you: me ? { champion: me.cname, internal_name: me.champ, role: me.role, team: TEAM_NAME[me.team], name: me.name }
      : 'not marked in the app (ask which player they are if it matters)',
    your_team: g.ps.filter(p => p.team === team).map(pl),
    enemy_team: g.ps.filter(p => p.team === en).map(pl),
    moment: {
      time: fmtTime(t),
      your_team_win_chance_pct: Math.round(wpFor(g, team, t)),
      gold_diff: Math.round(sg * (f.gold || 0) * 1000),
      xp_diff: Math.round(sg * (f.xp || 0) * 1000),
      kills: `${count(g.kills, team)}-${count(g.kills, en)}`,
      towers_destroyed: `${count(g.structureEvents, team, s => s.kind === 'tower')}-${count(g.structureEvents, en, s => s.kind === 'tower')}`,
      champions_alive: raw.aliveB != null ? `${team === 100 ? raw.aliveB : raw.aliveR} vs ${team === 100 ? raw.aliveR : raw.aliveB}` : undefined,
      your_objectives: objs(team), enemy_objectives: objs(en),
    },
    selected_move: a ? {
      player: (g.byId[a.actor] || {}).cname, time: fmtTime(a.t), grade: GRADES[a.grade].label, title: a.title,
      app_explanation: a.detail || undefined, app_suggestion: a.better || undefined, tags: a.tags && a.tags.length ? a.tags : undefined,
      win_chance_change_pct_points: a.dwp != null ? r1(a.dwp) : (a.before != null ? Math.round(a.after - a.before) : undefined),
    } : null,
    events_around: eventsBetween(g, t - 120, t + 75).slice(0, 30).map(e => `${fmtTime(e.t)} ${e.text}`),
  };
  const sum = fp && S.review.players[fp.id];
  if (sum) ctx.reviewed_player = { player: pl(fp), accuracy: sum.accuracy != null ? r1(sum.accuracy) : null,
    grades: Object.fromEntries(Object.entries(sum.counts).filter(([, v]) => v)), coach_notes: (sum.notes || []).map(n => n.text).slice(0, 6) };
  return ctx;
}

function chatAboutText() {
  const a = chatMove();
  if (a) return `About <b>${fmtTime(a.t)}</b> · ${esc(a.title)} <span class="muted">(${GRADES[a.grade].label})</span>`;
  return S.game ? `About <b>${fmtTime(S.t)}</b> <span class="muted">(where the replay is; select a move to ask about it)</span>` : '';
}

// a small, safe Markdown subset: paragraphs, bullet/numbered lists, **bold**, *italic*, `code`, ### headings
function chatMd(src) {
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<i>$2</i>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = []; let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of String(src).split('\n')) {
    const l = line.trimEnd();
    let m;
    if ((m = l.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    close();
    if ((m = l.match(/^#{1,4}\s+(.*)/))) out.push(`<p class="h">${inline(m[1])}</p>`);
    else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  close();
  return out.join('');
}

async function chatLoadStatus() {
  try { CHAT.status = await api('/api/chat/status'); } catch { CHAT.status = { ready: false, error: 'Could not reach the local server.' }; }
  return CHAT.status;
}

function chatShown() {
  if (!CHAT.status) chatLoadStatus().then(renderChat); else renderChat();
  setTimeout(() => { const i = $('chatIn'); if (i) i.focus(); }, 0);
}

function chatOnGameOpened() {
  const id = S.game && S.game.matchId;
  if (CHAT.game !== id) { chatReset(false); CHAT.game = id; }
  if (S.sideTab === 'chat') renderChat();
}

function chatReset(render = true) {
  if (CHAT.ctrl) CHAT.ctrl.abort();
  if (CHAT.id) fetch('/api/chat/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: CHAT.id }) }).catch(() => {});
  CHAT.id = chatNewId(); CHAT.log = []; CHAT.busy = false; CHAT.cost = 0; CHAT.ctrl = null;
  if (render) renderChat();
}

function chatAskAbout(actionId) {
  if (S.revSel !== actionId && typeof selectAction === 'function') selectAction(actionId, true);
  const q = 'Was this the right call? What should I have done?';
  if (!CHAT.draft.trim()) CHAT.draft = q;  // the panel may render after the status loads: it picks the draft up then
  const b = $('sideTabs').querySelector('[data-st="chat"]'); if (b) b.click();
  const i = $('chatIn'); if (i && !i.value.trim()) { i.value = q; i.focus(); }
}

function renderChat() {
  const box = $('chat'); if (!box) return;
  const st = CHAT.status;
  if (!st) { box.innerHTML = '<p class="muted small">Loading…</p>'; return; }
  if (!st.ready) { box.innerHTML = chatSetupHtml(st); wireChatSetup(); return; }
  if (!CHAT.id) CHAT.id = chatNewId();
  const sugg = (chatMove() ? CHAT_SUGGEST.move : CHAT_SUGGEST.free).map(q => `<button class="chat-chip" data-q="${esc(q)}">${esc(q)}</button>`).join('');
  const prevDraft = $('chatIn') ? $('chatIn').value : CHAT.draft;
  box.innerHTML = `<div class="chat-head"><span class="chat-about" id="chatAbout">${chatAboutText()}</span>
      <button class="btn ghost small" id="chatNew" title="Start a new conversation">New chat</button>
      <button class="btn ghost small" id="chatCfg" title="Chat settings (API key)">⚙</button></div>
    <div class="chat-log" id="chatLog">${CHAT.log.length ? CHAT.log.map(chatMsgHtml).join('') : chatEmptyHtml(st)}</div>
    ${CHAT.busy ? '' : `<div class="chat-chips">${sugg}</div>`}
    <div class="chat-input"><textarea id="chatIn" rows="2" placeholder="Ask about this play… (Enter to send, Shift+Enter for a new line)" ${CHAT.busy ? 'disabled' : ''}></textarea>
      ${CHAT.busy ? '<button class="btn" id="chatStop">Stop</button>' : '<button class="btn primary" id="chatSend">Send</button>'}</div>
    <p class="chat-foot">${esc(st.model)} · Master+ data: ${st.index ? `${st.index.games.toLocaleString()} games, patches ${esc(st.index.patches)}` : 'missing'}${CHAT.cost ? ` · this chat ≈ $${CHAT.cost.toFixed(2)}` : ''}</p>`;
  const inp = $('chatIn'); inp.value = prevDraft || '';
  inp.oninput = () => { CHAT.draft = inp.value; };
  inp.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend(); } };
  if ($('chatSend')) $('chatSend').onclick = () => chatSend();
  if ($('chatStop')) $('chatStop').onclick = () => { if (CHAT.ctrl) CHAT.ctrl.abort(); };
  $('chatNew').onclick = () => chatReset();
  $('chatCfg').onclick = () => { box.innerHTML = chatSetupHtml(st, true); wireChatSetup(); };
  for (const b of box.querySelectorAll('[data-q]')) b.onclick = () => chatSend(b.dataset.q);
  const log = $('chatLog'); log.scrollTop = log.scrollHeight;
}

function chatEmptyHtml(st) {
  return `<div class="chat-empty"><p><b>Ask Claude about your plays.</b> Select a move on the Moves tab (or click <i>✦ Ask Claude</i> on it) and ask whether it was right and what to do instead.</p>
    <p class="muted small">Claude sees this game's timeline and the app's grades, and checks its answers against ${st.index ? st.index.games.toLocaleString() : ''} Master+ games: what high-elo teams did in the same spot and how those games ended.</p></div>`;
}

function chatMsgHtml(m) {
  if (m.role === 'user') return `<div class="chat-msg user"><div class="chat-about-tag">${m.about || ''}</div>${esc(m.text).replace(/\n/g, '<br>')}</div>`;
  const tools = m.tools.length ? `<div class="chat-tools">${m.tools.map(t => `<div>🔎 ${esc(t)}</div>`).join('')}</div>` : '';
  const body = m.text ? chatMd(m.text) : '';
  const status = m.done ? '' : `<div class="chat-status"><span class="rs-spin"></span>${esc(m.status || 'Thinking…')}</div>`;
  const err = m.error ? `<div class="chat-err">${esc(m.error)}</div>` : '';
  const foot = m.done && m.cost ? `<div class="chat-cost">≈ $${m.cost.toFixed(3)}</div>` : '';
  return `<div class="chat-msg bot">${tools}${body}${status}${err}${foot}</div>`;
}

function updateChatLast() {
  const log = $('chatLog'); if (!log) return;
  const last = log.lastElementChild; const m = CHAT.log[CHAT.log.length - 1];
  if (!last || !m) return;
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  last.outerHTML = chatMsgHtml(m);
  if (stick) log.scrollTop = log.scrollHeight;
}

async function chatSend(text) {
  const inp = $('chatIn');
  text = (text != null ? text : inp ? inp.value : '').trim();
  if (!text || CHAT.busy) return;
  if (!S.game) { banner('Open a replay first.', true); return; }
  CHAT.draft = ''; if (inp) inp.value = '';
  const bot = { role: 'bot', text: '', tools: [], status: 'Thinking…', done: false };
  CHAT.log.push({ role: 'user', text, about: chatAboutText() }, bot);
  CHAT.busy = true;
  const ctrl = (CHAT.ctrl = new AbortController());
  renderChat();
  try {
    const r = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
      body: JSON.stringify({ chatId: CHAT.id, message: text, context: chatContext() }),
    });
    if (!r.ok || !r.body) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.trim()) chatEvent(bot, JSON.parse(line));
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') bot.error = bot.text ? 'Stopped.' : 'Stopped. (Claude may still finish this answer in the background; it will be part of the conversation.)';
    else bot.error = 'Could not get an answer: ' + (e.message || e);
  }
  bot.done = true;
  if (CHAT.ctrl === ctrl) { CHAT.busy = false; CHAT.ctrl = null; } // after "New chat" a newer question may already be running
  renderChat();
}

function chatEvent(bot, ev) {
  if (ev.type === 'text') { bot.text += ev.text; bot.status = ''; }
  else if (ev.type === 'status') bot.status = ev.text;
  else if (ev.type === 'tool') { bot.tools.push(ev.text); bot.status = ev.text + '…'; }
  else if (ev.type === 'done') { bot.cost = ev.cost; CHAT.cost = ev.chatCost || CHAT.cost; }
  else if (ev.type === 'error') {
    bot.error = ev.text;
    if (ev.code === 'setup') chatLoadStatus();
  }
  updateChatLast();
}

// ---------------------------------------------------------------- setup (API key)
function chatSetupHtml(st, settings) {
  const why = !st.sdk ? 'The Anthropic Python package is missing on this PC (pip install anthropic).'
    : !st.index ? 'The Master+ data index is missing. Build it with train/fetch_highelo.py and train/build_coach_index.py (see the README).' : '';
  const keyLine = st.keySource === 'env' ? '<p class="small">Using the key from the <code>ANTHROPIC_API_KEY</code> environment variable.</p>'
    : st.hasKey ? `<p class="small">Saved key: <code>${esc(st.keyHint)}</code></p>` : '';
  return `<div class="chat-setup">
    <p><b>Ask Claude</b> answers questions about your plays and checks them against ${st.index ? st.index.games.toLocaleString() + ' ' : ''}Master+ games.</p>
    ${why ? `<p class="chat-err">${esc(why)}</p>` : ''}
    <p class="small">It runs on your own Anthropic API account: create a key at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>
      (API usage is billed separately from a Claude.ai subscription; a typical answer costs a few cents). The key is stored only in this app's settings on this PC.</p>
    ${keyLine}
    <div class="chat-input"><input type="password" id="chatKey" placeholder="sk-ant-…" autocomplete="off" spellcheck="false">
      <button class="btn primary" id="chatKeySave">Save key</button></div>
    ${st.hasKey && st.keySource === 'app' ? '<button class="btn ghost small" id="chatKeyDel">Remove saved key</button>' : ''}
    ${settings && st.ready ? '<button class="btn ghost small" id="chatBack">← Back to chat</button>' : ''}
  </div>`;
}

function wireChatSetup() {
  const save = async key => {
    CHAT.status = await api('/api/chat/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
    renderChat();
  };
  if ($('chatKeySave')) $('chatKeySave').onclick = () => { const k = $('chatKey').value.trim(); if (k) save(k); };
  if ($('chatKey')) $('chatKey').onkeydown = e => { if (e.key === 'Enter') $('chatKeySave').click(); };
  if ($('chatKeyDel')) $('chatKeyDel').onclick = () => save('');
  if ($('chatBack')) $('chatBack').onclick = () => renderChat();
}

// keep the "About …" line current while the replay plays or the selection changes
setInterval(() => {
  if (S.sideTab !== 'chat' || !CHAT.status || !CHAT.status.ready) return;
  const el = $('chatAbout'); if (!el) return;
  const h = chatAboutText(); if (el.innerHTML !== h) el.innerHTML = h;
}, 1000);
