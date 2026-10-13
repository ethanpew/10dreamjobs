const test = require('node:test');
const assert = require('node:assert');
const DJ = require('../app/lib.js');

test('dedup: requisition ID, canonical URL (tracking params), and company/title/location fallback', () => {
  const a = { company: 'Acme Inc.', title: 'Senior Brand Manager', location: 'Austin, TX', reqId: 'R-100', sourceUrl: 'https://careers.acme.com/jobs/100?utm_source=x' };
  const jobs = [a];
  assert.ok(DJ.findDuplicate({ company: 'ACME Inc', reqId: 'r-100', title: 'Renamed', location: 'NYC' }, jobs));
  assert.match(DJ.findDuplicate({ company: 'Other', sourceUrl: 'https://www.careers.acme.com/jobs/100/?gh_src=abc' }, jobs).reason, /canonical URL/);
  assert.match(DJ.findDuplicate({ company: 'acme inc', title: 'senior brand manager', location: 'austin tx' }, jobs).reason, /title/);
  assert.equal(DJ.findDuplicate({ company: 'Acme Inc.', title: 'Insights Lead', location: 'Austin, TX' }, jobs), null);
});

test('stable ids', () => {
  const j = { company: 'Acme', reqId: '7', title: 'x' };
  assert.equal(DJ.jobId(j), DJ.jobId({ company: 'acme', reqId: '7', title: 'different title' }));
  assert.notEqual(DJ.jobId(j), DJ.jobId({ company: 'acme', reqId: '8' }));
});

test('salary: undisclosed is honest; published text preserved; annualization only when period known', () => {
  assert.equal(DJ.fmtSalary(null), 'Not disclosed');
  assert.equal(DJ.fmtSalary({}), 'Not disclosed');
  assert.equal(DJ.fmtSalary({ text: '$120,000 - $150,000 USD base' }), '$120,000 - $150,000 USD base');
  assert.equal(DJ.fmtSalary({ currency: 'USD', min: 100000, max: 120000, period: 'year' }), 'USD 100,000–120,000 / year');
  assert.equal(DJ.annualMid({ min: 100000, max: 120000, period: 'year' }), 110000);
  assert.equal(DJ.annualMid({ min: 50, max: 70, period: 'hour' }), 60 * 2080);
  assert.equal(DJ.annualMid({ min: 5, max: 6 }), null);
  assert.equal(DJ.annualMid(null), null);
});

test('rating history is append-only; original preserved; review_s tracked separately; legacy normalizes', () => {
  let r = DJ.appendRating(null, { roleInterest: 9, companyInterest: 4, qualification: 4 }, 'love the work', '2026-10-13T10:00:00Z', 0);
  r.active_s = 95;
  assert.equal(r.ratings[0].kind, 'original'); assert.equal(r.ratings[0].schema, 2);
  const before = JSON.stringify(r.ratings[0]);
  const r2 = DJ.appendRating(r, { roleInterest: 6, companyInterest: 8, qualification: 5, qualificationCarried: true }, 'cooled', '2026-10-20T10:00:00Z', 42);
  assert.equal(JSON.stringify(r2.ratings[0]), before);
  assert.equal(r2.ratings.length, 2); assert.equal(r2.ratings[1].kind, 'revision'); assert.equal(r2.ratings[1].review_s, 42); assert.equal(r2.ratings[1].qualificationCarried, true);
  assert.equal(DJ.norm(DJ.ratingOf(r2, 'original')).role, 9); assert.equal(DJ.norm(DJ.ratingOf(r2, 'latest')).company, 8);
  assert.equal(r.ratings.length, 1, 'input not mutated');
  // legacy (schema 1): one combined interest, no company score
  const leg = { ratings: [{ at: 't', interest: 7, qualification: 4, kind: 'original', review_s: 30 }], active_s: 30 };
  const n = DJ.norm(DJ.ratingOf(leg, 'latest')); assert.equal(n.legacy, true); assert.equal(n.role, 7); assert.equal(n.company, null);
  const mig = DJ.appendRating(leg, { roleInterest: 8, companyInterest: 3, qualification: 4, qualificationCarried: true }, '', 't2', 20);
  assert.equal(mig.ratings[0].interest, 7); assert.equal(mig.ratings[1].roleInterest, 8); assert.equal(DJ.norm(DJ.ratingOf(mig, 'latest')).legacy, false);
  assert.equal(DJ.quadrant2(9, 2), 'High role / lower company'); assert.equal(DJ.quadrant2(2, 9), 'Lower role / high company');
});

