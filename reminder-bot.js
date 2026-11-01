/* Kanha Bot - Telegram helper for the HR Reminder feature.
   Runs on GitHub Actions (free), each run stays awake about 55 minutes. Secrets are read from environment variables only:
   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, FIREBASE_SERVICE_ACCOUNT.
   Reminders: meta/reminders/<id> { title, note, type:'once'|'monthly', date, day, done:{'YYYY-MM-DD':{...}} }
   Telegram memory: meta/telegram { offset, sent:{...}, todoSent:{...}, botUsername }
   Groups: todo/<accountKey>/tg { chatId, title } is created when someone sends /link <code> in a group (code from the website, todo/<accountKey>/tgCode). */
'use strict';
const DEFAULT_TIMES = ['08:00', '13:00', '18:00'];
/* ---- To-Do workflow core (same code runs in the website and in the Telegram helper) ----
   template: { id, title, note, freq:'monthly'|'weekly'|'daily'|'once', dueDay (1-31 or 'last'; weekly 1=Mon..7=Sun), dueOffset (-1,0,1 months, monthly only),
               lead (show N days before due), warn (remind N days before due), steps:[...], startFrom, dueDate (once), active }
   progress: done[templateId][periodKey] = { s:{ '0':{at,by}, ... }, doneAt } */
