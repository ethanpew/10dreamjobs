/* Pure logic for 10 Dream Jobs. No DOM, no db. Tested in tests/lib.test.js. */
var DJ = (function () {
  'use strict';

  var ROLE_FAMILIES = ['Brand', 'Product Marketing', 'Consumer Insights', 'Marketing Research', 'Marketing Analytics',
    'Growth', 'Lifecycle/CRM', 'Performance Marketing', 'Strategy', 'Marketing Operations', 'Partnerships',
    'Content/Communications', 'Category/Channel Marketing', 'Adjacent: Product', 'Adjacent: Sales/BD', 'Adjacent: Other', 'Unknown'];
  var SENIORITY = ['Intern/Entry', 'Associate', 'Mid', 'Senior', 'Manager', 'Senior Manager', 'Director', 'VP+', 'Unknown'];
  var HIGH_INTEREST = 8, LOW_INTEREST = 3;     // report thresholds (1-3 low, 8-10 high)
  var QUAD_INTEREST = 7, QUAD_QUAL = 7;        // quadrant cut points (>=)

  function normKey(s) { return String(s == null ? '' : s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim(); }

  function canonUrl(u) {
    if (!u) return '';
    try {
      var x = new URL(String(u).trim());
      var drop = /^(utm_|gclid|fbclid|source$|src$|ref$|referrer$|lever-source|gh_src)/i;
      var keep = [];
      x.searchParams.forEach(function (v, k) { if (!drop.test(k)) keep.push(k + '=' + v); });
      keep.sort();
      return x.hostname.toLowerCase().replace(/^www\./, '') + x.pathname.replace(/\/+$/, '').toLowerCase() + (keep.length ? '?' + keep.join('&') : '');
    } catch (e) { return String(u).trim().toLowerCase(); }
  }

  function hash(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); }

  function companyId(name) { return 'c_' + normKey(name).replace(/ /g, '-').slice(0, 60); }

  function jobId(j) {
    var base = j.reqId ? normKey(j.company) + '|' + normKey(j.reqId)
      : j.sourceUrl ? canonUrl(j.sourceUrl)
        : normKey(j.company) + '|' + normKey(j.title) + '|' + normKey(j.location);
    return 'j_' + hash(base) + hash(base.split('').reverse().join(''));
  }

  /* Returns {job, reason} for the first existing record that the candidate duplicates, else null. */
  function findDuplicate(cand, jobs) {
    var cc = normKey(cand.company), cu = canonUrl(cand.sourceUrl), cr = normKey(cand.reqId);
    for (var i = 0; i < jobs.length; i++) {
      var e = jobs[i];
      if (cr && normKey(e.reqId) === cr && normKey(e.company) === cc) return { job: e, reason: 'same company + requisition ID' };
      if (cu && canonUrl(e.sourceUrl) === cu) return { job: e, reason: 'same canonical URL' };
    }
    for (var k = 0; k < jobs.length; k++) {
      var f = jobs[k];
      if (normKey(f.company) === cc && normKey(f.title) === normKey(cand.title) && normKey(f.location) === normKey(cand.location)) {
        return { job: f, reason: 'same company + title + location' };
      }
    }
    return null;
  }

  function fmtSalary(s) {
    if (!s) return 'Not disclosed';
    if (s.text) return s.text;                       // exactly as published
    if (s.min == null && s.max == null) return 'Not disclosed';
    var n = function (v) { return v == null ? '?' : Number(v).toLocaleString('en-US'); };
    var rng = s.min != null && s.max != null && s.min !== s.max ? n(s.min) + '–' + n(s.max) : n(s.min != null ? s.min : s.max);
    return (s.currency || '') + ' ' + rng + (s.period ? ' / ' + s.period : '');
  }

  /* Annualized midpoint for comparison only; null if not comparable. Never imputed. */
  function annualMid(s) {
    if (!s || (s.min == null && s.max == null)) return null;
    var lo = s.min != null ? s.min : s.max, hi = s.max != null ? s.max : s.min, mid = (lo + hi) / 2;
    var p = String(s.period || '').toLowerCase();
    var mult = /year|annual|yr/.test(p) ? 1 : /hour/.test(p) ? 2080 : /month/.test(p) ? 12 : /week/.test(p) ? 52 : /day/.test(p) ? 260 : null;
    return mult == null ? null : mid * mult;
  }

  function fmtDate(iso, tz) {
    if (!iso) return '';
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)); }
    catch (e) { return String(iso).slice(0, 10); }
  }
  function fmtDur(sec) { sec = Math.round(sec || 0); var m = Math.floor(sec / 60), s = sec % 60; return m + ':' + (s < 10 ? '0' : '') + s; }

  function ratingOf(review, mode) {          // mode: 'original' | 'latest'
    if (!review || !review.ratings || !review.ratings.length) return null;
    return mode === 'original' ? review.ratings[0] : review.ratings[review.ratings.length - 1];
  }

  /* Normalize a stored rating entry. Schema 1 (legacy) held one combined "interest"; schema 2 splits role and company interest. */
  function norm(e) {
    if (!e) return null;
    var legacy = e.roleInterest == null && e.interest != null;
    return { role: legacy ? e.interest : e.roleInterest, company: legacy ? null : (e.companyInterest == null ? null : e.companyInterest), qual: e.qualification, legacy: legacy, at: e.at, kind: e.kind, note: e.note };
  }
  /* Rating history append. Never mutates earlier entries. r = {roleInterest, companyInterest, qualification, qualificationCarried?} */
  function appendRating(review, r, note, nowIso, activeSecThisOpen) {
    var rv = review ? JSON.parse(JSON.stringify(review)) : { ratings: [], sessions: [], active_s: 0, extra_active_s: 0, elapsed_s: 0 };
    var first = rv.ratings.length === 0;
    var e = { at: nowIso, roleInterest: r.roleInterest, companyInterest: r.companyInterest, qualification: r.qualification, note: note || '', kind: first ? 'original' : 'revision',
      review_s: first ? Math.round(rv.active_s || 0) : Math.round(activeSecThisOpen || 0), schema: 2 };
    if (r.qualificationCarried) e.qualificationCarried = true;
    rv.ratings.push(e);
    return rv;
  }

  /* ---- statistics ---- */
  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }
  function rank(a) {
    var idx = a.map(function (v, i) { return [v, i]; }).sort(function (x, y) { return x[0] - y[0]; }), r = new Array(a.length), i = 0;
    while (i < idx.length) { var j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; var avg = (i + j) / 2 + 1; for (var k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; }
    return r;
  }
  function spearman(x, y) {
    if (x.length < 5) return null;
    var rx = rank(x), ry = rank(y), mx = mean(rx), my = mean(ry), num = 0, dx = 0, dy = 0;
    for (var i = 0; i < rx.length; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += Math.pow(rx[i] - mx, 2); dy += Math.pow(ry[i] - my, 2); }
    return dx && dy ? num / Math.sqrt(dx * dy) : null;
  }
  /* rows: [{interest, ...}] ; keysFn returns array of group keys (multi-tag allowed) */
  function groupMeans(rows, keysFn, minN, field) {
    field = field || 'interest';
    var g = {}, missing = 0;
    rows.forEach(function (r) {
      if (r[field] == null) return;
      var ks = keysFn(r).filter(function (k) { return k && k !== 'Unknown'; });
      if (!ks.length) { missing++; return; }
      ks.forEach(function (k) { (g[k] = g[k] || []).push(r[field]); });
    });
    var out = Object.keys(g).map(function (k) {
      var v = g[k]; return { key: k, n: v.length, mean: mean(v), high: v.filter(function (x) { return x >= HIGH_INTEREST; }).length, low: v.filter(function (x) { return x <= LOW_INTEREST; }).length, tentative: v.length < (minN || 5) };
    }).sort(function (a, b) { return b.mean - a.mean; });
    return { groups: out, missing: missing, total: rows.filter(function (r) { return r[field] != null; }).length };
  }
  function quadrant(i, q) {
    var hi = i >= QUAD_INTEREST, hq = q >= QUAD_QUAL;
    return hi && hq ? 'High interest / high qualification' : hi ? 'High interest / lower qualification'
      : hq ? 'Lower interest / high qualification' : 'Lower interest / lower qualification';
  }

  function quadrant2(role, company) {
    var hr = role >= QUAD_INTEREST, hc = company >= QUAD_INTEREST;
    return hr && hc ? 'High role / high company' : hr ? 'High role / lower company' : hc ? 'Lower role / high company' : 'Lower role / lower company';
  }

  /* Synonym-grouped description themes. Proportion of jobs containing a theme, not raw word counts. */
  var THEMES = {
    'Consumer insights & research': /consumer insight|market research|qualitative|quantitative research|survey|focus group|voice of (the )?customer|conjoint|segmentation/i,
    'Analytics & measurement': /analytics|measurement|attribution|marketing mix|\bmmm\b|incrementality|a\/b test|experiment|dashboard|kpi/i,
    'SQL / data tooling': /\bsql\b|python|\bR\b programming|tableau|power ?bi|looker|snowflake|bigquery|databricks/i,
    'Brand strategy': /brand (strategy|positioning|equity|health|platform)|brand manag/i,
    'Go-to-market & positioning': /go-to-market|\bgtm\b|positioning|messaging|launch/i,
    'Lifecycle / CRM': /lifecycle|\bcrm\b|retention|email marketing|marketing automation|customer journey|salesforce|hubspot|braze|marketo/i,
    'Performance / paid media': /paid (media|search|social)|performance marketing|\bsem\b|\bseo\b|media buying|\bcac\b|\broas\b/i,
    'Growth': /\bgrowth\b|acquisition|funnel|conversion/i,
    'Cross-functional leadership': /cross-functional|stakeholder|influence without authority|partner with (product|sales|engineering)/i,
    'People management': /manage(s)? a team|direct reports|lead(ing)? a team|mentor|coach/i,
    'Strategy & planning': /strategic plan|roadmap|business case|portfolio|pricing|market (sizing|opportunity)|competitive (analysis|landscape)/i,
    'Partnerships': /partnership|alliances?|co-marketing|channel partner|affiliate/i,
    'Creative & content': /creative|storytelling|content (strategy|marketing)|copywriting|campaign/i,
    'Generative AI / automation': /generative ai|\bllm\b|\bgenai\b|machine learning|\bai\b tools|automation/i,
    'Executive communication': /executive (presentation|communication)|c-suite|board|senior leadership/i,
    'Travel required': /travel (up to )?\d+|\d+% travel|travel required/i
  };
  function themesOf(text) { var out = []; Object.keys(THEMES).forEach(function (t) { if (THEMES[t].test(text || '')) out.push(t); }); return out; }

  function themeContrast(rows) {   // rows: [{interest, text}]
    var hi = rows.filter(function (r) { return r.interest >= HIGH_INTEREST; }), lo = rows.filter(function (r) { return r.interest <= LOW_INTEREST; });
    var res = Object.keys(THEMES).map(function (t) {
      var h = hi.filter(function (r) { return themesOf(r.text).indexOf(t) >= 0; }).length, l = lo.filter(function (r) { return themesOf(r.text).indexOf(t) >= 0; }).length;
      var ph = hi.length ? h / hi.length : null, pl = lo.length ? l / lo.length : null;
      return { theme: t, highN: h, lowN: l, highPct: ph, lowPct: pl, diff: ph != null && pl != null ? ph - pl : null, tentative: (h + l) < 5 };
    });
    return { highGroup: hi.length, lowGroup: lo.length, themes: res.sort(function (a, b) { return Math.abs(b.diff || 0) - Math.abs(a.diff || 0); }) };
  }

  /* Threshold sensitivity: how the high/low groups change under alternative cut points. */
  function sensitivity(rows) {
    return [[8, 3], [9, 2], [7, 4]].map(function (p) {
      return { high: '>=' + p[0], low: '<=' + p[1], highN: rows.filter(function (r) { return r.interest >= p[0]; }).length, lowN: rows.filter(function (r) { return r.interest <= p[1]; }).length };
    });
  }

  /* CSV with RFC4180 quoting. */
  function toCsv(rows, cols) {
    var q = function (v) { v = v == null ? '' : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    return [cols.join(',')].concat(rows.map(function (r) { return cols.map(function (c) { return q(r[c]); }).join(','); })).join('\r\n');
  }

  /* Active-time tracker with an injectable clock. States: running / paused.
     Idle: when no activity for idleSec, pause and count time only up to the last activity. */
  function ReviewTimer(idleSec, now) {
    now = now || Date.now;
    var t = { idleSec: idleSec, running: false, activeMs: 0, segStart: 0, lastAct: 0, sessionStart: null, pauses: [] };
    t.start = function () { var n = now(); t.sessionStart = n; t.activeMs = 0; t.pauses = []; t.running = true; t.segStart = n; t.lastAct = n; };
    t.pause = function (reason) {
      if (!t.running) return; var n = now();
      var end = reason === 'idle' ? Math.min(n, t.lastAct) : n;
      t.activeMs += Math.max(0, end - t.segStart); t.running = false; t.pauses.push({ at: n, reason: reason });
    };
    t.resume = function () { if (t.running || t.sessionStart == null) return; t.running = true; t.segStart = now(); t.lastAct = t.segStart; };
    t.activity = function () {
      var n = now();
      if (t.running && n - t.lastAct > t.idleSec * 1000) { t.pause('idle'); t.resume(); return; }  // missed idle tick (e.g. throttled timers)
      if (!t.running && t.sessionStart != null && t.pauses.length && t.pauses[t.pauses.length - 1].reason === 'idle') { t.resume(); return; }
      t.lastAct = n;
    };
    t.checkIdle = function () { if (t.running && now() - t.lastAct > t.idleSec * 1000) t.pause('idle'); };
    t.activeSec = function () { var n = now(); return (t.activeMs + (t.running ? n - t.segStart : 0)) / 1000; };
    t.finish = function (reason) {
      t.pause(reason || 'finish'); var n = now();
      var out = { start: new Date(t.sessionStart).toISOString(), end: new Date(n).toISOString(), active_s: Math.round(t.activeMs / 1000),
        elapsed_s: Math.round((n - t.sessionStart) / 1000), pauses: t.pauses.map(function (p) { return p.reason; }), method: 'page-events: visibility + idle(' + t.idleSec + 's) + manual pause' };
      t.sessionStart = null; return out;
    };
    return t;
  }

  return { ReviewTimer: ReviewTimer, norm: norm, quadrant2: quadrant2, ROLE_FAMILIES: ROLE_FAMILIES, SENIORITY: SENIORITY, HIGH_INTEREST: HIGH_INTEREST, LOW_INTEREST: LOW_INTEREST, normKey: normKey, canonUrl: canonUrl,
    companyId: companyId, jobId: jobId, findDuplicate: findDuplicate, fmtSalary: fmtSalary, annualMid: annualMid, fmtDate: fmtDate, fmtDur: fmtDur,
    ratingOf: ratingOf, appendRating: appendRating, mean: mean, spearman: spearman, groupMeans: groupMeans, quadrant: quadrant, themesOf: themesOf,
    themeContrast: themeContrast, sensitivity: sensitivity, toCsv: toCsv, THEMES: THEMES };
})();
if (typeof module !== 'undefined') module.exports = DJ;