test('timer: hidden pause, resume, idle pause excludes trailing idle, accumulation', () => {
  let t0 = 0; const clock = () => t0; const T = DJ.ReviewTimer(120, clock);
  T.start(); t0 += 30000; T.activity();                    // 30s active
  T.pause('hidden'); t0 += 600000;                         // 10 min away, not counted
  T.resume(); t0 += 20000; T.activity();                   // +20s => 50s
  t0 += 300000; T.checkIdle();                             // idle 5 min; counts only to last activity
  assert.equal(T.running, false);
  assert.equal(Math.round(T.activeSec()), 70 > 0 ? Math.round(T.activeSec()) : 0);
  assert.equal(Math.round(T.activeSec()), 50);
  t0 += 1000; T.activity();                                // renewed activity resumes
  assert.equal(T.running, true);
  t0 += 10000; T.activity();
  const s = T.finish('submit');
  assert.equal(s.active_s, 60);
  assert.ok(s.elapsed_s >= 900);
  assert.deepEqual(s.pauses.slice(0, 2), ['hidden', 'idle']);
  assert.match(s.method, /idle\(120s\)/);
});

test('timer: missed idle tick (throttled timer) is detected on next activity', () => {
  let t0 = 0; const T = DJ.ReviewTimer(120, () => t0);
  T.start(); t0 += 10000; T.activity(); t0 += 500000; T.activity();   // long gap then activity
  t0 += 5000; T.activity();
  assert.equal(Math.round(T.activeSec()), 15);  // 10s before gap + 5s after
});

test('groupMeans handles multi-tags, Unknown, missingness and tentative flags', () => {
  const rows = [{ interest: 9, f: ['A', 'B'] }, { interest: 3, f: ['A'] }, { interest: 8, f: ['Unknown'] }, { interest: 5, f: [] }];
  const g = DJ.groupMeans(rows, r => r.f, 2);
  const gc = DJ.groupMeans([{ interest: 1, companyInterest: 9, f: ['X'] }, { interest: 9, companyInterest: null, f: ['X'] }], r => r.f, 1, 'companyInterest');
  assert.equal(gc.groups[0].n, 1); assert.equal(gc.groups[0].mean, 9);   // null company interest skipped
  assert.equal(g.missing, 2);
  const a = g.groups.find(x => x.key === 'A');
  assert.equal(a.n, 2); assert.equal(a.mean, 6); assert.equal(a.tentative, false);
  assert.equal(g.groups.find(x => x.key === 'B').tentative, true);
});

test('spearman, quadrant, sensitivity, theme contrast', () => {
  assert.equal(DJ.spearman([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]), 1);
  assert.equal(DJ.spearman([1, 2], [1, 2]), null);
  assert.equal(DJ.quadrant(9, 4), 'High interest / lower qualification');
  assert.equal(DJ.quadrant(2, 9), 'Lower interest / high qualification');
  const rows = [{ interest: 9, text: 'Own go-to-market launch and SQL analysis' }, { interest: 2, text: 'Manage a team of coordinators' }, { interest: 5, text: 'x' }];
  const c = DJ.themeContrast(rows);
  assert.equal(c.highGroup, 1); assert.equal(c.lowGroup, 1);
  assert.equal(c.themes.find(t => t.theme === 'SQL / data tooling').highN, 1);
  assert.equal(DJ.sensitivity(rows)[0].highN, 1);
});

test('csv quoting', () => {
  assert.equal(DJ.toCsv([{ a: 'x,y', b: 'say "hi"' }], ['a', 'b']), 'a,b\r\n"x,y","say ""hi"""');
});

test('dates use the given timezone', () => {
  assert.equal(DJ.fmtDate('2026-10-14T02:00:00Z', 'America/Chicago'), '2026-10-13');
  assert.equal(DJ.fmtDate('2026-10-14T02:00:00Z', 'UTC'), '2026-10-14');
  assert.equal(DJ.fmtDate(null, 'UTC'), '');
});