function tdPad(n) { return (n < 10 ? '0' : '') + n; }
function tdParse(ds) { var p = String(ds).split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
function tdFmt(ms) { var d = new Date(ms); return d.getUTCFullYear() + '-' + tdPad(d.getUTCMonth() + 1) + '-' + tdPad(d.getUTCDate()); }
function tdAdd(ds, n) { return tdFmt(tdParse(ds) + n * 86400000); }
function tdDiff(a, b) { return Math.round((tdParse(a) - tdParse(b)) / 86400000); }
function tdDim(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function tdMonthShift(key, off) { var y = +key.slice(0, 4), m = +key.slice(5, 7) - 1 + off; y += Math.floor(m / 12); m = ((m % 12) + 12) % 12; return y + '-' + tdPad(m + 1); }
function tdTxt(s, key) {
  s = String(s == null ? '' : s); if (s.indexOf('{') < 0) return s;
  var k = String(key || '').slice(0, 7); if (!/^\d{4}-\d{2}$/.test(k)) k = tdFmt(Date.now() + 7 * 3600000).slice(0, 7);
  return s.replace(/\{\s*(this|next|last)\s+(month|mon)(?:\s+(num|km))?\s*\}/gi, function (m, w, f, sty) {
    var sh = w.toLowerCase() === 'this' ? 0 : w.toLowerCase() === 'next' ? 1 : -1, kk = tdMonthShift(k, sh), lc = 'en-US'; sty = (sty || '').toLowerCase();
    var yy = kk.slice(0, 4), mm = String(parseInt(kk.slice(5, 7), 10));
    if (sty === 'num') return (kk.slice(5, 7)) + '/' + yy;
    if (sty === 'km') return 'ខែ ' + mm + ' ឆ្នាំ ' + yy;
    try { return new Date(Date.UTC(+yy, +kk.slice(5, 7) - 1, 1)).toLocaleDateString(lc, f.toLowerCase() === 'mon' ? { month: 'short', timeZone: 'UTC' } : { month: 'long', year: 'numeric', timeZone: 'UTC' }); } catch (e) { return m; }
  });
}
function tdMonday(ds) { var d = new Date(tdParse(ds)), wd = (d.getUTCDay() + 6) % 7; return tdAdd(ds, -wd); }
function tdDefaults(tpl) {
  var f = tpl.freq || 'monthly';
  return { lead: f === 'monthly' ? 10 : f === 'weekly' ? 3 : f === 'daily' ? 0 : 7, warn: f === 'monthly' ? 3 : f === 'weekly' ? 1 : 0 };
}
function tdStepKey(text) { return String(text).replace(/[.#$\[\]\/]/g, '_').trim().slice(0, 60); }
function tdCur(tpl, today) { var f = tpl.freq || 'monthly'; return f === 'monthly' ? today.slice(0, 7) : f === 'weekly' ? tdMonday(today) : f === 'daily' ? today : 'once'; }
function tdNum(v, d) { var x = parseInt(v, 10); return isNaN(x) ? d : x; }
function tdDue(tpl, key) {
  var f = tpl.freq || 'monthly';
  if (f === 'monthly') {
    var mk = tdMonthShift(key, tdNum(tpl.dueOffset, 0)), y = +mk.slice(0, 4), m = +mk.slice(5, 7), dm = tdDim(y, m);
    var day = (tpl.dueDay === 'last') ? dm : Math.min(Math.max(tdNum(tpl.dueDay, 1), 1), dm);
    return mk + '-' + tdPad(day);
  }
  if (f === 'weekly') return tdAdd(key, Math.min(Math.max(tdNum(tpl.dueDay, 5), 1), 7) - 1);
  if (f === 'daily') return key;
  return tpl.dueDate || '';
}
function tdPeriods(tpl, today) {
  var f = tpl.freq || 'monthly', out = [], i, k, sf = tpl.startFrom || '';
  if (f === 'monthly') { var cm = today.slice(0, 7); for (i = -6; i <= 3; i++) { k = tdMonthShift(cm, i); if (!sf || k >= sf.slice(0, 7)) out.push(k); } }
  else if (f === 'weekly') { var mon = tdMonday(today); for (i = -6; i <= 1; i++) { k = tdAdd(mon, i * 7); if (!sf || k >= tdMonday(sf)) out.push(k); } }
  else if (f === 'daily') { for (i = -3; i <= 0; i++) { k = tdAdd(today, i); if (!sf || k >= sf) out.push(k); } }
  else out.push('once');
  return out;
}
function tdStepWin(tpl, key, i) {
    var to = tpl.stepDates && tpl.stepDates[i], fr = tpl.stepFrom && tpl.stepFrom[i];
    to = to && String(to).length >= 10 ? String(to) : ''; fr = fr && String(fr).length >= 10 ? String(fr) : '';
    if (!to && !fr) return null; if (!to) to = fr;
    var f = tpl.freq || 'monthly';
    if (f === 'daily') return null;
    if (f === 'once') return { from: (fr && fr < to) ? fr : '', to: to };
    if (f === 'monthly') {
        var mk = key.slice(0, 7), dayIn = function (ds, m2) { var dm = tdDim(+m2.slice(0, 4), +m2.slice(5, 7)); return m2 + '-' + tdPad(Math.min(parseInt(ds.slice(8, 10), 10) || 1, dm)); };
        var dt = parseInt(to.slice(8, 10), 10) || 1, dfr = fr ? (parseInt(fr.slice(8, 10), 10) || 1) : 0;
        var b = dayIn(to, (fr && dt < dfr) ? tdMonthShift(mk, 1) : mk), a = fr ? dayIn(fr, mk) : '';
        return { from: (a && a !== b) ? a : '', to: b };
    }
    var wt = (new Date(tdParse(to)).getUTCDay() + 6) % 7, wf = fr ? (new Date(tdParse(fr)).getUTCDay() + 6) % 7 : -1, b2 = tdAdd(key, wt), a2 = wf >= 0 ? tdAdd(key, wf) : '';
    if (a2 && wt < wf) b2 = tdAdd(b2, 7);
    return { from: (a2 && a2 !== b2) ? a2 : '', to: b2 };
}
function tdStepDue(tpl, key, i) { var w = tdStepWin(tpl, key, i); return w ? w.to : ''; }
function tdInst(tpl, key, done, today) {
  var steps = tpl.steps || [], dn = ((done || {})[tpl.id] || {})[key] || {}, s = dn.s || {}, due = tdDue(tpl, key), df = tdDefaults(tpl), ticked = 0, next = -1, i;
  for (i = 0; i < steps.length; i++) { if (s[tdStepKey(steps[i])]) ticked++; else if (next < 0) next = i; }
  var complete = steps.length > 0 && ticked === steps.length;
  var lead = tdNum(tpl.lead, df.lead), warn = tdNum(tpl.warn, df.warn), days = due ? tdDiff(due, today) : 9999, status;
  if (complete) status = 'done';
  else if (!due) status = 'open';
  else if (days < 0) status = 'over';
  else if (days <= warn) status = 'soon';
  else if (days <= lead) status = 'open';
  else status = 'hidden';
  var sLate = 0, sSoon = 0, sMin = 9999, why = '';
  if (!complete && tpl.stepDates) steps.forEach(function (st, ix) {
    if (s[tdStepKey(st)]) return; var w = tdStepWin(tpl, key, ix); if (!w) return; var dd = tdDiff(w.to, today);
    if (dd < 0) sLate++; else if (dd <= warn) { sSoon++; if (dd < sMin) sMin = dd; }
  });
  if (!complete && sLate) { status = 'over'; why = 'step'; } else if (!complete && sSoon && (status === 'open' || status === 'hidden')) { status = 'soon'; why = 'step'; }
  return { why: why, stepLate: sLate, stepSoonMin: sMin, id: tpl.id, key: key, tpl: tpl, due: due, days: days, status: status, total: steps.length, ticked: ticked, next: next, nextText: next >= 0 ? tdTxt(steps[next], key) : '', complete: complete, doneAt: dn.doneAt || 0, s: s };
}
function tdAll(tpls, done, today, nowMs) {
  var out = [];
  Object.keys(tpls || {}).forEach(function (id) {
    var tpl = tpls[id]; if (!tpl || tpl.active === false || !(tpl.steps && tpl.steps.length)) return;
    tpl = Object.assign({}, tpl, { id: id });
    var cur = tdCur(tpl, today), isNew = tpl.docsFor !== undefined;
    tdPeriods(tpl, today).forEach(function (k) {
      var x = tdInst(tpl, k, done, today), isCur = (k === cur);
      if (isNew && k > cur && k !== 'once') return;                 /* a coming month stays hidden until it starts */
      if (x.status === 'hidden') { if (isCur) x.status = 'open'; else return; }
      if (x.status === 'done' && !isCur && !(k === 'once' && x.doneAt && (nowMs - x.doneAt) < 14 * 86400000)) return;
      x.cur = isCur; out.push(x);
    });
  });
  var rank = { over: 0, soon: 1, open: 2, done: 3 };
  out.sort(function (a, b) { return rank[a.status] - rank[b.status] || a.days - b.days || String(a.tpl.title).localeCompare(String(b.tpl.title)); });
  return out;
}

function khNow(ms) { return new Date((ms || Date.now()) + 7 * 3600 * 1000); }
function pad(n) { return (n < 10 ? '0' : '') + n; }
function dateKey(d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
function dim(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
/* how many of the 3 daily times have already passed (times are Cambodia time, chosen on the website) */
function slotOf(d, times) {
  const m = d.getUTCHours() * 60 + d.getUTCMinutes(); let n = 0;
  (times || DEFAULT_TIMES).forEach(x => { const q = String(x).split(':'); if (m >= (+q[0]) * 60 + (+q[1])) n++; });
  return n;
}
function dueToday(r, d) {
  if (r.type === 'monthly') return d.getUTCDate() === Math.min(parseInt(r.day, 10) || 1, dim(d.getUTCFullYear(), d.getUTCMonth() + 1));
  return r.date === dateKey(d);
}
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }


/* ================= To-Do step messages (Step 1, Step 2 ... Final Step) =================
   Each open task gets ONE message for its current step in the group of the account: sent on the step's From date, pinned, with a Task Complete button.
   Late steps get an overdue warning at the 3 daily times. When a step is completed (button or website) the pinned message is unpinned, a completed
   message goes to the group and to the account's personal chat, and the next step message is sent and pinned at once.
   Memory: meta/telegram/steps/<account>/<task~id>/<period> = { n, mid, chat, late:{day:slot} }, meta/telegram/stepRef/<ref> = { key, cid, period, n } */
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], MONL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function fmtD(ds, withYear) { ds = String(ds || ''); if (ds.length < 10) return ''; return parseInt(ds.slice(8, 10), 10) + ' ' + MON[+ds.slice(5, 7) - 1] + (withYear === false ? '' : ' ' + ds.slice(0, 4)); }
function periodText(x) { const k = x.key; if (k === 'once') return ''; if (/^\d{4}-\d{2}$/.test(k)) return MONL[+k.slice(5, 7) - 1] + ' ' + k.slice(0, 4); if ((x.tpl.freq || '') === 'weekly') return 'week of ' + fmtD(k); return fmtD(k); }
function entriesOf(p) {
  const nm = z => String(z || '').replace(/^\s*\d+\s*[.)]\s*/, '').trim(), out = [];
  const tl = String(p.title || '').split(/\n/).map(z => z.trim()).filter(Boolean), nl = String(p.note || '').split(/\n/).map(z => z.trim()).filter(Boolean);
  tl.forEach((z, i) => out.push({ title: nm(z), note: tl.length > 1 ? (nl[i] || '') : nl.join('\n') }));
  if (tl.length > 1 && nl.length > tl.length) out[out.length - 1].note += '\n' + nl.slice(tl.length).join('\n');
  (p.extra || []).forEach(r => { const k = nm(r.title); let f = null; out.forEach(o => { if (!f && o.title === k) f = o; }); if (f) { if (r.note) f.note = f.note ? f.note + '\n' + r.note : r.note; } else out.push({ title: k, note: r.note || '' }); });
  if (!out.length) out.push({ title: '', note: '' });
  return out;
}
function stepTitle(x, n) { return (n >= x.total - 1) ? '(Final Step)' : '(Step ' + (n + 1) + ')'; }
function taskLines(x, withNotes) {
  const per = periodText(x);
  return entriesOf(x.tpl).map(e => '• <b>' + esc(e.title) + '</b>' + (per ? ' (' + esc(per) + ')' : '') + (withNotes && e.note ? '\nNoted: ' + esc(e.note) : '')).join('\n\n');
}
function winText(x, n) { const w = tdStepWin(x.tpl, x.key, n); if (w) return w.from ? fmtD(w.from, false) + ' → ' + fmtD(w.to) : fmtD(w.to); return x.due ? fmtD(x.due) : ''; }
function stepText(x, n, late) {
  const wt = winText(x, n), steps = x.tpl.steps || [];
  let t = '📋 <b>To-Do List ' + stepTitle(x, n) + '</b>\n\n' + (late ? 'You have <b>overdue</b> task' : 'You have new tasks to complete') + (wt ? ' for: <b>' + esc(wt) + '</b>' : '') + '\n\n' + taskLines(x, true) + '\n\nStep: <b>' + esc(tdTxt(steps[n] || '', x.key)) + '</b>';
  if (late) t += '\n\nPlease complete your task as soon as possible.';
  else if (n < x.total - 1) t += '\nNext Step: ' + esc(nextAfter(x, n));
  return t;
}
function nextAfter(x, n) { const st = x.tpl.steps || [], s = x.s || {}; for (let i = n + 1; i < st.length; i++) if (!s[tdStepKey(st[i])]) return st[i]; return st[n + 1] || ''; }
function whenText(ms) { const d = khNow(ms); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); }
function doneText(x, n, who, at, last, groupName) {
  const steps = x.tpl.steps || [];
  let t = '✅ <b>Task complete ' + stepTitle(x, n) + '</b>\n\n' + taskLines(x, false) + '\n\nStep: <b>' + esc(tdTxt(steps[n] || '', x.key)) + '</b>\nCompleted by: ' + esc(who || '-') + (at ? ' · ' + esc(whenText(at)) : '');
  if (groupName) t += '\nGroup: ' + esc(groupName);
  t += last ? '\n\n🎉 All steps are finished.' : '\n\nNext Step: <b>' + esc(nextAfter(x, n)) + '</b>';
  return t;
}

/* private data used to route messages: todo/<account>/tg = the Telegram group that account linked, plus tasks, shares and the people list */
async function loadTodo(env) {
  const c = env.cache;
  if (c && c.v && Date.now() - c.at < 60000) return c.v;
  const v = { todo: (await env.db.ref('todo').once('value')).val() || {}, shared: (await env.db.ref('todoShared').once('value')).val() || {}, people: (await env.db.ref('todoPeople').once('value')).val() || {} };
  if (c) { c.v = v; c.at = Date.now(); }
  return v;
}
function normTask(p) { p = p || {}; p.steps = Array.isArray(p.steps) ? p.steps : Object.keys(p.steps || {}).map(k => p.steps[k]); if (p.extra && !Array.isArray(p.extra)) p.extra = Object.keys(p.extra).sort((a, b) => a - b).map(q => p.extra[q]); ['stepDates', 'stepFrom', 'stepEarly', 'stepWait'].forEach(k => { if (p[k]) p[k] = Array.isArray(p[k]) ? p[k] : (ob => { let n = 0; const r = []; Object.keys(ob).forEach(q => { n = Math.max(n, (+q || 0) + 1); }); for (let i = 0; i < n; i++) r.push(ob[i] === undefined ? '' : ob[i]); return r; })(p[k]); }); return p; }
function visibleTasks(T, key) {
  const tpls = {}, dn = {}, own = T.todo[key] || {};
  Object.keys(own.tasks || {}).forEach(id => { tpls[key + '~' + id] = normTask(own.tasks[id]); dn[key + '~' + id] = (own.done || {})[id] || {}; });
  const ptr = T.shared[key] || {};
  Object.keys(ptr).forEach(owner => Object.keys(ptr[owner] || {}).forEach(id => {
    const o = T.todo[owner] || {}, tt = (o.tasks || {})[id];
    if (tt && tt.shareWith && tt.shareWith[key]) { tpls[owner + '~' + id] = normTask(tt); dn[owner + '~' + id] = (o.done || {})[id] || {}; }
  }));
  return { tpls, dn };
}

async function run(env) {
  const { db, tg, chatId, now } = env;
  const d = khNow(now), today = dateKey(d), nowMs = now || Date.now();
  const tv = (await db.ref('meta/reminderTimes').once('value')).val();
  const times = (tv && tv.t1 && tv.t2 && tv.t3) ? [tv.t1, tv.t2, tv.t3] : DEFAULT_TIMES;
  const slot = slotOf(d, times);
  const out = { completed: 0, sent: 0, todo: 0, linked: 0 };
  if (env.cache && !env.cache.bot) { env.cache.bot = 1; try { const me = await tg('getMe', {}); if (me.result && me.result.username) await db.ref('meta/telegram/botUsername').set(me.result.username); } catch (e) {} }

  let T = await loadTodo(env);
  const groupsOf = () => { const g = {}; Object.keys(T.todo).forEach(k => { const x = T.todo[k] && T.todo[k].tg; if (x && x.chatId) g[k] = x; }); return g; };
  const meOf = k => { const x = T.todo[k] && T.todo[k].tgMe; return x && x.chatId ? x : null; };
  let groups = groupsOf();
  const byName = {}; Object.keys(T.people).forEach(k => { const n = (T.people[k] || {}).name; if (n && !byName[n]) byName[n] = k; });
  /* a reminder goes to the group of the account that created it; if that account has no group, to the main chat */
  const dest = r => { const k = r.byKey || byName[r.createdBy] || ''; return (k && groups[k]) ? String(groups[k].chatId) : String(chatId); };

  /* 1) Telegram taps and /link messages */
  const tref = db.ref('meta/telegram');
  const tstate = (await tref.once('value')).val() || {};
  let offset = tstate.offset || 0, ticked = false;
  const ups = await tg('getUpdates', { offset: offset, timeout: env.pollSeconds || 0, allowed_updates: ['callback_query', 'message'] });
  for (const u of (ups.result || [])) {
    offset = Math.max(offset, u.update_id + 1);
    const msg = u.message;
    if (msg && msg.text && msg.chat) {
      const txt = msg.text.trim(), isReplyToBot = !!(msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.is_bot);
      const lm = /^\/link(?:@\w+)?\s*(\d{6})\b/.exec(txt) || /^(\d{6})$/.exec(txt);
      if (!lm && /^\/(start|link)(?:@\w+)?\s*$/.test(txt)) {
        await tg('sendMessage', { chat_id: msg.chat.id, parse_mode: 'HTML', reply_to_message_id: msg.message_id,
          text: '👋 <b>Hello!</b> To link this chat to your website account:\n1) On the website open <b>To-Do List &gt; Link Telegram</b> and tap <b>Get a link code</b>.\n2) <b>Reply to this message</b> with the 6-digit code (for example 123456).\n\nAfter linking, your reminders and To-Do warnings are sent here.',
          reply_markup: { force_reply: true, selective: true, input_field_placeholder: '123456' } });
      }
      if (lm) {
        T = await loadTodo({ db, cache: null }); if (env.cache) { env.cache.v = T; env.cache.at = Date.now(); }
        const key = Object.keys(T.todo).find(k => { const c = T.todo[k] && T.todo[k].tgCode; return c && String(c.code) === lm[1] && c.exp > nowMs; });
        if (key) {
          const nm = (T.people[key] || {}).name || key;
          const prevTg = T.todo[key].tg, rec = { chatId: msg.chat.id, title: msg.chat.title || msg.chat.first_name || '', type: msg.chat.type || '', at: nowMs };
          const personal = msg.chat.type === 'private' && prevTg && prevTg.chatId && prevTg.type && prevTg.type !== 'private';
          await db.ref('todo/' + key + (personal ? '/tgMe' : '/tg')).set(rec);
          await db.ref('todo/' + key + '/tgCode').remove();
          T.todo[key][personal ? 'tgMe' : 'tg'] = rec; delete T.todo[key].tgCode; groups = groupsOf();
          await tg('sendMessage', { chat_id: msg.chat.id, parse_mode: 'HTML', text: personal ? '✅ <b>Linked</b> to ' + esc(nm) + ' as your <b>personal chat</b>.\nYou will get a message here after every completed step.' : '✅ <b>Linked</b> to ' + esc(nm) + '.\nYour reminders and To-Do steps will appear in this chat.' });
          out.linked++;
        } else if (isReplyToBot || msg.chat.type === 'private' || /^\/link/.test(txt)) {
          await tg('sendMessage', { chat_id: msg.chat.id, text: 'This code was not found or has expired. Get a new code on the website (To-Do List > Link Telegram).' });
        }
      }
      continue;
    }
    const cb = u.callback_query; if (!cb || !cb.data) continue;
    const cbChat = String(cb.message && cb.message.chat && cb.message.chat.id);
    const known = new Set([String(chatId)].concat(Object.keys(groups).map(k => String(groups[k].chatId)), Object.keys(T.todo).map(k => meOf(k)).filter(Boolean).map(x => String(x.chatId))));
    if (!known.has(cbChat)) continue; /* only your own chats */
    const sm = /^s\|([a-z0-9]+)$/.exec(cb.data);
    if (sm) {
      const rf = (await db.ref('meta/telegram/stepRef/' + sm[1]).once('value')).val();
      const who = (cb.from && (cb.from.first_name || cb.from.username)) || 'Telegram';
      let ans = 'This step was already completed.';
      if (rf) {
        const okChat = (groups[rf.key] && String(groups[rf.key].chatId) === cbChat) || (meOf(rf.key) && String(meOf(rf.key).chatId) === cbChat);
        if (!okChat) ans = 'This task belongs to another group.';
        else {
          T = await loadTodo({ db, cache: null }); if (env.cache) { env.cache.v = T; env.cache.at = Date.now(); }
          const vt = visibleTasks(T, rf.key), tpl0 = vt.tpls[rf.cid];
          if (tpl0) {
            const x0 = tdInst(Object.assign({}, tpl0, { id: rf.cid }), rf.period, vt.dn, today);
            if (x0.next >= 0 && x0.next === rf.n && !x0.complete) {
              const ow = rf.cid.split('~'), sk = tdStepKey(x0.tpl.steps[rf.n]), base = 'todo/' + ow[0] + '/done/' + ow[1] + '/' + rf.period;
              await db.ref(base + '/s/' + sk).set({ at: Date.now(), by: who + ' (Telegram)' });
              if (x0.ticked + 1 === x0.total) await db.ref(base + '/doneAt').set(Date.now());
              out.completed++; ticked = true; ans = 'Step completed ✅';
            }
          } else ans = 'This task no longer exists.';
        }
      }
      try { await tg('answerCallbackQuery', { callback_query_id: cb.id, text: ans }); } catch (e) {}
      continue;
    }
    const m = /^d\|([^|]+)\|(\d{4}-\d{2}-\d{2})$/.exec(cb.data); if (!m) continue;
    const id = m[1], day = m[2];
    const snap = (await db.ref('meta/reminders/' + id).once('value')).val();
    const allowed = !!snap && dest(snap) === cbChat;
    if (allowed) {
      await db.ref('meta/reminders/' + id + '/done/' + day).set({ at: Date.now(), by: (cb.from && (cb.from.first_name || cb.from.username)) || 'Telegram', via: 'telegram' });
      out.completed++;
    }
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: allowed ? 'Task completed. No more reminders for today.' : (snap ? 'This reminder belongs to another group.' : 'This reminder no longer exists.') });
    if (allowed) { try { await tg('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, parse_mode: 'HTML', text: '✅ <b>Task completed</b>\n' + esc(snap.title) }); } catch (e) {} }
  }
  if (offset !== (tstate.offset || 0)) await tref.child('offset').set(offset);
  if (ticked) { T = await loadTodo({ db, cache: null }); if (env.cache) { env.cache.v = T; env.cache.at = Date.now(); } }

  /* 2) the 3 daily reminders (morning, afternoon, evening) */
  if (slot > 0) {
    const all = (await db.ref('meta/reminders').once('value')).val() || {};
    const sent = tstate.sent || {};
    for (const id of Object.keys(all)) {
      const r = all[id] || {};
      if (!dueToday(r, d)) continue;
      if (r.done && r.done[today]) continue;
      const last = (sent[id] && sent[id][today]) || 0;
      if (last >= slot) continue;
      const text = '⏰ <b>Reminder</b>\n\n<b>' + esc(r.title) + '</b>' + (r.note ? '\n' + esc(r.note) : '') +
        '\n\n(' + slot + ' of 3 today - ' + times[slot - 1] + ')';
      await tg('sendMessage', { chat_id: dest(r), parse_mode: 'HTML', text: text,
        reply_markup: { inline_keyboard: [[{ text: '✅ Task Completed', callback_data: 'd|' + id + '|' + today }]] } });
      await tref.child('sent/' + id + '/' + today).set(slot);
      out.sent++;
    }
    for (const id of Object.keys(sent)) for (const k of Object.keys(sent[id] || {})) if (k < today) await tref.child('sent/' + id + '/' + k).remove();
  }

  /* 3) To-Do steps: one pinned message per open task step, per linked group (see the notes above) */
  {
    const stepsAll = (await tref.child('steps').once('value')).val() || {};
    const repAll = (await tref.child('reportSent').once('value')).val() || {};
    const sid = z => String(z).replace(/[.#$\[\]\/]/g, '_');
    const pinTry = async (chat, mid) => {
      try { await tg('pinChatMessage', { chat_id: chat, message_id: mid, disable_notification: true }); }
      catch (e) {
        try { const w = (await db.ref('meta/telegram/pinWarn/' + chat).once('value')).val(); if (!w) { await db.ref('meta/telegram/pinWarn/' + chat).set(nowMs); await tg('sendMessage', { chat_id: chat, text: 'I could not pin the step message. Please make me an admin of this group with the permission to pin messages.' }); } } catch (e2) {}
      }
    };
    const unpin = async (chat, mid) => { try { await tg('unpinChatMessage', { chat_id: chat, message_id: mid }); } catch (e) {} };
    for (const key of Object.keys(groups)) {
      const chat = groups[key].chatId, me = meOf(key), gName = groups[key].title || '';
      const { tpls, dn } = visibleTasks(T, key);
      const insts = tdAll(tpls, dn, today, nowMs);
      const seen = {};
      const finish = async (x, rec, node) => {
        const steps = (x && x.tpl.steps) || [], sk = (x && steps[rec.n] != null) ? tdStepKey(steps[rec.n]) : '', tk = sk && (x.s || {})[sk];
        if (tk) {
          const last = !!x.complete;
          try { await tg('editMessageText', { chat_id: rec.chat || chat, message_id: rec.mid, parse_mode: 'HTML', text: doneText(x, rec.n, tk.by, tk.at, last, ''), reply_markup: { inline_keyboard: [] } }); } catch (e) {}
          await unpin(rec.chat || chat, rec.mid);
          await tg('sendMessage', { chat_id: chat, parse_mode: 'HTML', text: doneText(x, rec.n, tk.by, tk.at, last, '') });
          if (me && String(me.chatId) !== String(chat)) { try { await tg('sendMessage', { chat_id: me.chatId, parse_mode: 'HTML', text: doneText(x, rec.n, tk.by, tk.at, last, gName) }); } catch (e) {} }
          out.stepsDone = (out.stepsDone || 0) + 1;
        } else { try { await tg('editMessageText', { chat_id: rec.chat || chat, message_id: rec.mid, parse_mode: 'HTML', text: '📋 This step message is no longer current.', reply_markup: { inline_keyboard: [] } }); } catch (e) {} await unpin(rec.chat || chat, rec.mid); }
        if (rec.ref) await db.ref('meta/telegram/stepRef/' + rec.ref).remove();
        await db.ref(node).remove();
      };
      for (const x of insts) {
        if (!x.cur && !(x.days > -31) && !x.complete) continue;
        const cid = x.id, per = x.key, node = 'meta/telegram/steps/' + key + '/' + sid(cid) + '/' + sid(per);
        let rec = ((stepsAll[key] || {})[sid(cid)] || {})[sid(per)] || null;
        const steps = x.tpl.steps || [];
        /* a step of an earlier message got completed (button or website) */
        seen[sid(cid) + '|' + sid(per)] = 1;
        if (rec && (rec.n !== x.next || x.complete)) { await finish(x, rec, node); rec = null; }
        /* a finished task makes a report: tell the task owner once per completion (a redo and finish again makes a new one) */
        if (x.complete && x.doneAt && String(cid).indexOf(key + '~') === 0 && nowMs - x.doneAt < 7 * 86400000) {
          const sc = sid(cid), sp = sid(per);
          if (((repAll[key] || {})[sc] || {})[sp] !== x.doneAt) {
            try {
              const link = 'https://hr203.com/#trp=' + encodeURIComponent(cid + '|' + per);
              await tg('sendMessage', { chat_id: me ? me.chatId : chat, parse_mode: 'HTML', text: '📄 <b>Task report ready</b>\n\n' + taskLines(x, false) + '\n\nCompleted: <b>' + esc(whenText(x.doneAt)) + '</b>\n\nOpen it, then save or print the PDF (it is removed after 7 days):\n' + link });
              await db.ref('meta/telegram/reportSent/' + key + '/' + sc + '/' + sp).set(x.doneAt);
              repAll[key] = repAll[key] || {}; repAll[key][sc] = repAll[key][sc] || {}; repAll[key][sc][sp] = x.doneAt;
              out.reports = (out.reports || 0) + 1;
            } catch (e) { console.error('report message failed: ' + String(e && e.message || e).replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot***')); }
          }
        }
        if (x.complete || x.next < 0) continue;
        const n = x.next, w = tdStepWin(x.tpl, per, n);
        if (!rec) {
          if (w && w.from && today < w.from) continue;           /* the step starts later */
          const ref = Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
          const ld0 = w ? w.to : x.due, isLate = !!(ld0 && ld0 < today);
          const sent = await tg('sendMessage', { chat_id: chat, parse_mode: 'HTML', text: stepText(x, n, isLate), reply_markup: { inline_keyboard: [[{ text: '✅ Task Complete', callback_data: 's|' + ref }]] } });
          const mid = sent && sent.result && sent.result.message_id;
          rec = { n: n, mid: mid || 0, chat: chat, ref: ref, at: nowMs, cid: cid, per: per, late: {} };
          if (isLate && slot > 0) rec.late[today] = slot;
          await db.ref('meta/telegram/stepRef/' + ref).set({ key: key, cid: cid, period: per, n: n });
          await db.ref(node).set(rec);
          if (mid) await pinTry(chat, mid);
          out.todo++;
          continue;
        }
        /* overdue warning at the 3 daily times */
        const lateDate = w ? w.to : x.due;
        if (lateDate && lateDate < today && slot > 0 && ((rec.late || {})[today] || 0) < slot) {
          await tg('sendMessage', { chat_id: chat, parse_mode: 'HTML', text: stepText(x, n, true), reply_markup: { inline_keyboard: [[{ text: '✅ Task Complete', callback_data: 's|' + rec.ref }]] } });
          await db.ref(node + '/late/' + today).set(slot);
          out.late = (out.late || 0) + 1;
        }
      }
      /* records whose task instance left the list (for example the last step finished in a later month, or the task was deleted) */
      const mine = stepsAll[key] || {};
      for (const c of Object.keys(mine)) for (const pk of Object.keys(mine[c] || {})) {
        if (seen[c + '|' + pk]) continue;
        const rec = mine[c][pk]; if (!rec || !rec.cid) { await db.ref('meta/telegram/steps/' + key + '/' + c + '/' + pk).remove(); continue; }
        const tpl0 = tpls[rec.cid], x0 = tpl0 ? tdInst(Object.assign({}, tpl0, { id: rec.cid }), rec.per, dn, today) : null;
        await finish(x0 && x0.complete ? x0 : null, rec, 'meta/telegram/steps/' + key + '/' + c + '/' + pk);
      }
    }
  }
  return out;
}
module.exports = { run, slotOf, dueToday, khNow, dateKey, tdAll };

if (require.main === module) {
  (async () => {
    const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID, sa = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!token || !chatId || !sa) { console.error('Missing secrets (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, FIREBASE_SERVICE_ACCOUNT).'); process.exit(1); }
    const admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(sa)), databaseURL: 'https://annual-leave-1feda-default-rtdb.asia-southeast1.firebasedatabase.app' });
    const tg = async (method, body) => {
      const r = await fetch('https://api.telegram.org/bot' + token + '/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      const j = await r.json();
      if (!j.ok) throw new Error('Telegram ' + method + ': ' + (j.description || r.status));
      return j;
    };
    /* stay awake ~55 minutes and watch Telegram every few seconds: a tap on Task Completed reacts at once and no gaps between runs */
    const stopAt = Date.now() + 55 * 60 * 1000, cache = {};
    let done = 0, sent = 0, fails = 0;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const redact = e => String(e && e.message || e).replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot***');
    do {
      /* one bad moment (network blip, Telegram "conflict", Firebase hiccup) must never stop the bot: log it, wait a little, try again */
      try {
        const res = await run({ db: admin.database(), tg, chatId, pollSeconds: 20, cache });
        done += res.completed; sent += res.sent; fails = 0;
      } catch (e) {
        fails++; console.error('Round failed (' + fails + ' in a row): ' + redact(e));
        if (fails >= 40) throw e;
        await sleep(Math.min(60000, 5000 * fails));
      }
    } while (Date.now() < stopAt);
    console.log('Done. Completed from Telegram:', done, '- Sent:', sent);
    process.exit(0);
  })().catch(e => { console.error(String(e && e.message || e).replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot***')); process.exit(1); });
}
