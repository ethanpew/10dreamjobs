#!/usr/bin/env node
/* Turn a sourced batch (tools/source.py build output + curation overrides) into database documents, using the same
   normalization and ID logic as the app (app/lib.js). Usage: node tools/make_docs.js <batch.json> <curation.json> <outdir>
   Writes <outdir>/jobs/<id>.json, companies/<id>.json, batches/<id>.json and <outdir>/writes.json (a batch-write list). */
const fs = require('fs'), path = require('path'), DJ = require('../app/lib.js');
const [batchFile, curFile, outDir] = process.argv.slice(2);
const batch = JSON.parse(fs.readFileSync(batchFile, 'utf8')), cur = JSON.parse(fs.readFileSync(curFile, 'utf8'));
const now = new Date().toISOString();
const jobs = [], companies = {}, writes = [];
const existing = [];
batch.forEach((raw, i) => {
  const o = cur.jobs[new URL(raw.sourceUrl).pathname.split('/').pop()] || cur.jobs[raw.title] || {};
  const cdata = Object.assign({}, raw.companyData, (cur.companies[raw.company] || {}).data || {});
  const name = (cur.companies[raw.company] || {}).name || raw.company;
  const j = Object.assign({}, raw, o, { company: name });
  delete j.companyData;
  const dup = DJ.findDuplicate(j, existing); if (dup) { console.error('DUPLICATE', j.title, dup.reason); return; }
  existing.push(j);
  const id = DJ.jobId(j), cid = DJ.companyId(name);
  Object.assign(j, { id, companyId: cid, status: 'unreviewed', batchId: cur.batch.id, policyVersion: cur.batch.policyVersion, sourcedAt: now, seq: i });
  j.extraction = Object.assign({}, j.extraction, { missing: Array.from(new Set((j.extraction.missing || []).concat(['structured responsibilities/qualifications', 'company size/stage']))) });
  jobs.push(j); companies[cid] = Object.assign({ id: cid, name }, companies[cid] || {}, cdata);
});
const fam = new Set(), ind = new Set(), per = {};
jobs.forEach(j => { (j.roleFamily || []).forEach(f => fam.add(f)); ind.add(companies[j.companyId].industry); per[j.company] = (per[j.company] || 0) + 1; });
const bd = Object.assign({ date: now, requested: 10, accepted: jobs.length, duplicatesSkipped: 0, jobIds: jobs.map(j => j.id),
  coverage: { roleFamilies: fam.size, industries: ind.size, maxPerCompany: Math.max(...Object.values(per)), warnings: [] } }, cur.batch);
bd.shortfall = Math.max(0, 10 - jobs.length);
for (const [dir, docs] of [['jobs', Object.fromEntries(jobs.map(j => [j.id, j]))], ['companies', companies], ['batches', { [bd.id]: bd }]]) {
  fs.mkdirSync(path.join(outDir, dir), { recursive: true });
  for (const [id, d] of Object.entries(docs)) { fs.writeFileSync(path.join(outDir, dir, id + '.json'), JSON.stringify(d)); writes.push({ op: 'set', collection: dir, doc_id: id, file_path: path.resolve(outDir, dir, id + '.json') }); }
}
fs.writeFileSync(path.join(outDir, 'writes.json'), JSON.stringify(writes, null, 1));
console.log(`${jobs.length} jobs, ${Object.keys(companies).length} companies; families=${fam.size} industries=${ind.size} maxPerCompany=${bd.coverage.maxPerCompany}`);
