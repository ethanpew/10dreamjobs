// End-to-end check of the built page in headless Chromium against an in-memory mock of the artifact `db` and `downloads`
// capabilities (persisted in localStorage so reloads behave like a real store). Fixture roles below are TEST DATA ONLY;
// they live in the throwaway browser profile and are never written to the real database.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const url = 'file://' + path.join(here, '..', 'app', 'dist', '10dreamjobs.html');

const MOCK = `(() => {
  const KEY = 'mockdb'; const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } };
  const save = d => localStorage.setItem(KEY, JSON.stringify(d)); const subs = [];
  const snapDoc = (id, v) => ({ id, exists: v !== undefined, data: () => v === undefined ? undefined : JSON.parse(JSON.stringify(v)), metadata: {} });
  const colDocs = c => { const d = load()[c] || {}; return Object.keys(d).sort().map(k => snapDoc(k, d[k])); };
  const notify = c => subs.filter(s => s.c === c).forEach(s => s.f({ docs: colDocs(c), size: 0, empty: false, metadata: {}, docChanges: () => [] }));
  const split = p => { const i = p.lastIndexOf('/'); return [p.slice(0, i), p.slice(i + 1)]; };
  const db = {
    doc: p => { const [c, id] = split(p); return {
      id, path: p, get: async () => snapDoc(id, (load()[c] || {})[id]),
      set: async v => { const d = load(); (d[c] = d[c] || {})[id] = JSON.parse(JSON.stringify(v)); save(d); setTimeout(() => notify(c), 0); },
      update: async v => { const d = load(); d[c][id] = Object.assign(d[c][id], v); save(d); setTimeout(() => notify(c), 0); },
      delete: async () => { const d = load(); if (d[c]) delete d[c][id]; save(d); setTimeout(() => notify(c), 0); } }; },
    collection: c => ({ get: async () => ({ docs: colDocs(c) }), onSnapshot: (f) => { subs.push({ c, f }); setTimeout(() => f({ docs: colDocs(c), size: 0, empty: false, metadata: {}, docChanges: () => [] }), 0); return () => {}; } })
  };
  window.__downloads = [];
  window.claude = { use: async n => n === 'db' ? db : n === 'downloads' ? { save: async r => { window.__downloads.push(r); return { status: 'saved' }; } } : null };
})();`;

const FIX = [
  { company: 'Testco Alpha', title: 'Senior Consumer Insights Manager', location: 'Austin, TX', arrangement: 'Hybrid', reqId: 'T-1', sourceUrl: 'https://example.test/jobs/1?utm_source=a', roleFamily: ['Consumer Insights'], seniority: 'Senior Manager',
    desc: 'About the role\n• Lead survey and qualitative research\n• Use SQL and Tableau\n\nRequirements\n- 7+ years', salary: { text: '$140,000 - $170,000 USD base', min: 140000, max: 170000, currency: 'USD', period: 'year', basis: 'base salary' },
    companyData: { industry: 'Software', model: 'B2B', ownership: 'Public', ticker: 'TSTA', exchange: 'NASDAQ', marketCap: { value: '12.0B', currency: 'USD', asOf: '2026-10-01' }, hq: 'Austin, TX' } },
  { company: 'Testco Beta', title: 'Brand Strategy Director', location: 'New York, NY', arrangement: 'On-site', reqId: 'T-2', sourceUrl: 'https://example.test/jobs/2', roleFamily: ['Brand'], seniority: 'Director',
    desc: 'Own brand positioning and go-to-market launches.\nManage a team of five.', companyData: { industry: 'Consumer goods', model: 'B2C', ownership: 'Private' } },
  { company: 'Testco Gamma', title: 'Lifecycle Marketing Lead', location: 'Remote (US)', arrangement: 'Remote', reqId: 'T-3', sourceUrl: 'https://example.test/jobs/3', roleFamily: ['Lifecycle/CRM'], seniority: 'Manager', companyData: { industry: 'Fintech' } }
];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
await ctx.addInitScript(MOCK);
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error' && !/fonts\.g/.test(m.text())) errors.push(m.text()); });
const results = []; const ok = (name) => results.push(name);
const reload = async () => { await page.reload(); await page.waitForSelector('#nav .tab'); await page.waitForTimeout(150); };
const dbGet = (col) => page.evaluate(c => (JSON.parse(localStorage.getItem('mockdb') || '{}')[c] || {}), col);

await page.goto(url); await page.waitForSelector('#nav .tab'); await page.waitForTimeout(150);
assert.match(await page.textContent('#main'), /No roles yet/); ok('empty state honest, no fabricated roles');

