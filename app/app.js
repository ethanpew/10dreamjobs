/* 10 Dream Jobs: UI + persistence. Depends on DJ (lib.js) and the artifact `db` / `downloads` capabilities. */
(function () {
  'use strict';
  var COLS = ['jobs', 'companies', 'reviews', 'batches', 'policies', 'reports', 'targets', 'settings'];
  var S = { jobs: {}, companies: {}, reviews: {}, batches: {}, policies: {}, reports: {}, targets: {}, settings: {} };
  var db = null, dl = null, ready = {}, view = 'table', cur = null, queue = [], qkind = 'review', tick = null;
  var ui = { sort: { k: 'company', dir: 1 }, q: '', status: 'all', rmin: '', rmax: '', cmin: '', cmax: '', qmin: '', qmax: '', mode: 'latest', filtersOpen: false };
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var main = $('#main');

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k]; if (v == null || v === false) return;
      if (k === 'class') el.className = v; else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v; else if (k === 'value') el.value = v; else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) { if (c == null || c === false) return; if (Array.isArray(c)) c.forEach(function (x) { add(el, x); }); else el.appendChild(c.nodeType ? c : document.createTextNode(String(c))); }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  var cfg = function () { var s = S.settings.main || {}; return { tz: s.tz || Intl.DateTimeFormat().resolvedOptions().timeZone, idleSec: s.idleSec || 120, policy: s.activePolicy || 'v1' }; };
  var date = function (iso) { return DJ.fmtDate(iso, cfg().tz); };
  var UNK = function (v) { return v == null || v === '' || (Array.isArray(v) && !v.length) ? 'Unknown' : Array.isArray(v) ? v.join(', ') : String(v); };
  var nowIso = function () { return new Date().toISOString(); };
  function toast(msg, bad) { var t = $('#toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : ''); clearTimeout(toast.t); toast.t = setTimeout(function () { t.className = ''; }, 4200); }

  /* ---------- persistence ---------- */
  var chains = {};
  function write(path, fn) {   // one write at a time per document
    var p = (chains[path] || Promise.resolve()).then(fn);
    chains[path] = p.catch(function () { });
    return p.catch(function (e) { toast('Save failed: ' + ((e && e.message) || e), true); throw e; });
  }
  function put(col, id, data) { if (!db) { toast('Storage is unavailable; nothing was saved.', true); return Promise.reject(new Error('no db')); } return write(col + '/' + id, function () { return db.doc(col + '/' + id).set(data); }); }
  function latestNorm(id) { return DJ.norm(DJ.ratingOf(S.reviews[id], 'latest')); }
  /* Completed = reviewed with the current rating scheme (role interest, company interest, qualification). */
  function completed() { return Object.keys(S.jobs).filter(function (id) { var n = S.jobs[id].status === 'reviewed' && latestNorm(id); return n && !n.legacy; }); }
  /* Reviewed under the earlier single-interest scheme and not yet re-rated. */
  function legacyJobs() { return Object.keys(S.jobs).filter(function (id) { var n = S.jobs[id].status === 'reviewed' && latestNorm(id); return n && n.legacy; }).map(function (id) { return S.jobs[id]; }).sort(function (a, b) { return (a.sourcedAt || '').localeCompare(b.sourcedAt || '') || (a.seq || 0) - (b.seq || 0); }); }

  /* ---------- derived rows ---------- */
  function jobsList() { return Object.keys(S.jobs).map(function (k) { return S.jobs[k]; }); }
  function co(j) { return S.companies[j.companyId] || {}; }
  function rating(j, mode) { return DJ.ratingOf(S.reviews[j.id], mode || ui.mode); }
  function unreviewedOrdered() {
    return jobsList().filter(function (j) { return j.status !== 'reviewed' && j.status !== 'skipped'; })
      .sort(function (a, b) { return (a.sourcedAt || '').localeCompare(b.sourcedAt || '') || (a.seq || 0) - (b.seq || 0); });
  }
  function dataset(mode) {   // completed unique jobs with merged attributes for analysis
    return completed().map(function (id) {
      var j = S.jobs[id], c = co(j), r = DJ.norm(DJ.ratingOf(S.reviews[id], mode));
      if (!r || r.legacy) return null;    // combined legacy scores cannot be split into role vs company
      return { id: id, job: j, co: c, interest: r.role, companyInterest: r.company, qual: r.qual, at: (S.reviews[id].ratings[0] || {}).at, text: j.desc || '' };
    }).filter(Boolean);
  }

  /* ---------- header / progress ---------- */
  function renderProgress() {
    var n = completed().length, total = Object.keys(S.jobs).length, unrev = unreviewedOrdered().length;
    var el = $('#progress'); clear(el);
    var bar = function (target) { return h('div', { class: 'pbar', title: n + ' of ' + target }, h('div', { class: 'pfill', style: 'width:' + Math.min(100, n / target * 100) + '%' }), h('span', { text: Math.min(n, target) + ' / ' + target })); };
    var lg = legacyJobs().length;
    el.appendChild(h('div', { class: 'pgrp' }, h('b', { text: n + ' reviewed' }), h('span', { class: 'muted', text: ' · ' + unrev + ' waiting' + (lg ? ' · ' + lg + ' to re-rate' : '') + ' · ' + total + ' total' })));
    el.appendChild(h('div', { class: 'pbars' }, bar(100), bar(200)));
    $('#storage').textContent = db ? 'Saved to this artifact’s database' : 'Storage unavailable: changes will not be saved';
    $('#storage').className = db ? 'ok' : 'bad';
  }

  /* ---------- navigation ---------- */
  var NAV = [['table', 'Roles'], ['import', 'Add roles'], ['report', 'Analysis'], ['reports', 'Saved reports'], ['targets', 'Target companies'], ['settings', 'Settings & data']];
  function renderNav() {
    var nav = $('#nav'); clear(nav);
    NAV.forEach(function (n) { nav.appendChild(h('button', { class: 'tab' + (view === n[0] || (view === 'record' && n[0] === 'table') ? ' on' : ''), onclick: function () { go(n[0]); } }, n[1])); });
  }
  function go(v) { leaveRecord('left-record'); view = v; render(); }
  function render() {
    renderProgress(); renderNav(); clear(main);
    ({ table: renderTable, record: renderRecord, import: renderImport, report: renderAnalysis, reports: renderReports, targets: renderTargets, settings: renderSettings })[view]();
  }

  /* ---------- roles table ---------- */
  function sortVal(j, k) {
    if (k === 'company') return (j.company || '').toLowerCase(); if (k === 'title') return (j.title || '').toLowerCase();
    if (k === 'location') return (j.location || '').toLowerCase(); if (k === 'salary') { var v = DJ.annualMid(j.salary); return v == null ? -1 : v; }
    return j.status === 'reviewed' ? j.reviewedAt || '' : '';
  }
  function filtered() {
    var q = ui.q.trim().toLowerCase(), num = function (v) { return v === '' ? null : Number(v); };
    var rmin = num(ui.rmin), rmax = num(ui.rmax), cmin = num(ui.cmin), cmax = num(ui.cmax), qmin = num(ui.qmin), qmax = num(ui.qmax);
    return jobsList().filter(function (j) {
      if (ui.status === 'rerate') { var ln = j.status === 'reviewed' && latestNorm(j.id); if (!(ln && ln.legacy)) return false; }
      else if (ui.status !== 'all' && (j.status || 'unreviewed') !== ui.status) return false;
      if (q) { var c = co(j); var hay = [j.company, j.title, j.location, j.division, (j.roleFamily || []).join(' '), c.industry, j.desc].join(' ').toLowerCase(); if (hay.indexOf(q) < 0) return false; }
      if (rmin != null || rmax != null || cmin != null || cmax != null || qmin != null || qmax != null) {
        var r = DJ.norm(rating(j)); if (!r) return false;
        if ((rmin != null || rmax != null) && r.legacy) return false;    // combined legacy score is not a role score
        if (rmin != null && !(r.role >= rmin)) return false; if (rmax != null && !(r.role <= rmax)) return false;
        if (cmin != null && !(r.company >= cmin)) return false; if (cmax != null && !(r.company <= cmax)) return false;
        if (qmin != null && r.qual < qmin) return false; if (qmax != null && r.qual > qmax) return false;
      }
      return true;
    }).sort(function (a, b) { var x = sortVal(a, ui.sort.k), y = sortVal(b, ui.sort.k); return (x < y ? -1 : x > y ? 1 : 0) * ui.sort.dir; });
  }
  function renderTable() {
    var all = jobsList();
    var bar = h('div', { class: 'toolbar' },
      h('button', { class: 'primary', onclick: function () { startQueue(10); } }, 'Review next 10'),
      legacyJobs().length ? h('button', { id: 'rerate', class: 'primary', onclick: function () { startQueue(10, 'rerate'); } }, 'Re-rate ' + Math.min(10, legacyJobs().length) + ' (split interest)') : null,
      h('input', { id: 'q', type: 'search', placeholder: 'Search company, title, location, description…', value: ui.q, 'aria-label': 'Search', oninput: function (e) { ui.q = e.target.value; refreshRows(); } }),
      h('select', { id: 'fstatus', 'aria-label': 'Status', onchange: function (e) { ui.status = e.target.value; refreshRows(); } },
        [['all', 'All roles'], ['unreviewed', 'Unreviewed'], ['reviewed', 'Reviewed'], ['rerate', 'Needs re-rating'], ['skipped', 'Skipped']].map(function (o) { return h('option', { value: o[0], selected: ui.status === o[0] }, o[1]); })),
      h('button', { onclick: function () { ui.filtersOpen = !ui.filtersOpen; render(); } }, ui.filtersOpen ? 'Hide rating filters' : 'Rating filters'));
    main.appendChild(bar);
    if (ui.filtersOpen) {
      var inp = function (k, label) { return h('label', { class: 'mini' }, label, h('input', { id: 'f_' + k, type: 'number', min: 1, max: 10, value: ui[k], oninput: function (e) { ui[k] = e.target.value; refreshRows(); } })); };
      main.appendChild(h('div', { class: 'toolbar sub' },
        h('select', { id: 'fmode', 'aria-label': 'Rating version', onchange: function (e) { ui.mode = e.target.value; refreshRows(); } },
          [['latest', 'Latest ratings'], ['original', 'Original ratings']].map(function (o) { return h('option', { value: o[0], selected: ui.mode === o[0] }, o[1]); })),
        inp('cmin', 'Company interest ≥'), inp('cmax', 'Company interest ≤'), inp('rmin', 'Role interest ≥'), inp('rmax', 'Role interest ≤'), inp('qmin', 'Qualification ≥'), inp('qmax', 'Qualification ≤')));
    }
    if (!all.length) {
      main.appendChild(h('div', { class: 'empty' }, h('h2', { text: 'No roles yet' }),
        h('p', { text: 'Roles appear here after they are sourced and added. Ask Claude “10 more” to source a batch, or open “Add roles” to paste postings you found yourself.' }),
        h('button', { class: 'primary', onclick: function () { go('import'); } }, 'Add roles')));
      return;
    }
    var cols = [['company', 'Company'], ['title', 'Job Title'], ['location', 'Location'], ['salary', 'Salary'], ['reviewed', 'Date Reviewed']];
    var thead = h('tr', null, cols.map(function (c) {
      var on = ui.sort.k === c[0];
      return h('th', { 'aria-sort': on ? (ui.sort.dir > 0 ? 'ascending' : 'descending') : 'none' }, h('button', { class: 'thb', onclick: function () { ui.sort = { k: c[0], dir: on ? -ui.sort.dir : 1 }; refreshRows(); } }, c[1] + (on ? (ui.sort.dir > 0 ? ' ▲' : ' ▼') : '')));
    }));
    main.appendChild(h('div', { class: 'tablewrap' }, h('table', { id: 'jobs' }, h('thead', null, thead), h('tbody', { id: 'rows' }))));
    main.appendChild(h('p', { class: 'muted', id: 'count' }));
    refreshRows();
  }
  function refreshRows() {
    var tb = $('#rows'); if (!tb) return; clear(tb);
    var rows = filtered();
    rows.forEach(function (j) {
      var open = function () { openJob(j.id); };
      tb.appendChild(h('tr', { tabindex: 0, 'data-id': j.id, class: j.status === 'skipped' ? 'skipped' : '', onclick: open, onkeydown: function (e) { if (e.key === 'Enter') open(); } },
        h('td', { text: j.company }), h('td', { text: j.title }), h('td', { text: j.location || 'Unknown' }),
        h('td', { text: DJ.fmtSalary(j.salary) }), h('td', { class: 'num', text: j.status === 'reviewed' ? date(j.reviewedAt) : '' })));
    });
    $('#count').textContent = rows.length + ' of ' + jobsList().length + ' roles shown';
  }

  /* ---------- review queue + record ---------- */
  function startQueue(n, kind) {
    kind = kind || 'review'; qkind = kind;
    var u = (kind === 'rerate' ? legacyJobs() : unreviewedOrdered()).slice(0, n);
    if (!u.length) { toast(kind === 'rerate' ? 'Nothing left to re-rate.' : 'No unreviewed roles. Ask Claude for “10 more”.'); return; }
    queue = u.map(function (j) { return j.id; }); openJob(queue[0], kind === 'rerate');
  }
  function openJob(id, rerate) {
    leaveRecord('switched-record');
    var j = S.jobs[id]; if (!j) return;
    cur = { id: id, revising: false, manual: false, timer: null, base: 0, ratingR: null, ratingC: null, ratingQ: null, qCarried: false };
    view = 'record';
    if (j.status !== 'reviewed') beginTiming(false);
    else if (rerate) startRevision(j);
    render(); window.scrollTo(0, 0);
  }
  function beginTiming(revising) {
    cur.revising = revising; cur.timer = DJ.ReviewTimer(cfg().idleSec); cur.timer.start(); cur.manual = false; cur.wasRunning = true;
    clearInterval(tick); tick = setInterval(onTick, 1000);
    saveDraft();
  }
  function onTick() {
    if (!cur || !cur.timer) return;
    cur.timer.checkIdle();
    var run = cur.timer.running;
    if (cur.wasRunning && !run) persistOpen();     // checkpoint when a pause happens
    cur.wasRunning = run;
    if (run) saveDraft();
    var el = $('#timer'); if (el) { el.textContent = DJ.fmtDur(cur.timer.activeSec()); var st = $('#tstate'); if (st) st.textContent = run ? 'running' : (cur.manual ? 'paused' : 'paused (inactive or tab hidden)'); }
    var pb = $('#pausebtn'); if (pb) pb.textContent = run ? 'Pause timer' : 'Resume timer';
  }
  function saveDraft() { try { if (cur && cur.timer) localStorage.setItem('dj_draft', JSON.stringify({ id: cur.id, revising: cur.revising, start: cur.timer.sessionStart, active_s: cur.timer.activeSec(), at: Date.now() })); } catch (e) { } }
  function clearDraft() { try { localStorage.removeItem('dj_draft'); } catch (e) { } }

  /* Fold the open timing session into the review doc. Returns {review, sec}. */
  function foldSession(reason) {
    if (!cur || !cur.timer || cur.timer.sessionStart == null) return { review: S.reviews[cur && cur.id] || null, sec: 0 };
    var s = cur.timer.finish(reason); s.purpose = cur.revising ? 'revision' : 'initial';
    var r = JSON.parse(JSON.stringify(S.reviews[cur.id] || { jobId: cur.id, ratings: [], sessions: [], active_s: 0, extra_active_s: 0, elapsed_s: 0 }));
    r.sessions.push(s); r.elapsed_s = (r.elapsed_s || 0) + s.elapsed_s;
    if (cur.revising) r.extra_active_s = (r.extra_active_s || 0) + s.active_s; else r.active_s = (r.active_s || 0) + s.active_s;
    r.timing_method = s.method;
    S.reviews[cur.id] = r; clearDraft();
    return { review: r, sec: s.active_s };
  }
  function persistOpen() {   // checkpoint without closing the session: store as an open-session note
    if (!cur || !cur.timer || !db) return;
    var id = cur.id, snap = { jobId: id, open_session: { start: new Date(cur.timer.sessionStart).toISOString(), active_s: Math.round(cur.timer.activeSec()), purpose: cur.revising ? 'revision' : 'initial' } };
    write('reviews/' + id, function () { return db.doc('reviews/' + id).get().then(function (d) { return db.doc('reviews/' + id).set(Object.assign({ ratings: [], sessions: [], active_s: 0, extra_active_s: 0, elapsed_s: 0 }, d.exists ? d.data() : {}, { open_session: snap.open_session, jobId: id })); }); }).catch(function () { });
  }
  function leaveRecord(reason) {
    if (!cur) return;
    clearInterval(tick); tick = null;
    if (cur.timer && cur.timer.sessionStart != null) {
      var f = foldSession(reason), id = cur.id, r = f.review;
      if (r && db && (f.sec > 0 || r.sessions.length)) { delete r.open_session; write('reviews/' + id, function () { return db.doc('reviews/' + id).set(r); }).catch(function () { }); }
    }
    cur = null;
  }
  function recoverDraft() {   // an interrupted session (tab closed or crashed) is recorded, not lost
    var d; try { d = JSON.parse(localStorage.getItem('dj_draft') || 'null'); } catch (e) { }
    if (!d || !S.jobs[d.id] || !db) { return; }
    var r = JSON.parse(JSON.stringify(S.reviews[d.id] || { jobId: d.id, ratings: [], sessions: [], active_s: 0, extra_active_s: 0, elapsed_s: 0 }));
    delete r.open_session;
    var sec = Math.round(d.active_s || 0);
    r.sessions.push({ start: new Date(d.start).toISOString(), end: new Date(d.at).toISOString(), active_s: sec, elapsed_s: Math.round((d.at - d.start) / 1000), pauses: ['interrupted-recovered'], purpose: d.revising ? 'revision' : 'initial', method: 'recovered from local checkpoint' });
    if (d.revising) r.extra_active_s = (r.extra_active_s || 0) + sec; else r.active_s = (r.active_s || 0) + sec;
    S.reviews[d.id] = r; clearDraft();
    put('reviews', d.id, r).then(function () { toast('Recovered ' + DJ.fmtDur(sec) + ' of interrupted review time.'); });
  }

  function field(label, value, cls) { return h('div', { class: 'kv ' + (cls || '') }, h('dt', { text: label }), h('dd', null, value)); }
  function renderRecord() {
    var j = S.jobs[cur.id], c = co(j), r = S.reviews[j.id], reviewed = j.status === 'reviewed';
    main.appendChild(h('div', { class: 'recnav' }, h('button', { onclick: function () { go('table'); } }, '← All roles'),
      queue.length > 1 && queue.indexOf(j.id) >= 0 ? h('span', { class: 'muted', text: 'Queue ' + (queue.indexOf(j.id) + 1) + ' of ' + queue.length }) : null,
      cur.timer ? h('div', { class: 'timerbox' }, h('span', { class: 'muted', text: 'Active review time ' }), h('b', { id: 'timer', text: DJ.fmtDur(cur.timer.activeSec()) }), h('span', { id: 'tstate', class: 'muted', text: ' running' }),
        h('button', { id: 'pausebtn', onclick: function () { if (cur.timer.running) { cur.timer.pause('manual'); cur.manual = true; persistOpen(); } else { cur.timer.resume(); cur.manual = false; } onTick(); } }, 'Pause timer')) : null));
    var mc = 'Not applicable';
    if (c.ownership === 'Public' || c.ticker) mc = [c.exchange || 'Exchange unknown', c.ticker || '', c.marketCap && c.marketCap.value != null ? c.marketCap.currency + ' ' + c.marketCap.value : 'Market cap unknown', c.marketCap && c.marketCap.asOf ? '(as of ' + c.marketCap.asOf + ')' : ''].filter(Boolean).join(' · ');
    else if (c.parent && c.parent.ticker) mc = 'Subsidiary: parent ' + c.parent.name + ' is listed (' + [c.parent.exchange, c.parent.ticker].join(': ') + ')';
    main.appendChild(h('article', { class: 'record' },
      h('header', null, h('p', { class: 'eyebrow', text: j.company }), h('h1', { text: j.title }),
        h('dl', { class: 'facts' },
          field('Location & arrangement', [UNK(j.location), j.arrangement ? ' · ' + j.arrangement : ' · Unknown arrangement', j.remoteEligibility ? ' (remote eligibility: ' + j.remoteEligibility + ')' : ''].join('')),
          field('Salary', DJ.fmtSalary(j.salary) + (j.salary && j.salary.basis ? ' (' + j.salary.basis + ')' : '')),
          field('Date reviewed', reviewed ? date(j.reviewedAt) : ''),
          field('Industry', UNK(c.industry) + (c.subsector ? ' · ' + c.subsector : '')),
          field('B2B / B2C', UNK(c.model)), field('Ownership', UNK(c.ownership)),
          field('Market cap & exchange', mc), field('Company HQ', UNK(c.hq)), field('Division / business unit', UNK(j.division)),
          field('Source & verification', [j.sourceUrl ? h('a', { href: j.sourceUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Original posting' }) : 'No source link', ' · verified ' + (j.verifiedAt ? date(j.verifiedAt) : 'Unknown') + (j.postingStatus ? ' (' + j.postingStatus + ')' : '')]))),
      descBlock(j),
      ratingBlock(j, r),
      detailsBlock(j, c, r)));
  }
  function descBlock(j) {
    var incomplete = !j.desc || j.descComplete === false;
    var wrap = h('section', { class: 'desc' }, h('h2', { text: 'Job description' }));
    if (incomplete) {
      wrap.appendChild(h('div', { class: 'warn' }, h('b', { text: 'Incomplete description. ' }), 'The full text could not be retrieved. Paste the full posting text below to complete this record.'));
      var ta = h('textarea', { id: 'missingtext', rows: 8, placeholder: 'Paste the full job description here…' });
      wrap.appendChild(ta); wrap.appendChild(h('button', { onclick: function () {
        var t = ta.value.trim(); if (!t) return;
        var nj = Object.assign({}, j, { desc: j.desc ? j.desc + '\n\n--- imported text ---\n' + t : t, descComplete: true, descImportedAt: nowIso() });
        put('jobs', j.id, nj).then(function () { S.jobs[j.id] = nj; render(); toast('Description saved.'); });
      } }, 'Save description'));
    }
    if (j.desc) wrap.appendChild(h('div', { class: 'jd', id: 'jd', text: j.desc }));
    return wrap;
  }
  function scale(name, label, anchors, get, set, sub) {
    var g = h('div', { class: 'scale', role: 'radiogroup', 'aria-label': label });
    for (var i = 1; i <= 10; i++) (function (n) {
      g.appendChild(h('button', { type: 'button', role: 'radio', id: name + '-' + n, class: 'sc' + (get() === n ? ' on' : ''), 'aria-checked': get() === n ? 'true' : 'false', onclick: function () { set(n); [].forEach.call(g.children, function (b, k) { b.className = 'sc' + (k + 1 === n ? ' on' : ''); b.setAttribute('aria-checked', k + 1 === n ? 'true' : 'false'); }); updSave(); } }, String(n)));
    })(i);
    return h('div', { class: 'ratingrow' }, h('h3', { text: label }), sub ? h('p', { class: 'muted sub', text: sub }) : null, g, h('div', { class: 'anchors' }, anchors.map(function (a) { return h('span', { text: a }); })));
  }
  var updSave = function () { };
  var describe = function (x) {
    var n = DJ.norm(x);
    return n.legacy ? 'combined interest ' + n.role + ' (earlier single-score scheme), qualification ' + n.qual
      : 'company interest ' + n.company + ', role interest ' + n.role + ', qualification ' + n.qual + (x.qualificationCarried ? ' (carried forward)' : '');
  };
  function startRevision(j) {
    var ln = latestNorm(j.id);
    cur.ratingR = null; cur.ratingC = null;
    if (ln && ln.legacy) { cur.ratingQ = ln.qual; cur.qCarried = true; } else { cur.ratingQ = null; cur.qCarried = false; }
    beginTiming(true);
  }
  function ratingBlock(j, r) {
    var sec = h('section', { class: 'rating' }, h('h2', { text: 'Your ratings' }));
    var reviewed = j.status === 'reviewed';
    if (reviewed && !cur.revising) {
      var orig = DJ.ratingOf(r, 'original'), last = DJ.ratingOf(r, 'latest'), ln = DJ.norm(last);
      sec.appendChild(h('p', null, 'Original (' + date(orig.at) + '): ' + describe(orig) + ' · initial review time ' + DJ.fmtDur(r.active_s)));
      if (r.ratings.length > 1) sec.appendChild(h('p', null, 'Latest (' + date(last.at) + '): ' + describe(last)));
      sec.appendChild(h('ol', { class: 'hist' }, r.ratings.map(function (x) { return h('li', { text: date(x.at) + ' · ' + x.kind + ' · ' + describe(x) + (x.note ? ' · “' + x.note + '”' : '') + ' · ' + DJ.fmtDur(x.review_s) + ' reviewing' }); })));
      if (ln.legacy) sec.appendChild(h('p', { class: 'warn', text: 'This role has one combined interest score. Re-rate to record role interest and company interest separately. Your original score stays in the history.' }));
      sec.appendChild(h('button', { id: 'revise', class: ln.legacy ? 'primary' : '', onclick: function () { cur.revising = true; startRevision(j); render(); } }, ln.legacy ? 'Re-rate: role + company interest' : 'Revise ratings'));
      return sec;
    }
    if (j.status === 'skipped') sec.appendChild(h('p', { class: 'muted', text: 'Skipped on ' + date(j.skippedAt) + '. A skip is not a low-interest rating.' }));
    sec.appendChild(scale('c', 'Company Interest', ['1 = I would not want to work for this company', '5 = Moderately interesting', '10 = I would be highly excited to work here'], function () { return cur.ratingC; }, function (n) { cur.ratingC = n; },
      'The employer: mission, products, industry, culture, stage.'));
    sec.appendChild(scale('r', 'Role Interest', ['1 = I would not want to do this work', '5 = Moderately interesting', '10 = I would be highly excited by this work'], function () { return cur.ratingR; }, function (n) { cur.ratingR = n; },
      'The job itself: responsibilities, scope, seniority, day-to-day work.'));
    sec.appendChild(scale('q', 'Qualification Level', ['1 = I meet almost none of the requirements', '5 = I meet roughly half / could grow into it', '10 = I am exceptionally well qualified'], function () { return cur.ratingQ; }, function (n) { cur.ratingQ = n; cur.qCarried = false; var hnt = $('#qhint'); if (hnt) hnt.textContent = ''; }));
    sec.appendChild(h('p', { class: 'muted', id: 'qhint', text: cur.qCarried ? 'Carried forward from your earlier rating. Click a different number to change it.' : '' }));
    var note = h('textarea', { id: 'note', rows: 3, placeholder: 'Optional: why this reaction? (role, company, or both)' });
    sec.appendChild(h('label', { class: 'notel' }, 'Note (optional)', note));
    var save = h('button', { id: 'save', class: 'primary', disabled: true, onclick: function () { submit(note.value, false); } }, cur.revising ? 'Save revision' : 'Save ratings');
    var saveNext = h('button', { id: 'savenext', class: 'primary', disabled: true, onclick: function () { submit(note.value, true); } }, 'Save and next');
    updSave = function () { var ok = cur.ratingR != null && cur.ratingC != null && cur.ratingQ != null; save.disabled = !ok; saveNext.disabled = !ok; };
    var acts = h('div', { class: 'actions' }, save, saveNext);
    if (!reviewed) acts.appendChild(h('button', { id: 'skip', onclick: function () { skip(j); } }, j.status === 'skipped' ? 'Keep skipped' : 'Skip this role'));
    if (j.status === 'skipped') acts.appendChild(h('button', { onclick: function () { var nj = Object.assign({}, j, { status: 'unreviewed' }); delete nj.skippedAt; put('jobs', j.id, nj).then(function () { S.jobs[j.id] = nj; render(); }); } }, 'Return to queue'));
    if (cur.revising) acts.appendChild(h('button', { onclick: function () { leaveRecord('cancel-revision'); openJob(j.id); } }, 'Cancel revision'));
    sec.appendChild(acts); updSave();
    return sec;
  }
  function pendingNext() {
    var ok = function (x) { var jj = S.jobs[x]; if (!jj) return false; if (qkind === 'rerate') { var n = jj.status === 'reviewed' && latestNorm(x); return !!(n && n.legacy); } return (jj.status || 'unreviewed') === 'unreviewed'; };
    var q = queue.filter(ok)[0]; if (q) return q;
    var any = qkind === 'rerate' ? legacyJobs()[0] : unreviewedOrdered()[0]; return any ? any.id : null;
  }
  function submit(note, next) {
    var id = cur.id, j = S.jobs[id], R = cur.ratingR, C = cur.ratingC, Q = cur.ratingQ, carried = cur.qCarried, revising = cur.revising;
    if (R == null || C == null || Q == null) return;
    var f = foldSession('submit'), t = nowIso();
    var entry = { roleInterest: R, companyInterest: C, qualification: Q, qualificationCarried: carried };
    var rev = DJ.appendRating(f.review, entry, note, t, revising ? f.sec : 0); delete rev.open_session;
    var nj = Object.assign({}, j, { status: 'reviewed' });
    if (!revising || !j.reviewedAt) { nj.reviewedAt = t; nj.ratingOriginal = { roleInterest: R, companyInterest: C, qualification: Q }; }
    nj.ratingLatest = { roleInterest: R, companyInterest: C, qualification: Q };
    clearInterval(tick); tick = null;
    S.reviews[id] = rev; S.jobs[id] = nj;
    put('reviews', id, rev).then(function () { return put('jobs', id, nj); }).then(function () {
      toast(revising ? 'Revision appended. Original ratings kept.' : 'Ratings saved.');
      cur = null;
      if (next) { var n = pendingNext(); if (n) return openJob(n, qkind === 'rerate'); toast(qkind === 'rerate' ? 'All roles re-rated.' : 'Queue finished. No unreviewed roles left.'); }
      view = next ? 'table' : 'record'; if (!next) { cur = { id: id, revising: false, timer: null }; } render();
    }).catch(function () { });
  }
  function skip(j) {
    var f = foldSession('skip'); var r = f.review; if (r) { delete r.open_session; put('reviews', j.id, r); }
    var nj = Object.assign({}, j, { status: 'skipped', skippedAt: nowIso() }); S.jobs[j.id] = nj; clearInterval(tick); tick = null;
    put('jobs', j.id, nj).then(function () {
      cur = null; var n = queue.filter(function (x) { return S.jobs[x] && (S.jobs[x].status || 'unreviewed') === 'unreviewed'; })[0];
      if (n) openJob(n); else { view = 'table'; render(); } toast('Skipped. This is not counted as low interest.');
    }).catch(function () { });
  }
  function detailsBlock(j, c, r) {
    var L = function (t, a) { return a && a.length ? [h('dt', { text: t }), h('dd', { text: a.join('; ') })] : []; };
    var s = j.sections || {}, ex = j.extraction || {};
    var d = h('details', { class: 'more' }, h('summary', { text: 'Standardized details and provenance' }),
      h('dl', { class: 'facts2' },
        field('Role family', UNK(j.roleFamily)), field('Seniority', UNK(j.seniority)), field('Employment type', UNK(j.employmentType)),
        field('Travel', UNK(j.travel)), field('Requisition ID', UNK(j.reqId)), field('Posted', UNK(j.postedDate)), field('Sourced', j.sourcedAt ? date(j.sourcedAt) : 'Unknown'),
        field('Batch / policy', UNK(j.batchId) + ' / ' + UNK(j.policyVersion)), field('Company size', c.size ? UNK(c.size.band || c.size.count) + (c.size.asOf ? ' (as of ' + c.size.asOf + ')' : '') : 'Unknown'),
        field('Stage', UNK(c.stage)), field('Extraction', (ex.completeness || 'Unknown') + (ex.missing && ex.missing.length ? '; missing: ' + ex.missing.join(', ') : '')),
        L('Responsibilities', s.responsibilities), L('Required', s.required), L('Preferred', s.preferred), L('Skills', s.skills), L('Platforms & tools', (s.platforms || []).concat(s.tools || [])), L('Certifications', s.certifications),
        c.careersUrl ? field('Career page', h('a', { href: c.careersUrl, target: '_blank', rel: 'noopener noreferrer', text: c.careersUrl })) : null));
    if (r && r.sessions && r.sessions.length) d.appendChild(h('p', { class: 'muted', text: r.sessions.length + ' timing session(s); initial active ' + DJ.fmtDur(r.active_s) + (r.extra_active_s ? '; additional revision time ' + DJ.fmtDur(r.extra_active_s) : '') + '. Method: ' + (r.timing_method || 'n/a') + '. Timing approximates active reading time.' }));
    return d;
  }

  /* ---------- add roles ---------- */
  function ensureCompany(c, name) {
    var id = DJ.companyId(name), ex = S.companies[id] || {}, merged = Object.assign({}, ex);
    Object.keys(c || {}).forEach(function (k) { if (merged[k] == null || merged[k] === '' || merged[k] === 'Unknown') merged[k] = c[k]; });
    merged.id = id; merged.name = ex.name || name; S.companies[id] = merged; return merged;
  }
  function importJobs(list, batchMeta) {
    var report = { added: [], dups: [], errors: [] }, existing = jobsList(), seq = existing.length, writes = [], bid = (batchMeta && batchMeta.id) || ('b_' + new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14));
    list.forEach(function (raw) {
      if (!raw || !raw.company || !raw.title) { report.errors.push('Missing company or title: ' + JSON.stringify(raw || {}).slice(0, 80)); return; }
      var cand = Object.assign({}, raw.job || raw), cdata = raw.companyData || raw.companyInfo || {};
      var dup = DJ.findDuplicate(cand, existing.concat(report.added));
      if (dup) {
        var e = dup.job;
        if (cand.desc && e.desc && cand.desc.trim() !== e.desc.trim() && e.status !== 'reviewed') { var nu = Object.assign({}, e, { updates: (e.updates || []).concat([{ at: nowIso(), desc: cand.desc }]) }); S.jobs[e.id] = nu; writes.push(['jobs', e.id, nu]); }
        report.dups.push(cand.company + ' — ' + cand.title + ' (' + dup.reason + ')'); return;
      }
      ensureCompany(cdata, cand.company);
      var id = DJ.jobId(cand);
      var j = Object.assign({ roleFamily: [], seniority: 'Unknown' }, cand, { id: id, companyId: DJ.companyId(cand.company), status: 'unreviewed', batchId: bid, policyVersion: cfg().policy, sourcedAt: cand.sourcedAt || nowIso(), seq: seq++ });
      if (!j.desc) j.descComplete = false; else if (j.descComplete == null) j.descComplete = true;
      S.jobs[id] = j; report.added.push(j); writes.push(['jobs', id, j]);
    });
    report.added.forEach(function (j) { writes.push(['companies', j.companyId, S.companies[j.companyId]]); });
    var cov = coverage(report.added);
    var batch = Object.assign({ id: bid, date: nowIso(), policyVersion: cfg().policy, requested: 10, jobIds: report.added.map(function (j) { return j.id; }), accepted: report.added.length, duplicatesSkipped: report.dups.length, coverage: cov }, batchMeta || {}, { id: bid });
    S.batches[bid] = batch; writes.push(['batches', bid, batch]);
    return writes.reduce(function (p, w) { return p.then(function () { return put(w[0], w[1], w[2]); }); }, Promise.resolve()).then(function () { report.coverage = cov; report.batch = batch; return report; });
  }
  function coverage(jobs) {
    var fam = {}, ind = {}, comp = {};
    jobs.forEach(function (j) { (j.roleFamily || []).forEach(function (f) { fam[f] = 1; }); var i = co(j).industry; if (i) ind[i] = 1; comp[j.company] = (comp[j.company] || 0) + 1; });
    var maxc = Math.max.apply(null, [0].concat(Object.keys(comp).map(function (k) { return comp[k]; })));
    var warn = []; if (jobs.length && jobs.length !== 10) warn.push('Batch has ' + jobs.length + ' roles, not 10 (shortfall or extra).');
    if (jobs.length && Object.keys(fam).length < 5) warn.push('Only ' + Object.keys(fam).length + ' role families (target ≥ 5).');
    if (jobs.length && Object.keys(ind).length < 5) warn.push('Only ' + Object.keys(ind).length + ' industries (target ≥ 5).');
    if (maxc > 2) warn.push('A company appears ' + maxc + ' times (target ≤ 2).');
    return { roleFamilies: Object.keys(fam).length, industries: Object.keys(ind).length, maxPerCompany: maxc, warnings: warn };
  }
  function renderImport() {
    main.appendChild(h('h2', { text: 'Add roles' }));
    main.appendChild(h('p', { class: 'muted', text: 'Claude sources batches and writes them to this same database, so they appear here automatically. Use this page to add postings yourself. Duplicates are detected by requisition ID, canonical URL, or company + title + location.' }));
    var out = h('div', { id: 'importout' });
    var f = {}; var fld = function (k, label, ph, tag) { f[k] = tag === 'ta' ? h('textarea', { id: 'f_' + k, rows: 10, placeholder: ph }) : h('input', { id: 'f_' + k, type: 'text', placeholder: ph || '' }); return h('label', { class: 'frm' }, label, f[k]); };
    var one = h('form', { class: 'card', onsubmit: function (e) { e.preventDefault();
      var v = function (k) { return f[k].value.trim(); }; if (!v('company') || !v('title')) { toast('Company and title are required.', true); return; }
      var job = { company: v('company'), title: v('title'), location: v('location'), sourceUrl: v('url'), reqId: v('req'), desc: v('desc'), salary: v('salary') ? { text: v('salary') } : null, verifiedAt: v('url') ? nowIso() : null, postingStatus: v('url') ? 'Open when added (manual)' : null };
      importJobs([{ job: job }], { note: 'Added manually', requested: 1 }).then(function (rep) { showImport(out, rep); one.reset(); render_keep(); });
    } },
      h('h3', { text: 'One posting' }), fld('company', 'Company *'), fld('title', 'Job title *'), fld('location', 'Location'), fld('url', 'Posting URL'), fld('req', 'Requisition ID'), fld('salary', 'Salary exactly as published (leave blank if none)'),
      fld('desc', 'Full job description', 'Paste the complete posting text', 'ta'), h('button', { class: 'primary', type: 'submit' }, 'Add role'));
    var ta = h('textarea', { id: 'batchjson', rows: 8, placeholder: '[{"company":"…","title":"…","location":"…","sourceUrl":"…","desc":"…","companyData":{"industry":"…"}}]' });
    var batch = h('div', { class: 'card' }, h('h3', { text: 'Batch JSON' }), ta,
      h('button', { id: 'runbatch', onclick: function () { var arr; try { arr = JSON.parse(ta.value); } catch (e) { toast('Not valid JSON: ' + e.message, true); return; } if (arr && arr.jobs) arr = arr.jobs; if (!Array.isArray(arr)) { toast('Expected a JSON array of roles.', true); return; }
        importJobs(arr, null).then(function (rep) { showImport(out, rep); render_keep(); }); } }, 'Import batch'));
    main.appendChild(h('div', { class: 'two' }, one, batch)); main.appendChild(out);
  }
  function render_keep() { renderProgress(); }
  function showImport(out, rep) {
    clear(out);
    out.appendChild(h('div', { class: 'card' }, h('h3', { text: rep.added.length + ' added, ' + rep.dups.length + ' duplicate(s) skipped' }),
      rep.errors.map(function (e) { return h('p', { class: 'warn', text: e }); }), rep.dups.map(function (d) { return h('p', { class: 'muted', text: 'Duplicate: ' + d }); }),
      h('p', { text: 'Coverage: ' + rep.coverage.roleFamilies + ' role families, ' + rep.coverage.industries + ' industries, max ' + rep.coverage.maxPerCompany + ' per company.' }),
      rep.coverage.warnings.map(function (w) { return h('p', { class: 'warn', text: w }); })));
  }

  /* ---------- analysis ---------- */
  function summarize(rows, keysFn) { return DJ.groupMeans(rows, keysFn, 5); }
  function groupTable(title, g, metric) {
    metric = metric || 'Mean role interest';
    var sec = h('section', { class: 'rep' }, h('h3', { text: title }));
    if (!g.groups.length) { sec.appendChild(h('p', { class: 'muted', text: 'No usable data (' + g.missing + ' of ' + g.total + ' missing/Unknown).' })); return sec; }
    sec.appendChild(h('div', { class: 'tablewrap' }, h('table', { class: 'small' }, h('thead', null, h('tr', null, ['Group', 'n', metric, 'Rated 8–10', 'Rated 1–3', 'Signal'].map(function (x) { return h('th', { text: x }); }))),
      h('tbody', null, g.groups.map(function (x) { return h('tr', null, h('td', { text: x.key }), h('td', { class: 'num', text: x.n }), h('td', { class: 'num', text: x.mean.toFixed(1) }), h('td', { class: 'num', text: x.high }), h('td', { class: 'num', text: x.low }), h('td', { text: x.tentative ? 'tentative (n<5)' : 'n≥5' })); })))));
    sec.appendChild(h('p', { class: 'muted', text: 'Missing/Unknown: ' + g.missing + ' of ' + g.total + '. Descriptive means only; groups overlap and are not causal.' }));
    return sec;
  }
  function analysisData() {
    var rows = dataset(ui.mode), n = rows.length, out = { mode: ui.mode, n: n, legacyExcluded: Object.keys(S.jobs).filter(function (id) { return S.jobs[id].status === 'reviewed'; }).length - n, preliminary: n < 100, generatedAt: nowIso(), policyVersions: Object.keys(S.policies), cutoff: rows.reduce(function (m, r) { return r.at > m ? r.at : m; }, '') };
    out.groups = {
      'Role family': DJ.groupMeans(rows, function (r) { return r.job.roleFamily || []; }, 5), 'Seniority': DJ.groupMeans(rows, function (r) { return [r.job.seniority]; }, 5),
      'Industry': DJ.groupMeans(rows, function (r) { return [r.co.industry]; }, 5), 'Business model (B2B/B2C)': DJ.groupMeans(rows, function (r) { return [r.co.model]; }, 5),
      'Ownership': DJ.groupMeans(rows, function (r) { return [r.co.ownership]; }, 5), 'Company stage': DJ.groupMeans(rows, function (r) { return [r.co.stage]; }, 5),
      'Work arrangement': DJ.groupMeans(rows, function (r) { return [r.job.arrangement]; }, 5), 'Location': DJ.groupMeans(rows, function (r) { return [r.job.location]; }, 5)
    };
    out.companyGroups = {
      'Industry': DJ.groupMeans(rows, function (r) { return [r.co.industry]; }, 5, 'companyInterest'), 'Business model (B2B/B2C)': DJ.groupMeans(rows, function (r) { return [r.co.model]; }, 5, 'companyInterest'),
      'Ownership': DJ.groupMeans(rows, function (r) { return [r.co.ownership]; }, 5, 'companyInterest'), 'Company stage': DJ.groupMeans(rows, function (r) { return [r.co.stage]; }, 5, 'companyInterest'),
      'Company': DJ.groupMeans(rows, function (r) { return [r.job.company]; }, 2, 'companyInterest')
    };
    var I = rows.map(function (r) { return r.interest; }), Q = rows.map(function (r) { return r.qual; }), CI = rows.map(function (r) { return r.companyInterest; });
    out.corrIQ = DJ.spearman(I, Q); out.corrRC = DJ.spearman(I, CI); out.corrCQ = DJ.spearman(CI, Q);
    out.quad2 = {}; rows.forEach(function (r) { var k = DJ.quadrant2(r.interest, r.companyInterest); (out.quad2[k] = out.quad2[k] || []).push(r); });
    out.gap = DJ.mean(rows.map(function (r) { return r.interest - r.companyInterest; }));
    out.quad = {}; rows.forEach(function (r) { var q = DJ.quadrant(r.interest, r.qual); (out.quad[q] = out.quad[q] || []).push(r); });
    var sal = rows.filter(function (r) { return r.job.salary && /usd|\$/i.test((r.job.salary.currency || '') + (r.job.salary.text || '')) && DJ.annualMid(r.job.salary) != null; });
    out.salary = { usableN: sal.length, disclosedAny: rows.filter(function (r) { return DJ.fmtSalary(r.job.salary) !== 'Not disclosed'; }).length, corr: DJ.spearman(sal.map(function (r) { return DJ.annualMid(r.job.salary); }), sal.map(function (r) { return r.interest; })),
      meanDisclosed: DJ.mean(rows.filter(function (r) { return DJ.fmtSalary(r.job.salary) !== 'Not disclosed'; }).map(function (r) { return r.interest; })), meanUndisclosed: DJ.mean(rows.filter(function (r) { return DJ.fmtSalary(r.job.salary) === 'Not disclosed'; }).map(function (r) { return r.interest; })) };
    out.sens = DJ.sensitivity(rows); out.themes = DJ.themeContrast(rows);
    var byTime = rows.slice().sort(function (a, b) { return (a.at || '').localeCompare(b.at || ''); }), half = Math.floor(byTime.length / 2);
    out.early = { n: half, mean: DJ.mean(byTime.slice(0, half).map(function (r) { return r.interest; })) }; out.recent = { n: byTime.length - half, mean: DJ.mean(byTime.slice(half).map(function (r) { return r.interest; })) };
    out.cohorts = DJ.groupMeans(rows, function (r) { return [r.job.policyVersion]; }, 5);
    out.dist = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (k) { return I.filter(function (x) { return x === k; }).length; });
    out.examples = function (f) { return rows.filter(f).sort(function (a, b) { return b.interest - a.interest; }).slice(0, 3).map(function (r) { return r.job.company + ' — ' + r.job.title; }); };
    return out;
  }
  var pct = function (x) { return x == null ? 'n/a' : Math.round(x * 100) + '%'; };
  function renderAnalysis() {
    var d = analysisData();
    main.appendChild(h('div', { class: 'toolbar' }, h('h2', { text: 'Analysis' }),
      h('select', { id: 'amode', 'aria-label': 'Rating version', onchange: function (e) { ui.mode = e.target.value; render(); } }, [['latest', 'Latest ratings'], ['original', 'Original ratings']].map(function (o) { return h('option', { value: o[0], selected: ui.mode === o[0] }, o[1]); })),
      h('button', { id: 'snap', onclick: function () { saveSnapshot(d); } }, 'Save report snapshot')));
    main.appendChild(h('p', { class: d.preliminary ? 'warn' : 'okmsg', text: (d.preliminary ? 'Preliminary: ' : 'Full report: ') + d.n + ' completed unique roles (' + ui.mode + ' ratings). ' + (d.preliminary ? 'The first full report unlocks at 100.' : '') + (d.legacyExcluded > 0 ? ' ' + d.legacyExcluded + ' reviewed role(s) have only the earlier combined-interest score in this view and are excluded; re-rate them to include them.' : '') }));
    if (d.n < 3) { main.appendChild(h('p', { class: 'muted', text: 'Rate a few roles to see patterns. Role interest and company interest are the primary outcomes; qualification is analyzed separately.' })); return; }
    var mx = Math.max.apply(null, d.dist.concat([1]));
    main.appendChild(h('section', { class: 'rep' }, h('h3', { text: 'Role interest distribution (1–10)' }), h('div', { class: 'dist' }, d.dist.map(function (c, i) { return h('div', { class: 'dcol' }, h('div', { class: 'dbar', style: 'height:' + (c / mx * 80) + 'px', title: c + ' roles' }), h('span', { text: String(i + 1) }), h('small', { text: String(c) })); }))));
    Object.keys(d.companyGroups).forEach(function (k) { main.appendChild(groupTable('Mean company interest by ' + k, d.companyGroups[k], 'Mean company interest')); });
    Object.keys(d.groups).forEach(function (k) { main.appendChild(groupTable('Mean role interest by ' + k, d.groups[k])); });
    var q2 = d.quad2;
    main.appendChild(h('section', { class: 'rep' }, h('h3', { text: 'Company interest vs role interest' }),
      h('p', { text: 'Spearman correlation (company, role): ' + (d.corrRC == null ? 'n/a (need ≥ 5)' : d.corrRC.toFixed(2)) + '. Mean role minus company interest: ' + (d.gap == null ? 'n/a' : d.gap.toFixed(1)) + '. Cut points: ≥ 7. Company interest repeats for roles at the same employer, so treat company patterns as tentative until more employers are rated.' }),
      h('div', { class: 'quads' }, ['High role / high company', 'High role / lower company', 'Lower role / high company', 'Lower role / lower company'].map(function (k) {
        var a = q2[k] || []; return h('div', { class: 'quad' }, h('b', { text: k }), h('div', { class: 'big', text: a.length }), h('small', { text: a.slice(0, 3).map(function (r) { return r.job.company + ': ' + r.job.title; }).join(' · ') || 'none' })); }))));
    var q = d.quad;
    main.appendChild(h('section', { class: 'rep' }, h('h3', { text: 'Role interest vs qualification' }),
      h('p', { text: 'Spearman correlation (role interest, qualification): ' + (d.corrIQ == null ? 'n/a (need ≥ 5)' : d.corrIQ.toFixed(2)) + '. Quadrant cut points: role interest ≥ 7, qualification ≥ 7. Company interest vs qualification: ' + (d.corrCQ == null ? 'n/a' : d.corrCQ.toFixed(2)) + '.' }),
      h('div', { class: 'quads' }, ['High interest / high qualification', 'High interest / lower qualification', 'Lower interest / high qualification', 'Lower interest / lower qualification'].map(function (k) {
        var a = q[k] || []; return h('div', { class: 'quad' }, h('b', { text: k }), h('div', { class: 'big', text: a.length }), h('small', { text: a.slice(0, 3).map(function (r) { return r.job.company + ': ' + r.job.title; }).join(' · ') || 'none' })); }))));
    main.appendChild(h('section', { class: 'rep' }, h('h3', { text: 'Compensation' }),
      h('p', { text: 'Published salary present on ' + d.salary.disclosedAny + ' of ' + d.n + ' roles; ' + d.salary.usableN + ' have a USD annualizable range. Rank correlation with role interest: ' + (d.salary.corr == null ? 'n/a' : d.salary.corr.toFixed(2)) + '. Mean role interest when salary disclosed ' + (d.salary.meanDisclosed == null ? 'n/a' : d.salary.meanDisclosed.toFixed(1)) + ' vs not disclosed ' + (d.salary.meanUndisclosed == null ? 'n/a' : d.salary.meanUndisclosed.toFixed(1)) + '. Undisclosed salaries are never imputed; disclosure itself varies by employer and location and can bias this.' })));
    var hi = d.themes.highGroup, lo = d.themes.lowGroup;
    main.appendChild(h('section', { class: 'rep' }, h('h3', { text: 'High (8–10) vs low (1–3) role interest' }),
      h('p', { text: 'Group sizes: ' + hi + ' high, ' + lo + ' low. Sensitivity: ' + d.sens.map(function (s) { return s.high + ' vs ' + s.low + ' → ' + s.highN + '/' + s.lowN; }).join('; ') + '.' }),
      hi && lo ? h('div', { class: 'tablewrap' }, h('table', { class: 'small' }, h('thead', null, h('tr', null, ['Theme in description', '% of high', '% of low', 'Gap', 'Signal'].map(function (x) { return h('th', { text: x }); }))),
        h('tbody', null, d.themes.themes.filter(function (t) { return t.highN + t.lowN > 0; }).map(function (t) { return h('tr', null, h('td', { text: t.theme }), h('td', { class: 'num', text: pct(t.highPct) + ' (' + t.highN + ')' }), h('td', { class: 'num', text: pct(t.lowPct) + ' (' + t.lowN + ')' }), h('td', { class: 'num', text: t.diff == null ? 'n/a' : Math.round(t.diff * 100) + ' pts' }), h('td', { text: t.tentative ? 'tentative (<5 postings)' : 'supported' })); })))) : h('p', { class: 'muted', text: 'Need both a high and a low group to compare themes.' })));
    main.appendChild(h('section', { class: 'rep' }, h('h3', { text: 'Early vs recent, and sourcing cohorts' }),
      h('p', { text: 'First half of reviews: mean ' + (d.early.mean == null ? 'n/a' : d.early.mean.toFixed(1)) + ' (n=' + d.early.n + '); second half: ' + (d.recent.mean == null ? 'n/a' : d.recent.mean.toFixed(1)) + ' (n=' + d.recent.n + '). A change may reflect which jobs were sourced under each policy version rather than a shift in your preferences.' })));
    main.appendChild(groupTable('Mean role interest by sourcing-policy version', d.cohorts));
    main.appendChild(h('p', { class: 'muted', text: 'Resume versions, skill priorities, role clusters and the narrative report are produced by Claude on request (“Analyze my ratings”) from this same dataset and saved under Saved reports. Review duration is context only, not a measure of interest.' }));
  }
  function saveSnapshot(d) {
    var id = 'r_' + nowIso().replace(/[-:T.Z]/g, '').slice(0, 14);
    var lite = JSON.parse(JSON.stringify(d, function (k, v) { return typeof v === 'function' ? undefined : (k === 'job' || k === 'co') ? undefined : v; }));
    ['quad', 'quad2'].forEach(function (k) { var o = {}; Object.keys(d[k]).forEach(function (q) { o[q] = d[k][q].map(function (r) { return r.id; }); }); lite[k] = o; });
    put('reports', id, { id: id, kind: 'auto-snapshot', createdAt: nowIso(), mode: d.mode, n: d.n, preliminary: d.preliminary, cutoff: d.cutoff, policyVersions: d.policyVersions, data: lite }).then(function () { toast('Snapshot saved.'); });
  }
  function renderReports() {
    main.appendChild(h('h2', { text: 'Saved reports' }));
    var ids = Object.keys(S.reports).sort().reverse();
    if (!ids.length) { main.appendChild(h('p', { class: 'muted', text: 'No saved reports yet. Save a snapshot from Analysis, or ask Claude to “Analyze my ratings” for the full narrative report.' })); return; }
    ids.forEach(function (id) { var r = S.reports[id];
      main.appendChild(h('details', { class: 'card' }, h('summary', { text: date(r.createdAt) + ' · ' + (r.title || r.kind || 'report') + ' · ' + r.n + ' completed · ' + r.mode + ' ratings' + (r.preliminary ? ' · preliminary' : '') }),
        h('p', { class: 'muted', text: 'Dataset cutoff ' + (r.cutoff ? date(r.cutoff) : 'n/a') + '; policy versions: ' + (r.policyVersions || []).join(', ') }), r.body ? h('div', { class: 'jd', text: r.body }) : h('pre', { class: 'jd', text: JSON.stringify(r.data || {}, null, 1).slice(0, 6000) }))); });
  }
  function renderTargets() {
    main.appendChild(h('h2', { text: 'Target companies' }));
    var ids = Object.keys(S.targets);
    if (!ids.length) { main.appendChild(h('p', { class: 'muted', text: 'No target list yet. After enough ratings, ask Claude to “Build my target company list”. It will show an evidence-backed core list and a separately labeled exploratory extension, with LinkedIn and McCombs/MSM connection leads.' })); return; }
    var rows = ids.map(function (k) { return S.targets[k]; }).sort(function (a, b) { return (a.tier || 9) - (b.tier || 9) || (a.name || '').localeCompare(b.name || ''); });
    var thead = ['Company', 'Tier / confidence', 'Basis', 'Industry · model · size · HQ', 'Role families / divisions', 'Geo & remote', 'Why', 'Evidence', 'Open role?', 'Career page'];
    main.appendChild(h('div', { class: 'tablewrap' }, h('table', { class: 'small' }, h('thead', null, h('tr', null, thead.map(function (x) { return h('th', { text: x }); }))), h('tbody', null, rows.map(function (t) {
      return h('tr', null, h('td', { text: t.name }), h('td', { text: 'T' + (t.tier || '?') + ' / ' + UNK(t.confidence) }), h('td', { text: t.basis === 'rated' ? 'Your ratings' : 'Similarity suggestion (exploratory)' }),
        h('td', { text: [t.industry, t.model, t.size, t.hq].map(UNK).join(' · ') }), h('td', { text: UNK(t.roleFamilies) }), h('td', { text: UNK(t.geo) }), h('td', { text: UNK(t.why) }), h('td', { text: UNK(t.evidence) }),
        h('td', { text: t.openRole ? 'Yes (verified ' + UNK(t.openRoleVerified) + ')' : 'None verified' }), h('td', null, t.careersUrl ? h('a', { href: t.careersUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Careers' }) : 'Unknown')); })))));
  }

  /* ---------- settings, export, backup ---------- */
  function copyBtn(text) { return h('button', { class: 'chip', onclick: function () { try { navigator.clipboard.writeText(text).then(function () { toast('Copied “' + text + '”. Paste it to Claude.'); }, function () { toast('Copy blocked. Type: ' + text); }); } catch (e) { toast('Type this to Claude: ' + text); } } }, text); }
  function allData() { var o = { app: '10 Dream Jobs', exportedAt: nowIso(), version: 1 }; ['companies', 'jobs', 'batches', 'reviews', 'policies', 'reports', 'targets', 'settings'].forEach(function (k) { o[k] = S[k]; }); return o; }
  function csvRows() {
    return jobsList().map(function (j) {
      var c = co(j), r = S.reviews[j.id], on = DJ.norm(DJ.ratingOf(r, 'original')), ln = DJ.norm(DJ.ratingOf(r, 'latest')), s = j.salary || {};
      return { job_id: j.id, company: j.company, division: j.division || '', title: j.title, role_family: (j.roleFamily || []).join('; '), seniority: j.seniority || 'Unknown', employment_type: j.employmentType || 'Unknown',
        location: j.location || 'Unknown', arrangement: j.arrangement || 'Unknown', salary_display: DJ.fmtSalary(j.salary), salary_min: s.min == null ? '' : s.min, salary_max: s.max == null ? '' : s.max, salary_currency: s.currency || '', salary_period: s.period || '', salary_basis: s.basis || '',
        industry: c.industry || 'Unknown', business_model: c.model || 'Unknown', ownership: c.ownership || 'Unknown', hq: c.hq || 'Unknown', ticker: c.ticker || '', exchange: c.exchange || '', market_cap: c.marketCap ? c.marketCap.value : '', market_cap_currency: c.marketCap ? c.marketCap.currency : '', market_cap_as_of: c.marketCap ? c.marketCap.asOf : '',
        source_url: j.sourceUrl || '', req_id: j.reqId || '', posted: j.postedDate || '', sourced: j.sourcedAt || '', verified: j.verifiedAt || '', posting_status: j.postingStatus || '', batch_id: j.batchId || '', policy_version: j.policyVersion || '',
        status: j.status || 'unreviewed', date_reviewed: j.status === 'reviewed' ? date(j.reviewedAt) : '', original_company_interest: on && !on.legacy ? on.company : '', original_role_interest: on && !on.legacy ? on.role : '', original_combined_interest_legacy: on && on.legacy ? on.role : '', original_qualification: on ? on.qual : '', latest_company_interest: ln && !ln.legacy ? ln.company : '', latest_role_interest: ln && !ln.legacy ? ln.role : '', latest_combined_interest_legacy: ln && ln.legacy ? ln.role : '', latest_qualification: ln ? ln.qual : '', revisions: r && r.ratings ? Math.max(0, r.ratings.length - 1) : 0, initial_active_seconds: r ? r.active_s || 0 : '', extra_active_seconds: r ? r.extra_active_s || 0 : '' };
    });
  }
  function saveFile(filename, text) {
    if (!dl) { var ta = h('textarea', { rows: 10, readonly: true }); ta.value = text; var box = h('div', { class: 'card' }, h('p', { class: 'warn', text: 'Downloads are unavailable here. Copy this text into ' + filename + '.' }), ta); $('#exportout').appendChild(box); return; }
    dl.save({ filename: filename, data: text }).then(function () { toast('Saved ' + filename); }, function (e) { toast(e && e.code === 'declined' ? 'Download cancelled.' : 'Download failed: ' + ((e && e.message) || e), true); });
  }
  function renderSettings() {
    var s = S.settings.main || {}, c = cfg(), rem = s.reminder || {};
    main.appendChild(h('h2', { text: 'Settings & data' }));
    var tzs = (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [c.tz]); if (tzs.indexOf(c.tz) < 0) tzs = [c.tz].concat(tzs);
    var tz = h('select', { id: 's_tz' }, tzs.map(function (z) { return h('option', { value: z, selected: z === c.tz }, z); }));
    var idle = h('input', { id: 's_idle', type: 'number', min: 15, max: 3600, value: c.idleSec });
    var rt = h('input', { id: 's_rtime', type: 'time', value: rem.time || '' }), rm = h('select', { id: 's_rmethod' }, ['', 'Email', 'Calendar event', 'Push notification', 'Teams message'].map(function (o) { return h('option', { value: o, selected: (rem.method || '') === o }, o || 'Not chosen'); }));
    var aligned = h('input', { id: 's_mix', type: 'number', min: 0, max: 100, value: s.alignedPct == null ? 100 : s.alignedPct });
    main.appendChild(h('section', { class: 'card' }, h('h3', { text: 'Preferences' }),
      h('label', { class: 'frm' }, 'Timezone for displayed dates', tz), h('label', { class: 'frm' }, 'Pause timer after inactivity (seconds)', idle),
      h('label', { class: 'frm' }, 'Aligned share of each batch after the exploratory period (%). Suggested 70; exploratory stays 100% aligned-agnostic until you change it.', aligned),
      h('label', { class: 'frm' }, 'Daily reminder time', rt), h('label', { class: 'frm' }, 'Reminder delivery method', rm),
      h('button', { id: 's_save', class: 'primary', onclick: function () {
        var ns = Object.assign({}, s, { id: 'main', tz: tz.value, idleSec: Math.max(15, Number(idle.value) || 120), alignedPct: Number(aligned.value), reminder: Object.assign({}, rem, { time: rt.value, method: rm.value, tz: tz.value, updatedAt: nowIso() }) });
        put('settings', 'main', ns).then(function () { S.settings.main = ns; render(); toast('Settings saved.'); }); } }, 'Save settings'),
      h('p', { class: 'muted', text: rem.scheduledId ? 'Daily reminder is scheduled (id ' + rem.scheduledId + ', ' + (rem.paused ? 'paused' : 'active') + '). To change it, ask Claude to update the reminder.' : 'Daily reminder: not scheduled. These fields only record your choice. A reminder exists only after Claude creates it and records its id here.' })));
    var pol = Object.keys(S.policies).sort();
    var notes = h('textarea', { id: 'pol_notes', rows: 3, placeholder: 'What should change? e.g. weight toward insights roles, exclude industries, narrow geography' });
    main.appendChild(h('section', { class: 'card' }, h('h3', { text: 'Sourcing policy (active: ' + c.policy + ')' }),
      pol.map(function (k) { var p = S.policies[k]; return h('p', { class: 'muted', text: p.version + ' · ' + date(p.createdAt) + ' · ' + (p.summary || '') }); }), notes,
      h('button', { id: 'pol_save', onclick: function () {
        var v = 'v' + (pol.length + 1), p = { version: v, createdAt: nowIso(), summary: notes.value.trim() || 'No notes', alignedPct: Number(aligned.value), basedOnReviews: completed().length };
        put('policies', v, p).then(function () { return put('settings', 'main', Object.assign({}, s, { id: 'main', activePolicy: v })); }).then(function () { S.policies[v] = p; S.settings.main = Object.assign({}, s, { id: 'main', activePolicy: v }); render(); toast('Policy ' + v + ' recorded. Ask Claude “Refine sourcing” to apply it to the next batch.'); }); } }, 'Record new policy version')));
    main.appendChild(h('section', { class: 'card' }, h('h3', { text: 'Ask Claude' }), h('p', { class: 'muted', text: 'These need Claude (web sourcing, report writing). Copy and paste.' }),
      h('div', { class: 'chips' }, ['10 more', 'Analyze my ratings', 'Refine sourcing', 'Build my target company list', 'Export my data'].map(copyBtn))));
    var exp = h('div', { id: 'exportout' });
    var file = h('input', { id: 'restorefile', type: 'file', accept: '.json,application/json' });
    main.appendChild(h('section', { class: 'card' }, h('h3', { text: 'Export, backup, restore' }),
      h('div', { class: 'actions' }, h('button', { id: 'x_csv', onclick: function () { saveFile('10dreamjobs-standardized.csv', DJ.toCsv(csvRows(), Object.keys(csvRows()[0] || { job_id: 1 }))); } }, 'Export CSV (standardized)'),
        h('button', { id: 'x_json', onclick: function () { saveFile('10dreamjobs-full.json', JSON.stringify(allData(), null, 2)); } }, 'Export JSON (full backup)')),
      h('label', { class: 'frm' }, 'Restore from a JSON backup (adds and overwrites by ID; never deletes)', file),
      h('button', { id: 'x_restore', onclick: function () { var f = file.files[0]; if (!f) { toast('Choose a backup file first.', true); return; } f.text().then(function (t) { var o; try { o = JSON.parse(t); } catch (e) { toast('Not valid JSON.', true); return; } restore(o); }); } }, 'Restore'), exp));
  }
  function restore(o) {
    var ps = [], n = 0;
    ['companies', 'jobs', 'batches', 'reviews', 'policies', 'reports', 'targets', 'settings'].forEach(function (col) { var m = o[col] || {}; Object.keys(m).forEach(function (id) { n++; ps.push(function () { return put(col, id, m[id]); }); }); });
    ps.reduce(function (p, f) { return p.then(f); }, Promise.resolve()).then(function () { toast('Restored ' + n + ' records.'); }, function () { });
  }

  /* ---------- events ---------- */
  ['mousemove', 'keydown', 'scroll', 'pointerdown', 'touchstart', 'wheel'].forEach(function (ev) {
    window.addEventListener(ev, function () { if (cur && cur.timer && !cur.manual) { cur.timer.activity(); } }, { passive: true, capture: true });
  });
  document.addEventListener('visibilitychange', function () {
    if (!cur || !cur.timer) return;
    if (document.hidden) { cur.timer.pause('hidden'); persistOpen(); cur.wasRunning = false; saveDraft(); }
    else if (!cur.manual) { cur.timer.resume(); cur.wasRunning = true; }
  });
  window.addEventListener('pagehide', function () { if (cur && cur.timer) { cur.timer.pause('pagehide'); saveDraft(); persistOpen(); } });

  /* ---------- boot ---------- */
  function subscribe() {
    COLS.forEach(function (col) {
      db.collection(col).onSnapshot(function (snap) {
        var m = {}; snap.docs.forEach(function (d) { m[d.id] = d.data(); });
        // never clobber the record being edited with an older snapshot of it
        if (cur && col === 'reviews' && S.reviews[cur.id] && m[cur.id] && (m[cur.id].sessions || []).length < (S.reviews[cur.id].sessions || []).length) m[cur.id] = S.reviews[cur.id];
        S[col] = m; var first = !ready[col]; ready[col] = true;
        if (first && COLS.every(function (c) { return ready[c]; })) { recoverDraft(); if (location.hash === '#review') startQueue(10); }
        if (view !== 'record' && view !== 'import') render(); else renderProgress();
      }, function (e) { toast('Database error: ' + (e && e.code), true); });
    });
  }
  function boot() {
    render();
    var c = window.claude; if (!c || !c.use) { render(); return; }
    Promise.all([c.use('db').catch(function () { return null; }), c.use('downloads').catch(function () { return null; })]).then(function (r) {
      db = r[0]; dl = r[1]; render(); if (db) subscribe();
    });
  }
  boot();
})();