// import batch
await page.click('text=Add roles'); await page.fill('#batchjson', JSON.stringify(FIX)); await page.click('#runbatch');
await page.waitForSelector('#importout .card'); assert.match(await page.textContent('#importout'), /3 added, 0 duplicate/);
assert.match(await page.textContent('#importout'), /Batch has 3 roles, not 10/); ok('batch import + shortfall warning');
await page.fill('#batchjson', JSON.stringify([FIX[0], { company: 'testco alpha', title: 'x', location: 'y', sourceUrl: 'https://www.example.test/jobs/1/' }]));
await page.click('#runbatch'); await page.waitForFunction(() => /0 added, 2 duplicate/.test(document.querySelector('#importout').textContent)); ok('duplicates detected (req ID and canonical URL)');
assert.equal(Object.keys(await dbGet('jobs')).length, 3);

// table
await page.click('text=Roles');
const heads = await page.$$eval('#jobs thead th', t => t.map(x => x.textContent.replace(/[ ▲▼]+$/, '')));
assert.deepEqual(heads, ['Company', 'Job Title', 'Location', 'Salary', 'Date Reviewed']); ok('default columns and order');
const rows = await page.$$eval('#rows tr', t => t.map(r => [...r.children].map(c => c.textContent)));
assert.equal(rows.length, 3); assert.equal(rows.find(r => r[0] === 'Testco Beta')[3], 'Not disclosed'); assert.equal(rows[0][4], ''); ok('Not disclosed salary; blank Date Reviewed');

// open record, check description exactly, no preselection, order
await page.click('tr:has-text("Testco Alpha")'); await page.waitForSelector('#jd');
assert.equal(await page.textContent('#jd'), FIX[0].desc); ok('row opens the correct complete description (bullets preserved)');
assert.equal(await page.$$eval('.sc.on', e => e.length), 0); assert.equal(await page.isDisabled('#save'), true);
const order = await page.evaluate(() => { const r = document.querySelector('article.record'); return [...r.children].map(c => c.tagName + '.' + c.className); });
assert.match(order.join('|'), /HEADER.*desc.*rating/); ok('header, description, then rating controls; none preselected; save disabled');
assert.match(await page.textContent('.facts'), /NASDAQ/); assert.match(await page.textContent('.facts'), /as of 2026-10-01/);
assert.doesNotMatch(await page.textContent('article.record'), /predicted|recommended|suggested rating/i);

// timing: hide page, idle, resume
await page.click('#i-9'); assert.equal(await page.isDisabled('#save'), true); await page.click('#q-4'); assert.equal(await page.isDisabled('#save'), false);
await page.waitForTimeout(2200);
await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
const t1 = await page.textContent('#timer'); await page.waitForTimeout(1800); assert.equal(await page.textContent('#timer'), t1); ok('timer pauses while page hidden');
await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
await page.waitForTimeout(1500); assert.notEqual(await page.textContent('#timer'), t1); ok('timer resumes when visible');
await page.click('#pausebtn'); const t2 = await page.textContent('#timer'); await page.waitForTimeout(1500); assert.equal(await page.textContent('#timer'), t2); ok('explicit pause');
await page.click('#pausebtn');
await page.fill('#note', 'Test note');
await page.click('#save'); await page.waitForSelector('text=Original (');
let jobs = await dbGet('jobs'), revs = await dbGet('reviews'); const aid = Object.keys(jobs).find(k => jobs[k].company === 'Testco Alpha');
assert.equal(jobs[aid].status, 'reviewed'); assert.ok(jobs[aid].reviewedAt);
assert.equal(revs[aid].ratings.length, 1); assert.equal(revs[aid].ratings[0].interest, 9); assert.equal(revs[aid].ratings[0].qualification, 4);
assert.ok(revs[aid].active_s >= 2 && revs[aid].active_s <= 8, 'active_s=' + revs[aid].active_s); assert.ok(revs[aid].sessions[0].elapsed_s >= revs[aid].sessions[0].active_s);
assert.ok(revs[aid].sessions[0].pauses.includes('hidden') && revs[aid].sessions[0].pauses.includes('manual')); ok('ratings saved together; active/elapsed seconds, pauses and method stored');

// reload persistence
await reload(); await page.click('#nav >> text=Roles');
let r2 = await page.$$eval('#rows tr', t => t.map(r => [...r.children].map(c => c.textContent)));
assert.match(r2.find(r => r[0] === 'Testco Alpha')[4], /^\d{4}-\d\d-\d\d$/); assert.equal(r2.find(r => r[0] === 'Testco Beta')[4], ''); ok('records and ratings survive reload');
await page.click('tr:has-text("Testco Alpha")'); await page.waitForSelector('text=Original (');
assert.equal(await page.textContent('#jd'), FIX[0].desc);

// revision keeps original
await page.click('#revise'); await page.click('#i-5'); await page.click('#q-6'); await page.waitForTimeout(1200); await page.click('#save'); await page.waitForSelector('ol.hist li:nth-child(2)');
revs = await dbGet('reviews'); assert.equal(revs[aid].ratings.length, 2); assert.equal(revs[aid].ratings[0].interest, 9); assert.equal(revs[aid].ratings[1].kind, 'revision'); assert.equal(revs[aid].ratings[1].interest, 5);
jobs = await dbGet('jobs'); assert.equal(jobs[aid].ratingOriginal.interest, 9); assert.equal(jobs[aid].ratingLatest.interest, 5);
assert.ok(revs[aid].extra_active_s >= 1 && revs[aid].extra_active_s < 6); ok('revision appended; original and initial duration preserved; extra time separate');

// review next 10 + save and next + skip
await page.click('#nav >> text=Roles'); await page.click('text=Review next 10'); await page.waitForSelector('#i-1');
assert.match(await page.textContent('article.record'), /Testco Beta/);
await page.click('#i-2'); await page.click('#q-8'); await page.click('#savenext'); await page.waitForFunction(() => /Testco Gamma/.test(document.querySelector('article.record')?.textContent || ''));
assert.match(await page.textContent('article.record'), /Incomplete description/); ok('Save and next advances queue; missing description flagged incomplete');
await page.fill('#missingtext', 'Pasted full text for Gamma.'); await page.click('text=Save description'); await page.waitForSelector('#jd');
assert.equal(await page.textContent('#jd'), 'Pasted full text for Gamma.'); ok('missing description can be imported');
await page.click('#skip'); await page.waitForSelector('#rows');
jobs = await dbGet('jobs'); const gid = Object.keys(jobs).find(k => jobs[k].company === 'Testco Gamma'); assert.equal(jobs[gid].status, 'skipped'); assert.equal(jobs[gid].ratingLatest, undefined);
assert.match(await page.textContent('#progress'), /2 reviewed/); ok('skip is not a rating; progress counts completed only');

// filters
await page.selectOption('#fstatus', 'reviewed'); assert.equal((await page.$$('#rows tr')).length, 2);
await page.click('text=Rating filters'); await page.fill('#f_imin', '8'); assert.equal((await page.$$('#rows tr')).length, 0, 'latest ratings: alpha=5, beta=2');
await page.selectOption('#fmode', 'original'); assert.equal((await page.$$('#rows tr')).length, 1); ok('search/filter by status and original vs latest rating');

// analysis + exports
await page.click('#nav >> text=Analysis'); assert.match(await page.textContent('#main'), /Preliminary: 2 completed unique roles/); ok('report counts completed unique jobs and labels preliminary');
await page.click('#snap'); await page.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem('mockdb')).reports || {}).length === 1); ok('report snapshot saved');
await page.click('#nav >> text=Settings'); await page.click('#x_csv'); await page.click('#x_json'); await page.waitForTimeout(200);
const dls = await page.evaluate(() => window.__downloads); const csv = dls.find(d => d.filename.endsWith('.csv')).data, json = JSON.parse(dls.find(d => d.filename.endsWith('.json')).data);
assert.match(csv, /Not disclosed/); assert.match(csv.split('\r\n')[0], /^job_id,company,division,title/);
assert.equal(json.jobs[aid].desc, FIX[0].desc); assert.equal(json.reviews[aid].ratings.length, 2); ok('CSV and JSON exports keep descriptions, ratings history');

// restore into a wiped store
const backup = JSON.stringify(json);
await page.evaluate(() => localStorage.removeItem('mockdb')); await reload(); await page.click('#nav >> text=Settings');
await page.setInputFiles('#restorefile', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(backup) }); await page.click('#x_restore'); await page.waitForTimeout(800);
jobs = await dbGet('jobs'); assert.equal(Object.keys(jobs).length, 3); revs = await dbGet('reviews'); assert.equal(revs[aid].ratings.length, 2); ok('restore from JSON backup');

// interrupted session recovery
await page.evaluate(({ id }) => { localStorage.setItem('dj_draft', JSON.stringify({ id, revising: false, start: Date.now() - 90000, active_s: 41, at: Date.now() - 50000 })); }, { id: gid });
await reload(); await page.waitForTimeout(500); revs = await dbGet('reviews');
assert.ok(revs[gid] && revs[gid].sessions.some(s => s.pauses.includes('interrupted-recovered')) && revs[gid].active_s >= 41); ok('interrupted session recovered after reload');

// phone width: no horizontal page scroll
await page.setViewportSize({ width: 390, height: 800 }); await page.click('#nav >> text=Roles');
assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll at 390px'); ok('phone width has no horizontal page scroll');

assert.deepEqual(errors, []); ok('no console/page errors');
console.log(results.map(r => 'PASS ' + r).join('\n')); await browser.close();
